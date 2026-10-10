/**
 * Smoke: cache↔live account-naming parity (#665).
 *
 * Run: `bun run scripts/smoke/account-names.ts` (or `bun run smoke:account-names`).
 *      Not in the `bun run smoke` composite yet: it is red on real data until
 *      the no-nickname fallback order is decided (#791).
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
 * is nothing to compare against, which is not drift). Logs counts only — never
 * an account name or balance (PII rules per CLAUDE.md).
 */

import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { LiveAccountsTools } from '../../src/tools/live/accounts.js';
import { setupLiveSmoke } from './_harness.js';
import { classifyAccountNameParity, compareAccountNames } from './account-names-checks.js';

async function main(): Promise<void> {
  const db = new CopilotDatabase();
  if (!db.getDbPath() || !db.isAvailable()) {
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

  if (status === 'FAIL') process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
