/**
 * Smoke: cache↔live account-visibility parity (#904).
 *
 * Run: `bun run scripts/smoke/account-visibility.ts` (or `bun run smoke:account-visibility`).
 *      Part of the `bun run smoke` composite. SKIPs (exit 0) where there is no
 *      local cache.
 *
 * Reads every cache account document and every live `Accounts` row, applies
 * each mode's visibility rule, and compares per account id. See
 * `account-visibility-checks.ts` for what each verdict means.
 *
 * Oracle for `FirestoreAccount.merged:notVisible` in `src/conformance/ledger.ts`.
 *
 * READS ONLY — one GraphQL Accounts query plus a local cache read; nothing
 * mutates. Needs BOTH a local Copilot cache and an authenticated
 * app.copilot.money browser session. With no cache it exits 0 as SKIP; with a
 * cache it could not read it exits 1, because that is not "no cache" (#774).
 * Logs counts only — never an account name or balance (PII rules per CLAUDE.md).
 */

import { CopilotDatabase, missingDatabaseError } from '../../src/core/database.js';
import { LiveAccountsTools } from '../../src/tools/live/accounts.js';
import { setupLiveSmoke } from './_harness.js';
import {
  classifyAccountVisibilityParity,
  compareAccountVisibility,
  type LiveVisibilityInput,
} from './account-visibility-checks.js';

async function main(): Promise<void> {
  const db = new CopilotDatabase();
  const { available, lookupError } = db.availability();
  if (lookupError) {
    console.error(
      `[smoke] FAIL — account-visibility parity could not read the local cache: ${missingDatabaseError(lookupError).message}`
    );
    process.exit(1);
  }
  if (!db.getDbPath() || !available) {
    // A SKIP_MARKERS entry in scripts/scheduled-smoke.ts (#819).
    console.error(
      '[smoke] SKIP — account-visibility parity not checked: no local Copilot cache to compare against.'
    );
    return;
  }

  const { live, log } = await setupLiveSmoke({ verbose: false });

  // The raw documents, not get_accounts rows: the rule is applied here, and a
  // projected row could lack the field that hid it.
  const cacheAccounts = await db.getAccounts();
  // include_hidden so live's own filter cannot hide a row from the comparison;
  // the fields the rule reads are requested by name so a preset trim cannot
  // turn into a false verdict.
  const liveResult = await new LiveAccountsTools(live).getAccounts({
    include_hidden: true,
    fields: ['id', 'isUserHidden', 'isUserClosed'],
  });
  const liveRows: LiveVisibilityInput[] = [];
  for (const row of liveResult.accounts) {
    if (
      typeof row.id === 'string' &&
      typeof row.isUserHidden === 'boolean' &&
      typeof row.isUserClosed === 'boolean'
    ) {
      liveRows.push({ id: row.id, isUserHidden: row.isUserHidden, isUserClosed: row.isUserClosed });
    }
  }
  if (liveRows.length !== liveResult.accounts.length) {
    // Not a drift verdict: the projection, not the server, lost the flags.
    console.error(
      `[smoke] FAIL — account-visibility parity: ${liveResult.accounts.length - liveRows.length} live row(s) came back without id / isUserHidden / isUserClosed`
    );
    process.exit(1);
  }

  const parity = compareAccountVisibility(cacheAccounts, liveRows);
  const { status, detail } = classifyAccountVisibilityParity(parity);

  if (status === 'FAIL') {
    log(`account-visibility parity mismatch: ${detail}`);
    // The marker scripts/scheduled-smoke.ts recognises as a drift verdict.
    console.error('[smoke] FAIL — account-visibility parity drift detected');
    process.exit(1);
  }
  if (status === 'WARN') {
    log(`WARN — account-visibility parity inconclusive: ${detail}`);
    return;
  }
  log(`PASS — account-visibility parity: ${detail}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error('[smoke] FAIL:', err);
    process.exit(1);
  });
}
