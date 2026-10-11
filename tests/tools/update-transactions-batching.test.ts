/**
 * Unit tests for the update_transactions (bulk edit) tool.
 *
 * The tool's reason for existing is turn count: N edits in one MCP call
 * instead of N calls. So the properties worth pinning are the ones that make
 * a big batch safe to issue blind:
 *  - one EditTransaction mutation per edit, each carrying its OWN input
 *  - never more than 5 mutations in flight
 *  - ALL validation (structural, routing, per-field) completes before the
 *    first write, so a bad entry anywhere cannot half-apply the batch
 *  - partial failure is accurately reported, both in stop-on-first-error
 *    mode and in continue_on_error mode
 *  - the optimistic cache patch reflects exactly the rows that landed
 */

import { describe, test, expect, mock } from 'bun:test';
import { homedir } from 'node:os';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';
import { GraphQLError } from '../../src/core/graphql/client.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import type { EditTransactionResponse } from '../../src/core/graphql/transactions.js';

function echoResponse(vars: any) {
  return {
    editTransaction: {
      transaction: {
        id: vars.id,
        name: vars.input.name ?? 'Coffee Shop',
        // Mirror the verified server behaviour: INCOME/INTERNAL_TRANSFER
        // clears the category; REGULAR keeps whatever was sent.
        categoryId:
          vars.input.type === 'INCOME' || vars.input.type === 'INTERNAL_TRANSFER'
            ? ''
            : (vars.input.categoryId ?? 'food'),
        userNotes: vars.input.userNotes ?? null,
        isReviewed: vars.input.isReviewed ?? false,
        type: vars.input.type ?? 'REGULAR',
        date: vars.input.date ?? '2024-01-15',
        amount: vars.input.amount ?? 50,
        tags: (vars.input.tagIds ?? []).map((id: string) => ({ id })),
      },
    },
  };
}

function makeTools(txnIds: string[], responses?: Record<string, unknown>) {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = txnIds.map((id) => ({
    transaction_id: id,
    amount: 50,
    date: '2024-01-15',
    name: `Txn ${id}`,
    category_id: 'food',
    user_note: null,
    item_id: 'item1',
    account_id: 'acct1',
    tag_ids: [],
  }));
  (db as any)._userCategories = [
    { category_id: 'food', name: 'Food' },
    { category_id: 'groceries', name: 'Groceries' },
  ];
  (db as any)._tags = [
    { tag_id: 'tag1', name: 'Important' },
    { tag_id: 'tag2', name: 'Recurring' },
  ];
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();

  const client = createMockGraphQLClient(responses ?? { EditTransaction: echoResponse });
  const tools = new CopilotMoneyTools(db, client);
  return { tools, db, client };
}

