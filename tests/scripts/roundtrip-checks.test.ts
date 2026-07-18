/**
 * Unit tests for the Tier-2 round-trip suite plumbing (issue #438).
 *
 * Mock-only — no auth, no network, no mutations. The live behavior of the
 * suite is exercised exclusively by the maintainer's attended
 * `bun run smoke:roundtrip`; these tests cover the pure helpers (cleanup
 * registry, arg parsing, residue detection, budget resolution) and — via a
 * stubbed GraphQLClient — the two properties the design hangs on:
 *
 * 1. verification is RE-READ-based: a write whose echo succeeds but whose
 *    re-read does not reflect the value FAILS the check;
 * 2. set→revert checks restore the captured original value even when
 *    verification fails mid-flight.
 */

import { describe, test, expect } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import {
  ROUNDTRIP_CHECKS,
  CleanupRegistry,
  budgetAmountForMonth,
  collectResidue,
  formatPlan,
  isResidueName,
  makeMarker,
  parseRoundtripArgs,
  type ResidueReaders,
  type RoundtripContext,
} from '../../scripts/smoke/roundtrip-checks.js';

// ---------------------------------------------------------------------------
// Stub GraphQL client
// ---------------------------------------------------------------------------

interface RecordedCall {
  kind: 'mutate' | 'query';
  operationName: string;
  variables: unknown;
}

/**
 * Dispatches by operation name to canned handlers. Records every call so
 * tests can assert which mutations were sent (and with what variables).
 */
function stubClient(handlers: Record<string, (variables: unknown) => unknown>): {
  client: GraphQLClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const dispatch = (kind: 'mutate' | 'query') => {
    return (operationName: string, _query: string, variables: unknown): Promise<unknown> => {
      calls.push({ kind, operationName, variables });
      const handler = handlers[operationName];
      if (!handler) {
        return Promise.reject(new Error(`stubClient: no handler for ${operationName}`));
      }
      return Promise.resolve(handler(variables));
    };
  };
  const client = { mutate: dispatch('mutate'), query: dispatch('query') };
  return { client: client as unknown as GraphQLClient, calls };
}

function makeContext(client: GraphQLClient): RoundtripContext {
  return {
    client,
    state: { marker: makeMarker(1700000000000) },
    registry: new CleanupRegistry(),
    log: () => undefined,
  };
}

function getCheck(tool: string) {
  const check = ROUNDTRIP_CHECKS.find((candidate) => candidate.tool === tool);
  if (!check) throw new Error(`no round-trip check for ${tool}`);
  return check;
}

function transactionsPage(nodes: unknown[]): unknown {
  return {
    transactions: {
      edges: nodes.map((node, i) => ({ cursor: `c${i}`, node })),
      pageInfo: { endCursor: null, hasNextPage: false },
    },
  };
}

// ---------------------------------------------------------------------------
// CleanupRegistry
// ---------------------------------------------------------------------------

describe('CleanupRegistry', () => {
  test('runAll deletes LIFO (dependents before dependencies)', async () => {
    const registry = new CleanupRegistry();
    const order: string[] = [];
    for (const id of ['first', 'second', 'third']) {
      registry.add({
        kind: 'tag',
        id,
        label: id,
        cleanup: () => {
          order.push(id);
          return Promise.resolve();
        },
      });
    }
    const failures = await registry.runAll(() => undefined);
    expect(failures).toEqual([]);
    expect(order).toEqual(['third', 'second', 'first']);
    expect(registry.pending).toEqual([]);
  });

  test('remove() deregisters an explicitly-deleted object', async () => {
    const registry = new CleanupRegistry();
    const deleted: string[] = [];
    for (const id of ['keep', 'gone']) {
      registry.add({
        kind: 'transaction',
        id,
        label: id,
        cleanup: () => {
          deleted.push(id);
          return Promise.resolve();
        },
      });
    }
    registry.remove('gone');
    expect(registry.pending.map((item) => item.id)).toEqual(['keep']);
    await registry.runAll(() => undefined);
    expect(deleted).toEqual(['keep']);
  });

  test('runAll never throws: failures are collected with id + label and the rest still runs', async () => {
    const registry = new CleanupRegistry();
    const deleted: string[] = [];
    registry.add({
      kind: 'category',
      id: 'cat-1',
      label: '__smoke__1-cat',
      cleanup: () => {
        deleted.push('cat-1');
        return Promise.resolve();
      },
    });
    registry.add({
      kind: 'recurring',
      id: 'rec-1',
      label: '__smoke__1-rec',
      cleanup: () => Promise.reject(new Error('server said no')),
    });
    const failures = await registry.runAll(() => undefined);
    expect(failures).toEqual([
      { kind: 'recurring', id: 'rec-1', label: '__smoke__1-rec', error: 'server said no' },
    ]);
    expect(deleted).toEqual(['cat-1']);
  });
});

