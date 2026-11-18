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
 *   4. months_window=1 anchors to the current month, not future projection rows
 *
 * Exits non-zero on any assertion failure. Paste its verdict lines into a PR
 * description, never the `[smoke]` log lines: those carry real figures. What
 * the server returned (the month window) prints a drift verdict the scheduled
 * run reports as drift. An empty budget list does not: an account with
 * budgeting off has none, so it prints a registered SKIP marker (#913 review).
 * That SKIP also covers an amount-encoding change that projects every row
 * away; read-shape validation in smoke:reads sees that from the other side;
 * the cache-hit and timing assertions are about this process, and throw plainly
 * so a slow run reads as "drift NOT checked" rather than as an API change
 * (#819). The month-window trim itself is local arithmetic
 * (trimAmountsToWindow); what the server controls there is the month-key
 * format, so that is checked separately on the raw, untrimmed keys.
 *
 * Audit C6 (rollover correctness): exercised end-to-end via the categories
 * smoke (`scripts/smoke/categories.ts`) since LiveBudgetsTools projects from
 * the same categoriesCache; running both smokes covers the path.
 */

import { setupLiveSmoke } from './_harness.js';
import { LiveBudgetsTools } from '../../src/tools/live/budgets.js';
import { RefreshCacheTool } from '../../src/tools/live/refresh-cache.js';

/**
 * A server-controlled assertion failed: report drift, not a broken run.
 * Deliberately a per-file copy: tests/scripts/smoke-composite-verdicts.test.ts
 * reads each member's printed literals, so the marker must be spelled out in
 * this file. Moving it into a shared helper would hide it from that check.
 */
function serverDrift(message: string): never {
  console.error('[smoke] server assertion failed:', message);
  console.error('[smoke] FAIL — budgets server drift detected');
  process.exit(1);
}

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
  if (cold.count === 0) {
    // A SKIP_MARKERS entry in scripts/scheduled-smoke.ts: with budgeting off
    // every category projects to no budget row, which is a fact about the
    // account, not the API (the same premise categories' rollover SKIP uses).
    console.error('[smoke] SKIP — budget rows not checked: the account has no budgets.');
  }

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  // The format check reads the raw server keys (months_window=0 skips the
  // local trim), because the trim drops any key monthIndex() cannot parse:
  // a non-numeric month ("2026-JUN") would otherwise vanish and pass. A cache
  // hit, so it does not disturb the cold/warm assertions (#913 review). It runs
  // first so a format change is reported as one, not as an off-anchor month.
  const full = await tools.getBudgets({ months_window: 0 });
  const rawKeys = full.budgets.flatMap((budget) => Object.keys(budget.amounts ?? {}));
  const badFormat = [...new Set(rawKeys.filter((m) => !/^\d{4}-\d{2}$/.test(m)))];
  log('month keys', { examined: rawKeys.length, badFormat: badFormat.length });
  if (badFormat.length > 0) {
    serverDrift(`budget month keys are not YYYY-MM: ${badFormat.join(', ')}`);
  }
  const currentWindow = await tools.getBudgets({ months_window: 1 });
  const windowKeys = currentWindow.budgets.flatMap((budget) => Object.keys(budget.amounts ?? {}));
  const offAnchor = windowKeys.filter((month) => month !== currentMonth);
  // `anchored` is the denominator: with no current-month amount anywhere the
  // check examines nothing, and the PASS line below must not claim it.
  log('months_window=1', {
    currentMonth,
    anchored: windowKeys.length,
    offAnchor: offAnchor.length,
  });
  if (offAnchor.length > 0) {
    serverDrift(
      `months_window=1 returned non-current budget months: ${[...new Set(offAnchor)].join(', ')}`
    );
  }

  // windowKeys is a subset of rawKeys, so this also covers no keys at all.
  if (cold.count > 0 && windowKeys.length === 0) {
    // The same registered marker as an empty list: the window had nothing to
    // anchor, so the month checks compared nothing. Reusing it keeps the
    // reader cap and the context budget where they are.
    console.error('[smoke] SKIP — budget rows not checked: no month amounts to anchor.');
  }

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

  if (windowKeys.length > 0) {
    console.error(
      '[smoke] PASS — budgets refresh smoke: cold, month window, warm and refresh verified.'
    );
  } else {
    console.error('[smoke] PASS — budgets refresh smoke: cold, warm and refresh verified.');
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
