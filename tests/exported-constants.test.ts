/**
 * Bidirectional pin over EVERY exported string-literal constant in `src/`.
 *
 * WHY THIS FILE EXISTS
 *
 * The repo's #635 bug class: "deleting a field from a preset survived all
 * 2,679 tests." It has now bitten three times. The third time is the reason
 * this file is not simply a test inside field-selection.test.ts.
 *
 *   1. #635  — a field deleted from a transactions preset, undetected.
 *   2. #673  — three of five DEFAULT_TOP_MOVER_FIELDS entries deletable with
 *              all 2,847 tests green.
 *   3. #676  — the fix for (2) discovered presets by importing ONE module,
 *              so DEFAULT_COMPACT_TRANSACTION_FIELDS in src/tools/tools.ts
 *              (7 entries, decides the `compact: true` row) stayed exposed:
 *              three of its seven could be deleted, suite still green.
 *
 * Each fix reproduced the bug it was fixing, one level up: assert the field →
 * forget a field; pin the preset → forget a preset; discover in a module →
 * forget a module. Every version left a list someone had to remember.
 *
 * So discovery here reads the SOURCE TREE, not a module and not a name
 * convention:
 *   - cross-module: a preset anywhere under src/ is found
 *   - name-agnostic: a constant that ignores the DEFAULT_*_FIELDS convention
 *     is still found, because the filter is SHAPE (an exported `as const`
 *     array whose members are all string literals)
 *
 * That shape also sweeps in wire-visible enums and allowlists —
 * RECURRING_FREQUENCIES, KNOWN_ERROR_CODES, COLOR_NAMES, TOP_MOVERS_FILTERS.
 * That is deliberate, not collateral: those have the identical failure mode.
 * Dropping a member changes what we accept from or send to Copilot, and no
 * ratchet elsewhere catches a list getting SHORTER.
 *
 * HOW IT FAILS (all three directions are mutation-tested in this file's PR)
 *
 *   forward   a constant exists in src/ with no pinned expectation
 *             -> someone added one and no test came with it
 *   backward  a pinned expectation names a constant no longer in src/
 *             -> a stale expectation quietly protecting nothing
 *   contents  a pinned constant's members changed
 *
 * The backward direction also guards the DISCOVERY MECHANISM itself: if the
 * regex below silently stops matching (a formatting change, a refactor to a
 * different declaration style), the constants it can no longer see read as
 * "vanished" and the backward check goes red. A partial under-match cannot
 * pass quietly. The explicit non-vacuity test makes the total-failure case
 * report an unambiguous reason rather than 23 confusing ones.
 *
 * MAINTENANCE: changing one of these deliberately means updating the entry
 * below. That is the intended workflow — the point is that it cannot happen
 * SILENTLY.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', 'src');

/**
 * Matches `export const NAME = [ ...string literals... ] as const`, with an
 * optional type annotation. Deliberately narrow: it requires the `as const`
 * suffix and rejects any array containing a non-string-literal member, so a
 * constant built from spreads, identifiers or numbers is not swept in.
 */
const EXPORTED_ARRAY = /^export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[(.*?)\]\s*as const/gms;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function discoverStringConstants(): Map<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  for (const file of tsFilesUnder(SRC_ROOT)) {
    const text = readFileSync(file, 'utf-8');
    for (const match of text.matchAll(EXPORTED_ARRAY)) {
      const [, name, rawBody] = match;
      if (name === undefined || rawBody === undefined) continue;
      const items = [...rawBody.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
      // Everything that is not a string literal, comma or whitespace: if
      // anything remains, the array is not purely string literals.
      const residue = rawBody.replace(/'[^']*'|,|\s/g, '');
      if (items.length > 0 && residue === '') found.set(name, items);
    }
  }
  return found;
}

