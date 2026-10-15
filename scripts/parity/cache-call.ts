#!/usr/bin/env bun
/**
 * Call one cache-mode `CopilotMoneyTools` method against the real local cache
 * and print its JSON result. Used by skills/release-parity-test.
 *
 * Run: `bun run scripts/parity/cache-call.ts <method> ['<json args>']`
 *   e.g. `bun run scripts/parity/cache-call.ts getAccounts '{"include_hidden":true}'`
 *
 * Why it exists: with `--live-reads` on (implied by `--write`) the MCP server
 * hides the cache-mode read tools, so the cache side of a cache-vs-live
 * comparison cannot be reached through the MCP client. This runs the same
 * method the cache-mode tool dispatches to.
 *
 * Read-only by construction: only methods named in READ_METHODS are callable,
 * so a typo or a write method name cannot reach Copilot.
 */

import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';

const READ_METHODS = [
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

async function main(): Promise<void> {
  const [method, argJson] = process.argv.slice(2);
  if (method === undefined || !isReadMethod(method)) {
    console.error(
      `usage: cache-call.ts <method> ['<json args>']\nmethods: ${READ_METHODS.join(', ')}`
    );
    process.exit(2);
  }
  let args: unknown = {};
  if (argJson !== undefined) {
    try {
      args = JSON.parse(argJson);
    } catch (err) {
      console.error(`args must be JSON: ${String(err)}`);
      process.exit(2);
    }
  }
  const tools = new CopilotMoneyTools(new CopilotDatabase());
  const fn = tools[method] as (a: unknown) => Promise<unknown>;
  const result = await fn.call(tools, args);
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[cache-call] FAIL:', err);
    process.exit(1);
  });
}
