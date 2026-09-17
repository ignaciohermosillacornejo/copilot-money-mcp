/**
 * Bidirectional pin over the exported string-literal constant LISTS in `src/` —
 * `as const` arrays and `new Set([...])` allowlists. 30 of them across 15 files
 * today. Deliberately not "every constant": SCOPE below names what this walk
 * does not take.
 *
 * On the number 30, which these comments quote in a few places: it is a
 * SNAPSHOT, not an invariant. No test enforces it — the floor is `>= 20` on
 * purpose (see the guards-the-guard test), so adding the 31st constant makes
 * every "30" here stale at once and nothing goes red. The workflow gives no
 * prompt either: forward fails, you add a `PINNED` entry, forward passes, and
 * no comment is touched. Treat the counts as "true when written" and the CHECKS
 * beside them as the evidence; where a count is load-bearing it is stated as a
 * comparison between two numbers derived separately, which stays meaningful
 * whatever the totals become.
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
 *              (7 entries, decided the `compact: true` row) stayed exposed:
 *              three of its seven could be deleted, suite still green. That
 *              preset and its boolean were deleted outright in #604, when
 *              DEFAULT_TRANSACTION_FIELDS became the default row.
 *
 * Each fix reproduced the bug it was fixing, one level up: assert the field →
 * forget a field; pin the preset → forget a preset; discover in a module →
 * forget a module. Every version left a list someone had to remember.
 *
 * So discovery here reads the SOURCE TREE, not a module and not a name
 * convention:
 *   - cross-module: a preset anywhere under src/ is found
 *   - name-agnostic: a constant that ignores the DEFAULT_*_FIELDS convention is
 *     still found, because the filter is SHAPE — an exported const whose
 *     initializer is a const-asserted array of string literals, or a `Set`
 *     built from one. The name is not looked at at all. It used to be: the
 *     previous grammar required a SCREAMING_CASE name, which quietly excluded a
 *     camelCase allowlist while the paragraph above claimed otherwise. Dropping
 *     the name class changes nothing today — measured, both ways, same 30 — and
 *     removes the gap between the claim and the code.
 *
 * That shape also sweeps in wire-visible enums and allowlists —
 * RECURRING_FREQUENCIES, KNOWN_ERROR_CODES, COLOR_NAMES, TOP_MOVERS_FILTERS,
 * TRANSFER_CATEGORIES. That is deliberate, not collateral: those have the
 * identical failure mode. Dropping a member changes what we accept from or send
 * to Copilot, or which transactions we call transfers, and no ratchet elsewhere
 * catches a list getting SHORTER.
 *
 * HOW DISCOVERY WORKS, AND WHY IT IS A PARSER
 *
 * `collectStringConstants` walks the TypeScript AST (`ts.createSourceFile`).
 * The previous version was a regex over comment-stripped text, and every one of
 * its silent-drop modes came from the same root: a regex does not know what a
 * string literal is. Five issues, one defect:
 *
 *   #691  the comment stripper was not string-aware, so a `//` inside a URL
 *         literal deleted the rest of its own declaration, and a block-comment
 *         opener inside a LINE comment let the block pass run forward and eat
 *         whole declarations.
 *   #696  the array body was bounded to bracket-free text (to stop a non-const
 *         declaration scanning forward into a later `] as const`), so any
 *         member CONTAINING a bracket stopped the body short and dropped its
 *         own declaration.
 *   #695  `new Set([...])` was not in the grammar at all, leaving
 *         TRANSFER_CATEGORIES and INCOME_CATEGORIES unpinned — the only one of
 *         the five with a present-day instance rather than a latent one.
 *   #694  the sweep keyed by name alone, so two files exporting the same name
 *         collapsed last-write-wins and one live declaration went unpinned with
 *         nothing to report it.
 *   #699  the decoy identifier in the annotation-boundary test contained an
 *         underscore, so a `[^_]+` mutation of the annotation bound survived
 *         every test in the file.
 *
 * A parser answers the first three by construction (comments are trivia, string
 * contents are `.text`, an initializer shape is a node kind rather than a span
 * of characters), the fourth is now reported instead of merged, and the fifth
 * had nothing left to mutate once the bounds were gone — so the mutation
 * coverage it was about is re-aimed at the shapes a parser CAN still get wrong.
 * See the "rejects" tests below.
 *
 * HISTORY, kept because the shape recurs and not because it is still live: the
 * regex era's hazards were double-quoted members (the extractor only matched
 * single quotes, and Prettier's fewer-escapes rule flips any string holding an
 * apostrophe to double quotes — so `bun run format` itself could silently
 * unpin a constant), bracket-bearing members, and `//` inside a literal. All
 * three are now ordinary input: the AST does not distinguish quote styles, and
 * a literal's content is never scanned for syntax. The tests below pin each one
 * so the guarantee is checked rather than asserted.
 *
 * SCOPE — what this walk still does not take, said out loud because "no ratchet
 * catches a list getting shorter" must not be read as "every list in src/ is
 * ratcheted"; a reader who believes the wider claim stops looking:
 *
 *   - members that are not string literals: spreads, identifiers, numbers,
 *     computed values, template literals with substitutions. A list built from
 *     `[...OTHER, 'x']` is not pinned, and its rejection is deliberate — the
 *     members are not statically known here.
 *   - an array with no const assertion, and a `Set` built from anything but an
 *     array literal of string literals.
 *   - `Set` specifically, by that bare name. `new Map([...])`, a subclass, or
 *     `globalThis.Set` are not taken.
 *   - constants that are not top-level exports of a module.
 *   - empty lists. There is nothing to pin, and an empty pin is the vacuous
 *     shape this file exists to avoid.
 *
 * HOW IT FAILS (every direction is mutation-tested in this file's PR)
 *
 *   forward    a constant exists in src/ with no pinned expectation
 *              -> someone added one and no test came with it
 *   backward   a pinned expectation names a constant no longer in src/
 *              -> a stale expectation quietly protecting nothing
 *   contents   a pinned constant's members changed
 *   collision  one name is exported from two files -> one of them is unpinned
 *              no matter what the pin says, so it is reported rather than
 *              silently merged (#694)
 *
 * The backward direction also guards the DISCOVERY MECHANISM itself: if the
 * walk silently stops matching (a refactor to a declaration style it does not
 * take), the constants it can no longer see read as "vanished" and the backward
 * check goes red. A partial under-match cannot pass quietly. Total failure is
 * the case worth naming: discovery returns nothing, so the forward check passes
 * vacuously and no contents tests are generated at all, leaving the backward
 * check to report it as a 30-name diff. The explicit non-vacuity test exists so
 * that case names one unambiguous reason instead.
 *
 * MAINTENANCE: changing one of these deliberately means updating the entry
 * below. That is the intended workflow — the point is that it cannot happen
 * SILENTLY.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { scriptKindFor, tsFilesUnder } from './helpers/ts-files.js';

const SRC_ROOT = join(import.meta.dir, '..', 'src');

/** How a discovered constant was written. Both shapes carry the same risk. */
type InitializerKind = 'as-const-array' | 'set';

