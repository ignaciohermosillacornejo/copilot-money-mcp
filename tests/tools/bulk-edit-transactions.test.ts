/**
 * Unit tests for the bulk_edit_transactions tool.
 *
 * The tool wraps Copilot's native bulk mutation, whose server-side behaviour is
 * unusually permissive. Three probe-verified facts drive most of what is
 * asserted here, and each one is a way the tool could silently corrupt data if
 * the guard were removed:
 *
 *  1. `filter` is NULLABLE server-side, and TransactionFilter also accepts
 *     dates/categoryIds/isReviewed/types. A call that sent anything but `ids`
 *     — or no filter at all — would apply the edit to an unbounded row set.
 *  2. The server performs NO referential validation: an unknown categoryId is
 *     persisted verbatim as a dangling reference, and an unknown tag id is
 *     silently dropped. Client-side validation is the only guard.
 *  3. An unknown transaction id is silently omitted from the row set — it does
 *     NOT error and does NOT appear in `failed[]`. Only a diff of `updated[]`
 *     against the requested ids catches a batch that half-applied.
 */

import { describe, test, expect } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { createMockGraphQLClient, bulkEditEcho } from '../helpers/mock-graphql.js';
import { GraphQLError } from '../../src/core/graphql/client.js';

function makeTools(txnIds: string[], responses?: Parameters<typeof createMockGraphQLClient>[0]) {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = txnIds.map((id) => ({
    transaction_id: id,
    amount: 50,
    date: '2024-01-15',
    name: `Txn ${id}`,
    category_id: 'food',
    item_id: 'item1',
    account_id: 'acct1',
    tag_ids: [],
  }));
  (db as any)._userCategories = [
    { category_id: 'food', name: 'Food' },
    { category_id: 'groceries', name: 'Groceries' },
  ];
  (db as any)._tags = [
    { tag_id: 'tag1', name: 'Trip' },
    { tag_id: 'tag2', name: 'Work' },
  ];
  (db as any)._allCollectionsLoaded = true;
  (db as any)._cacheLoadedAt = Date.now();

  const client = createMockGraphQLClient(responses ?? { BulkEditTransactions: bulkEditEcho });
  const tools = new CopilotMoneyTools(db, client);
  return { tools, db, client };
}

describe('bulk_edit_transactions sends one scoped request', () => {
  test('one call, all ids in filter.ids, one shared input', async () => {
    const { tools, client } = makeTools(['a', 'b', 'c']);

    const result = await tools.bulkEditTransactions({
      transaction_ids: ['a', 'b', 'c'],
      category_id: 'groceries',
    });

    expect(result.success).toBe(true);
    expect(result.updated_count).toBe(3);
    expect(result.applied).toEqual(['category_id']);
    expect(client._calls).toHaveLength(1);
    expect(client._calls[0]!.op).toBe('BulkEditTransactions');
    expect(client._calls[0]!.variables).toEqual({
      input: { categoryId: 'groceries' },
      filter: {
        ids: [
          { id: 'a', accountId: 'acct1', itemId: 'item1' },
          { id: 'b', accountId: 'acct1', itemId: 'item1' },
          { id: 'c', accountId: 'acct1', itemId: 'item1' },
        ],
      },
    });
  });

  test('filter carries ONLY ids — never a widening key', async () => {
    const { tools, client } = makeTools(['a']);
    await tools.bulkEditTransactions({ transaction_ids: ['a'], reviewed: true });
    const vars = client._calls[0]!.variables as { filter: Record<string, unknown> };
    expect(Object.keys(vars.filter)).toEqual(['ids']);
  });

  test('every supported field maps to its GraphQL name', async () => {
    const { tools, client } = makeTools(['a']);

    await tools.bulkEditTransactions({
      transaction_ids: ['a'],
      category_id: 'groceries',
      reviewed: true,
      add_tag_ids: ['tag1'],
      remove_tag_ids: ['tag2'],
    });

    const vars = client._calls[0]!.variables as { input: Record<string, unknown> };
    expect(vars.input).toEqual({
      categoryId: 'groceries',
      isReviewed: true,
      addTagIds: ['tag1'],
      removeTagIds: ['tag2'],
    });
  });

  test('rows mode passes caller-supplied routing through unresolved', async () => {
    const { tools, client } = makeTools([]); // empty cache: resolution would fail

    const result = await tools.bulkEditTransactions({
      rows: [
        { transaction_id: 'old-1', account_id: 'acctA', item_id: 'itemA' },
        { transaction_id: 'old-2', account_id: 'acctB', item_id: 'itemB' },
      ],
      reviewed: true,
    });

    expect(result.updated_count).toBe(2);
    const vars = client._calls[0]!.variables as { filter: { ids: unknown[] } };
    expect(vars.filter.ids).toEqual([
      { id: 'old-1', accountId: 'acctA', itemId: 'itemA' },
      { id: 'old-2', accountId: 'acctB', itemId: 'itemB' },
    ]);
  });
});

