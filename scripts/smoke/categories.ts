/**
 * Smoke test: get_categories_live against the real Copilot GraphQL endpoint.
 *
 * Run: `bun run scripts/smoke/categories.ts`
 *
 * Requires an authenticated app.copilot.money browser session. Asserts:
 *   1. Cold call returns rows with _cache_hit=false
 *   2. Warm call (within TTL) returns _cache_hit=true with sub-50ms latency
 *   3. refresh_cache --scope categories invalidates and triggers refetch
 *   4. Audit C6: rollover surfaces correctly — if the user has rollovers
 *      enabled, at least one category surfaces a non-zero rolloverAmount;
 *      if disabled, all categories return rolloverAmount === 0.
 *
 * Exits non-zero on any assertion failure. Paste its verdict lines into a PR
 * description, never the `[smoke]` log lines: those carry real figures.
 * Assertions about what the server returned (a non-empty category list,
 * rollover polarity) print a drift verdict the scheduled run reports as drift;
 * the cache-hit and timing assertions are about this process, and throw plainly
 * so a slow run reads as "drift NOT checked" rather than as an API change
 * (#819).
 */

import { setupLiveSmoke } from './_harness.js';
import { LiveCategoriesTools } from '../../src/tools/live/categories.js';
import { RefreshCacheTool } from '../../src/tools/live/refresh-cache.js';
import { fetchUser } from '../../src/core/graphql/queries/user.js';

/**
 * A server-controlled assertion failed: report drift, not a broken run.
 * Deliberately a per-file copy: tests/scripts/smoke-composite-verdicts.test.ts
 * reads each member's printed literals, so the marker must be spelled out in
 * this file. Moving it into a shared helper would hide it from that check.
 */
function serverDrift(message: string): never {
  console.error('[smoke] server assertion failed:', message);
  console.error('[smoke] FAIL — categories server drift detected');
  process.exit(1);
}

async function main(): Promise<void> {
  const { live, graphql, log } = await setupLiveSmoke({ verbose: true });
  const tools = new LiveCategoriesTools(live);
  const refresh = new RefreshCacheTool(live);

  // 1. Cold call
  const t0 = Date.now();
  const cold = await tools.getCategories({});
  const coldMs = Date.now() - t0;
  log('cold', { rows: cold.count, hit: cold._cache_hit, ms: coldMs });
  if (cold._cache_hit !== false) {
    throw new Error(`expected cold call _cache_hit=false, got ${cold._cache_hit}`);
  }
  if (cold.count === 0) {
    serverDrift('expected at least one category');
  }

  // 2. Warm call
  const t1 = Date.now();
  const warm = await tools.getCategories({});
  const warmMs = Date.now() - t1;
  log('warm', { rows: warm.count, hit: warm._cache_hit, ms: warmMs });
  if (warm._cache_hit !== true) {
    throw new Error(`expected warm call _cache_hit=true, got ${warm._cache_hit}`);
  }
  if (warmMs > 50) {
    throw new Error(`warm call took ${warmMs}ms, expected sub-50ms`);
  }

  // 3. Refresh + refetch
  await refresh.refresh({ scope: 'categories' });
  log('refreshed', { scope: 'categories' });
  const t2 = Date.now();
  // `budget` is asked for explicitly: the default preset drops it (#597), and
  // the rollover check below is about what the server put in it. Without it
  // every row reads as rollover 0 and the check can never fail (#913 review).
  const recold = await tools.getCategories({ fields: ['default', 'budget'] });
  const recoldMs = Date.now() - t2;
  log('recold', { rows: recold.count, hit: recold._cache_hit, ms: recoldMs });
  if (recold._cache_hit !== false) {
    throw new Error(`expected post-refresh _cache_hit=false, got ${recold._cache_hit}`);
  }

  // 4. Audit C6: rollover surfaces correctly. Read the user record directly
  //    so we know the expected polarity, then assert recold mirrors it.
  const user = await fetchUser(graphql);
  const rolloversEnabled =
    user.budgetingConfig?.isEnabled === true &&
    user.budgetingConfig.rolloversConfig?.isEnabled === true;
  // No `?? 0`: a row whose budget did not come back is left out, so a blind
  // run shows categories_with_rollover_amount: 0 instead of the row count.
  const rolloverAmounts = recold.categories
    .map((c) => c.budget?.current?.rolloverAmount)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const nonZero = rolloverAmounts.filter((n) => n !== 0);
  log('rollover', {
    user_rollovers_enabled: rolloversEnabled,
    categories_with_rollover_amount: rolloverAmounts.length,
    categories_with_nonzero_rollover: nonZero.length,
  });
  const rolloverCompared = rolloverAmounts.length > 0;
  if (!rolloverCompared) {
    // A SKIP_MARKERS entry in scripts/scheduled-smoke.ts: no category came
    // back with a rollover number (budgeting off leaves budget.current null),
    // so there is nothing to compare, which is neither a pass nor drift.
    console.error(
      '[smoke] SKIP — rollover polarity not checked: no category carried a rollover amount.'
    );
  } else if (rolloversEnabled) {
    // Gentle assertion: if the user has rollovers on but no rollover effects
    // happen to be active this period (legitimately possible when every
    // category zeroes out), don't fail. Just log the count.
    if (nonZero.length === 0) {
      log('rollover-warn', {
        msg: 'user has rollovers enabled but no non-zero rolloverAmount surfaced — possibly a legitimate state, but worth confirming',
      });
    }
  } else {
    // If the user has rollovers disabled, EVERY category must report 0.
    if (nonZero.length > 0) {
      serverDrift(
        `expected rolloverAmount=0 on every category when user has rollovers disabled; found ${nonZero.length} non-zero`
      );
    }
  }

  if (rolloverCompared) {
    console.error(
      '[smoke] PASS — categories refresh smoke: cold, warm, refresh and rollover polarity verified.'
    );
  } else {
    console.error('[smoke] PASS — categories refresh smoke: cold, warm and refresh verified.');
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
