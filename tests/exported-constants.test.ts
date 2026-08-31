/**
 * Bidirectional pin over the exported string-literal `as const` arrays in
 * `src/` — 25 of them across 15 files today. Deliberately not "every constant":
 * SCOPE below names what this grammar cannot see.
 *
 * On the number 25, which these comments quote in several places: it is a
 * SNAPSHOT as of this PR, not an invariant. No test enforces it — the floor is
 * `>= 20` on purpose (see the guards-the-guard test), so adding the 26th
 * constant makes every "25" here stale at once and nothing goes red. The
 * workflow gives no prompt either: forward fails, you add a `PINNED` entry,
 * forward passes, and no comment is touched. Treat the counts as "true when
 * written" and the CHECKS beside them as the evidence; where a count is
 * load-bearing it is stated as a comparison between two numbers derived
 * separately, which stays meaningful whatever the totals become.
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
 *     array whose members are all SINGLE-QUOTED string literals)
 *
 * That shape also sweeps in wire-visible enums and allowlists —
 * RECURRING_FREQUENCIES, KNOWN_ERROR_CODES, COLOR_NAMES, TOP_MOVERS_FILTERS.
 * That is deliberate, not collateral: those have the identical failure mode.
 * Dropping a member changes what we accept from or send to Copilot, and no
 * ratchet elsewhere catches a list getting SHORTER.
 *
 * SCOPE: the grammar below is `export const NAME = [...] as const`, so all of
 * that covers as-const ARRAYS only. A string-literal allowlist declared as
 * `new Set([...])` is invisible to it — TRANSFER_CATEGORIES
 * (src/utils/categories.ts:837) and INCOME_CATEGORIES (:886) are unpinned today
 * for exactly that reason. Known gap, tracked in #695. Said out loud because
 * "no ratchet catches a list getting shorter" must not be read as "every list
 * in src/ is ratcheted": a reader who believes the wider claim stops looking.
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
 * pass quietly. Total failure is the case worth naming: discovery returns
 * nothing, so the forward check passes vacuously and no contents tests are
 * generated at all, leaving the backward check to report it as a 25-name diff.
 * The explicit non-vacuity test exists so that case names one unambiguous
 * reason instead.
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
 * suffix, and the purity check in collectStringConstants keeps only arrays
 * whose members are all SINGLE-QUOTED string literals, so a constant built from
 * spreads, identifiers or numbers is not swept in.
 *
 * FLAGS: `m` is load-bearing. Without it `^` matches only at index 0, so each
 * file yields at most its first declaration and discovery collapses — measured,
 * not assumed: dropping `m` takes the sweep from 25 constants to 0. With it,
 * `^` also anchors every attempt to a line start, so a failed match cannot
 * restart mid-line. `s` is vestigial: no `.` remains in the pattern, and
 * `[^[\]]` / `[^=]` cross newlines by themselves. The character class below is
 * explained in enough detail to suggest every flag was chosen; this one was not.
 *
 * The body is `[^[\]]*?`, not `.*?`: a lazy dotall body lets a declaration
 * that is NOT `as const` scan forward to the next `] as const` anywhere later
 * in the file and swallow every declaration in between, which drops them from
 * the pin silently. Bounding the body to bracket-free text stops the match at
 * its own declaration.
 *
 * ASSUMPTION, same class as stripComments' below and silent in the same way:
 * no member of an `as const` array CONTAINS a bracket character. The array
 * holds no SYNTACTIC brackets by construction — that part is free — but a
 * literal that carries one, say a `fields: ["default"]` hint string, stops the
 * bounded body short of its own `] as const`. The declaration is then never
 * matched, the forward check has nothing to complain about, and the constant
 * leaves the pin without a word. Note the shape: that is #677's own failure,
 * reintroduced by the bound that fixes the swallowing one, so the bound trades
 * a multi-declaration silent drop for a single-declaration silent drop rather
 * than eliminating the class.
 *
 * No such literal sits in an `as const` array in src/ today. The denominator is
 * the load-bearing part: the scan bracket-matches EVERY
 * `export const NAME = [ ... ] as const` in src/, discoverable by this grammar
 * or not, which is a wider net than the matcher above casts. Wider but for one
 * direction: that opener is matched line by line where the grammar's `=\s*\[`
 * crosses newlines, so a declaration wrapped after its `=` falls outside the
 * census while staying inside the grammar — a hole only if it ALSO carries
 * what the grammar rejects: a bracket literal here, a double-quoted member
 * below. Run both ways over src/, the opener returns the same set today. It is
 * a CHECK, not a proof: the walk counts brackets in raw text, so an UNBALANCED
 * one inside a literal (`['a]', 'b']`) closes it early and that declaration
 * goes uncounted — the same class of blind spot as the matcher it is meant to
 * outperform. A balanced pair split across concatenated literals is fine, since
 * the walk never needed them to be in the same literal. Today the net holds: 33
 * declarations match `export const NAME = [` — run WITH the optional type
 * annotation the grammar allows (`NAME: readonly T[] =`, the shape
 * CONFORMANCE_LEDGER uses), which is not a detail: run without it the same
 * opener returns 25, the grammar's own population exactly, and the check cannot
 * fail, because the 8 that miss `as const` ARE the 8 annotated declarations.
 * Of the 33, 25 land on `as const` and 8 correctly do not, and src/'s only two
 * unbalanced-bracket literals (src/tools/field-selection.ts:105 and :106, which
 * balance each other) sit inside an object literal the array walk never enters.
 * That 25 is the same 25 the pin holds, and none of their literals carries a
 * bracket. Counting only the pin's 25 would prove nothing, for the reason
 * spelled out below.
 *
 * The two shapes already coexist in one file though — src/tools/field-selection.ts
 * declares `as const` arrays at :36, :60, :121 and :151 (closing at :47, :68,
 * :127 and :158) and carries bracket-bearing hint literals at :89, :105-106,
 * :137 and :169 — so a `fields:`-hint list landing in one is a plausible next
 * commit rather than a hypothetical. Tracked as #696.
 *
 * ASSUMPTION, another silent-drop mode and the likeliest of them to actually
 * happen: every member is written with SINGLE quotes. `.prettierrc.json` sets
 * `singleQuote: true`, but Prettier's fewer-escapes rule flips any string whose
 * content holds an apostrophe to double quotes, so `bun run format` itself
 * produces:
 *
 *     export const MSGS = ["can't", 'ok'] as const;
 *
 * The item extractor then pairs the apostrophe in `can't` with the quote that
 * opens `ok` — items come back as `["t\", "]`, residue as `"canok'` — the
 * purity check fails, and the constant is dropped. Backtick members behave the
 * same way. This is NOT the "not a string literal" rejection described at the
 * top: a double-quoted string IS a string literal, so a reader checking whether
 * their new constant is covered concludes that it is. Same shape as #677 — not
 * "the pin rejects this" but "the pin never saw it." Unlikely against today's
 * members — but the check has to be run over something other than the 25, since
 * a member holding an apostrophe cannot appear among them BY CONSTRUCTION: that
 * is the hazard itself, not evidence against it. The falsifiable form is to
 * bracket-match every as-const array in src/, discoverable or not, and compare
 * counts: 25 of them, the same 25 the pin holds, none written with a
 * double-quoted or backtick member. Nothing is hidden today — subject to the
 * same caveat as that scan above: it is a check, not a proof. Likely against
 * the first human-readable list anyone adds. Tracked as #696 with the rest of
 * the family.
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
 * ASSUMPTION: no string literal INSIDE an exported `as const` array contains
 * `//` or a block-comment opener. Scoped on purpose, because the unscoped
 * version is false — three URL literals in src/ do contain `//`
 * (src/core/graphql/client.ts, src/core/auth/browser-token.ts,
 * src/core/database.ts) and this helper mangles all three. Note that the reason
 * they are harmless is narrower than "they are not in an array": this helper is
 * applied to the WHOLE file, so stripping deletes from each `//` to end of
 * line wherever it occurs. They are harmless because none of those three LINES
 * carries an `as const` declaration, so the text destroyed is text the matcher
 * would not have matched. Put a URL inside a member and the constant is gone:
 * `export const U = ['https://x'] as const` does not survive stripping. Note
 * WHAT was checked, because the distinction is the whole point of this helper:
 * the count is over extracted member VALUES, after stripping. Two of the 25 raw
 * bodies — IGNORED_ITEM_FIELDS and KNOWN_FREQUENCIES — do contain `//`, as the
 * line comments this helper exists to remove and the live hole #677 fixed.
 * Post-strip, zero of the 25 have a member whose CONTENT holds `//`, and zero
 * string literals anywhere in src/ hold a block-comment opener.
 *
 * Stated rather than left implicit because the failure is SILENT in exactly
 * this file's own direction: mangling a literal makes the residue check reject
 * the array and drop it from the pin. Making this string-aware is the fix when
 * a URL eventually lands in one. A sibling hazard of the same shape: block
 * comments are stripped BEFORE line comments, so a line comment containing a
 * block-comment opener lets the block regex run to the next closer and delete
 * the declarations in between. Both tracked in #691.
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

/**
 * The tree-wide sweep: collectStringConstants applied to every .ts under src/.
 *
 * ASSUMPTION, and the one member of the family with teeth: constant names are
 * unique across src/. The map is keyed by name alone, so two files exporting
 * the same name collapse last-write-wins. Checked as two independently derived
 * numbers: the grammar matches 25 declarations in src/, and they reduce to 25
 * distinct map keys. Counting the map alone could never show this — collisions
 * are precisely what the map hides, so `discovered.size === 25` would hold
 * either way.
 *
 * The branch that decides how bad it gets is WHICH FILE WINS RELATIVE TO WHAT
 * THE PIN HOLDS — not whether the two arrays agree. The name is present either
 * way, so forward and backward are satisfied in every case and only the contents
 * test can move:
 *
 *   arrays differ, pin matches the WINNER -> all three green, and the loser is a
 *     live declaration in src/ that no test touches. Silent, stable and
 *     indefinite on machines whose readdirSync order produces that winner;
 *     elsewhere the same pin matches the LOSER instead. The dangerous one, and
 *     the one the workflow RATCHETS TOWARDS — see below.
 *   arrays differ, pin matches the LOSER  -> contents red, but only where
 *     readdirSync order makes the OTHER file win. Loud where it fires.
 *   arrays identical                      -> quiet and stable; the loser is
 *     uncovered but currently says the same thing, until it drifts.
 *
 * The ratchet, which is why the pin-matches-WINNER branch is not merely one
 * outcome in three: `PINNED` entries are authored from what discovery REPORTS.
 * So pin-matches-LOSER does not persist — the author sees contents red,
 * reconciles the pin against the actual output, i.e. against the winner, and
 * lands in pin-matches-WINNER. The decay happens on whichever machine last
 * edited the pin, which is also why pin-matches-LOSER presents as a
 * CROSS-MACHINE symptom: the same pin matches the winner here and the loser on
 * a machine whose readdirSync order differs. Not a probability argument — a
 * property of how the pin gets written.
 *
 * Unlike its siblings, no branch drops a NAME the backward check could notice:
 * this one substitutes rather than drops. Tracked as #694.
 */
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
    // Coverage floor, deliberately loose in BOTH directions. An exact count
    // churns on every constant added; a floor flush against today's 25 churns
    // on every legitimate deletion, where a constant leaves src/ and its pin
    // together. The slack is what keeps this test about its one job —
    // discovery collapsing to a handful, which is the failure that would make
    // every other test in this file vacuous at once.
    expect(discovered.size).toBeGreaterThanOrEqual(20);
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

  test('a non-as-const array is not itself discovered', () => {
    // CONFORMANCE_LEDGER (src/conformance/ledger.ts) is `readonly LedgerEntry[]`
    // with no `as const`; it must not consume the declarations that follow it.
    // A shape pin only. The detectors are the synthetic snippets below: the
    // boundary one for the body bound, and the semicolon-free one for the
    // annotation bound.
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

  test('an annotated declaration is still discovered', () => {
    // The complement of the boundary snippet above, and the reason it is
    // needed: an annotation appears nowhere else in this file except on a
    // declaration asserted ABSENT (NOT_A_PIN there, CONFORMANCE_LEDGER above),
    // and nothing in the tree exercises it either — the 8 annotated
    // declarations in src/ are exactly the 8 the grammar excludes for missing
    // `as const`, so no input from the tree reaches the accepting branch
    // today. Delete `(?::[^=]+)?` from the grammar and every other test in this
    // file stays green; that was checked by deleting it, not assumed.
    //
    // The shape is not hypothetical, though not for the obvious reason:
    // adding `as const` to one of those 8 would change nothing either way,
    // since none of them is a pure single-quoted string array — numbers,
    // identifiers, object literals, spreads — so the purity check rejects
    // them with or without this group. Checked by extracting all 8 bodies and
    // applying the residue rule: zero pure. What the group is load-bearing
    // for is the COMPOSITION of two shapes src/ already writes separately,
    // the annotation (8 times) and the pure string-literal `as const` array
    // (25 times), meeting in one declaration — `export const FOO: readonly
    // string[] = ['a', 'b'] as const`. That is the commit that would
    // otherwise leave discovery without a word, the #677 failure again.
    const found = collectStringConstants(
      "export const ANNOTATED: readonly string[] = ['a', 'b'] as const;"
    );
    expect([...(found.get('ANNOTATED') ?? [])]).toEqual(['a', 'b']);
  });

  test('an annotation cannot reach past its own declaration', () => {
    // The other half of `(?::[^=]+)?`. The accepting half is pinned above;
    // this is the bound: `[^=]+` cannot cross the declaration's own `=`, so an
    // annotated NON-as-const declaration cannot reach a later string-literal
    // `as const` declaration and take its members under the wrong name.
    //
    // What survives the rest of the file is not one mutation but a family:
    // any bound whose stop character does not appear between these two
    // declarations. A dotall is not in it — loosening to `[\s\S]+?` already
    // turns the boundary snippet, forward and one contents test red — but a
    // bound that merely stops SOMEWHERE ELSE is. The rule generates its own
    // survivors, so whatever the decoy carries is a hole: with the previous
    // decoy body `{ field: 1 },`, each of `[^{]+`, `[^}]+`, `[^,]+` and
    // `[^:]+` cleared the whole file. Four characters it did not need, four
    // holes.
    //
    // Hence a decoy with no punctuation in it at all. Sweeping 35 bounds — 33
    // negated-class variants over ASCII punctuation, digits and newline, plus
    // both dotall forms — mutated one at a time into the grammar and run
    // against this file, this snippet detects 32. Of the rest, `[^ ]+` is
    // caught by the accepting test above rather than here, and `[^_]+` and
    // `[^\n]+` are caught by nothing: the first halts on the `_` in the
    // constant NAMES, the second cannot cross a line start, which is where
    // every declaration begins, so it narrows discovery instead of swallowing
    // a neighbour. None of the three is a bound anyone would write — spaces,
    // underscores and newlines are what a declaration is made of.
    //
    // The rule to preserve is that the decoy carries no character a plausible
    // bound would stop at, beyond the `=` such a bound stops at by definition
    // and the letters and spaces every declaration has. It is easy to lose:
    // annotating it `readonly Thing[]` was enough to hand `[^[]+`, `[^\]]+`
    // and `[^[\]]+` — the body bound copied up one line — to the accepting
    // test rather than this one. Measured, and why the type here is bare. Do
    // not give the decoy a body to make it match the boundary snippet.
    const snippet = [
      'export const ANNOTATED_NOT_A_PIN: Thing = x',
      '',
      "export const AFTER_IT = ['alpha'] as const;",
    ].join('\n');
    const found = collectStringConstants(snippet);
    expect(found.has('ANNOTATED_NOT_A_PIN')).toBe(false);
    expect([...(found.get('AFTER_IT') ?? [])]).toEqual(['alpha']);
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