type Discovered = {
  readonly items: readonly string[];
  readonly kind: InitializerKind;
};

/** One name exported from more than one file — see #694. */
type Collision = {
  readonly name: string;
  readonly files: readonly string[];
};

type Sweep = {
  readonly constants: Map<string, Discovered>;
  readonly collisions: readonly Collision[];
};

/** `as const` is a type reference to the identifier `const`, nothing else. */
function isConstAssertion(type: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'const'
  );
}

/**
 * Strip `(...)`, `as T` and `satisfies T` off an expression, reporting
 * SEPARATELY whether an `as const` was among them.
 *
 * The two answers are separate because the callers want different ones: an
 * array must carry an assertion to be a pin, a `Set` needs none. Fusing them —
 * returning null when no `as const` was seen — means the `Set` branch cannot
 * peel without also demanding an assertion it does not want, and
 * `new Set(['a'] satisfies readonly string[])` drops out with no signal. Which
 * is this file's own bug class, in the file that closes it. Found in review of
 * this PR, not by these tests, which is itself the finding.
 *
 * `satisfies` is load-bearing, not defensive: six declarations in src/ are
 * written `[...] as const satisfies readonly T[]` — four of them against a
 * `keyof Row`, which is how the field presets stay checked against the row they
 * select from. A walk that only knew `as const` found 24 constants where the
 * tree holds 30 — measured by running both, not reasoned about.
 */
