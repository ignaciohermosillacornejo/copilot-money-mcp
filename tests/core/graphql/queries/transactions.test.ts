import { describe, test, expect } from 'bun:test';
import { TRANSACTIONS } from '../../../../src/core/graphql/operations.generated.js';

describe('TRANSACTIONS query constant', () => {
  test('is non-empty and targets transactions root field', () => {
    expect(TRANSACTIONS).toContain('query Transactions');
    expect(TRANSACTIONS).toContain('transactions(');
    expect(TRANSACTIONS).toContain('$filter: TransactionFilter');
    expect(TRANSACTIONS).toContain('$sort: [TransactionSort!]');
    expect(TRANSACTIONS).toContain('edges');
    expect(TRANSACTIONS).toContain('pageInfo');
    expect(TRANSACTIONS).toContain('endCursor');
    expect(TRANSACTIONS).toContain('hasNextPage');
    expect(TRANSACTIONS).toContain('parentId');
    expect(TRANSACTIONS).toContain('isoCurrencyCode');
  });
});

import {
  buildTransactionFilter,
  type BuildFilterOptions,
  type TransactionFilterInput,
} from '../../../../src/core/graphql/queries/transactions.js';

describe('buildTransactionFilter', () => {
  test('returns null when no options are provided', () => {
    expect(buildTransactionFilter({})).toBeNull();
  });

  test('translates start_date and end_date into dates array', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
    });
  });

  test('uses far-future end when only start_date given', () => {
    const filter = buildTransactionFilter({ startDate: '2025-01-01' });
    expect(filter?.dates?.[0]?.from).toBe('2025-01-01');
    expect(filter?.dates?.[0]?.to).toBe('9999-12-31');
  });

  test('uses far-past start when only end_date given', () => {
    const filter = buildTransactionFilter({ endDate: '2025-12-31' });
    expect(filter?.dates?.[0]?.from).toBe('1970-01-01');
    expect(filter?.dates?.[0]?.to).toBe('2025-12-31');
  });
});

describe('buildTransactionFilter — more mappings', () => {
  test('translates accountRefs', () => {
    const filter = buildTransactionFilter({
      accountRefs: [{ accountId: 'a1', itemId: 'i1' }],
    });
    expect(filter).toEqual({
      accountIds: [{ accountId: 'a1', itemId: 'i1' }],
    });
  });

  test('translates categoryIds', () => {
    expect(buildTransactionFilter({ categoryIds: ['c1', 'c2'] })).toEqual({
      categoryIds: ['c1', 'c2'],
    });
  });

  test('translates tagIds', () => {
    expect(buildTransactionFilter({ tagIds: ['t1'] })).toEqual({
      tagIds: ['t1'],
    });
  });

  test('translates types', () => {
    expect(buildTransactionFilter({ types: ['REGULAR', 'INCOME'] })).toEqual({
      types: ['REGULAR', 'INCOME'],
    });
  });

  test('translates matchString', () => {
    expect(buildTransactionFilter({ matchString: 'amazon' })).toEqual({
      matchString: 'amazon',
    });
  });

  test('omits empty matchString', () => {
    expect(buildTransactionFilter({ matchString: '' })).toBeNull();
  });

  test('translates isReviewed=false', () => {
    expect(buildTransactionFilter({ isReviewed: false })).toEqual({
      isReviewed: false,
    });
  });

  test('combines multiple filters', () => {
    const filter = buildTransactionFilter({
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
    expect(filter).toEqual({
      dates: [{ from: '2025-01-01', to: '2025-12-31' }],
      categoryIds: ['c1'],
      matchString: 'amazon',
      types: ['REGULAR'],
    });
  });
});
