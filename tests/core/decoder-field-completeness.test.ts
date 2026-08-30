/**
 * Bidirectional pin over EVERY field name the LevelDB decoder extracts.
 *
 * WHY THIS FILE EXISTS
 *
 * `src/core/decoder.ts` is the only thing standing between a Firestore
 * protobuf and the rows a user sees. Each `process*` function decides what
 * survives with literal name lists — `stringFields`, `booleanFields`,
 * `numericFields`, `stringArrayFields`, `mapFields`. Nothing pinned them.
 * Deleting one entry silently drops that field from every decoded row, and a
 * full `bun run check` stayed green. Confirmed by mutation on the pre-fix
 * tree, each deletion individually, 2853 tests passing:
 *
 *   'excluded'          from processTransaction booleanFields
 *                       -> the `exclude_excluded` filter in src/tools/tools.ts
 *                          becomes a NO-OP. Excluded transactions get counted
 *                          in every spend total. Nothing fails.
 *   'excluded'          from processCategory     -> excluded-category filter no-ops
 *   'category_id'       from processBudget       -> budget -> category link gone
 *   'category_id'       from processRecurring    -> recurring -> category link gone
 *   'mask' / 'institution_name' from processAccount -> account identifiers vanish
 *   'plaid_category_id' from processTransaction  -> Plaid taxonomy gone
 *
 * A handful of names (`logo`, `user_hidden`, `tag_ids`, `user_note`,
 * `internal_transfer`, `pending`) DID fail on deletion — but only because
 * tests/core/decoder-coverage.test.ts happens to assert on them by hand. That
 * is protection for the N fields somebody remembered to list, which is the bug
 * one level up: the shape this file must not reproduce.
 *
 * WHAT IS PINNED
 *
 * Discovery reads the SOURCE of src/core/decoder.ts and finds, per `process*`
 * function:
 *
 *   - `lists`  every string-literal array declared in the body, by name.
 *              This is deliberately broader than the `consumed:` spread set.
 *              `processGoal` declares `savingsStringFields` /
 *              `savingsBoolFields` which read from the nested `savings` map
 *              and therefore never appear in `consumed:` at all — deleting
 *              `'tracking_type'` from one of those drops
 *              `goal.savings.tracking_type` with no unread-field warning to
 *              show for it. Pinning the arrays rather than only `consumed`
 *              closes that hole.
 *   - `calls`  every `warnUnreadFields(...)` call: its `collection` label and
 *              the verbatim `consumed:` / `ignored:` spec, where a spread is
 *              kept as `'...stringFields'` and a computed value as
 *              `'@Array.from(fields.keys())'`. A processor that swaps a
 *              dynamic pass-through for a literal allow-list (or the reverse)
 *              changes its silent-drop exposure, and that change has to be
 *              deliberate.
 *
 * HOW IT FAILS (every direction is mutation-tested in this file's PR)
 *
 *   forward     a `process*` exists in the decoder with no pinned expectation
 *               -> someone added a processor and no test came with it
 *   backward    a pinned expectation names a `process*` that is gone
 *               -> a stale pin quietly protecting nothing
 *   contents    a pinned list or call spec changed -> the six mutations above
 *   surfacing   a name the processor claims to consume never reaches the
 *               decoded row (see NOT_SURFACED). NOTE this direction is
 *               near-tautological for list-driven fields: a member of e.g.
 *               `stringFields` enters `consumedFields` by spread resolution
 *               AND `surfaced` via the write loop over the SAME array, so it
 *               cannot fail for those names. It has real teeth only for the
 *               individually-quoted entries in `consumed`. Do not read a
 *               green surfacing check as proof a field reaches the row —
 *               `contents` is the load-bearing direction, and it is what
 *               catches deleting 'excluded'.
 *   non-vacuity discovery matching nothing reports one unambiguous reason
 *               instead of 27 confusing ones
 *
 * The backward direction also guards the DISCOVERY MECHANISM. If the regexes
 * below stop matching (a refactor to arrow functions, a list moved to module
 * scope, a `consumed:` built some new way), what they can no longer see reads
 * as "vanished" and backward goes red. A partial under-match cannot pass
 * quietly, and `discovery resolved every reference` catches the case where a
 * spread or a write-loop points at something discovery cannot see.
 *
 * That argument covers processors already pinned. It does NOT cover a
 * processor discovery never saw in the first place — an arrow function, or a
 * different name prefix — for which forward has nothing to compare. The
 * `warnUnreadFields` census test is what closes that: D2 requires every
 * processor to call it, so the call sites are an independent count of the
 * processor set that never passes through the declaration regex.
 *
 * WHAT THIS DOES NOT CHECK, deliberately
 *
 *   - That a decoded value survives Zod. Every model in src/models/ is
 *     `.passthrough()`, so a field the decoder writes is not stripped at the
 *     schema boundary; `validateOrWarn` already logs and counts the drops that
 *     do happen. If a schema ever loses `.passthrough()`, this file's surfacing
 *     check stops being the whole story.
 *   - Surfacing for names read out of a NESTED map (`processGoal`'s
 *     `savingsStringFields` land on `goal.savings.*`, not on the row). Those
 *     lists are contents-pinned above, which is what catches their deletion;
 *     only the "reaches the row" leg is skipped, because they never claimed to.
 *
 * MAINTENANCE: adding or removing a decoded field means updating the entry
 * below. That is the intended workflow — the point is that it cannot happen
 * SILENTLY.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DECODER_PATH = join(import.meta.dir, '..', '..', 'src', 'core', 'decoder.ts');
const SRC = readFileSync(DECODER_PATH, 'utf-8');

/**
 * There are 27 `process*` functions today. The floor is a vacuity guard, not a
 * budget: it exists so a discovery regex that silently stops matching reports
 * ONE unambiguous failure rather than 27 downstream ones. Raise it only if the
 * decoder genuinely shrinks below it, and think hard first.
 */
