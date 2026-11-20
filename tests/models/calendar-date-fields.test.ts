/**
 * Class-level detector for #920: every YYYY-MM-DD date in the cache models
 * goes through calendarDateField (src/models/calendar-date.ts), so a
 * well-formed but impossible day such as 2025-02-30 is a counted drop or
 * repair rather than a value that sorts past the end of its month and silently
 * falls out of every string-compared range.
 *
 * Discovery reads the source tree, not a hand-kept list, so a new file, field
 * or record is covered without anyone remembering to add it:
 *   1. nothing under src/ spells the YYYY-MM-DD pattern itself except the
 *      sites in PATTERN_SITES, each of which pairs it with isCalendarDate (or
 *      deliberately hands an impossible day on to a schema that does);
 *   2. a model field named `date` or `*_date` declared as a bare `z.string()`
 *      must be in EXEMPT_FIELDS, with the reason it is not a calendar day;
 *   3. a model `z.record` keyed by a bare `z.string()` must be in
 *      NON_DATE_RECORD_KEYS, with what its keys are. A date-keyed record (the
 *      shape of goal-history's daily_data) keys with calendarDateField().
 * Every list fails both ways: an entry whose site is gone or fixed must go.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BalanceHistorySchema } from '../../src/models/balance-history.js';
import { BudgetSchema } from '../../src/models/budget.js';
import { GoalSchema } from '../../src/models/goal.js';
import { GoalHistorySchema } from '../../src/models/goal-history.js';
import { InvestmentSplitSchema } from '../../src/models/investment-split.js';
import { RecurringSchema } from '../../src/models/recurring.js';
import { TransactionSchema } from '../../src/models/transaction.js';

const SRC_DIR = join(import.meta.dir, '../../src');
const MODELS_DIR = join(SRC_DIR, 'models');

const VALIDATE_ARG = 'JSON-schema patterns on tool inputs; the handler runs validateDateArg';

/** Path under src → count of YYYY-MM-DD spellings there, and why none is the bug. */
const PATTERN_SITES: Record<string, { count: number; reason: string }> = {
  'models/calendar-date.ts': { count: 1, reason: 'the helper itself' },
  'utils/date.ts': {
    count: 2,
    reason: 'isCalendarDate, and validateDateArg, which calls it on the next line',
  },
  'tools/tools.ts': {
    count: 1,
    reason: 'validateWriteDate, which calls isCalendarDate on the next line',
  },
  'core/decoder.ts': {
    count: 1,
    reason:
      'balance_history doc-id shape filter: an impossible day passes it on purpose, so ' +
      'BalanceHistorySchema (calendarDateField) counts the drop instead of a silent skip',
  },
  'tools/registry/transactions.ts': { count: 2, reason: VALIDATE_ARG },
  'tools/registry/recurring.ts': { count: 2, reason: VALIDATE_ARG },
  'tools/live/transactions.ts': { count: 2, reason: VALIDATE_ARG },
};

/** `file:field` → why it is a plain string and not a calendar day. */
const EXEMPT_FIELDS: Record<string, string> = {
  'amazon.ts:date':
    'Amazon order date, only used to order orders (localeCompare), never in a range; ' +
    'its on-disk shape is not pinned',
  'transaction.ts:original_date':
    "The decoder's fallback for `date`, so it is gated as `date`: an impossible value " +
    'drops the row there; the field itself is never compared',
  'user-profile.ts:rollovers_starte_date':
    'Profile setting with no range comparison; its on-disk shape is not pinned',
};