describe('update_transactions dispatches one EditTransaction per edit', () => {
  test('each edit carries its own input — different fields on different rows', async () => {
    const { tools, client } = makeTools(['a', 'b', 'c']);

    const result = await tools.updateTransactions({
      edits: [
        { transaction_id: 'a', name: 'Renamed A' },
        { transaction_id: 'b', category_id: 'groceries' },
        { transaction_id: 'c', note: 'a note', reviewed: true },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.updated_count).toBe(3);
    expect(result.failures).toEqual([]);
    expect(client._calls).toHaveLength(3);

    const byId = new Map(client._calls.map((c) => [(c.variables as any).id, c.variables as any]));
    expect(byId.get('a').input).toEqual({ name: 'Renamed A' });
    expect(byId.get('b').input).toEqual({ categoryId: 'groceries' });
    expect(byId.get('c').input).toEqual({ userNotes: 'a note', isReviewed: true });
    // Routing ids resolved from the local cache for every row.
    for (const vars of byId.values()) {
      expect(vars).toMatchObject({ accountId: 'acct1', itemId: 'item1' });
    }
  });

  test('results report per-transaction updated field names in MCP naming', async () => {
    const { tools } = makeTools(['a', 'b']);
    const result = await tools.updateTransactions({
      edits: [
        { transaction_id: 'a', note: 'x' },
        { transaction_id: 'b', tag_ids: ['tag1'] },
      ],
    });

    const byId = new Map(result.results.map((r) => [r.transaction_id, r.updated]));
    expect(byId.get('a')).toEqual(['note']);
    expect(byId.get('b')).toEqual(['tag_ids']);
  });

  test('a 60-edit batch issues exactly 60 calls, one per id', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const { tools, client } = makeTools(ids);

    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, category_id: 'groceries' })),
    });

    expect(result.updated_count).toBe(60);
    expect(client._calls).toHaveLength(60);
    const calledIds = client._calls.map((c) => (c.variables as any).id).sort();
    expect(calledIds).toEqual([...ids].sort());
  });

  test('caller-supplied account_id/item_id bypass local resolution', async () => {
    // Empty cache: resolution would reject these ids. The routing pair on each
    // edit (from a live read) is what makes out-of-window rows writable.
    const { tools, client } = makeTools([]);

    const result = await tools.updateTransactions({
      edits: [
        { transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA', note: 'n1' },
        { transaction_id: 'old-2', account_id: 'acctB', item_id: 'itemB', note: 'n2' },
      ],
    });

    expect(result.updated_count).toBe(2);
    const byId = new Map(client._calls.map((c) => [(c.variables as any).id, c.variables as any]));
    expect(byId.get('old-1')).toMatchObject({ accountId: 'acctA', itemId: 'itemA' });
    expect(byId.get('old-2')).toMatchObject({ accountId: 'acctB', itemId: 'itemB' });
  });

  test('resolved and bypassed rows mix freely in one batch', async () => {
    const { tools, client } = makeTools(['cached-1']);

    const result = await tools.updateTransactions({
      edits: [
        { transaction_id: 'cached-1', note: 'from cache' },
        { transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA', note: 'from live' },
      ],
    });

    expect(result.updated_count).toBe(2);
    const byId = new Map(client._calls.map((c) => [(c.variables as any).id, c.variables as any]));
    expect(byId.get('cached-1')).toMatchObject({ accountId: 'acct1', itemId: 'item1' });
    expect(byId.get('old-1')).toMatchObject({ accountId: 'acctA', itemId: 'itemA' });
  });
});

describe('update_transactions response determinism and error labelling', () => {
  test('results[] comes back in INPUT order, not completion order', async () => {
    // The pool runs 5 wide, so completion order is nondeterministic — without
    // an explicit sort, identical input produces differently-ordered output.
    // Make later entries finish first and assert the response order still
    // matches what the caller sent.
    const ids = Array.from({ length: 10 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const client = {
      mutate: mock((_op: string, _q: string, vars: any) => {
        // Earlier ids resolve slowest, so completion order is reversed.
        const rank = ids.indexOf(vars.id);
        const delay = (ids.length - rank) * 4;
        return new Promise((resolve) => setTimeout(() => resolve(echoResponse(vars)), delay));
      }),
    } as unknown as GraphQLClient;

    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = ids.map((id) => ({
      transaction_id: id,
      amount: 50,
      date: '2024-01-15',
      name: id,
      category_id: 'food',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    }));
    (db as any)._userCategories = [{ category_id: 'food', name: 'Food' }];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, note: 'x' })),
    });

    expect(result.results.map((r) => r.transaction_id)).toEqual(ids);
  });

  test('a bad routing id names the edits[i] row, like every other batch error', async () => {
    const { tools, client } = makeTools(['a', 'b']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', note: 'ok' },
          { transaction_id: 'b', account_id: 'bad/acct', item_id: 'itemA', note: 'x' },
        ],
      })
    ).rejects.toThrow(/edits\[1\]:.*account_id/);
    expect(client._calls).toHaveLength(0);
  });
});