const PINNED: Record<string, readonly string[]> = {
  // src/core/graphql/queries/_shared.ts
  ALL_TIME_FRAMES: ['ONE_DAY', 'ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'YTD', 'ONE_YEAR', 'ALL'],
  // src/tools/constants.ts
  BALANCE_HISTORY_GRANULARITIES: ['daily', 'weekly', 'monthly'],
  // src/tools/constants.ts
  CATEGORY_VIEWS: ['list', 'tree', 'search'],
  // src/core/graphql/colors.ts
  COLOR_NAMES: [
    'BLUE1',
    'BROWN1',
    'GRAY1',
    'GREEN1',
    'OLIVE1',
    'ORANGE1',
    'ORANGE2',
    'PINK1',
    'PINK2',
    'PURPLE1',
    'PURPLE2',
    'RED1',
    'RED2',
    'TEAL1',
    'YELLOW1',
    'YELLOW2',
  ],
  // src/conformance/ledger.ts
  CONFORMANCE_CLASSES: ['gated', 'verified-once', 'unverified'],
  // src/models/item.ts
  CONNECTION_STATUSES: ['active', 'error', 'disconnected', 'pending'],
  // src/tools/field-selection.ts
  DEFAULT_CATEGORY_LIVE_FIELDS: [
    'id',
    'parentId',
    'name',
    'colorName',
    'isExcluded',
    'budget_amount',
  ],
  // src/tools/tools.ts
  DEFAULT_COMPACT_TRANSACTION_FIELDS: [
    'transaction_id',
    'date',
    'name',
    'amount',
    'category_name',
    'account_id',
    'pending',
  ],
  // src/tools/field-selection.ts
  DEFAULT_INVESTMENT_PRICE_FIELDS: [
    'security_id',
    'ticker_symbol',
    'price_type',
    'date',
    'month',
    'latest_price',
    'latest_at',
  ],
  // src/tools/field-selection.ts
  DEFAULT_TOP_MOVER_FIELDS: ['security_id', 'ticker_symbol', 'name', 'type', 'change'],
  // src/tools/field-selection.ts
  DEFAULT_TRANSACTION_FIELDS: [
    'transaction_id',
    'date',
    'amount',
    'name',
    'category_name',
    'account_id',
    'item_id',
    'pending',
    'excluded',
    'internal_transfer',
  ],
  // src/models/item.ts
  KNOWN_ERROR_CODES: [
    'ITEM_LOGIN_REQUIRED',
    'INVALID_CREDENTIALS',
    'INVALID_MFA',
    'ITEM_LOCKED',
    'ITEM_NO_ERROR',
    'ITEM_NOT_SUPPORTED',
    'NO_ACCOUNTS',
    'INSTITUTION_DOWN',
    'INSTITUTION_NOT_RESPONDING',
    'INSTITUTION_NO_LONGER_SUPPORTED',
  ],
  // src/models/budget.ts
  KNOWN_PERIODS: ['monthly', 'yearly', 'weekly', 'daily'],
  // src/tools/live/transactions.ts
  LIVE_TRANSACTION_TYPES: ['refunds', 'credits', 'hsa_eligible', 'tagged'],
  // src/models/investment-price.ts
  PRICE_TYPES: ['daily', 'hf'],
  // src/core/graphql/recurrings.ts
  RECURRING_FREQUENCIES: [
    'WEEKLY',
    'BIWEEKLY',
    'MONTHLY',
    'BIMONTHLY',
    'QUARTERLY',
    'QUADMONTHLY',
    'SEMIANNUALLY',
    'ANNUALLY',
  ],
  // src/models/recurring.ts
  RECURRING_STATES: ['active', 'paused', 'archived'],
  // src/core/graphql/recurrings.ts
  RECURRING_STATE_VALUES: ['ACTIVE', 'PAUSED', 'ARCHIVED'],
  // src/utils/scheduled-smoke-status.ts
  SCHEDULED_SMOKE_RESULTS: ['pass', 'fail', 'auth-missing', 'incomplete'],
  // src/conformance/ledger.ts
  SURFACE_KINDS: ['enum', 'input-field', 'response-shape', 'operation', 'applies'],
  // src/tools/live/top-movers.ts
  TOP_MOVERS_FILTERS: ['PRICE_CHANGE', 'MY_EQUITY_CHANGE'],
  // src/core/graphql/transactions.ts
  TRANSACTION_TYPES: ['REGULAR', 'INCOME', 'INTERNAL_TRANSFER'],
  // src/tools/constants.ts
  TRANSACTION_TYPE_FILTERS: [
    'foreign',
    'refunds',
    'credits',
    'duplicates',
    'hsa_eligible',
    'tagged',
  ],
};

describe('exported string constants are pinned (#635 class detector)', () => {
  const discovered = discoverStringConstants();
  const discoveredNames = [...discovered.keys()].sort();

  test('discovery finds constants at all (guards the guard)', () => {
    expect(discoveredNames.length).toBeGreaterThan(0);
  });

  test('forward: every exported string constant in src/ is pinned', () => {
    expect(discoveredNames.filter((name) => !(name in PINNED))).toEqual([]);
  });

  test('backward: every pinned expectation still names a live constant', () => {
    expect(
      Object.keys(PINNED)
        .filter((name) => !discovered.has(name))
        .sort()
    ).toEqual([]);
  });

  for (const name of discoveredNames) {
    test(`${name} members are unchanged`, () => {
      expect([...(discovered.get(name) ?? [])]).toEqual([...(PINNED[name] ?? [])]);
    });
  }
});