/** `file:field` → what the record's keys are, since they are not days. */
const NON_DATE_RECORD_KEYS: Record<string, string> = {
  'account.ts:metadata': 'opaque metadata names',
  'account.ts:merged': 'opaque merge map',
  'budget.ts:amounts': 'YYYY-MM month keys, not days',
  'goal.ts:associated_accounts': 'account ids',
  'holdings-history.ts:history': 'epoch-millis strings',
  'plaid-account.ts:metadata': 'opaque metadata names',
  'plaid-account.ts:merged': 'opaque merge map',
  'item.ts:error': 'Plaid error fields',
  'item.ts:fetch_data': 'opaque fetch state',
  'item.ts:oauth': 'opaque OAuth state',
  'investment-price.ts:prices': 'epoch-millis strings (#622)',
  'security.ts:info': 'opaque security info',
  'transaction.ts:internal_tx_match': 'opaque match data',
  'transaction.ts:venmo_extra_data': 'opaque Venmo data',
  'transaction.ts:amazon': 'opaque Amazon data',
  'user-profile.ts:accounts_config': 'account ids',
  'user-profile.ts:auto_terms_timestamps': 'term names',
  'user-profile.ts:finance_goals_review_timestamps': 'review names',
  'user-profile.ts:ml_report': 'report names',
  'user-profile.ts:notifications': 'notification names',
  'user-profile.ts:terms_timestamps': 'term names',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const srcFiles = walk(SRC_DIR);
const modelFiles = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.ts'));
const readModel = (f: string): string => readFileSync(join(MODELS_DIR, f), 'utf8');

/**
 * Count YYYY-MM-DD pattern spellings in source, robust to the usual variants:
 * capture groups, `\d\d\d\d` / `\d\d`, and the doubled backslashes of a
 * pattern written inside a string literal.
 */
function countDatePatterns(src: string): number {
  const normalized = src
    .replace(/[()]/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\d\\d\\d\\d/g, '\\d{4}')
    .replace(/\\d\\d/g, '\\d{2}');
  return normalized.match(/\\d\{4\}-\\d\{2\}-\\d\{2\}/g)?.length ?? 0;
}

const Z_STRING = String.raw`z\s*\.\s*string\(\)`;
const BARE_DATE_FIELD = new RegExp(String.raw`^\s+(date|[a-z_]+_date):\s*` + Z_STRING, 'gm');
const STRING_KEYED_RECORD = new RegExp(
  String.raw`^\s+(\w+):\s*z\s*\.\s*record\(\s*` + Z_STRING,
  'gm'
);

function found(re: RegExp): string[] {
  return modelFiles.flatMap((f) => [...readModel(f).matchAll(re)].map((m) => `${f}:${m[1]}`));
}

describe('cache model date fields are calendar days (#920)', () => {
  test('the walks see the tree', () => {
    expect(modelFiles.length).toBeGreaterThan(20);
    expect(srcFiles.length).toBeGreaterThan(modelFiles.length);
    expect(srcFiles.map((f) => relative(SRC_DIR, f))).toContain('models/transaction.ts');
  });

  test('the pattern counter sees the usual spellings, and not a month', () => {
    expect(countDatePatterns(String.raw`/^\d{4}-\d{2}-\d{2}$/`)).toBe(1);
    expect(countDatePatterns(String.raw`/^(\d{4})-(\d{2})-(\d{2})$/`)).toBe(1);
    expect(countDatePatterns(String.raw`/^\d\d\d\d-\d\d-\d\d$/`)).toBe(1);
    expect(countDatePatterns(String.raw`'^\\d{4}-\\d{2}-\\d{2}$'`)).toBe(1);
    expect(countDatePatterns(String.raw`/^\d{4}-\d{2}$/`)).toBe(0);
  });

  test('nothing under src spells the YYYY-MM-DD pattern outside the listed sites', () => {
    const counts = Object.fromEntries(
      srcFiles
        .map((f) => [relative(SRC_DIR, f), countDatePatterns(readFileSync(f, 'utf8'))] as const)
        .filter(([, n]) => n > 0)
    );
    const expected = Object.fromEntries(
      Object.entries(PATTERN_SITES).map(([k, v]) => [k, v.count])
    );
    expect(counts).toEqual(expected);
  });

  test('every bare z.string() date field is exempted with a reason', () => {
    const fields = found(BARE_DATE_FIELD);
    expect(fields.filter((k) => !(k in EXEMPT_FIELDS))).toEqual([]);
    expect(Object.keys(EXEMPT_FIELDS).filter((k) => !fields.includes(k))).toEqual([]);
  });

  test('every z.string()-keyed record is listed as not date-keyed', () => {
    const records = found(STRING_KEYED_RECORD);
    expect(records.filter((k) => !(k in NON_DATE_RECORD_KEYS))).toEqual([]);
    expect(Object.keys(NON_DATE_RECORD_KEYS).filter((k) => !records.includes(k))).toEqual([]);
  });

  test('the field and record rules see a prettier-wrapped declaration', () => {
    const wrapped = [
      '  created_date: z',
      '    .string()',
      '    .optional(),',
      '  daily: z',
      '    .record(',
      '      z.string(),',
    ].join('\n');
    expect([...wrapped.matchAll(BARE_DATE_FIELD)].map((m) => m[1])).toEqual(['created_date']);
    expect([...wrapped.matchAll(STRING_KEYED_RECORD)].map((m) => m[1])).toEqual(['daily']);
  });

  // Behavioural spot-checks, one per kind of field the walk covers: a
  // required field, optional ones, and record keys.
  const IMPOSSIBLE = '2025-02-30';
  const VALID = '2025-02-28';
  test.each([
    [
      'transactions.date',
      (d: string) =>
        TransactionSchema.safeParse({
          transaction_id: 'Tq4mZ8xK2pL6vN1rB7cW',
          amount: 100,
          date: d,
        }),
    ],
    [
      'balance_history.date',
      (d: string) =>
        BalanceHistorySchema.safeParse({
          balance_id: 'Hb2kL7pQ4xN9vR1mC6tW',
          date: d,
          item_id: 'Ib3mN8qR5yP1wS2nD7uX',
          account_id: 'Ac4nP9rS6zQ2xT3oE8vY',
        }),
    ],
    [
      'recurring.next_date',
      (d: string) =>
        RecurringSchema.safeParse({ recurring_id: 'Rc5pQ1sT7aR3yU4pF9wZ', next_date: d }),
    ],
    [
      'budgets.start_date',
      (d: string) => BudgetSchema.safeParse({ budget_id: 'Bd6qR2tU8bS4zV5qG1xA', start_date: d }),
    ],
    [
      'financial_goals.created_date',
      (d: string) => GoalSchema.safeParse({ goal_id: 'Gl7rS3uV9cT5aW6rH2yB', created_date: d }),
    ],
    [
      'financial_goal_history.daily_data key',
      (d: string) =>
        GoalHistorySchema.safeParse({
          month: '2025-02',
          goal_id: 'Gl7rS3uV9cT5aW6rH2yB',
          daily_data: { [d]: { amount: 100 } },
        }),
    ],
    [
      'investment_splits.adjustments key',
      (d: string) =>
        InvestmentSplitSchema.safeParse({
          security_id: 'Sc8sT4vW1dU6bX7sI3zC',
          adjustments: { [d]: 0.5 },
        }),
    ],
  ])('%s rejects a well-formed but impossible day', (_name, parse) => {
    // The valid day parses, so the rejection is the date's and nothing else's.
    expect(parse(VALID).success).toBe(true);
    expect(parse(IMPOSSIBLE).success).toBe(false);
  });
});
