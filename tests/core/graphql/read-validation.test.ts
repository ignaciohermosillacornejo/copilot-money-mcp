/**
 * Read-shape validation for Transactions pages (#512, warn-and-skip).
 * Invalid nodes are stripped at the page boundary; valid nodes pass through
 * unchanged; warnings dedupe per (op, failed-field set).
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  invalidMutationRowFields,
  MUTATION_ROW_DATE_ECHO_SURFACE,
  isUsableMutationTransactionRow,
  MUTATION_ROW_READ_SCHEMA_SURFACE,
  stripInvalidTransactionNodes,
  warnMutationRowMisdated,
  warnMutationRowRefused,
  warnReadShapeDrift,
  __resetReadShapeWarnDedupe,
} from '../../../src/core/graphql/read-validation.js';
import {
  fetchTransactionsPage,
  type TransactionsPage,
  type TransactionNode,
} from '../../../src/core/graphql/queries/transactions.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function goodNode(id: string, extra?: Record<string, unknown>): TransactionNode {
  return {
    id,
    accountId: 'acct-1',
    itemId: 'item-1',
    categoryId: 'c1',
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    date: '2025-01-15',
    name: `tx-${id}`,
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: null,
    createdAt: 1,
    tags: [],
    goal: null,
    ...(extra ?? {}),
  } as TransactionNode;
}

function page(nodes: TransactionNode[]): TransactionsPage {
  return {
    edges: nodes.map((n) => ({ cursor: `c-${n.id}`, node: n })),
    pageInfo: { endCursor: null, hasNextPage: false },
  };
}

beforeEach(() => __resetReadShapeWarnDedupe());

describe('stripInvalidTransactionNodes', () => {
  test('clean page passes through with identical nodes and pageInfo', () => {
    const n1 = goodNode('t1');
    const input = page([n1, goodNode('t2')]);
    const drops: unknown[] = [];
    const out = stripInvalidTransactionNodes(input, (i) => drops.push(i));
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0]!.node).toBe(n1); // original object, untransformed
    expect(out.pageInfo).toEqual(input.pageInfo);
    expect(drops).toHaveLength(0);
  });

  test.each([
    ['empty accountId', { accountId: '' }, 'accountId'],
    ['missing itemId', { itemId: undefined as unknown as string }, 'itemId'],
    ['malformed date', { date: '2025-1-5' }, 'date'],
    // Well-formed but not a calendar day: one definition of a usable date for
    // reads and for the rows writes return (#874).
    ['impossible calendar date', { date: '2025-02-30' }, 'date'],
    ['non-finite amount', { amount: Number.NaN }, 'amount'],
    ['non-string name', { name: 42 as unknown as string }, 'name'],
  ])('drops node with %s and reports the field', (_label, patch, field) => {
    const bad = goodNode('bad', patch);
    const drops: Array<{ id: string | null; fields: string[] }> = [];
    const out = stripInvalidTransactionNodes(page([goodNode('ok'), bad]), (i) => drops.push(i));
    expect(out.edges.map((e) => e.node.id)).toEqual(['ok']);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.id).toBe('bad');
    expect(drops[0]!.fields).toContain(field);
  });

  test('unknown extra fields never fail a node; new type enum values pass', () => {
    const weird = goodNode('t3', { some_future_field: { nested: true }, type: 'FUTURE_TYPE' });
    const out = stripInvalidTransactionNodes(page([weird]));
    expect(out.edges).toHaveLength(1);
  });

  test('node with unreadable id reports id: null', () => {
    const bad = goodNode('x', { id: '' });
    const drops: Array<{ id: string | null }> = [];
    stripInvalidTransactionNodes(page([bad]), (i) => drops.push(i));
    expect(drops[0]!.id).toBe(null);
  });
});

describe('warnReadShapeDrift dedupe', () => {
  test('identical (op, field-set) warns once; different set warns again', () => {
    const spy = mock();
    const orig = console.warn;
    console.warn = spy as unknown as typeof console.warn;
    try {
      warnReadShapeDrift('Transactions', { id: 'a', fields: ['accountId'] });
      warnReadShapeDrift('Transactions', { id: 'b', fields: ['accountId'] });
      warnReadShapeDrift('Transactions', { id: 'c', fields: ['date'] });
      expect(spy).toHaveBeenCalledTimes(2);
      const first = String(spy.mock.calls[0]![0]);
      expect(first).toContain('Transactions');
      expect(first).toContain('accountId');
      expect(first).toContain('Query.transactions:response');
    } finally {
      console.warn = orig;
    }
  });
});

describe('invalidMutationRowFields', () => {
  /** A row as a mutation returns it: no parentId, isoCurrencyCode or routing needed. */
  function mutationRow(extra?: Record<string, unknown>): Record<string, unknown> {
    const {
      parentId: _p,
      isoCurrencyCode: _c,
      accountId: _a,
      itemId: _i,
      ...rest
    } = goodNode('aB3xK9pQ2mN7vR4tY8wZ');
    return { ...rest, ...extra };
  }

  test('a well-formed mutation row has no invalid fields', () => {
    expect(invalidMutationRowFields(mutationRow())).toEqual([]);
    expect(isUsableMutationTransactionRow(mutationRow())).toBe(true);
  });

  test('names every top-level field that failed, once each', () => {
    const fields = invalidMutationRowFields(
      mutationRow({ name: undefined, tags: [{}, {}], amount: null })
    );
    expect([...fields].sort()).toEqual(['amount', 'name', 'tags']);
  });

  test.each([null, undefined, 'a string', 42])(
    'a row that is not an object (%p) is <root>',
    (v) => {
      expect(invalidMutationRowFields(v)).toEqual(['<root>']);
      expect(isUsableMutationTransactionRow(v)).toBe(false);
    }
  );
});

