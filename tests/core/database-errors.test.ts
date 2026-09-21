/**
 * Tests for error handling paths in database.ts and decoder.ts.
 *
 * These tests focus on error conditions that are difficult
 * to trigger in normal operation.
 */

import { describe, test, expect } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import { extractValue } from '../../src/core/decoder.js';
import type { FirestoreValue } from '../../src/core/protobuf-parser.js';

const DB_NOT_FOUND_MESSAGE =
  'Database not found. Please ensure Copilot Money is installed and has synced data.';

/**
 * Any non-empty string, because nothing here reads it (#756).
 *
 * Passing *a* path is the whole point: `new CopilotDatabase()` with no argument
 * runs `findCopilotDatabase()`, which `readdirSync`s the user's live Copilot
 * Money Firestore container on the way to a test that then throws the path
 * away. That readdir is bimodal: measured over 8,470 calls on an otherwise idle
 * machine, 93% came back under 1ms and 99.9% under 100ms, nothing at all landed
 * between 100ms and 1s, and 8 calls (~0.1%) blocked for seconds and then failed
 * with `EINTR`. Bun's 5,000ms default test timeout lands inside the stall, so one of
 * these fifteen cases failed roughly 10% of runs in isolation and about one run
 * in three under the concurrent load of a release day, always blaming whichever
 * getter happened to be executing.
 *
 * The constructor's `if (dbPath)` branch touches no filesystem, and
 * `requireDbPath()` throws before anything else does, so with a path supplied
 * these tests reach the rejection with zero syscalls.
 */
const SYNTHETIC_DB_PATH = '/nonexistent/copilot-money-mcp/database-errors.test';

/**
 * Each case describes a public getter that, when the dbPath is missing and
 * the associated cache fields are cleared, must surface the "database not
 * found" error instead of silently returning stale data.
 *
 * `cacheFieldsToClear` covers the specific private caches each method
 * consults before triggering a disk load.
 */
const dbPathErrorCases: Array<{
  method: keyof CopilotDatabase;
  cacheFieldsToClear: string[];
  args?: unknown[];
}> = [
  { method: 'getTransactions', cacheFieldsToClear: ['_transactions'] },
  { method: 'getAccounts', cacheFieldsToClear: ['_accounts'] },
  { method: 'getRecurring', cacheFieldsToClear: ['_recurring'] },
  { method: 'getBudgets', cacheFieldsToClear: ['_budgets'] },
  { method: 'getGoals', cacheFieldsToClear: ['_goals'] },
  { method: 'getGoalHistory', cacheFieldsToClear: ['_goalHistory'] },
  { method: 'getInvestmentPrices', cacheFieldsToClear: ['_investmentPrices'] },
  { method: 'getItems', cacheFieldsToClear: ['_items'] },
  { method: 'getUserCategories', cacheFieldsToClear: ['_userCategories'] },
  { method: 'getUserAccounts', cacheFieldsToClear: ['_userAccounts'] },
  {
    method: 'getCategoryNameMap',
    cacheFieldsToClear: ['_categoryNameMap', '_userCategories'],
  },
  {
    method: 'getAccountNameMap',
    cacheFieldsToClear: ['_accountNameMap', '_userAccounts'],
  },
  {
    method: 'getCategories',
    cacheFieldsToClear: ['_transactions', '_userCategories'],
  },
  { method: 'getAllTransactions', cacheFieldsToClear: ['_transactions'] },
  {
    method: 'searchTransactions',
    cacheFieldsToClear: ['_transactions'],
    args: ['test'],
  },
];

describe('CopilotDatabase error handling', () => {
  describe('requireDbPath error path', () => {
    test.each(dbPathErrorCases)(
      '$method rejects when dbPath is undefined and cache is empty',
      async ({ method, cacheFieldsToClear, args = [] }) => {
        const db = new CopilotDatabase(SYNTHETIC_DB_PATH);
        // @ts-expect-error - accessing private property for testing
        db.dbPath = undefined;
        for (const field of cacheFieldsToClear) {
          (db as unknown as Record<string, unknown>)[field] = null;
        }

        const fn = db[method] as (...a: unknown[]) => Promise<unknown>;
        await expect(fn.call(db, ...args)).rejects.toThrow(DB_NOT_FOUND_MESSAGE);
      }
    );
  });

  describe('isAvailable edge cases', () => {
    test('returns false when dbPath is null-ish', () => {
      const db = new CopilotDatabase(SYNTHETIC_DB_PATH);
      // @ts-expect-error - accessing private property for testing
      db.dbPath = undefined;
      expect(db.isAvailable()).toBe(false);

      // @ts-expect-error - setting to empty string
      db.dbPath = '';
      expect(db.isAvailable()).toBe(false);
    });
  });
});

describe('extractValue error handling', () => {
  test.each([
    { label: 'unknown future type', type: 'unknown_future_type', value: 'some data' },
    { label: 'malformed object', type: 'not_a_real_type', value: { nested: 'data' } },
    { label: 'empty type string', type: '', value: 'data' },
  ])('returns undefined for $label', ({ type, value }) => {
    const firestoreValue = { type, value } as unknown as FirestoreValue;
    expect(extractValue(firestoreValue)).toBeUndefined();
  });
});
