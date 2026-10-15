#!/usr/bin/env bun
/**
 * Call one cache-mode `CopilotMoneyTools` method against the real local cache
 * and print its JSON result. Used by skills/release-parity-test.
 *
 * Run: `bun run parity:cache <method> ['<json args>']`
 *   e.g. `bun run parity:cache getAccounts '{"include_hidden":true}'`
 *
 * Why it exists: with `--live-reads` on (implied by `--write`) the MCP server
 * hides the cache-mode read tools, so the cache side of a cache-vs-live
 * comparison cannot be reached through the MCP client. This runs the same
 * method the cache-mode tool dispatches to.
 *
 * Same database as the server: if the MCP host's `copilot-money` entry passes
 * `--db-path`, set `PARITY_DB_PATH` to the same value. Otherwise the cache
 * column comes from a different database than the live column and every diff
 * gets blamed on our code. The resolved path is printed to stderr on every
 * call so the report can record which database was read.
 *
 * Read-only by construction: only methods named in READ_METHODS are callable,
 * and tests/scripts/parity-cache-call.test.ts checks every entry is the method
 * behind a `readOnly: true` tool and behind no write tool.
 */

import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';

export const READ_METHODS = [
  'getAccounts',
  'getTransactions',
  'getCategories',
  'getBudgets',
  'getRecurringTransactions',
  'getHoldings',
  'getGoals',
  'getGoalHistory',
  'getBalanceHistory',
  'getInvestmentPrices',
  'getInvestmentSplits',
  'getCacheInfo',
  'getConnectionStatus',
] as const;

type ReadMethod = (typeof READ_METHODS)[number];

function isReadMethod(name: string): name is ReadMethod {
  return (READ_METHODS as readonly string[]).includes(name);
}

/**
 * Tool handlers take an options object. A JSON scalar, array or `null` would
 * either crash deep in the database layer (reading like a cache failure) or,
 * worse, run the unfiltered default read: `'"last_month"'` is an easy typo for
 * `'{"period":"last_month"}'` and would yield a wrong but believable comparison.
 */
export function parseArgs(argJson: string | undefined): Record<string, unknown> {
  if (argJson === undefined) return {};
  const parsed: unknown = JSON.parse(argJson);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`args must be a JSON object like '{"period":"last_month"}', got: ${argJson}`);
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [method, argJson] = process.argv.slice(2);
  if (method === undefined || !isReadMethod(method)) {
    console.error(
      `usage: parity:cache <method> ['<json args>']\nmethods: ${READ_METHODS.join(', ')}`
    );
    process.exit(2);
  }
  let args: Record<string, unknown>;
  try {
    args = parseArgs(argJson);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  }
  const db = new CopilotDatabase(process.env.PARITY_DB_PATH || undefined);
  console.error(`[parity:cache] database: ${db.getDbPath() ?? '(none found)'}`);
  const tools = new CopilotMoneyTools(db);
  const fn = tools[method] as (a: unknown) => Promise<unknown>;
  const result = await fn.call(tools, args);
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[parity:cache] FAIL:', err);
    process.exit(1);
  });
}