describe('bulk_edit_transactions validates before writing', () => {
  test('rejects a batch with no editable field, naming what bulk cannot do', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(tools.bulkEditTransactions({ transaction_ids: ['a'] })).rejects.toThrow(
      /requires at least one of.*name, date, amount and note are NOT/s
    );
    expect(client._calls).toHaveLength(0);
  });

  test('unknown category is rejected client-side — the server would persist it', async () => {
    // Verified live: Copilot accepts a nonexistent categoryId verbatim and
    // writes a dangling reference on every targeted row. This check is the
    // only thing preventing that.
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a'], category_id: 'nonexistent' })
    ).rejects.toThrow(/Category not found: nonexistent/);
    expect(client._calls).toHaveLength(0);
  });

  test('unknown tag ids are rejected client-side — the server would drop them', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a'], add_tag_ids: ['ghost'] })
    ).rejects.toThrow(/Tag/i);
    expect(client._calls).toHaveLength(0);
  });

  test('category_id + INCOME is rejected (server would clear the category)', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({
        transaction_ids: ['a'],
        category_id: 'groceries',
        type: 'INCOME',
      })
    ).rejects.toThrow(/cannot be combined with type INCOME/);
    expect(client._calls).toHaveLength(0);
  });

  test('a tag in both add and remove is rejected as ambiguous', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({
        transaction_ids: ['a'],
        add_tag_ids: ['tag1'],
        remove_tag_ids: ['tag1'],
      })
    ).rejects.toThrow(/appear in both add_tag_ids and remove_tag_ids/);
    expect(client._calls).toHaveLength(0);
  });

  test('invalid type is rejected', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a'], type: 'BOGUS' as never })
    ).rejects.toThrow(/type must be one of/);
    expect(client._calls).toHaveLength(0);
  });

  test('empty tag arrays are rejected rather than sent as no-ops', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a'], add_tag_ids: [] })
    ).rejects.toThrow(/add_tag_ids must be a non-empty array/);
    expect(client._calls).toHaveLength(0);
  });

  test('duplicate transaction_id is rejected', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a', 'a'], reviewed: true })
    ).rejects.toThrow(/duplicate transaction_id a/);
    expect(client._calls).toHaveLength(0);
  });

  test('a batch over the cap is rejected before any write', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      transaction_id: `t${String(i).padStart(4, '0')}`,
      account_id: 'acctA',
      item_id: 'itemA',
    }));
    const { tools, client } = makeTools([]);
    await expect(tools.bulkEditTransactions({ rows, reviewed: true })).rejects.toThrow(
      /exceeds the maximum of 500/
    );
    expect(client._calls).toHaveLength(0);
  });

  test('an unresolvable id fails the call before any write', async () => {
    const { tools, client } = makeTools(['a']);
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a', 'ghost'], reviewed: true })
    ).rejects.toThrow(/Transaction not found: ghost/);
    expect(client._calls).toHaveLength(0);
  });
});

describe('bulk_edit_transactions surfaces partial application', () => {
  test('a silently-skipped id fails the call', async () => {
    const { tools } = makeTools(['a', 'b'], {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [
            {
              id: 'a',
              name: 'n',
              categoryId: 'groceries',
              userNotes: null,
              isReviewed: true,
              type: 'REGULAR',
              date: '2024-01-15',
              amount: 50,
              tags: [],
            },
          ],
          failed: [],
        },
      },
    });

    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a', 'b'], reviewed: true })
    ).rejects.toThrow(/did not apply 1 transaction\(s\)[\s\S]*\bb\b/);
  });

  test('a failed[] entry throws, naming the row and its errorCode', async () => {
    const { tools } = makeTools(['a', 'b'], {
      BulkEditTransactions: {
        bulkEditTransactions: {
          updated: [],
          failed: [
            { transaction: { id: 'a' }, error: 'denied', errorCode: 'SOME_CODE' },
            { transaction: { id: 'b' }, error: null, errorCode: 'OTHER_CODE' },
          ],
        },
      },
    });

    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a', 'b'], reviewed: true })
    ).rejects.toThrow(/rejected 2 of 2[\s\S]*a: SOME_CODE denied[\s\S]*b: OTHER_CODE/);
  });

  test('GraphQL errors are mapped to the MCP error string', async () => {
    const { tools } = makeTools(['a'], {
      BulkEditTransactions: new GraphQLError('USER_ACTION_REQUIRED', 'session expired'),
    });
    await expect(
      tools.bulkEditTransactions({ transaction_ids: ['a'], reviewed: true })
    ).rejects.toThrow(/bulk_edit_transactions failed/);
  });
});

describe('bulk_edit_transactions optimistic cache patch', () => {
  test('patches confirmed rows with category and reviewed', async () => {
    const { tools, db } = makeTools(['a', 'b']);
    const patched: Array<[string, any]> = [];
    (db as any).patchCachedTransaction = (id: string, patch: any) => patched.push([id, patch]);

    await tools.bulkEditTransactions({
      transaction_ids: ['a', 'b'],
      category_id: 'groceries',
      reviewed: true,
    });

    expect(patched.map(([id]) => id).sort()).toEqual(['a', 'b']);
    expect(patched[0]![1]).toMatchObject({ category_id: 'groceries', user_reviewed: true });
  });

  test('INCOME mirrors the server-side category clear', async () => {
    const { tools, db } = makeTools(['a']);
    const patched: Array<[string, any]> = [];
    (db as any).patchCachedTransaction = (id: string, patch: any) => patched.push([id, patch]);

    await tools.bulkEditTransactions({ transaction_ids: ['a'], type: 'INCOME' });

    expect(patched).toHaveLength(1);
    expect(patched[0]![1].category_id).toBe('');
  });

  test('tag edits mirror the tag list the SERVER returned, not a local recompute', async () => {
    // addTagIds is additive server-side; the authoritative post-edit tag list
    // comes back in updated[].tags, so the cache copies that rather than
    // guessing at the union.
    const { tools, db } = makeTools(['a']);
    const patched: Array<[string, any]> = [];
    (db as any).patchCachedTransaction = (id: string, patch: any) => patched.push([id, patch]);

    await tools.bulkEditTransactions({ transaction_ids: ['a'], add_tag_ids: ['tag1'] });

    expect(patched[0]![1].tag_ids).toEqual(['tag1']);
  });
});