function peel(expr: ts.Expression): { readonly expr: ts.Expression; readonly sawConst: boolean } {
  let current: ts.Expression = expr;
  let sawConst = false;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current)) {
      if (isConstAssertion(current.type)) sawConst = true;
      current = current.expression;
    } else {
      return { expr: current, sawConst };
    }
  }
}

/**
 * Members of an array literal whose every element is a string literal, or null.
 *
 * `ts.isStringLiteral` covers single AND double quotes — the AST does not
 * record which was typed — so the quote-style hazard the regex era carried is
 * gone rather than merely unexercised. A no-substitution template (a backtick
 * string with no `${}`) is a string literal too and is taken; a template WITH
 * substitutions is not statically known and is rejected with everything else.
 *
 * Empty arrays return null: a pin over no members protects nothing.
 */
function stringLiteralMembers(expr: ts.Expression): string[] | null {
  if (!ts.isArrayLiteralExpression(expr)) return null;
  const items: string[] = [];
  for (const element of expr.elements) {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      items.push(element.text);
    } else {
      // Spread, identifier, number, property access, nested array, hole.
      return null;
    }
  }
  return items.length > 0 ? items : null;
}

/** `new Set(<one argument>)`, by that bare name, with no other call shape. */
function setArgument(expr: ts.Expression): ts.Expression | null {
  if (!ts.isNewExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'Set') return null;
  const args = expr.arguments;
  if (args === undefined || args.length !== 1) return null;
  return args[0] ?? null;
}

/**
 * The members a declaration's initializer pins, or null if it pins nothing.
 *
 * Peel FIRST, then dispatch on what is underneath — rather than trying each
 * accepted shape against the raw initializer in turn. The first version did the
 * latter and had two silent drops from it: the `Set` branch never saw a wrapper
 * OUTSIDE the call (`new Set([...]) satisfies ReadonlySet<string>`), and an
 * inner `as const` was required before an inner `satisfies` could be peeled.
 * `new Set(['a']) as const` hit both at once — the array branch consumed the
 * assertion, handed a `NewExpression` to the array reader, got null, and
 * returned before the `Set` branch ran.
 *
 * `sawConst` is consulted only where it means something. An array literal must
 * carry an assertion to be a pin; an un-asserted one is a mutable, widened list
 * and is REJECTED. A `Set` needs none: `new Set([...])` is already an allowlist.
 */
function initializerMembers(initializer: ts.Expression): Discovered | null {
  const { expr, sawConst } = peel(initializer);

  if (ts.isArrayLiteralExpression(expr)) {
    if (!sawConst) return null;
    const items = stringLiteralMembers(expr);
    return items === null ? null : { items, kind: 'as-const-array' };
  }

  const argument = setArgument(expr);
  if (argument !== null) {
    const items = stringLiteralMembers(peel(argument).expr);
    return items === null ? null : { items, kind: 'set' };
  }

  return null;
}

/**
 * Collect every exported string-literal constant list in ONE file's source.
 *
 * Split out from the tree walk on purpose: a discovery mechanism whose only
 * input is the real source tree can only be mutation-tested by the accidents of
 * what that tree happens to contain today. Feeding it a synthetic snippet lets
 * the tests below pin the parsing rules themselves.
 *
 * No comment handling of any kind appears here, and that absence is the fix for
 * #691. Comments are trivia to the parser: they are attached to nodes, never
 * mistaken for code, and a comment marker inside a string literal is just two
 * characters of that string's content.
 */
