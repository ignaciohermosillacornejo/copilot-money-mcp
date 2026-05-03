/**
 * Smoke test: get_budgets_live against the real Copilot GraphQL endpoint.
 *
 * Run: `bun run scripts/smoke/budgets.ts`
 *
 * Requires an authenticated app.copilot.money browser session. Asserts:
 *   1. Cold call returns rows with _cache_hit=false
 *   2. Warm call (within TTL) returns _cache_hit=true with sub-50ms latency
 *   3. refresh_cache --scope budgets invalidates categoriesCache (the alias)
 *      and triggers a refetch on the next get_budgets_live call
 *
 * Exits non-zero on any assertion failure. Output is intended to be pasted
 * into the PR description.
 */

import { setupLiveSmoke } from './_harness.js';
import { LiveBudgetsTools } from '../../src/tools/live/budgets.js';
import { RefreshCacheTool } from '../../src/tools/live/refresh-cache.js';

async function main(): Promise<void> {
  const { live, log } = await setupLiveSmoke({ verbose: true });
  const tools = new LiveBudgetsTools(live);
  const refresh = new RefreshCacheTool(live);

  // 1. Cold
  const t0 = Date.now();
  const cold = await tools.getBudgets({});
  const coldMs = Date.now() - t0;
  log('cold', { rows: cold.count, total: cold.total_budgeted, hit: cold._cache_hit, ms: coldMs });
  if (cold._cache_hit !== false) throw new Error(`expected cold _cache_hit=false`);
  if (cold.count === 0) throw new Error('expected at least one budget');

  // 2. Warm
  const t1 = Date.now();
  const warm = await tools.getBudgets({});
  const warmMs = Date.now() - t1;
  log('warm', { rows: warm.count, hit: warm._cache_hit, ms: warmMs });
  if (warm._cache_hit !== true) throw new Error(`expected warm _cache_hit=true`);
  if (warmMs > 50) throw new Error(`warm took ${warmMs}ms, expected sub-50ms`);

  // 3. Refresh + recold (verifies alias: scope=budgets invalidates categoriesCache)
  await refresh.refresh({ scope: 'budgets' });
  log('refreshed', { scope: 'budgets' });
  const t2 = Date.now();
  const recold = await tools.getBudgets({});
  const recoldMs = Date.now() - t2;
  log('recold', { rows: recold.count, hit: recold._cache_hit, ms: recoldMs });
  if (recold._cache_hit !== false) throw new Error(`expected post-refresh _cache_hit=false`);

  log('done', { passed: 3 });
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
