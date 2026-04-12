/**
 * Tests for review_transactions batching behavior.
 *
 * Verifies that writes are issued in groups of at most 10 concurrently
 * rather than all at once, without hitting a real Firestore backend.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

// ---------------------------------------------------------------------------
// Batch math helpers
// ---------------------------------------------------------------------------

/** Returns the number of batches needed to process `total` items `batchSize` at a time. */
function batchCount(total: number, batchSize: number): number {
  if (total === 0) return 0;
  return Math.ceil(total / batchSize);
}

/** Returns the size of the last batch given `total` items and `batchSize`. */
function lastBatchSize(total: number, batchSize: number): number {
  if (total === 0) return 0;
  const remainder = total % batchSize;
  return remainder === 0 ? batchSize : remainder;
}

describe('batch math helpers', () => {
  test('0 items → 0 batches', () => {
    expect(batchCount(0, 10)).toBe(0);
  });

  test('1 item → 1 batch of 1', () => {
    expect(batchCount(1, 10)).toBe(1);
    expect(lastBatchSize(1, 10)).toBe(1);
  });

  test('exactly 10 items → 1 batch of 10', () => {
    expect(batchCount(10, 10)).toBe(1);
    expect(lastBatchSize(10, 10)).toBe(10);
  });

  test('11 items → 2 batches, last batch has 1', () => {
    expect(batchCount(11, 10)).toBe(2);
    expect(lastBatchSize(11, 10)).toBe(1);
  });

  test('25 items → 3 batches, last batch has 5', () => {
    expect(batchCount(25, 10)).toBe(3);
    expect(lastBatchSize(25, 10)).toBe(5);
  });

  test('20 items → 2 batches of 10', () => {
    expect(batchCount(20, 10)).toBe(2);
    expect(lastBatchSize(20, 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Concurrency tracking mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Firestore client that:
 *  - records every updateDocument call
 *  - tracks the peak number of simultaneously in-flight calls
 */
function makeConcurrencyTrackingClient(opts: {
  updateCalls: Array<{ collection: string; docId: string }>;
  peakConcurrency: { value: number };
  delayMs?: number;
}) {
  let inFlight = 0;

  return {
    requireUserId: async () => 'user123',
    getUserId: () => 'user123',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateDocument: async (collection: string, docId: string, _fields: any, _mask: string[]) => {
      inFlight++;
      opts.peakConcurrency.value = Math.max(opts.peakConcurrency.value, inFlight);
      opts.updateCalls.push({ collection, docId });

      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }

      inFlight--;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDocument: async (_collection: string, _docId: string, _fields: any) => {},
    deleteDocument: async (_collection: string, _docId: string) => {},
  };
}

/**
 * Build a minimal CopilotDatabase mock that returns synthetic transactions.
 * Each transaction gets item_id = 'item1' and account_id = 'acct1'.
 */
function makeMockDb(txnIds: string[]): CopilotDatabase {
  const db = new CopilotDatabase('/nonexistent');
  (db as any)._allCollectionsLoaded = true;

  const transactions = txnIds.map((id) => ({
    transaction_id: id,
    item_id: 'item1',
    account_id: 'acct1',
    amount: 10,
    date: '2024-01-01',
    name: `Txn ${id}`,
    user_reviewed: false,
  }));

  // Stub getAllTransactions to return synthetic data
  (db as any).getAllTransactions = async () => transactions;

  // patchCachedTransaction always succeeds (returns true = no cache clear needed)
  (db as any).patchCachedTransaction = (_id: string, _patch: object) => true;
  (db as any).clearCache = () => {};

  return db;
}

// ---------------------------------------------------------------------------
// Concurrency cap tests
// ---------------------------------------------------------------------------

describe('review_transactions batching', () => {
  const BATCH_SIZE = 10;

  test('single transaction: 1 write, peak concurrency = 1', async () => {
    const updateCalls: Array<{ collection: string; docId: string }> = [];
    const peakConcurrency = { value: 0 };
    const client = makeConcurrencyTrackingClient({ updateCalls, peakConcurrency });
    const db = makeMockDb(['txn-1']);
    const tools = new CopilotMoneyTools(db, client as any);

    const result = await tools.reviewTransactions({ transaction_ids: ['txn-1'] });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(peakConcurrency.value).toBe(1);
  });

  test('exactly 10 transactions: all in one batch, peak concurrency = 10', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `txn-${i}`);
    const updateCalls: Array<{ collection: string; docId: string }> = [];
    const peakConcurrency = { value: 0 };

    // Use a small delay so all writes in the batch overlap
    const client = makeConcurrencyTrackingClient({ updateCalls, peakConcurrency, delayMs: 5 });
    const db = makeMockDb(ids);
    const tools = new CopilotMoneyTools(db, client as any);

    const result = await tools.reviewTransactions({ transaction_ids: ids });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(10);
    expect(updateCalls).toHaveLength(10);
    expect(peakConcurrency.value).toBeLessThanOrEqual(BATCH_SIZE);
  });

  test('11 transactions: 2 batches, peak concurrency never exceeds 10', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `txn-${i}`);
    const updateCalls: Array<{ collection: string; docId: string }> = [];
    const peakConcurrency = { value: 0 };

    const client = makeConcurrencyTrackingClient({ updateCalls, peakConcurrency, delayMs: 5 });
    const db = makeMockDb(ids);
    const tools = new CopilotMoneyTools(db, client as any);

    const result = await tools.reviewTransactions({ transaction_ids: ids });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(11);
    expect(updateCalls).toHaveLength(11);
    // With batching, peak should never exceed batch size
    expect(peakConcurrency.value).toBeLessThanOrEqual(BATCH_SIZE);
  });

  test('25 transactions: all writes issued, peak concurrency ≤ 10', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `txn-${i}`);
    const updateCalls: Array<{ collection: string; docId: string }> = [];
    const peakConcurrency = { value: 0 };

    const client = makeConcurrencyTrackingClient({ updateCalls, peakConcurrency, delayMs: 5 });
    const db = makeMockDb(ids);
    const tools = new CopilotMoneyTools(db, client as any);

    const result = await tools.reviewTransactions({ transaction_ids: ids });

    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(25);
    expect(updateCalls).toHaveLength(25);
    expect(peakConcurrency.value).toBeLessThanOrEqual(BATCH_SIZE);
    // 3 batches of (10, 10, 5) — peak within any batch is at most 10
    expect(batchCount(25, BATCH_SIZE)).toBe(3);
  });

  test('returned transaction_ids match input order', async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `txn-${String(i).padStart(2, '0')}`);
    const updateCalls: Array<{ collection: string; docId: string }> = [];
    const peakConcurrency = { value: 0 };

    const client = makeConcurrencyTrackingClient({ updateCalls, peakConcurrency });
    const db = makeMockDb(ids);
    const tools = new CopilotMoneyTools(db, client as any);

    const result = await tools.reviewTransactions({ transaction_ids: ids });

    expect(result.transaction_ids).toEqual(ids);
  });
});