function collectStringConstants(source: string, fileName = 'snippet.ts'): Map<string, Discovered> {
  const found = new Map<string, Discovered>();
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    // From the extension, not hardcoded: a `.tsx` parsed as `.ts` misreads
    // `<T>(x) => x`. The sweep now reaches those files (see ts-files.ts), so
    // the kind has to follow.
    scriptKindFor(fileName)
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported !== true) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.initializer === undefined) continue;
      const discovered = initializerMembers(declaration.initializer);
      if (discovered !== null) found.set(declaration.name.text, discovered);
    }
  }

  return found;
}

/**
 * The cross-file sweep, with collisions REPORTED rather than merged.
 *
 * #694: the previous version kept a single `Map` keyed by name, so two files
 * exporting the same name collapsed last-write-wins. Both directions of the
 * guard stayed green — the name is present either way — and which declaration
 * survived depended on `readdirSync` order, so the same pin could match the
 * winner on one machine and the loser on another. Nothing anywhere reported
 * that a second declaration existed.
 *
 * It is not enough to key by `file + name`: that pins both, which reads as a
 * fix but leaves two exported constants sharing a name across src/, which is
 * worth a human look regardless of what this guard wants. So the sweep collects
 * the collision and a test fails on it, naming both paths.
 *
 * Takes its files as text rather than reading them, for the same reason
 * `collectStringConstants` is split out: a two-file collision cannot be staged
 * in the real tree, so without this seam the collision branch would be
 * unexercised code asserted to work.
 */
function sweepFiles(files: readonly { readonly path: string; readonly source: string }[]): Sweep {
  const constants = new Map<string, Discovered>();
  const sources = new Map<string, string[]>();

  for (const file of files) {
    for (const [name, discovered] of collectStringConstants(file.source, file.path)) {
      constants.set(name, discovered);
      const seen = sources.get(name);
      if (seen === undefined) sources.set(name, [file.path]);
      else seen.push(file.path);
    }
  }

  const collisions: Collision[] = [];
  for (const [name, paths] of sources) {
    if (paths.length > 1) collisions.push({ name, files: paths });
  }
  collisions.sort((a, b) => a.name.localeCompare(b.name));

  // A colliding name is REMOVED from the map, not merely reported. Leaving the
  // last-written declaration in would make the per-name contents test flip with
  // `readdirSync` order alongside the loud collision failure — a
  // machine-dependent red stacked on a deterministic one. Dropping it means the
  // collision test fires, and backward fires if the name is pinned, and both
  // say the same true thing: this name is not pinnable until one of the two
  // declarations is renamed.
  for (const collision of collisions) constants.delete(collision.name);

  return { constants, collisions };
}