describe('update_transactions validates the whole batch before any write', () => {
  test('a bad field in the LAST edit prevents the FIRST from being written', async () => {
    const { tools, client } = makeTools(['a', 'b', 'c']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', name: 'fine' },
          { transaction_id: 'b', name: 'also fine' },
          { transaction_id: 'c', name: '   ' },
        ],
      })
    ).rejects.toThrow(/update_transactions edits\[2\]: name must not be empty/);

    // The whole point: nothing half-applied.
    expect(client._calls).toHaveLength(0);
  });

  test('unresolvable id anywhere in the batch fails the call before any write', async () => {
    const { tools, client } = makeTools(['a']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', note: 'x' },
          { transaction_id: 'ghost', note: 'y' },
        ],
      })
    ).rejects.toThrow(/Transaction not found: ghost/);
    expect(client._calls).toHaveLength(0);
  });

  test('unknown category anywhere in the batch fails the call before any write', async () => {
    const { tools, client } = makeTools(['a', 'b']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', category_id: 'groceries' },
          { transaction_id: 'b', category_id: 'nonexistent' },
        ],
      })
    ).rejects.toThrow(/Category not found: nonexistent/);
    expect(client._calls).toHaveLength(0);
  });

  test('category_id + INCOME is rejected per-entry, with the index named', async () => {
    const { tools, client } = makeTools(['a', 'b']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', note: 'ok' },
          { transaction_id: 'b', category_id: 'food', type: 'INCOME' },
        ],
      })
    ).rejects.toThrow(/edits\[1\]: category_id cannot be combined with type INCOME/);
    expect(client._calls).toHaveLength(0);
  });

  test('duplicate transaction_id is rejected — concurrent edits to one row would race', async () => {
    const { tools, client } = makeTools(['a']);

    await expect(
      tools.updateTransactions({
        edits: [
          { transaction_id: 'a', note: 'first' },
          { transaction_id: 'a', name: 'second' },
        ],
      })
    ).rejects.toThrow(/duplicate transaction_id a .*combine the edits/);
    expect(client._calls).toHaveLength(0);
  });

  test('an edit with no mutable field is rejected, naming its index', async () => {
    const { tools, client } = makeTools(['a', 'b']);

    await expect(
      tools.updateTransactions({
        edits: [{ transaction_id: 'a', note: 'x' }, { transaction_id: 'b' }],
      })
    ).rejects.toThrow(/edits\[1\] requires at least one field to update/);
    expect(client._calls).toHaveLength(0);
  });

  test('unknown field is rejected, naming its index', async () => {
    const { tools, client } = makeTools(['a']);

    await expect(
      tools.updateTransactions({
        edits: [{ transaction_id: 'a', excluded: true } as any],
      })
    ).rejects.toThrow(/edits\[0\]: unknown field "excluded"/);
    expect(client._calls).toHaveLength(0);
  });

  test('half a routing pair is rejected, naming its index', async () => {
    const { tools, client } = makeTools(['a']);

    await expect(
      tools.updateTransactions({
        edits: [{ transaction_id: 'a', account_id: 'acctA', note: 'x' }],
      })
    ).rejects.toThrow(/edits\[0\]: account_id and item_id must be passed together/);
    expect(client._calls).toHaveLength(0);
  });

  test('empty and oversized batches are rejected', async () => {
    const { tools, client } = makeTools(['a']);

    await expect(tools.updateTransactions({ edits: [] })).rejects.toThrow(
      /edits must be a non-empty array/
    );
    await expect(
      tools.updateTransactions({
        edits: Array.from({ length: 201 }, (_, i) => ({
          transaction_id: `t${i}`,
          note: 'x',
        })),
      })
    ).rejects.toThrow(/exceeds the maximum batch size \(200\): 201/);
    expect(client._calls).toHaveLength(0);
  });
});

describe('update_transactions respects the 5-parallel concurrency cap', () => {
  function makeConcurrencyTrackingClient(delayMs: number): GraphQLClient & {
    _maxConcurrent: number;
    _totalCalls: number;
  } {
    let inflight = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;

    const client = {
      mutate: mock(async (_op: string, _q: string, vars: unknown): Promise<unknown> => {
        inflight++;
        totalCalls++;
        maxConcurrent = Math.max(maxConcurrent, inflight);
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          const v = vars as { id: string; input: Record<string, unknown> };
          const response: EditTransactionResponse = {
            editTransaction: {
              transaction: {
                id: v.id,
                name: 'Coffee Shop',
                categoryId: 'food',
                userNotes: null,
                isReviewed: false,
                type: 'REGULAR',
                date: '2024-01-15',
                amount: 50,
                tags: [],
              },
            },
          };
          return response;
        } finally {
          inflight--;
        }
      }),
      get _maxConcurrent(): number {
        return maxConcurrent;
      },
      get _totalCalls(): number {
        return totalCalls;
      },
    };
    return client as unknown as GraphQLClient & { _maxConcurrent: number; _totalCalls: number };
  }

  test('batch of 20 never exceeds 5 concurrent calls but is genuinely parallel', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = ids.map((id) => ({
      transaction_id: id,
      amount: 50,
      date: '2024-01-15',
      name: id,
      category_id: 'food',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    }));
    (db as any)._userCategories = [{ category_id: 'food', name: 'Food' }];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();

    const client = makeConcurrencyTrackingClient(25);
    const tools = new CopilotMoneyTools(db, client);

    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, note: 'x' })),
    });

    expect(result.updated_count).toBe(20);
    expect(client._totalCalls).toBe(20);
    expect(client._maxConcurrent).toBeLessThanOrEqual(5);
    expect(client._maxConcurrent).toBeGreaterThan(1);
  });
});

