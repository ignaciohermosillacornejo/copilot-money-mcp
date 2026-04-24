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