const MIN_PROCESSORS = 27;

/**
 * Same idea one level down, over the field names inside those processors
 * (307 today). Without this, a broken array regex would leave every `lists`
 * entry empty and the failure would read as "the decoder lost 307 fields".
 */
const MIN_FIELD_NAMES = 300;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type WarnCallSpec = {
  collection: string;
  /** Literals verbatim; a spread as `...name`; a computed value as `@expr`. */
  consumed: string[];
  ignored: string[];
};

type ProcessorPin = {
  lists: Record<string, string[]>;
  calls: WarnCallSpec[];
};

type DiscoveredProcessor = ProcessorPin & {
  name: string;
  /** `consumed` with spreads resolved, deduped. Empty when `consumed` is computed. */
  consumedFields: string[];
  /** Field names statically provable to be written onto the returned row. */
  surfaced: Set<string>;
  /** True when a generic `for (const [key] of fields)` loop copies every raw key. */
  passthrough: boolean;
  /** Tokens discovery could not resolve. Non-empty means the scan is degraded. */
  unresolved: string[];
};

/**
 * Slice out `open`..`close` starting at `openIdx`, counting nesting depth.
 *
 * ASSUMPTION: no string literal inside the region contains an unbalanced
 * bracket or brace. True for field-name lists; a literal like `'a[b'` would
 * break the depth count. Same class of assumption as stripComments above.
 */
function balanced(text: string, openIdx: number, open: string, close: string): [string, number] {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return [text.slice(openIdx + 1, i), i];
    }
  }
  return ['', text.length];
}

/**
 * ASSUMPTION: no string literal in a scanned region contains `//` or a block
 * comment opener. True for the decoder, whose scanned regions hold field names
 * only. If it were ever false the effect is a SILENT one — the residue check in
 * stringLiteralMembers would reject the mangled array and drop that list from
 * the pin — which is this file's own failure mode, so it is stated rather than
 * left implicit. Making it string-aware is the fix if a URL ever lands in one.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Members of a pure string-literal array, or null if the array holds anything
 * else. Deliberately narrow, same rationale as tests/exported-constants.test.ts:
 * an array built from identifiers or numbers is not a field allow-list.
 *
 * `raw` is always a slice of `body` (see discoverProcessors), which is
 * stripped once at the top of that function — no `stripComments()` call
 * needed here, the same leftover this file's own `spec()` fix removed.
 */
function stringLiteralMembers(raw: string): string[] | null {
  const items = [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  const residue = raw.replace(/'[^']*'|,|\s/g, '');
  return residue === '' && items.length > 0 ? items : null;
}

/**
 * Top-level keys of an object literal body, ignoring nested groups. `literal`
 * is always a slice of `body` (see discoverProcessors), already stripped —
 * no `stripComments()` call needed here either.
 */
function topLevelKeys(literal: string): string[] {
  let text = literal;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/\{[^{}]*\}/g, '~')
      .replace(/\[[^[\]]*\]/g, '~')
      .replace(/\([^()]*\)/g, '~');
  } while (text !== previous);
  return text
    .split(',')
    .map((part) => part.match(/^\s*(\w+)\s*(?::|$)/)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Body of the function whose parameter list opens at `parenIdx`. */
/**
 * ASSUMPTION: no `process*` has an inline object return type. This walks to the
 * first `{` at paren-depth 0, which is the body for `): Account | null {` but
 * would be the RETURN TYPE for `): { securityId: string } {`. In that case the
 * processor's pinned `lists` quietly become `{}` — which the contents pin then
 * catches loudly, so it is safe rather than silent. Verified: no processor has
 * one today. Same class of assumption as `balanced` and `stripComments` above.
 */
function functionBody(src: string, parenIdx: number): string {
  let i = parenIdx;
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '{' && depth === 0) break;
    i++;
  }
  return balanced(src, i, '{', '}')[0];
}

/**
 * `src` defaults to the real decoder so every call site in this file scans
 * production code unless it deliberately overrides it. The override exists
 * so a regression fixture (a synthetic source snippet reproducing exactly
 * one discovery hazard) can be run through the SAME discovery logic the real
 * pin uses, rather than a hand-duplicated copy that could drift from it.
 */
