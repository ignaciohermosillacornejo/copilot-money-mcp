/**
 * Read filters refuse an impossible calendar date the same way in both modes
 * (#825). Before, `2026-02-30` passed the cache tools' format check and matched
 * nothing, and the live tool sent it to the server unchecked.
 */
import { describe, expect, test } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';

function cacheTools(): CopilotMoneyTools {
  const db = new CopilotDatabase('/nonexistent');
  (db as any).dbPath = '/fake';
  (db as any)._transactions = [];
  db._markLoadedForTesting();
  return new CopilotMoneyTools(db);
}

function liveTools(): { tools: LiveTransactionsTools; calls: () => number } {
  let calls = 0;
  const client = {
    query: () => {
      calls += 1;
      return Promise.reject(new Error('no request expected'));
    },
    mutate: () => Promise.reject(new Error('no request expected')),
  } as unknown as GraphQLClient;
  const db = new CopilotDatabase('/nonexistent');
  return {
    tools: new LiveTransactionsTools(new LiveCopilotDatabase(client, db)),
    calls: () => calls,
  };
}

const IMPOSSIBLE = /Invalid start_date: 2026-02-30 is not a real calendar date/;
const MALFORMED = /Invalid end_date format\. Expected YYYY-MM-DD, got: 2026-3-1/;

describe('read-filter dates are real calendar dates in both modes (#825)', () => {
  test('get_transactions (cache)', async () => {
    const tools = cacheTools();
    await expect(
      tools.getTransactions({ start_date: '2026-02-30', end_date: '2026-03-31' })
    ).rejects.toThrow(IMPOSSIBLE);
    await expect(
      tools.getTransactions({ start_date: '2026-02-01', end_date: '2026-3-1' })
    ).rejects.toThrow(MALFORMED);
  });

  test('get_transactions_live: the same messages, and nothing is sent', async () => {
    const { tools, calls } = liveTools();
    await expect(
      tools.getTransactions({ start_date: '2026-02-30', end_date: '2026-03-31' })
    ).rejects.toThrow(IMPOSSIBLE);
    await expect(
      tools.getTransactions({ start_date: '2026-02-01', end_date: '2026-3-1' })
    ).rejects.toThrow(MALFORMED);
    expect(calls()).toBe(0);
  });

  test('get_recurring_transactions (cache) now checks its dates at all', async () => {
    const tools = cacheTools();
    await expect(
      tools.getRecurringTransactions({ start_date: '2026-02-30', end_date: '2026-03-31' })
    ).rejects.toThrow(IMPOSSIBLE);
  });

  test('a month filter must name a real month', async () => {
    const tools = cacheTools();
    await expect(
      tools.getGoalHistory({ goal_id: 'gA1bC2dE3fG4hI5jK6lM', start_month: '2026-13' })
    ).rejects.toThrow(/Invalid start_month: 2026-13 is not a real month \(01-12\)/);
  });
});