describe('warnMutationRowRefused', () => {
  beforeEach(__resetReadShapeWarnDedupe);

  function capture(fn: () => void): string[] {
    const spy = mock();
    const orig = console.warn;
    console.warn = spy as unknown as typeof console.warn;
    try {
      fn();
      return spy.mock.calls.map((c) => String(c[0]));
    } finally {
      console.warn = orig;
    }
  }

  test('one line per field SET, whatever order the fields arrive in; the line lists them sorted', () => {
    const lines = capture(() => {
      warnMutationRowRefused({ id: 'a', fields: ['tags', 'name'] }, 1);
      warnMutationRowRefused({ id: 'b', fields: ['name', 'tags'] }, 2);
      warnMutationRowRefused({ id: 'c', fields: ['name'] }, 0);
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('(invalid name, tags)');
    expect(lines[0]).toContain(MUTATION_ROW_READ_SCHEMA_SURFACE);
    expect(lines[1]).toContain('(invalid name)');
  });

  test('the misdated refusal names the requested month, never the returned date, and logs once', () => {
    const lines = capture(() => {
      warnMutationRowMisdated({ id: 'a', requestedMonth: '2025-02' }, 2);
      warnMutationRowMisdated({ id: 'b', requestedMonth: '2025-04' }, 1);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      'transaction a came back dated outside the month the write requested (2025-02)'
    );
    expect(lines[0]).toContain('2 cached months were dropped');
    expect(lines[0]).toContain(MUTATION_ROW_DATE_ECHO_SURFACE);
  });

  test('a null id is printed as <unreadable id>', () => {
    const [line] = capture(() => warnMutationRowRefused({ id: null, fields: ['<root>'] }, 0));
    expect(line).toContain('transaction <unreadable id> not stored');
    expect(line).toContain('(invalid <root>)');
  });
});

describe('fetchTransactionsPage default callback', () => {
  test('fetchTransactionsPage without a callback still warns on drops (#512 default)', async () => {
    const spy = mock();
    const orig = console.warn;
    console.warn = spy as unknown as typeof console.warn;
    try {
      __resetReadShapeWarnDedupe();
      const bad = goodNode('bad-default', { accountId: '' });
      const client = {
        query: mock(() => Promise.resolve({ transactions: page([bad]) })),
        mutate: mock(),
      } as unknown as GraphQLClient;
      const result = await fetchTransactionsPage(client, {
        first: 25,
        after: null,
        filter: null,
        sort: [],
      });
      expect(result.edges).toHaveLength(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = orig;
    }
  });
});
