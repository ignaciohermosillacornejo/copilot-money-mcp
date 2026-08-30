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
 *
 * The body is `[^[\]]*?`, not `.*?`: a lazy dotall body lets a declaration
 * that is NOT `as const` scan forward to the next `] as const` anywhere later
 * in the file and swallow every declaration in between, which drops them from
 * the pin silently. Bounding the body to bracket-free text stops the match at
 * its own declaration. Costs nothing here — a pure string-literal array holds
 * no brackets by construction.
 */
const EXPORTED_ARRAY =
  /^export const ([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[([^[\]]*?)\]\s*as const/gms;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip line and block comments so the matcher can see the array literal
 * underneath. Without this an inline `//` leaves residue, the purity check in
 * collectStringConstants rejects the array, and the constant drops out of the
 * pin without a word.
 *
 * ASSUMPTION: no string literal in `src/` contains `//` or a block-comment
 * opener. Stated rather than left implicit because the failure is SILENT in
 * exactly this file's own direction: mangling a literal makes the residue check
 * reject the array and drop it from the pin. That is a known limitation, not
 * something to work around here — a URL inside an exported `as const` array is
 * the realistic case, and making this string-aware is the fix if one ever
 * lands. A sibling hazard of the same shape: block comments are stripped
 * BEFORE line comments, so a line comment that contains a block-comment opener
 * lets the block regex run forward to the next closer and delete the real
 * declarations in between. Neither case occurs in `src/` today; both are
 * tracked separately.
 *
 * Same helper and same caveat as tests/core/decoder-field-completeness.test.ts,
 * duplicated on purpose rather than shared, so neither file's parsing rules can
 * be changed out from under the other.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Collect every exported string-literal `as const` array in ONE file's source
 * text.
 *
 * Split out from the tree walk on purpose: a discovery mechanism whose only
 * input is the real source tree can only be mutation-tested by the accidents
 * of what that tree happens to contain today. Feeding it a synthetic snippet
 * lets the tests below pin the parsing rules themselves.
 */
function collectStringConstants(source: string): Map<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  // Strip comments before matching: an inline `//` inside an array literal
  // leaves residue that the purity check below rejects, so a commented array
  // is dropped from the pin without a word. An under-reporting pin is
  // indistinguishable from a passing one.
  const text = stripComments(source);
  for (const match of text.matchAll(EXPORTED_ARRAY)) {
    const [, name, rawBody] = match;
    if (name === undefined || rawBody === undefined) continue;
    const items = [...rawBody.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
    // Everything that is not a string literal, comma or whitespace: if
    // anything remains, the array is not purely string literals.
    const residue = rawBody.replace(/'[^']*'|,|\s/g, '');
    if (items.length > 0 && residue === '') found.set(name, items);
  }
  return found;
}

/** The tree-wide sweep: collectStringConstants applied to every .ts under src/. */
function discoverStringConstants(): Map<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  for (const file of tsFilesUnder(SRC_ROOT)) {
    for (const [name, items] of collectStringConstants(readFileSync(file, 'utf-8'))) {
      found.set(name, items);
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
  IGNORED_ITEM_FIELDS: [
    'access_token',
    'deleted_access_token',
    'akoya',
    'available_products',
    'billed_products',
    'optional_products',
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
  // src/models/recurring.ts
  KNOWN_FREQUENCIES: [
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'bimonthly',
    'quarterly',
    'quadmonthly',
    'semiannually',
    'yearly',
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
    // Coverage floor, deliberately not an exact count: an exact one would churn
    // on every constant added, while a floor still catches discovery collapsing
    // to a handful — the failure this file exists to make loud.
    expect(discovered.size).toBeGreaterThanOrEqual(25);
  });

  test('comment-carrying arrays survive stripping', () => {
    // Synthetic rather than tree-derived, for the same reason
    // collectStringConstants is split out at all: a routine cleanup that
    // dropped the `// Every 2 weeks`-style comments from src/models/recurring.ts
    // would leave a tree-based version of this test green while it exercised
    // nothing.
    const found = collectStringConstants(
      ['export const WITH_NOTES = [', "  'a', // note", "  'b',", '] as const;'].join('\n')
    );
    expect([...(found.get('WITH_NOTES') ?? [])]).toEqual(['a', 'b']);
  });

  test('the constants whose literals carry inline comments are in the pin', () => {
    // These two were outside the pin until #677, for exactly that reason. This
    // is a membership check on the real tree, not a test of the stripping rule
    // — that is the synthetic test above.
    expect(discovered.has('KNOWN_FREQUENCIES')).toBe(true);
    expect(discovered.has('IGNORED_ITEM_FIELDS')).toBe(true);
  });

  test('a non-as-const array does not swallow the as-const arrays after it', () => {
    // CONFORMANCE_LEDGER (src/conformance/ledger.ts) is `readonly LedgerEntry[]`
    // with no `as const`; it must not consume the declarations that follow it.
    // A shape pin only — the detector for the rule is the synthetic test below.
    expect(discovered.has('CONFORMANCE_LEDGER')).toBe(false);
  });

  test('declaration boundaries: a non-as-const array cannot reach a later `] as const`', () => {
    // The tree cannot detect this, and NOT because the greedy match fails to
    // happen — it happens. In src/conformance/ledger.ts, CONFORMANCE_LEDGER at
    // :305 is not `as const`, and the first `] as const` ahead of it is the
    // INLINE `(['id', 'accountId', 'itemId'] as const)` at :493, so the old
    // lazy body matched 305 -> 493 and the sweep resumed past the whole span.
    // Nothing is lost from the pin only because that span happens to contain no
    // exported string-literal declaration — an accident of today's tree, not a
    // property of it. This snippet puts a declaration inside such a span, which
    // is what makes the boundary rule mutation-detectable at all.
    const snippet = [
      'export const NOT_A_PIN: readonly Thing[] = [',
      '  { field: 1 },',
      '];',
      '',
      "export const AFTER_THE_LEDGER = ['alpha', 'beta'] as const;",
      '',
    ].join('\n');
    const found = collectStringConstants(snippet);
    expect(found.has('NOT_A_PIN')).toBe(false);
    expect([...(found.get('AFTER_THE_LEDGER') ?? [])]).toEqual(['alpha', 'beta']);
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