function discoverStringConstants(): Sweep {
  return sweepFiles(
    tsFilesUnder(SRC_ROOT).map((path) => ({ path, source: readFileSync(path, 'utf-8') }))
  );
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
  // src/core/schema-warn.ts — every name here is silenced on EVERY collection,
  // so a third entry hides a third field database-wide. That is a decision,
  // not a one-line edit, and this pin is what makes it look like one.
  FIRESTORE_BACKEND_MARKERS: ['_migration_backfill', '_replicated_at'],
  // src/tools/field-selection.ts
  DEFAULT_ACCOUNT_FIELDS: [
    'account_id',
    'name',
    'account_type',
    'subtype',
    'current_balance',
    'institution_name',
    'iso_currency_code',
    'item_id',
    'user_hidden',
    'user_deleted',
  ],
  // src/tools/field-selection.ts
  DEFAULT_ACCOUNT_LIVE_FIELDS: [
    'id',
    'name',
    'type',
    'subType',
    'balance',
    'institutionId',
    'itemId',
    'isUserHidden',
    'isUserClosed',
  ],
  // src/tools/field-selection.ts
  DEFAULT_CATEGORY_LIVE_FIELDS: [
    'id',
    'parentId',
    'name',
    'colorName',
    'isExcluded',
    'budget_amount',
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
  DEFAULT_RECURRING_CACHE_FIELDS: [
    'merchant',
    'normalized_merchant',
    'occurrences',
    'average_amount',
    'total_amount',
    'frequency',
    'confidence',
    'category_name',
    'last_date',
    'next_expected_date',
  ],
  // src/tools/field-selection.ts
  DEFAULT_RECURRING_LIVE_FIELDS: [
    'id',
    'name',
    'state',
    'frequency',
    'nextPaymentAmount',
    'nextPaymentDate',
    'categoryId',
    'category_name',
    'emoji',
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
  // src/utils/categories.ts — `new Set([...])`, unpinned until #695
  INCOME_CATEGORIES: [
    'income',
    'income_dividends',
    'income_interest_earned',
    'income_retirement_pension',
    'income_tax_refund',
    'income_unemployment',
    'income_wages',
    'income_other_income',
    'paycheck',
    'salary',
    'bonus',
    'refund',
    'reimbursement',
    'dividend',
    '15000000',
    '15001000',
    '21007000',
    '21005003',
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
  // src/utils/categories.ts — `new Set([...])`, unpinned until #695. Decides
  // what `exclude_transfers` removes, so a dropped member reclassifies real
  // transactions as spending. Its only prior coverage was a one-member spot
  // check (`.has('transfer_in')`).
  TRANSFER_CATEGORIES: [
    'transfer_in',
    'transfer_in_account_transfer',
    'transfer_in_cash_advances_and_loans',
    'transfer_in_deposit',
    'transfer_in_investment_and_retirement_funds',
    'transfer_in_savings',
    'transfer_in_other_transfer_in',
    'transfer_out',
    'transfer_out_account_transfer',
    'transfer_out_investment_and_retirement_funds',
    'transfer_out_savings',
    'transfer_out_withdrawal',
    'transfer_out_other_transfer_out',
    'loan_payments_credit_card_payment',
    '21000000',
    '21001000',
    '21002000',
    '21003000',
    '21004000',
    '21005000',
    '21005001',
    '21005002',
    '21005003',
    '21006000',
    '21007000',
    '21008000',
    '21009000',
    '21009001',
    '21009002',
    '21009003',
    '21009004',
    '21009005',
    '21009006',
    '21009007',
    '21009008',
    '21009009',
    '21010000',
    '21010001',
    '21010002',
    '21011000',
  ],
};

describe('exported string constants are pinned (#635 class detector)', () => {
  const sweep = discoverStringConstants();
  const discovered = sweep.constants;
  const discoveredNames = [...discovered.keys()].sort();

  test('discovery finds constants at all (guards the guard)', () => {
    expect(discoveredNames.length).toBeGreaterThan(0);
    // Coverage floor, deliberately loose in BOTH directions. An exact count
    // churns on every constant added; a floor flush against today's 30 churns
    // on every legitimate deletion, where a constant leaves src/ and its pin
    // together. The slack is what keeps this test about its one job —
    // discovery collapsing to a handful, which is the failure that would make
    // every other test in this file vacuous at once.
    expect(discovered.size).toBeGreaterThanOrEqual(20);
  });

  test('both initializer shapes are exercised by the real tree', () => {
    // Non-vacuity for the two branches of `initializerMembers`. Without this,
    // a broken `Set` branch would look like "those two constants vanished"
    // only because they happen to be pinned; a shape with no pinned instance
    // would produce no signal at all.
    const kinds = new Set([...discovered.values()].map((d) => d.kind));
    expect([...kinds].sort()).toEqual(['as-const-array', 'set']);
  });

  test('the Set-declared allowlists are in the pin (#695)', () => {
    // Membership on the real tree. TRANSFER_CATEGORIES and INCOME_CATEGORIES
    // were invisible to the previous grammar, which only knew `[...] as const`.
    // Their only other coverage asserts one member each, so every other member
    // was deletable with the suite green.
    expect(discovered.get('TRANSFER_CATEGORIES')?.kind).toBe('set');
    expect(discovered.get('INCOME_CATEGORIES')?.kind).toBe('set');
  });

  test('the constants whose literals carry inline comments are in the pin', () => {
    // These two were outside the pin until #677, because a comment inside the
    // array left residue the old purity check rejected. A membership check on
    // the real tree, not a test of the parsing rule — that is synthetic, below.
    expect(discovered.has('KNOWN_FREQUENCIES')).toBe(true);
    expect(discovered.has('IGNORED_ITEM_FIELDS')).toBe(true);
  });

  test('a non-as-const array is not itself discovered', () => {
    // CONFORMANCE_LEDGER (src/conformance/ledger.ts) is `readonly LedgerEntry[]`
    // with no `as const`. A shape pin only; the detector for the rule is the
    // synthetic rejection test below.
    expect(discovered.has('CONFORMANCE_LEDGER')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // What the parser takes. Each of these was a silent drop before this PR.
  // -------------------------------------------------------------------------

  test('accepts: a comment inside the array does not affect its members', () => {
    // Synthetic rather than tree-derived, for the same reason
    // collectStringConstants is split out at all: a routine cleanup that
    // dropped the `// Every 2 weeks`-style comments from src/models/recurring.ts
    // would leave a tree-based version of this test green while it exercised
    // nothing.
    const found = collectStringConstants(
      ['export const WITH_NOTES = [', "  'a', // note", "  'b',", '] as const;'].join('\n')
    );
    expect([...(found.get('WITH_NOTES')?.items ?? [])]).toEqual(['a', 'b']);
  });

  test('accepts: a member containing a line-comment marker (#691)', () => {
    // The regex era stripped comments from the whole file with no idea what a
    // string was, so this declaration ended at the `//` and vanished.
    const found = collectStringConstants(
      "export const URLS = ['https://example.invalid/a', 'b'] as const;"
    );
    expect([...(found.get('URLS')?.items ?? [])]).toEqual(['https://example.invalid/a', 'b']);
  });

  test('accepts: a block-comment opener inside a line comment eats nothing (#691)', () => {
    // The sibling half of #691. Block comments were stripped BEFORE line
    // comments, so an opener sitting inside a line comment let the block pass
    // run forward to the next closer and delete every declaration in between.
    // The closer here is on the line after the declaration, so the old
    // stripper removed FIRST entirely.
    const snippet = [
      '// mentions a block opener: /*',
      "export const FIRST = ['a'] as const;",
      '/* an ordinary block comment */',
      "export const SECOND = ['b'] as const;",
    ].join('\n');
    const found = collectStringConstants(snippet);
    expect([...(found.get('FIRST')?.items ?? [])]).toEqual(['a']);
    expect([...(found.get('SECOND')?.items ?? [])]).toEqual(['b']);
  });

  test('accepts: a member containing a bracket (#696)', () => {
    // The body bound `[^[\]]*?` could not cross a bracket CHARACTER, so a hint
    // string like this one stopped the match short of its own `] as const` and
    // the declaration left the pin without a word. src/tools/field-selection.ts
    // already carries both shapes — bracket-bearing hint literals and `as const`
    // arrays — so this was a plausible next commit, not a hypothetical.
    const found = collectStringConstants(
      'export const HINTS = [\'use fields: ["a", "b"]\', \'or "all"\'] as const;'
    );
    expect([...(found.get('HINTS')?.items ?? [])]).toEqual(['use fields: ["a", "b"]', 'or "all"']);
  });

  test('accepts: a double-quoted member', () => {
    // Prettier's fewer-escapes rule flips any string holding an apostrophe to
    // double quotes, so `bun run format` itself could produce a member the
    // single-quote extractor mispaired — and the constant dropped out. The AST
    // does not record which quote was typed.
    const found = collectStringConstants("export const MSGS = [\"can't\", 'ok'] as const;");
    expect([...(found.get('MSGS')?.items ?? [])]).toEqual(["can't", 'ok']);
  });

  test('accepts: a Set-declared allowlist, whichever wrapper it wears (#695)', () => {
    // A wrapper can sit OUTSIDE the call or INSIDE the argument, and neither
    // position changes what the declaration means. The first version of this
    // walk peeled only the inside, and only when the peel found an `as const`,
    // so three of the six below dropped out silently — this file's own bug
    // class, caught in review of this PR rather than by these tests.
    const found = collectStringConstants(
      [
        "export const PLAIN = new Set(['a', 'b']);",
        "export const ASSERTED = new Set(['c'] as const);",
        "export const SET_SATISFIES = new Set(['d']) satisfies ReadonlySet<string>;",
        "export const SET_ARG_SATISFIES = new Set(['e'] satisfies readonly string[]);",
        "export const SET_PARENS = (new Set(['f']));",
        "export const SET_AS_CONST_OUTSIDE = new Set(['g']) as const;",
      ].join('\n')
    );
    expect([...(found.get('PLAIN')?.items ?? [])]).toEqual(['a', 'b']);
    expect(found.get('PLAIN')?.kind).toBe('set');
    expect([...(found.get('ASSERTED')?.items ?? [])]).toEqual(['c']);
    expect([...(found.get('SET_SATISFIES')?.items ?? [])]).toEqual(['d']);
    expect([...(found.get('SET_ARG_SATISFIES')?.items ?? [])]).toEqual(['e']);
    expect([...(found.get('SET_PARENS')?.items ?? [])]).toEqual(['f']);
    expect([...(found.get('SET_AS_CONST_OUTSIDE')?.items ?? [])]).toEqual(['g']);
  });

  test('accepts: an annotated declaration, and one with `satisfies`', () => {
    // The annotation was a regex group (`(?::[^=]+)?`) before this PR and is a
    // node property now, so it needs no bound. `satisfies` is not decorative:
    // six declarations in src/ carry it, and a walk that did not peel it found
    // 24 where the tree holds 30.
    const found = collectStringConstants(
      [
        "export const ANNOTATED: readonly string[] = ['a', 'b'] as const;",
        "export const CHECKED = ['c', 'd'] as const satisfies readonly string[];",
      ].join('\n')
    );
    expect([...(found.get('ANNOTATED')?.items ?? [])]).toEqual(['a', 'b']);
    expect([...(found.get('CHECKED')?.items ?? [])]).toEqual(['c', 'd']);
  });

  // -------------------------------------------------------------------------
  // What the parser refuses, and why each refusal has to be pinned.
  //
  // These two tests replace the pair that existed to mutation-test the regex
  // bounds (`([^[\]]*?)` for the array body, `(?::[^=]+)?` for the annotation).
  // Those bounds are gone, so testing them would be testing nothing — but the
  // coverage is not deleted, it is re-aimed: the AST has its own accepting
  // branches, and an over-broad one is the same silent failure in the other
  // direction. A walk that accepted a spread would pin `[...OTHER, 'x']` as the
  // single member `'x'` and report success. #699 asked for the decoy in the old
  // annotation test to lose its underscore so a `[^_]+` mutation could be
  // caught; the honest answer is that the bound it decoyed no longer exists,
  // and the mutations worth catching now are the ones below.
  // -------------------------------------------------------------------------

  test('rejects: an array with no const assertion, and it consumes nothing after it', () => {
    // The tree cannot detect this: in src/conformance/ledger.ts the first
    // `] as const` ahead of the un-asserted CONFORMANCE_LEDGER is an inline one
    // far below, and the span between them happens to hold no exported
    // string-literal declaration — an accident of today's tree. This snippet
    // puts a declaration inside such a span, which is what makes the rule
    // detectable at all. Drop the `sawConst` gate in `initializerMembers` and
    // the first assertion goes red; make the walk span-based again and the
    // second does.
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
    expect([...(found.get('AFTER_THE_LEDGER')?.items ?? [])]).toEqual(['alpha', 'beta']);
  });

  test('rejects: members that are not string literals', () => {
    // Every one of these would be pinned as a SHORTER list than it really is if
    // `stringLiteralMembers` returned the literals it recognised instead of
    // null — the exact shape of an under-reporting pin, and the reason the
    // rejection is a test rather than a comment. `new Set(OTHER)` is here too:
    // the Set branch has its own way to accept something whose members are not
    // statically known.
    const cases: Record<string, string> = {
      SPREAD: "export const SPREAD = [...OTHER, 'x'] as const;",
      IDENTIFIER: "export const IDENTIFIER = ['a', SOME_NAME] as const;",
      COMPUTED: "export const COMPUTED = ['a', OTHER[0]] as const;",
      TEMPLATE: 'export const TEMPLATE = [`a${x}`, ' + "'b'] as const;",
      NUMERIC: "export const NUMERIC = ['a', 1] as const;",
      NESTED: "export const NESTED = ['a', ['b']] as const;",
      // A PURE string array with no `as const`. The gate that rejects it is
      // `sawConst` in initializerMembers, and nothing else in this file or the
      // tree exercises it: NOT_A_PIN below is un-asserted but also holds an
      // object literal, so the member check rejects it first and the gate never
      // decides anything. Deleting the gate left every test green until this
      // case existed — mutation-verified, which is how it was found.
      UNASSERTED: "export const UNASSERTED = ['a', 'b'];",
      SET_OF_IDENTIFIER: 'export const SET_OF_IDENTIFIER = new Set(OTHER);',
      SET_OF_SPREAD: "export const SET_OF_SPREAD = new Set([...OTHER, 'x']);",
      EMPTY: 'export const EMPTY = [] as const;',
      NOT_EXPORTED: "const NOT_EXPORTED = ['a'] as const;",
    };
    const taken = Object.entries(cases)
      .filter(([name, source]) => collectStringConstants(source).has(name))
      .map(([name]) => name);
    expect(taken).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Cross-file name collisions (#694)
  // -------------------------------------------------------------------------

  test('a name exported from two files is reported, not merged (#694)', () => {
    // Synthetic because the real tree has no collision — and a collision that
    // only ever shows up when someone creates one is a branch nothing has run.
    // The two declarations deliberately DIFFER, because the damage does not
    // depend on them agreeing: whichever one loses is a live declaration in
    // src/ that no test touches, and which one loses depends on readdirSync
    // order.
    const sweep = sweepFiles([
      { path: 'src/a.ts', source: "export const SHARED = ['from-a'] as const;" },
      { path: 'src/b.ts', source: "export const SHARED = ['from-b'] as const;" },
      { path: 'src/c.ts', source: "export const UNIQUE = ['c'] as const;" },
    ]);
    expect(sweep.collisions).toEqual([{ name: 'SHARED', files: ['src/a.ts', 'src/b.ts'] }]);
    // And gone from the map, so no downstream test can pin whichever
    // declaration the filesystem happened to hand over last.
    expect(sweep.constants.has('SHARED')).toBe(false);
    expect([...(sweep.constants.get('UNIQUE')?.items ?? [])]).toEqual(['c']);
  });

  test('no exported constant name is declared in two files under src/', () => {
    expect(
      sweep.collisions.map((c) => `${c.name} is exported from ${c.files.join(' and ')}`)
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The pin itself
  // -------------------------------------------------------------------------

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
      expect([...(discovered.get(name)?.items ?? [])]).toEqual([...(PINNED[name] ?? [])]);
    });
  }
});
