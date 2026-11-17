/**
 * Smoke test: get_recurring_live against the real Copilot GraphQL endpoint.
 *
 * Run: `bun run scripts/smoke/recurring.ts`
 *
 * Requires an authenticated app.copilot.money browser session. Asserts:
 *   1. Cold call returns rows with _cache_hit=false
 *   2. Warm call (within TTL) returns _cache_hit=true with sub-50ms latency
 *   3. refresh_cache --scope recurring invalidates and triggers refetch
 *
 * Exits non-zero on any assertion failure. Output is intended to be pasted
 * into the PR description. A row with no id is about the server and prints a
 * drift verdict the scheduled run reports as drift. An empty list is not: an
 * account can simply have no recurring items, so it prints a registered SKIP
 * marker and the run records the comparison as not checked rather than as
 * drift or as a clean pass (#913). The cache-hit and timing assertions are
 * about this process and still run on an empty list (an empty snapshot is
 * cached like any other); they throw plainly so a slow run reads as
 * "drift NOT checked" rather than as an API change (#819).
 */

import { setupLiveSmoke } from './_harness.js';
import { LiveRecurringTools } from '../../src/tools/live/recurring.js';
import { RefreshCacheTool } from '../../src/tools/live/refresh-cache.js';

/**
 * A server-controlled assertion failed: report drift, not a broken run.
 * Deliberately a per-file copy: tests/scripts/smoke-composite-verdicts.test.ts
 * reads each member's printed literals, so the marker must be spelled out in
 * this file. Moving it into a shared helper would hide it from that check.
 */
function serverDrift(message: string): never {
  console.error('[smoke] server assertion failed:', message);
  console.error('[smoke] FAIL — recurring server drift detected');
  process.exit(1);
}

async function main(): Promise<void> {
  const { live, log } = await setupLiveSmoke({ verbose: true });
  const tools = new LiveRecurringTools(live);
  const refresh = new RefreshCacheTool(live);

  // 1. Cold
  const t0 = Date.now();
  const cold = await tools.getRecurring({});
  const coldMs = Date.now() - t0;
  log('cold', { rows: cold.count, hit: cold._cache_hit, ms: coldMs });
  if (cold._cache_hit !== false) throw new Error(`expected cold _cache_hit=false`);
  if (cold.count === 0) {
    // A SKIP_MARKERS entry in scripts/scheduled-smoke.ts: an account with no
    // recurring items has nothing to compare, which is not evidence the API changed.
    console.error('[smoke] SKIP — recurring rows not checked: the account has no recurring items.');
  }
  const missingId = cold.recurring.filter((r) => !r.id).length;
  if (missingId > 0) {
    serverDrift(`${missingId} of ${cold.count} recurring items came back with no id`);
  }

  // 2. Warm
  const t1 = Date.now();
  const warm = await tools.getRecurring({});
  const warmMs = Date.now() - t1;
  log('warm', { rows: warm.count, hit: warm._cache_hit, ms: warmMs });
  if (warm._cache_hit !== true) throw new Error(`expected warm _cache_hit=true`);
  if (warmMs > 50) throw new Error(`warm took ${warmMs}ms, expected sub-50ms`);

  // 3. Refresh + recold
  await refresh.refresh({ scope: 'recurring' });
  log('refreshed', { scope: 'recurring' });
  const t2 = Date.now();
  const recold = await tools.getRecurring({});
  const recoldMs = Date.now() - t2;
  log('recold', { rows: recold.count, hit: recold._cache_hit, ms: recoldMs });
  if (recold._cache_hit !== false) throw new Error(`expected post-refresh _cache_hit=false`);

  console.error('[smoke] PASS — recurring refresh smoke: cold, warm and refresh verified.');
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