function discoverProcessors(src: string = SRC): DiscoveredProcessor[] {
  const found: DiscoveredProcessor[] = [];
  const declaration = /function (process\w+)(?:<[^>]*>)?\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = declaration.exec(src)) !== null) {
    const name = match[1] as string;
    // Stripped ONCE, here, and used for every scan below — the list/rowIdent/
    // surfacing scans and the warnUnreadFields census used to run on two
    // different texts (raw body vs. a separately-stripped copy only the
    // census used), so a commented-out line was invisible to one half and
    // load-bearing to the other. `balanced()`'s bracket/brace counting is
    // safe against the shift stripping introduces because every index this
    // function computes downstream is relative to THIS `body`, never to raw
    // source positions.
    const body = stripComments(functionBody(src, match.index + match[0].length - 1));
    const unresolved: string[] = [];

    // --- every string-literal field list in the body ---------------------
    const lists: Record<string, string[]> = {};
    for (const m of body.matchAll(/const (\w+)\s*(?::[^=]+)?=\s*\[/g)) {
      const [raw] = balanced(body, m.index + m[0].length - 1, '[', ']');
      const members = stringLiteralMembers(raw);
      if (members) lists[m[1] as string] = members;
    }
    // Inline lists — `for (const key of ['a', 'b'])`. Discovered too, so a
    // list cannot escape the pin just by losing its name.
    let inlineIndex = 0;
    for (const m of body.matchAll(/for \(const \w+ of \[/g)) {
      const [raw] = balanced(body, m.index + m[0].length - 1, '[', ']');
      const members = stringLiteralMembers(raw);
      if (members) lists[`inline#${++inlineIndex}`] = members;
    }

    // --- every warnUnreadFields call -------------------------------------
    const calls: WarnCallSpec[] = [];
    const consumedFields = new Set<string>();
    // `body` is already stripped (see above), so this agrees with the census
    // total below, which counts on stripComments(SRC) — counting a RAW body
    // here would let a commented-out call inflate this processor's pin AND
    // the census total.
    for (const m of body.matchAll(/warnUnreadFields\(/g)) {
      const [args] = balanced(body, m.index + m[0].length - 1, '(', ')');
      const spec = (key: 'consumed' | 'ignored'): string[] => {
        const keyMatch = args.match(new RegExp(`${key}:\\s*`));
        // `=== undefined`, not falsy: offset 0 is a valid match position, and
        // this is a file whose whole premise is not silently under-checking.
        if (keyMatch?.index === undefined) return ['@MISSING'];
        const at = keyMatch.index + keyMatch[0].length;
        if (args[at] !== '[') {
          // A computed value (`Array.from(fields.keys())`). Scan to the next
          // TOP-LEVEL comma rather than the first one, so an expression that
          // contains commas inside its own parens/brackets is recorded whole,
          // and fall back to the end of args when there is no trailing comma
          // (`indexOf` returning -1 would otherwise drop the last character).
          let depth = 0;
          let end = args.length;
          for (let i = at; i < args.length; i++) {
            const ch = args[i];
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            else if (ch === ',' && depth === 0) {
              end = i;
              break;
            }
          }
          return [`@${args.slice(at, end).trim()}`];
        }
        // `args` (and therefore `raw`, sliced from it) is already stripped —
        // `body` is stripped once at the top of discoverProcessors and every
        // downstream slice inherits that, so re-stripping here would be a
        // redundant no-op leftover from before that single-convention fix.
        const [raw] = balanced(args, at, '[', ']');
        const tokens: Array<[number, string]> = [];
        for (const lit of raw.matchAll(/'([^']*)'/g)) tokens.push([lit.index, lit[1] as string]);
        for (const sp of raw.matchAll(/\.\.\.(\w+)/g))
          tokens.push([sp.index, `...${sp[1] as string}`]);
        const residue = raw.replace(/'[^']*'|\.\.\.\w+|,|\s/g, '');
        if (residue !== '') unresolved.push(`${name}: ${key} residue ${JSON.stringify(residue)}`);
        return tokens.sort((a, b) => a[0] - b[0]).map(([, token]) => token);
      };
      const consumed = spec('consumed');
      calls.push({
        collection: args.match(/collection:\s*'([^']*)'/)?.[1] ?? '@NO_LITERAL_COLLECTION',
        consumed,
        ignored: spec('ignored'),
      });
      for (const token of consumed) {
        if (token.startsWith('@')) continue;
        if (!token.startsWith('...')) {
          consumedFields.add(token);
          continue;
        }
        const listName = token.slice(3);
        const members = lists[listName];
        if (!members) {
          unresolved.push(`${name}: consumed spread ...${listName} resolves to nothing`);
          continue;
        }
        for (const member of members) consumedFields.add(member);
      }
    }

    // --- what actually reaches the returned row ---------------------------
    // The row is the object handed to validateOrWarn, or returned directly.
    const rowIdents = new Set<string>();
    for (const m of body.matchAll(/const (\w+)\s*(?::[^=]+)?=\s*\{/g)) {
      const ident = m[1] as string;
      if (
        new RegExp(`validateOrWarn\\(\\s*\\w+,\\s*${ident}\\b`).test(body) ||
        new RegExp(`return ${ident};`).test(body)
      ) {
        rowIdents.add(ident);
      }
    }

    const surfaced = new Set<string>();
    let passthrough = false;

    for (const m of body.matchAll(/const (\w+)\s*(?::[^=]+)?=\s*\{/g)) {
      if (!rowIdents.has(m[1] as string)) continue;
      const [literal] = balanced(body, m.index + m[0].length - 1, '{', '}');
      for (const key of topLevelKeys(literal)) surfaced.add(key);
    }

    for (const ident of rowIdents) {
      // row.field = ... / row.field ??= ...
      for (const m of body.matchAll(new RegExp(`\\b${ident}\\.(\\w+)\\s*(?:=[^=]|\\?\\?=)`, 'g')))
        surfaced.add(m[1] as string);
      // row['field'] = ...
      for (const m of body.matchAll(new RegExp(`\\b${ident}\\['(\\w+)'\\]\\s*=`, 'g')))
        surfaced.add(m[1] as string);
      // for (const field of someList) { row[field] = ... }
      for (const m of body.matchAll(
        /for \(const (?:\[(\w+), *\w+\]|(\w+)) of ([\w.()]+)\)\s*\{/g
      )) {
        const [loopBody] = balanced(body, m.index + m[0].length - 1, '{', '}');
        const keyVar = (m[1] ?? m[2]) as string;
        const source = m[3] as string;
        if (!new RegExp(`\\b${ident}\\[${keyVar}\\]\\s*=`).test(loopBody)) continue;
        if (/^fields(\.(entries|keys)\(\))?$/.test(source)) {
          passthrough = true;
        } else if (lists[source]) {
          for (const member of lists[source]) surfaced.add(member);
        } else {
          unresolved.push(`${name}: write loop over unresolvable source ${source}`);
        }
      }
      // for (const key of ['a', 'b']) { row[key] = ... }
      for (const m of body.matchAll(/for \(const (\w+) of \[/g)) {
        const [raw, end] = balanced(body, m.index + m[0].length - 1, '[', ']');
        const members = stringLiteralMembers(raw);
        if (!members) continue;
        // Scan the ACTUAL loop body, like the sibling scanner above, not a
        // fixed window. A 500-char slice was an unannounced cap: a long loop
        // body stopped registering its writes, those fields dropped out of
        // `surfaced`, and the surfacing check went red for a reason having
        // nothing to do with the decoder. Loud, but misleading — and this file
        // exists to make coverage bounds explicit.
        //
        // The `{` must be ADJACENT to the `)` that closes this for-of header —
        // `body.indexOf('{', end)` used to search forward for the next `{`
        // ANYWHERE in the body, which can latch onto an unrelated later
        // block's brace (a bare-statement loop with no braces of its own,
        // followed later by an unconnected `if (...) { ... }`) and silently
        // scan the wrong loop's body for this array's members.
        const after = /^\s*\)\s*\{/.exec(body.slice(end + 1));
        if (after === null) continue;
        const brace = end + 1 + after[0].length - 1;
        const [loopBody] = balanced(body, brace, '{', '}');
        if (!new RegExp(`\\b${ident}\\[${m[1] as string}\\]\\s*=`).test(loopBody)) continue;
        for (const member of members) surfaced.add(member);
      }
    }

    found.push({
      name,
      lists,
      calls,
      consumedFields: [...consumedFields],
      surfaced,
      passthrough,
      unresolved,
    });
  }

  return found;
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

const PINNED: Record<string, ProcessorPin> = {
  processTransaction: {
    lists: {
      stringFields: [
        'name',
        'original_name',
        'original_clean_name',
        'name_override',
        'account_id',
        'item_id',
        'user_id',
        'category_id',
        'plaid_category_id',
        'category_id_source',
        'account_type',
        'original_date',
        'pending_transaction_id',
        'iso_currency_code',
        'transaction_type',
        'plaid_transaction_type',
        'payment_method',
        'payment_processor',
        'city',
        'region',
        'address',
        'postal_code',
        'country',
        'reference_number',
        'ppd_id',
        'by_order_of',
        'from_investment',
        'user_note',
        '_origin',
        'intelligence_chosen_category_id',
        'recurring_id',
        'plaid_pending_transaction_id',
        'posted_transaction_id',
        'original_transaction_id',
        'old_category_id',
        'parent_transaction_id',
      ],
      booleanFields: [
        'pending',
        'excluded',
        'user_reviewed',
        'plaid_deleted',
        'is_amazon',
        'account_dashboard_active',
        'is_manual',
        'recurring',
        'skip_balance_adjust',
        'user_deleted',
        'intelligence_powered',
        'internal_transfer',
      ],
      numericFields: ['original_amount', 'lat', 'lon', 'pending_amount'],
      stringArrayFields: [
        'plaid_category_strings',
        'intelligence_suggested_category_ids',
        'tag_ids',
        'children_transaction_ids',
        'suggestion_ids',
      ],
      mapFields: ['internal_tx_match', 'venmo_extra_data'],
    },
    calls: [
      {
        collection: 'transactions',
        consumed: [
          'transaction_id',
          'amount',
          'date',
          'type',
          '...stringFields',
          '...booleanFields',
          '...numericFields',
          'created_timestamp',
          '...stringArrayFields',
          '...mapFields',
        ],
        ignored: ['location', 'payment_meta', 'intelligence_category_scores'],
      },
    ],
  },
  processAccount: {
    lists: {
      stringFields: [
        'name',
        'official_name',
        'mask',
        'institution_name',
        'item_id',
        'iso_currency_code',
        'institution_id',
        'color',
        'custom_color',
        'logo',
        'logo_content_type',
        '_origin',
        'nickname',
        'group_id',
        'user_id',
        'persistent_account_id',
      ],
      booleanFields: [
        'user_deleted',
        'historical_update',
        'dashboard_active',
        'savings_active',
        'provider_deleted',
        'live_balance_backend_disabled',
        'live_balance_user_disabled',
        'holdings_initialized',
        'investments_performance_enabled',
        'is_manual',
        'user_hidden',
        'group_leader',
      ],
    },
    calls: [
      {
        collection: 'accounts',
        consumed: [
          'account_id',
          'id',
          'current_balance',
          'original_current_balance',
          'available_balance',
          'limit',
          'type',
          'account_type',
          'subtype',
          'original_type',
          'original_subtype',
          'verification_status',
          'latest_balance_update',
          'holdings',
          'metadata',
          'merged',
          'last_auto_current_balance',
          'financial_goal_ids',
          '...stringFields',
          '...booleanFields',
        ],
        ignored: [],
      },
    ],
  },
  processRecurring: {
    lists: {
      stringFields: [
        'name',
        'merchant_name',
        'frequency',
        'category_id',
        'account_id',
        'iso_currency_code',
        'emoji',
        'match_string',
        'plaid_category_id',
      ],
    },
    calls: [
      {
        collection: 'recurring',
        consumed: [
          'recurring_id',
          'id',
          'state',
          'is_active',
          'amount',
          'min_amount',
          'max_amount',
          'days_filter',
          'latest_date',
          'next_date',
          'last_date',
          'transaction_ids',
          'excluded_transaction_ids',
          'included_transaction_ids',
          'skip_filter_update',
          'identification_method',
          '_origin',
          '...stringFields',
        ],
        ignored: [],
      },
    ],
  },
  processBudget: {
    lists: {
      stringFields: [
        'name',
        'period',
        'category_id',
        'start_date',
        'end_date',
        'iso_currency_code',
      ],
    },
    calls: [
      {
        collection: 'budgets',
        consumed: ['budget_id', 'amount', 'is_active', 'amounts', 'id', '...stringFields'],
        ignored: [],
      },
    ],
  },
  processGoal: {
    lists: {
      stringFields: [
        'name',
        'recommendation_id',
        'created_date',
        'user_id',
        'associated_category_id',
        'status',
        'type',
      ],
      boolFields: ['created_with_allocations', 'is_met_early', 'party_mode_activated'],
      savingsStringFields: ['type', 'status', 'tracking_type', 'start_date'],
      savingsBoolFields: ['modified_start_date', 'inflates_budget', 'is_ongoing'],
    },
    calls: [
      {
        collection: 'goals',
        consumed: [
          'goal_id',
          'emoji',
          'associated_accounts',
          'savings',
          '...stringFields',
          '...boolFields',
        ],
        ignored: [],
      },
    ],
  },
  processGoalHistory: {
    lists: {
      stringFields: ['user_id', 'last_updated', 'created_date'],
    },
    calls: [
      {
        collection: 'goal_history',
        consumed: [
          'goal_id',
          'current_amount',
          'target_amount',
          'total_contribution',
          'daily_data',
          '...stringFields',
        ],
        ignored: [],
      },
    ],
  },
  processInvestmentPrice: {
    lists: {
      priceFields: ['price', 'close_price', 'current_price', 'institution_price'],
      ohlcvFields: ['high', 'low', 'open', 'volume'],
      metaFields: ['currency', 'source', 'close_price_as_of'],
    },
    calls: [
      {
        collection: 'investment_prices',
        consumed: [
          'investment_id',
          'ticker_symbol',
          'date',
          'month',
          'prices',
          '...priceFields',
          '...ohlcvFields',
          '...metaFields',
        ],
        ignored: [],
      },
    ],
  },
  processItem: {
    lists: {
      stringFields: [
        'user_id',
        'institution_id',
        'institution_name',
        'connection_status',
        'last_successful_update',
        'last_failed_update',
        'consent_expiration_time',
        'error_code',
        'error_message',
        'error_type',
        'created_at',
        'updated_at',
        'webhook',
        'status_transactions_last_successful_update',
        'status_transactions_last_failed_update',
        'status_investments_last_successful_update',
        'status_investments_last_failed_update',
        'latest_fetch',
        'latest_investments_fetch',
        '_origin',
        'provider',
        'country_code',
        'plaid_user_id',
        'update_type',
        'disconnect_attempted_error',
        'id',
        'status_last_webhook_code_sent',
        'status_last_webhook_sent_at',
      ],
      timestampFields: ['creation_timestamp', 'disconnect_attempted', 'latest_investments_refresh'],
      boolFields: [
        'needs_update',
        'login_required',
        'disconnected',
        'historical_update',
        'is_manual',
        'new_accounts_available',
        'user_disconnected',
        'login_required_dismissed',
        'new_accounts_available_dismissed',
      ],
    },
    calls: [
      {
        collection: 'items',
        consumed: [
          'item_id',
          'products',
          'fetch_data',
          'error',
          'oauth',
          '...stringFields',
          '...timestampFields',
          '...boolFields',
        ],
        ignored: ['@IGNORED_ITEM_FIELDS'],
      },
    ],
  },
  processCategory: {
    lists: {
      stringFields: ['emoji', 'color', 'bg_color', 'parent_category_id', 'user_id'],
      booleanFields: [
        'excluded',
        'is_other',
        'auto_budget_lock',
        'auto_delete_lock',
        'rollover_disabled',
      ],
      arrayFields: [
        'plaid_category_ids',
        'partial_name_rules',
        'children_category_ids',
        'children_categories',
      ],
      additionalStringFields: ['budget_id', '_origin', 'id'],
    },
    calls: [
      {
        collection: 'categories',
        consumed: [
          'category_id',
          'name',
          'order',
          '...stringFields',
          '...booleanFields',
          '...arrayFields',
          '...additionalStringFields',
        ],
        ignored: [],
      },
    ],
  },
  processUserAccount: {
    lists: {},
    calls: [
      {
        collection: 'user_accounts',
        consumed: ['account_id', 'name', 'hidden', 'order'],
        ignored: [],
      },
    ],
  },
  processPlaidAccount: {
    lists: {
      stringFields: [
        'account_id',
        'name',
        'official_name',
        'mask',
        'account_type',
        'subtype',
        'iso_currency_code',
        'institution_id',
        'institution_name',
        'original_subtype',
        'original_type',
        'color',
        'logo',
        'logo_content_type',
        'nickname',
        '_origin',
        'id',
        'user_id',
        'custom_color',
        'group_id',
        'item_id',
      ],
      numberFields: ['current_balance', 'available_balance', 'original_current_balance'],
      booleanFields: [
        'historical_update',
        'investments_performance_enabled',
        'holdings_initialized',
        'provider_deleted',
        'savings_active',
        'dashboard_active',
        'live_balance_backend_disabled',
        'live_balance_user_disabled',
        'user_hidden',
        'user_deleted',
        'is_manual',
        'group_leader',
      ],
      mapFieldNames: ['metadata', 'merged'],
    },
    calls: [
      {
        collection: 'plaid_accounts',
        consumed: [
          'verification_status',
          'latest_balance_update',
          'holdings',
          '...stringFields',
          '...numberFields',
          'limit',
          '...booleanFields',
          '...mapFieldNames',
        ],
        ignored: [],
      },
    ],
  },
  processTag: {
    lists: {
      stringFields: ['name', 'color_name', 'hex_color'],
    },
    calls: [
      {
        collection: 'tags',
        consumed: ['...stringFields'],
        ignored: ['_migration_backfill'],
      },
    ],
  },
  processBalanceHistory: {
    lists: {
      numericFields: ['current_balance', 'available_balance', 'limit'],
    },
    calls: [
      {
        collection: 'balance_history',
        consumed: ['...numericFields', '_origin'],
        ignored: [],
      },
    ],
  },
  processHoldingsHistoryMeta: {
    lists: {},
    calls: [
      {
        collection: 'holdings_history_meta',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processHoldingsHistory: {
    lists: {},
    calls: [
      {
        collection: 'holdings_history',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processChange: {
    lists: {},
    calls: [
      {
        collection: 'changes',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processSubChange: {
    lists: {},
    calls: [
      {
        collection: 'transaction_changes',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
      {
        collection: 'account_changes',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
      {
        collection: 'change_sub',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processSecurity: {
    lists: {
      stringFields: [
        'ticker_symbol',
        'name',
        'type',
        'provider_type',
        'close_price_as_of',
        'iso_currency_code',
        'isin',
        'cusip',
        'sedol',
        'institution_id',
        'institution_security_id',
        'market_identifier_code',
        'last_update',
        'next_update',
        'source',
        'unofficial_currency_code',
        'cik',
        'proxy_security_id',
        '_origin',
        'update_datetime',
      ],
      numericFields: ['close_price', 'current_price', 'update_frequency'],
      booleanFields: ['is_cash_equivalent', 'comparison', 'trades_24_7'],
    },
    calls: [
      {
        collection: 'securities',
        consumed: [
          'security_id',
          'option_contract',
          'info',
          '...stringFields',
          '...numericFields',
          '...booleanFields',
        ],
        ignored: [],
      },
    ],
  },
  processInvestmentSplit: {
    lists: {},
    calls: [
      {
        collection: 'investment_splits',
        consumed: ['@Object.keys(adjustments)'],
        ignored: [],
      },
    ],
  },
  processUserProfile: {
    lists: {
      stringFields: [
        'public_id',
        'last_cold_open',
        'last_warm_open',
        'last_month_reviewed',
        'last_year_reviewed',
        'account_creation_timestamp',
        'onboarding_completed_timestamp',
        'onboarding_last_completed_step',
      ],
      numericFields: [
        'service_ends_on_ms',
        'items_disconnect_on_ms',
        'intelligence_categories_review_count',
      ],
      booleanFields: [
        'budgeting_enabled',
        'authentication_required',
        'data_initialized',
        'onboarding_completed',
        'logged_out',
        'match_internal_txs_enabled',
        'rollovers_enabled',
        'investments_performance_initialized',
        'finance_goals_monthly_summary_mode_enabled',
      ],
      mapFields: [
        'accounts_config',
        'auto_terms_timestamps',
        'finance_goals_review_timestamps',
        'ml_report',
        'notifications',
        'terms_timestamps',
      ],
    },
    calls: [
      {
        collection: 'user_profile',
        consumed: [
          'fcm_tokens',
          'latest_spending_trigger',
          'rollovers_starte_date',
          '_origin',
          '...stringFields',
          '...numericFields',
          '...booleanFields',
          '...mapFields',
        ],
        ignored: [],
      },
    ],
  },
  processAmazonIntegration: {
    lists: {},
    calls: [
      {
        collection: 'amazon_integrations',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processAmazonOrder: {
    lists: {
      'inline#1': ['date', 'account_id', 'match_state', 'id', 'copilot_tx'],
    },
    calls: [
      {
        collection: 'amazon_orders',
        consumed: [
          'date',
          'account_id',
          'match_state',
          'id',
          'copilot_tx',
          'items',
          'details',
          'payment',
          'transactions',
        ],
        ignored: [],
      },
    ],
  },
  processSubscription: {
    lists: {
      'inline#1': [
        'product_id',
        'provider',
        'environment',
        'user_id',
        'expires_date_ms',
        'created_timestamp',
        'original_transaction_id',
      ],
      'inline#2': ['will_auto_renew', 'is_eligible_for_initial_offer'],
    },
    calls: [
      {
        collection: 'subscriptions',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processInvite: {
    lists: {
      'inline#1': ['code', 'inviter_id', 'product_id'],
      'inline#2': ['is_available', 'is_unlimited', 'assigned', 'offer_reviewed'],
    },
    calls: [
      {
        collection: 'invites',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processUserItems: {
    lists: {},
    calls: [
      {
        collection: 'user_items',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processFeatureTracking: {
    lists: {},
    calls: [
      {
        collection: 'feature_tracking',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
  processSupport: {
    lists: {},
    calls: [
      {
        collection: 'support',
        consumed: ['@Array.from(fields.keys())'],
        ignored: [],
      },
    ],
  },
};
/**
 * Names a processor legitimately READS but deliberately does not emit on the
 * decoded row under that name. Every entry needs a reason, and every entry is
 * checked backwards: it must name a live processor, a name that processor
 * still consumes, and a name that is still not surfaced. A stale entry — for a
 * field that is gone, or one that now DOES surface — fails, because an
 * allow-list nobody has to keep honest is the bug this file exists to prevent.
 */
const NOT_SURFACED: Record<string, Record<string, string>> = {
  processTransaction: {
    type: "Copilot's `type` string is read only to derive the boolean `internal_transfer`; the raw string is never emitted.",
  },
  processAccount: {
    type: 'Read as a fallback source for `account_type`; emitted under that name, never as `type`.',
  },
  processRecurring: {
    id: 'Copilot stores the recurring id as `id`; it is emitted under our `recurring_id` name.',
  },
};

/**
 * Processors whose surfacing check is skipped because a passthrough loop
 * copies every raw key, so there is no allow-list to compare against.
 *
 * Not a complete inventory of passthrough-shaped loops in the decoder — only
 * of the ones the `passthrough` flag can SEE. Detection requires the loop to
 * write `row[key] = ...` onto an identifier `rowIdents` already tracks, which
 * in turn requires that identifier to be a NAMED `const row = {...}` later
 * passed to `validateOrWarn` or returned. `processInvestmentSplit` has an
 * equivalent loop (`for (const [key, value] of fields.entries())`), but
 * writes into a local `adjustments` object that is embedded directly in an
 * INLINE return literal (`validateOrWarn(Schema, { security_id: docId,
 * adjustments }, ...)`) — there is no named row variable for `rowIdents` to
 * capture, so this processor's copy loop is invisible to `passthrough`
 * detection and it never enters this set. Its surfacing check is still
 * skipped, but for an unrelated reason: its `consumed` spec is computed
 * (`@Object.keys(adjustments)`), so `consumedFields` stays empty and no
 * surfacing test is generated for it at all (see the
 * `consumedFields.length > 0` guard below). Eleven processors in the decoder
 * copy raw keys through a loop with no allow-list to check them against; this
 * set names the ten `passthrough` can actually see.
 *
 * Pinned as a SET rather than asserted inside the skip. A previous revision
 * did `if (found.passthrough) { expect(found.passthrough).toBe(true); return; }`
 * — which is `expect(true).toBe(true)` inside a branch that already guarantees
 * it. That was a vacuous assertion added in response to a review ABOUT vacuous
 * assertions. Pinning the set means a processor entering or leaving the skip
 * list is a visible diff, which is the property the assertion was reaching for.
 */
const PASSTHROUGH_PROCESSORS = [
  'processAmazonIntegration',
  'processChange',
  'processFeatureTracking',
  'processHoldingsHistory',
  'processHoldingsHistoryMeta',
  'processInvite',
  'processSubChange',
  'processSubscription',
  'processSupport',
  'processUserItems',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('decoder field completeness (silent-drop class detector)', () => {
  const discovered = discoverProcessors();
  const byName = new Map(discovered.map((p) => [p.name, p]));
  const names = [...byName.keys()].sort();

  describe('non-vacuity: discovery must not silently match nothing', () => {
    test(`finds at least ${MIN_PROCESSORS} process* functions`, () => {
      // A discovery regex that stops matching would otherwise turn every
      // check below green-by-emptiness. This is the one unambiguous message.
      expect(names.length).toBeGreaterThanOrEqual(MIN_PROCESSORS);
    });

    test('no two processors share a name', () => {
      // `names` comes from a Map, so this can only differ when two `process*`
      // functions collide — one would silently shadow the other's pin. It was
      // previously written as a count check under the floor's comment, which
      // described something it does not do.
      expect({ uniqueNames: names.length }).toEqual({ uniqueNames: discovered.length });
    });

    test('the passthrough skip list is unchanged', () => {
      expect(
        discovered
          .filter((p) => p.passthrough)
          .map((p) => p.name)
          .sort()
      ).toEqual([...PASSTHROUGH_PROCESSORS].sort());
    });

    test('discovery accounted for every warnUnreadFields call site', () => {
      // The floors above catch discovery matching NOTHING. This catches the
      // likelier failure: discovery matching only MOST of the processors.
      //
      // The declaration regex only sees `function process*`. A 28th processor
      // written as `const processFoo = (fields) => {...}`, or named parseFoo,
      // is invisible to it — the forward check then has nothing to compare and
      // passes, and the backward check only guards names already pinned. That
      // is this file's own bug class, one level up.
      //
      // D2 requires EVERY processor to call warnUnreadFields, so the call
      // sites are an independent census of the processor set that does not go
      // through the declaration regex at all. If discovery cannot see a
      // processor, its calls go missing from this total and this fails —
      // no maintenance, no list.
      const inSource = [...stripComments(SRC).matchAll(/\bwarnUnreadFields\(/g)].length;
      const inDiscovered = discovered.reduce((n, proc) => n + proc.calls.length, 0);
      // Three distinct causes land here, and the test name only names one.
      // Spell them out so the next reader does not go straight to the
      // declaration regex when the real cause is elsewhere:
      //   1. a processor discovery cannot see (arrow function, renamed) —
      //      inDiscovered too LOW
      //   2. a warnUnreadFields call in a NON-processor helper — inSource too
      //      HIGH, nothing wrong with discovery at all
      //   3. a `function process*` nested inside another processor —
      //      functionBody returns the outer body including the inner one, so
      //      the inner's calls are counted twice — inDiscovered too HIGH
      expect(
        inDiscovered === inSource
          ? 'census balanced'
          : `census mismatch: ${inDiscovered} calls inside discovered processors vs ${inSource} ` +
              `in the source. Causes: (1) a processor discovery cannot see — arrow function or a ` +
              `name that is not process*; (2) a warnUnreadFields call outside any processor; ` +
              `(3) a nested process* whose calls are counted twice.`
      ).toBe('census balanced');
    });

    test('finds the known-load-bearing processors by name', () => {
      expect(names).toContain('processTransaction');
      expect(names).toContain('processAccount');
      expect(names).toContain('processCategory');
    });

    test(`finds at least ${MIN_FIELD_NAMES} extracted field names`, () => {
      const total = discovered.reduce(
        (sum, p) => sum + Object.values(p.lists).reduce((n, list) => n + list.length, 0),
        0
      );
      expect(total).toBeGreaterThanOrEqual(MIN_FIELD_NAMES);
    });

    test('resolved every spread and every write loop it found', () => {
      // A `consumed` spread pointing at a list discovery cannot see, or a write
      // loop over an unknown source, means the scan is degraded — the pin would
      // still pass while checking less than it claims.
      expect(discovered.flatMap((p) => p.unresolved)).toEqual([]);
    });
  });

  test('forward: every process* in the decoder has a pinned expectation', () => {
    expect(names.filter((name) => !(name in PINNED))).toEqual([]);
  });

  test('backward: every pinned expectation still names a live process*', () => {
    expect(
      Object.keys(PINNED)
        .filter((name) => !byName.has(name))
        .sort()
    ).toEqual([]);
  });

  // warnUnreadFields was per-processor opt-in with no registry. It is the only
  // detector for fields Copilot ADDS upstream, and deleting the call from
  // processAccount or processHoldingsHistory left the whole suite green. All 27
  // processors call it today; this is what keeps the 28th honest.
  test('every process* reports its unread fields', () => {
    expect(discovered.filter((p) => p.calls.length === 0).map((p) => p.name)).toEqual([]);
  });

  for (const name of names) {
    const found = byName.get(name) as DiscoveredProcessor;
    const pin = PINNED[name];

    test(`${name}: extracted field lists are unchanged`, () => {
      expect(found.lists).toEqual(pin?.lists ?? {});
    });

    test(`${name}: warnUnreadFields calls are unchanged`, () => {
      expect(found.calls).toEqual((pin?.calls ?? []) as WarnCallSpec[]);
    });

    // A processor whose `consumed` is computed (`Array.from(fields.keys())`)
    // copies every raw key by construction — there is no allow-list to check.
    if (found.consumedFields.length > 0) {
      test(`${name}: every consumed field reaches the decoded row`, () => {
        // Skipping is correct for a passthrough processor; which processors
        // those are is pinned by PASSTHROUGH_PROCESSORS below, so entering or
        // leaving the skip list cannot happen silently.
        if (found.passthrough) return;
        const allowed = NOT_SURFACED[name] ?? {};
        expect(
          found.consumedFields.filter((field) => !found.surfaced.has(field) && !(field in allowed))
        ).toEqual([]);
      });
    }
  }

  describe('NOT_SURFACED allow-list is checked backwards', () => {
    test('every entry names a live processor', () => {
      expect(Object.keys(NOT_SURFACED).filter((name) => !byName.has(name))).toEqual([]);
    });

    test('every entry names a field that processor still consumes', () => {
      const stale: string[] = [];
      for (const [name, fields] of Object.entries(NOT_SURFACED)) {
        const found = byName.get(name);
        if (!found) continue;
        for (const field of Object.keys(fields)) {
          if (!found.consumedFields.includes(field)) stale.push(`${name}.${field}`);
        }
      }
      expect(stale).toEqual([]);
    });

    test('every entry names a field that is still not surfaced', () => {
      const pointless: string[] = [];
      for (const [name, fields] of Object.entries(NOT_SURFACED)) {
        const found = byName.get(name);
        if (!found) continue;
        for (const field of Object.keys(fields)) {
          if (found.surfaced.has(field)) pointless.push(`${name}.${field}`);
        }
      }
      expect(pointless).toEqual([]);
    });

    test('every entry carries a reason', () => {
      const unreasoned: string[] = [];
      for (const [name, fields] of Object.entries(NOT_SURFACED)) {
        for (const [field, reason] of Object.entries(fields)) {
          if (reason.trim().length < 20) unreasoned.push(`${name}.${field}`);
        }
      }
      expect(unreasoned).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: the `for (const key of [...])` scanner's brace must be adjacent
// ---------------------------------------------------------------------------

describe('surfacing scan for a bare for-of loop requires an adjacent brace (#685)', () => {
  // A `for (const key of ['ghost_field']) consume(key);` header with NO
  // braces of its own — a legal single-statement for-of — immediately
  // followed by an UNRELATED `for (const key of ['real_field']) { ... }`
  // block that reuses the same loop-variable name and does write `row[key] =`.
  // The pre-fix scanner searched forward for the next `{` from ANYWHERE in
  // the body, found the second loop's brace, and credited 'ghost_field' as
  // surfaced because the SECOND loop's body happens to satisfy the
  // `row[key] =` check — even though 'ghost_field' is never written to row.
  const FIXTURE_SRC = `
function processFixture(fields: Map<string, unknown>): unknown {
  const row: Record<string, unknown> = {};
  for (const key of ['ghost_field'])
    consume(key);
  for (const key of ['real_field']) {
    row[key] = fields.get(key);
  }
  return row;
}
`;

  const [fixture] = discoverProcessors(FIXTURE_SRC);

  test('fixture is discovered at all (non-vacuity)', () => {
    expect(fixture?.name).toBe('processFixture');
  });

  test('the unrelated later block is not credited to the bare loop', () => {
    expect(fixture?.surfaced.has('ghost_field')).toBe(false);
  });

  test('the real, adjacent loop still surfaces its own field', () => {
    expect(fixture?.surfaced.has('real_field')).toBe(true);
  });
});