// ---------------------------------------------------------------------------
// Arg parsing + plan
// ---------------------------------------------------------------------------

describe('parseRoundtripArgs', () => {
  test('defaults: full mutating run', () => {
    expect(parseRoundtripArgs([])).toEqual({ list: false });
  });

  test('--list and --only combine', () => {
    expect(parseRoundtripArgs(['--list'])).toEqual({ list: true });
    expect(parseRoundtripArgs(['--only', 'tags'])).toEqual({ list: false, only: 'tags' });
    expect(parseRoundtripArgs(['--list', '--only', 'recurring'])).toEqual({
      list: true,
      only: 'recurring',
    });
  });

  test('rejects unknown domains and unknown flags', () => {
    expect(() => parseRoundtripArgs(['--only', 'accounts'])).toThrow(/--only requires one of/);
    expect(() => parseRoundtripArgs(['--only'])).toThrow(/--only requires one of/);
    expect(() => parseRoundtripArgs(['--nuke'])).toThrow(/unknown argument/);
  });
});

describe('formatPlan', () => {
  test('lists every check with its tool, domain, and flow', () => {
    const plan = formatPlan(ROUNDTRIP_CHECKS);
    expect(plan).toContain(`${ROUNDTRIP_CHECKS.length} round-trips`);
    for (const check of ROUNDTRIP_CHECKS) {
      expect(plan).toContain(check.tool);
    }
  });
});

// ---------------------------------------------------------------------------
// Residue detection
// ---------------------------------------------------------------------------

