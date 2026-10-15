/**
 * Smoke: cache↔live account-naming parity (#665).
 *
 * Run: `bun run scripts/smoke/account-names.ts` (or `bun run smoke:account-names`).
 *      Part of the `bun run smoke` composite since #791 settled the no-nickname
 *      fallback order. SKIPs (exit 0) where there is no local cache.
 *
 * Calls cache-mode `get_accounts` and live-mode `get_accounts_live` (both with
 * `include_hidden: true`, so visibility filtering cannot hide a row from one
 * side) and compares `name` per account id. See `account-names-checks.ts` for
 * what each verdict means — in particular WARN, which is what a run reports
 * when no account has a nickname that differs from its provider label and the
 * check therefore cannot tell the two sources apart.
 *
 * Oracle for `AccountNode.name:resolvesNickname` in `src/conformance/ledger.ts`.
 *
 * READS ONLY — one GraphQL Accounts query plus a local cache read; nothing
 * mutates. Needs BOTH a local Copilot cache and an authenticated
 * app.copilot.money browser session. With no cache it exits 0 as SKIP (there
 * is nothing to compare against, which is not drift); with a cache it could
 * not read it exits 1, because that is not "no cache". Logs counts only — never
 * an account name or balance (PII rules per CLAUDE.md).
 */

import { CopilotDatabase, missingDatabaseError } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { LiveAccountsTools } from '../../src/tools/live/accounts.js';
import { setupLiveSmoke } from './_harness.js';
import { classifyAccountNameParity, compareAccountNames } from './account-names-checks.js';

async function main(): Promise<void> {
  const db = new CopilotDatabase();
  const { available, lookupError } = db.availability();
  // A cache that could not be READ is not "no cache" (#774): SKIP would report
  // a parity check as having nothing to compare when it never looked.
  if (lookupError) {
    console.error(
      `[smoke] FAIL account-name parity — ${missingDatabaseError(lookupError).message}`
    );
    process.exit(1);
  }
  if (!db.getDbPath() || !available) {
    console.error('[smoke] SKIP account-name parity — no local Copilot cache to compare against.');
    return;
  }

  // Quiet: the harness's verbose mode logs per-call telemetry this check
  // does not need.
  const { live, log } = await setupLiveSmoke({ verbose: false });

  const cache = await new CopilotMoneyTools(db).getAccounts({ include_hidden: true });
  const liveResult = await new LiveAccountsTools(live).getAccounts({ include_hidden: true });

  const cacheNames = new Map<string, string | undefined>();
  for (const row of cache.accounts) {
    if (typeof row.account_id === 'string') cacheNames.set(row.account_id, row.name);
  }
  const liveNames = new Map<string, string | undefined>();
  for (const row of liveResult.accounts) {
    if (typeof row.id === 'string') liveNames.set(row.id, row.name);
  }

  const parity = compareAccountNames(cacheNames, liveNames, await db.getAccounts());
  const { status, detail } = classifyAccountNameParity(parity);
  log(`${status} account-name parity — ${detail}`);

  if (status === 'FAIL') {
    // The marker scripts/scheduled-smoke.ts recognises as a drift verdict.
    // Without it, a real mismatch in the weekly run is reported as "drift NOT
    // checked". The could-not-read-the-cache FAIL above deliberately does not
    // print it: that run never compared anything.
    console.error('[smoke] FAIL — account-name parity drift detected');
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