describe('update_transactions partial-failure accounting', () => {
  const failOn = (badId: string) => ({
    mutate: mock((_op: string, _q: string, vars: any) => {
      if (vars.id === badId) {
        return Promise.reject(new GraphQLError('USER_ACTION_REQUIRED', 'simulated failure'));
      }
      return Promise.resolve(echoResponse(vars));
    }),
  });

  function toolsWithFailure(ids: string[], badId: string) {
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = ids.map((id) => ({
      transaction_id: id,
      amount: 50,
      date: '2024-01-15',
      name: id,
      category_id: 'food',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    }));
    (db as any)._userCategories = [{ category_id: 'food', name: 'Food' }];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    const client = failOn(badId) as unknown as GraphQLClient;
    return { tools: new CopilotMoneyTools(db, client), db };
  }

  test('default: stops — entries queued behind the failure are never written', async () => {
    // The blast-radius property `continue_on_error: false` actually promises.
    // Without it, a failure at row 3 of a 200-row batch still writes the other
    // 197 against real financial data, while the error message ("failed at X,
    // N/200 succeeded") looks identical to the stopped-early behaviour.
    //
    // Structure: 20 edits, 5-wide pool. Entry 0 rejects immediately; entries
    // 1-4 are slow. By the time a slot frees for entry 5, a failure is on
    // record, so every queued task must become a no-op. Entries 5..19
    // therefore must NEVER reach the wire.
    const ids = Array.from({ length: 20 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const attempted: string[] = [];
    const client = {
      mutate: mock((_op: string, _q: string, vars: any) => {
        attempted.push(vars.id);
        if (vars.id === ids[0]) {
          return Promise.reject(new GraphQLError('USER_ACTION_REQUIRED', 'simulated failure'));
        }
        return new Promise((resolve) => setTimeout(() => resolve(echoResponse(vars)), 25));
      }),
    } as unknown as GraphQLClient;

    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = ids.map((id) => ({
      transaction_id: id,
      amount: 50,
      date: '2024-01-15',
      name: id,
      category_id: 'food',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    }));
    (db as any)._userCategories = [{ category_id: 'food', name: 'Food' }];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();
    const tools = new CopilotMoneyTools(db, client);

    await expect(
      tools.updateTransactions({ edits: ids.map((id) => ({ transaction_id: id, note: 'x' })) })
    ).rejects.toThrow(/update_transactions failed/);

    // The assertion that matters: the tail was never attempted.
    const tail = ids.slice(5);
    const leaked = attempted.filter((id) => tail.includes(id));
    expect(leaked).toEqual([]);
    // And the pool never started more than its width before stopping.
    expect(attempted.length).toBeLessThanOrEqual(5);
  });

  test('default: throws naming the failed id and how many succeeded', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `txn-0${i + 1}`);
    const { tools } = toolsWithFailure(ids, 'txn-05');

    await expect(
      tools.updateTransactions({ edits: ids.map((id) => ({ transaction_id: id, note: 'x' })) })
    ).rejects.toThrow(/update_transactions failed at transaction_id=txn-05 \(\d+\/8 succeeded\)/);
  });

  test('continue_on_error: every edit attempted, failure isolated to its own row', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `txn-0${i + 1}`);
    const { tools } = toolsWithFailure(ids, 'txn-05');

    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, note: 'x' })),
      continue_on_error: true,
    });

    expect(result.success).toBe(false);
    expect(result.updated_count).toBe(7);
    expect(result.results).toHaveLength(7);
    expect(result.results.map((r) => r.transaction_id)).not.toContain('txn-05');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.transaction_id).toBe('txn-05');
    expect(result.failures[0]!.error).toMatch(/simulated failure/);
  });

  test('continue_on_error: a returned failure message has the username redacted', async () => {
    // Returned, not thrown, so it never passes the redaction at handleCallTool's
    // catch. The row's message is redacted where it is built instead.
    const ids = ['txn-01', 'txn-02'];
    const { tools } = toolsWithFailure(ids, 'none');
    const leaked = `${homedir()}/Library/Containers/x/main/000001.ldb`;
    (tools as unknown as { graphqlClient: { mutate: unknown } }).graphqlClient.mutate = mock(
      (_op: string, _q: string, vars: any) =>
        vars.id === 'txn-02'
          ? Promise.reject(new Error(`EACCES: permission denied, open '${leaked}'`))
          : Promise.resolve(echoResponse(vars))
    );
    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, note: 'x' })),
      continue_on_error: true,
    });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain('~/Library/Containers/x/main/000001.ldb');
    expect(result.failures[0]!.error).not.toContain(homedir());
  });

  test('continue_on_error with no failures reports success', async () => {
    const { tools } = makeTools(['a', 'b']);
    const result = await tools.updateTransactions({
      edits: [
        { transaction_id: 'a', note: 'x' },
        { transaction_id: 'b', note: 'y' },
      ],
      continue_on_error: true,
    });
    expect(result.success).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('update_transactions optimistic cache patch', () => {
  test('patches each applied row with its own values', async () => {
    const { tools, db } = makeTools(['a', 'b']);
    const patched: Array<[string, unknown]> = [];
    (db as any).patchCachedTransaction = (id: string, patch: unknown) => {
      patched.push([id, patch]);
    };

    await tools.updateTransactions({
      edits: [
        { transaction_id: 'a', name: 'Renamed A' },
        { transaction_id: 'b', note: 'note B', reviewed: true },
      ],
    });

    const byId = new Map(patched);
    expect(byId.get('a')).toEqual({ name: 'Renamed A' });
    expect(byId.get('b')).toEqual({ user_note: 'note B', user_reviewed: true });
  });

  test('INCOME/INTERNAL_TRANSFER mirrors the server-side category clear', async () => {
    const { tools, db } = makeTools(['a']);
    const patched: Array<[string, any]> = [];
    (db as any).patchCachedTransaction = (id: string, patch: any) => {
      patched.push([id, patch]);
    };

    await tools.updateTransactions({
      edits: [{ transaction_id: 'a', type: 'INTERNAL_TRANSFER' }],
    });

    expect(patched).toHaveLength(1);
    expect(patched[0]![1].category_id).toBe('');
  });

  test('only rows that actually landed are patched', async () => {
    const ids = ['t1', 't2', 't3'];
    const db = new CopilotDatabase('/nonexistent');
    (db as any).dbPath = '/fake';
    (db as any)._transactions = ids.map((id) => ({
      transaction_id: id,
      amount: 50,
      date: '2024-01-15',
      name: id,
      category_id: 'food',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    }));
    (db as any)._userCategories = [{ category_id: 'food', name: 'Food' }];
    (db as any)._tags = [];
    (db as any)._allCollectionsLoaded = true;
    (db as any)._cacheLoadedAt = Date.now();

    const patched: string[] = [];
    (db as any).patchCachedTransaction = (id: string) => {
      patched.push(id);
    };

    const client = {
      mutate: mock((_op: string, _q: string, vars: any) => {
        if (vars.id === 't2') {
          return Promise.reject(new GraphQLError('USER_ACTION_REQUIRED', 'nope'));
        }
        return Promise.resolve(echoResponse(vars));
      }),
    } as unknown as GraphQLClient;

    const tools = new CopilotMoneyTools(db, client);
    const result = await tools.updateTransactions({
      edits: ids.map((id) => ({ transaction_id: id, note: 'x' })),
      continue_on_error: true,
    });

    expect(result.updated_count).toBe(2);
    // The failed row must not be patched — a cache claiming a write that
    // never landed is worse than a stale cache.
    expect(patched.sort()).toEqual(['t1', 't3']);
  });
});