describe('residue detection', () => {
  test('isResidueName: marker matches everywhere; bare "smoke" only for recurrings', () => {
    expect(isResidueName('tag', '__smoke__1700000000000-tag')).toBe(true);
    expect(isResidueName('transaction', 'prefix __smoke__1 suffix')).toBe(true);
    expect(isResidueName('tag', 'Groceries')).toBe(false);
    // Server-derived recurring names may have lost the raw marker.
    expect(isResidueName('recurring', 'Smoke 1700000000000 Txn A')).toBe(true);
    expect(isResidueName('recurring', 'Smokehouse BBQ')).toBe(false);
    expect(isResidueName('transaction', 'Smoke 1700000000000 Txn A')).toBe(false);
    // Documented approximation: a standalone "smoke" word in a REAL
    // recurring name false-positives, making the pre-flight refuse to
    // start — the safe direction for an attended gate (see
    // RECURRING_RESIDUE_RE in roundtrip-checks.ts).
    expect(isResidueName('recurring', "Smoke's BBQ")).toBe(true);
    expect(isResidueName('recurring', 'Smoke Shop')).toBe(true);
  });

  test('collectResidue reads all four collections and keeps only marker hits', async () => {
    const readers: ResidueReaders = {
      tags: () =>
        Promise.resolve([
          { id: 't1', name: 'vacation' },
          { id: 't2', name: '__smoke__1-tag' },
        ]),
      categories: () => Promise.resolve([{ id: 'c1', name: 'Groceries' }]),
      recurrings: () => Promise.resolve([{ id: 'r1', name: 'Smoke 1 Txn A' }]),
      transactions: () => Promise.resolve([{ id: 'x1', name: '__smoke__1-txn-a' }]),
    };
    const residue = await collectResidue(readers);
    expect(residue).toEqual([
      { kind: 'tag', id: 't2', name: '__smoke__1-tag' },
      { kind: 'recurring', id: 'r1', name: 'Smoke 1 Txn A' },
      { kind: 'transaction', id: 'x1', name: '__smoke__1-txn-a' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// budgetAmountForMonth
// ---------------------------------------------------------------------------

describe('budgetAmountForMonth', () => {
  const monthly = (month: string, amount: number | null, resolvedAmount: number | null) => ({
    unassignedRolloverAmount: null,
    childRolloverAmount: null,
    unassignedAmount: null,
    resolvedAmount,
    rolloverAmount: null,
    childAmount: null,
    goalAmount: null,
    amount,
    month,
    id: `b-${month}`,
  });

  test('resolves from current, preferring amount over resolvedAmount', () => {
    const budget = { current: monthly('2026-06', 200, 150), histories: [] };
    expect(budgetAmountForMonth(budget, '2026-06')).toBe(200);
  });

  test('falls back to resolvedAmount, then to histories, and tolerates day-suffixed months', () => {
    const budget = {
      current: monthly('2026-06-01', null, 100),
      histories: [monthly('2026-05', 200, null)],
    };
    expect(budgetAmountForMonth(budget, '2026-06')).toBe(100);
    expect(budgetAmountForMonth(budget, '2026-05')).toBe(200);
  });

  test('returns undefined for missing budget, missing month, or unparseable amounts', () => {
    expect(budgetAmountForMonth(null, '2026-06')).toBeUndefined();
    expect(budgetAmountForMonth(undefined, '2026-06')).toBeUndefined();
    const budget = { current: monthly('2026-06', null, null), histories: [] };
    expect(budgetAmountForMonth(budget, '2026-06')).toBeUndefined();
    expect(budgetAmountForMonth(budget, '2026-07')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Re-read-based verification (the accepted-but-ignored detector)
// ---------------------------------------------------------------------------

describe('create_tag check (stubbed client)', () => {
  const created = { id: 'tag-1', name: '__smoke__1700000000000-tag', colorName: 'BLUE1' };

  test('PASSES when the Tags re-read reflects the created tag, and registers cleanup', async () => {
    const { client } = stubClient({
      CreateTag: () => ({ createTag: created }),
      Tags: () => ({ tags: [{ id: 'other', name: 'vacation', colorName: 'RED1' }, created] }),
    });
    const ctx = makeContext(client);
    const outcome = await getCheck('create_tag').run(ctx);
    expect(outcome).toBeUndefined();
    expect(ctx.registry.pending).toEqual([
      { kind: 'tag', id: 'tag-1', label: '__smoke__1700000000000-tag' },
    ]);
  });

  test('FAILS when the mutation echo succeeds but the re-read does not contain the tag', async () => {
    const { client } = stubClient({
      CreateTag: () => ({ createTag: created }),
      Tags: () => ({ tags: [] }), // write accepted but ignored
    });
    const ctx = makeContext(client);
    await expect(getCheck('create_tag').run(ctx)).rejects.toThrow(/missing from Tags re-read/);
  });

  test('FAILS when the re-read shows the tag with a different value than written', async () => {
    const { client } = stubClient({
      CreateTag: () => ({ createTag: created }),
      Tags: () => ({ tags: [{ ...created, colorName: 'GRAY1' }] }),
    });
    const ctx = makeContext(client);
    await expect(getCheck('create_tag').run(ctx)).rejects.toThrow(/colorName/);
  });
});

describe('review_transactions check (stubbed client)', () => {
  const txnNode = (isReviewed: boolean) => ({
    id: 'txn-1',
    accountId: 'acct-1',
    itemId: 'item-1',
    categoryId: 'cat-1',
    recurringId: null,
    parentId: null,
    isReviewed,
    isPending: false,
    amount: 100,
    date: '2026-06-11',
    name: '__smoke__1700000000000-txn-a',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: null,
    createdAt: 0,
    tags: [],
    goal: null,
  });

  const editEcho = (isReviewed: boolean) => ({
    editTransaction: {
      transaction: {
        id: 'txn-1',
        name: '__smoke__1700000000000-txn-a',
        categoryId: 'cat-1',
        userNotes: null,
        isReviewed,
        tags: [],
      },
    },
  });

  function contextWithTxnA(client: GraphQLClient): RoundtripContext {
    const ctx = makeContext(client);
    ctx.state.txnA = { id: 'txn-1', accountId: 'acct-1', itemId: 'item-1' };
    return ctx;
  }

  test('flips isReviewed, verifies via re-read, and restores the original', async () => {
    let serverReviewed = false;
    const { client, calls } = stubClient({
      Transactions: () => transactionsPage([txnNode(serverReviewed)]),
      EditTransaction: (variables) => {
        const input = (variables as { input: { isReviewed: boolean } }).input;
        serverReviewed = input.isReviewed;
        return editEcho(serverReviewed);
      },
    });
    const ctx = contextWithTxnA(client);
    const outcome = await getCheck('review_transactions').run(ctx);
    expect(outcome).toBeUndefined();
    const edits = calls.filter((call) => call.operationName === 'EditTransaction');
    expect(edits.length).toBe(2); // flip + restore
    expect((edits[1]!.variables as { input: { isReviewed: boolean } }).input.isReviewed).toBe(
      false
    ); // original captured BEFORE mutating
    expect(serverReviewed).toBe(false);
  });

  test('FAILS when the write is echoed but the re-read never reflects it — and STILL restores the original', async () => {
    const { client, calls } = stubClient({
      // Server always reports the original value: accepted-but-ignored write.
      Transactions: () => transactionsPage([txnNode(false)]),
      EditTransaction: () => editEcho(true),
    });
    const ctx = contextWithTxnA(client);
    await expect(getCheck('review_transactions').run(ctx)).rejects.toThrow(
      /write accepted but re-read isReviewed/
    );
    const edits = calls.filter((call) => call.operationName === 'EditTransaction');
    expect(edits.length).toBe(2); // flip + restore, despite the failure
    expect((edits[1]!.variables as { input: { isReviewed: boolean } }).input.isReviewed).toBe(
      false
    );
  });

  test('skips when no run-created transaction exists (never touches user data)', async () => {
    const { client, calls } = stubClient({});
    const ctx = makeContext(client); // no txnA, and no handlers: any call would throw
    const outcome = await getCheck('review_transactions').run(ctx);
    expect(outcome?.skipped).toMatch(/no run-created transaction/);
    expect(calls).toEqual([]);
  });
});

describe('set_recurring_state check (stubbed client)', () => {
  const recurringNode = (state: string) => ({
    id: 'rec-1',
    name: '__smoke__1700000000000-recurring',
    state,
    frequency: 'MONTHLY',
    nextPaymentAmount: null,
    nextPaymentDate: null,
    categoryId: null,
    emoji: null,
    icon: null,
    rule: null,
    payments: [],
  });

  const editEcho = (state: string) => ({
    editRecurring: {
      recurring: {
        id: 'rec-1',
        name: '__smoke__1700000000000-recurring',
        categoryId: 'cat-1',
        frequency: 'MONTHLY',
        state,
      },
    },
  });

  test('flips ACTIVE→PAUSED, verifies via re-read, and restores the original', async () => {
    let serverState = 'ACTIVE';
    const { client, calls } = stubClient({
      Recurrings: () => ({ recurrings: [recurringNode(serverState)] }),
      EditRecurring: (variables) => {
        serverState = (variables as { input: { state: string } }).input.state;
        return editEcho(serverState);
      },
    });
    const ctx = makeContext(client);
    ctx.state.recurringId = 'rec-1';
    const outcome = await getCheck('set_recurring_state').run(ctx);
    expect(outcome).toBeUndefined();
    const edits = calls.filter((call) => call.operationName === 'EditRecurring');
    expect(edits.length).toBe(2); // flip + restore
    expect((edits[0]!.variables as { input: { state: string } }).input.state).toBe('PAUSED');
    expect((edits[1]!.variables as { input: { state: string } }).input.state).toBe('ACTIVE');
    expect(serverState).toBe('ACTIVE');
  });

  test('FAILS when the write is echoed but the re-read never reflects it — and STILL restores the original', async () => {
    const { client, calls } = stubClient({
      // Server always reports the original state: accepted-but-ignored write.
      Recurrings: () => ({ recurrings: [recurringNode('ACTIVE')] }),
      EditRecurring: () => editEcho('PAUSED'),
    });
    const ctx = makeContext(client);
    ctx.state.recurringId = 'rec-1';
    await expect(getCheck('set_recurring_state').run(ctx)).rejects.toThrow(
      /write accepted but re-read state/
    );
    const edits = calls.filter((call) => call.operationName === 'EditRecurring');
    expect(edits.length).toBe(2); // flip + restore, despite the failure
    expect((edits[1]!.variables as { input: { state: string } }).input.state).toBe('ACTIVE');
  });
});

describe('delete_transaction check (stubbed client)', () => {
  test('verifies absence via re-read and deregisters from cleanup', async () => {
    const { client } = stubClient({
      DeleteTransaction: () => ({ deleteTransaction: true }),
      Transactions: () => transactionsPage([]),
    });
    const ctx = makeContext(client);
    ctx.state.txnA = { id: 'txn-1', accountId: 'acct-1', itemId: 'item-1' };
    ctx.registry.add({
      kind: 'transaction',
      id: 'txn-1',
      label: 'x',
      cleanup: () => Promise.resolve(),
    });
    const outcome = await getCheck('delete_transaction').run(ctx);
    expect(outcome).toBeUndefined();
    expect(ctx.registry.pending).toEqual([]);
    expect(ctx.state.txnA).toBeUndefined();
  });

  test('FAILS when the delete is echoed true but the transaction is still readable', async () => {
    // Node must pass stripInvalidTransactionNodes (Task 1, #512) so it survives
    // the re-read and triggers the "still present" detection.
    const node = {
      id: 'txn-1',
      accountId: 'acct-1',
      itemId: 'item-1',
      date: '2023-11-14',
      name: '__smoke__1700000000000-txn-a',
      parentId: null,
      amount: 100,
      categoryId: null,
      recurringId: null,
      isReviewed: false,
      isPending: false,
      type: 'REGULAR',
      userNotes: null,
      tipAmount: null,
      suggestedCategoryIds: [],
      isoCurrencyCode: null,
      createdAt: 1700000000000,
      tags: [],
      goal: null,
    };
    const { client } = stubClient({
      DeleteTransaction: () => ({ deleteTransaction: true }),
      Transactions: () => transactionsPage([node]),
    });
    const ctx = makeContext(client);
    ctx.state.txnA = { id: 'txn-1', accountId: 'acct-1', itemId: 'item-1' };
    await expect(getCheck('delete_transaction').run(ctx)).rejects.toThrow(
      /still present on re-read/
    );
  });
});
