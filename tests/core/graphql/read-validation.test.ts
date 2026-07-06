/**
 * Read-shape validation for Transactions pages (#512, warn-and-skip).
 * Invalid nodes are stripped at the page boundary; valid nodes pass through
 * unchanged; warnings dedupe per (op, failed-field set).
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  stripInvalidTransactionNodes,
  warnReadShapeDrift,
  __resetReadShapeWarnDedupe,
} from '../../../src/core/graphql/read-validation.js';
import type {
  TransactionsPage,
  TransactionNode,
} from '../../../src/core/graphql/queries/transactions.js';

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
