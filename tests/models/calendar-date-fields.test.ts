/**
 * Class-level detector for #920: every YYYY-MM-DD date field in the cache
 * models goes through calendarDateField (src/models/calendar-date.ts), so a
 * well-formed but impossible day such as 2025-02-30 is a counted drop rather
 * than a value that sorts past the end of its month and silently falls out of
 * every string-compared range.
 *
 * Discovery reads the source tree, not a hand-kept list of models, so a new
 * model file or field is covered without anyone remembering to add it:
 *   1. no model file outside calendar-date.ts may spell the YYYY-MM-DD
 *      pattern itself (the pattern-only definition this replaces);
 *   2. a field named `date` or `*_date` declared as a bare `z.string()` must
 *      be in EXEMPT below, with the reason it is not a calendar-day field.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BalanceHistorySchema } from '../../src/models/balance-history.js';
import { BudgetSchema } from '../../src/models/budget.js';
import { GoalSchema } from '../../src/models/goal.js';
import { InvestmentSplitSchema } from '../../src/models/investment-split.js';
import { RecurringSchema } from '../../src/models/recurring.js';
import { TransactionSchema } from '../../src/models/transaction.js';

const MODELS_DIR = join(import.meta.dir, '../../src/models');
const HELPER = 'calendar-date.ts';

/** `file:field` → why it is a plain string and not a calendar day. */
const EXEMPT: Record<string, string> = {
  'amazon.ts:date':
    'Amazon order date: its on-disk shape is not pinned and no cache range compares it; refine it once it is (#920)',
  'transaction.ts:original_date':
    'Not range-compared or bucketed anywhere; its on-disk shape is not pinned (#920)',
  'user-profile.ts:rollovers_starte_date':
    'Profile setting with no range comparison; its on-disk shape is not pinned (#920)',
};

const modelFiles = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.ts') && f !== HELPER);

// A regex spelling of YYYY-MM-DD: the pattern-only date check. (YYYY-MM month
// patterns are a different field kind and are not matched.)
const DATE_PATTERN_SPELLING = /\\d\{4\}-\\d\{2\}-\\d\{2\}/;
const BARE_DATE_FIELD = /^\s+(date|[a-z_]+_date):\s*z\.string\(\)/gm;

describe('cache model date fields are calendar days (#920)', () => {
  test('the walk sees the model files', () => {
    expect(modelFiles.length).toBeGreaterThan(20);
    expect(modelFiles).toContain('transaction.ts');
  });

  test('no model spells the YYYY-MM-DD pattern outside calendarDateField', () => {
    const offenders = modelFiles.filter((f) =>
      DATE_PATTERN_SPELLING.test(readFileSync(join(MODELS_DIR, f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  test('every bare z.string() date field is exempted with a reason', () => {
    const found: string[] = [];
    for (const f of modelFiles) {
      const src = readFileSync(join(MODELS_DIR, f), 'utf8');
      for (const m of src.matchAll(BARE_DATE_FIELD)) found.push(`${f}:${m[1]}`);
    }
    expect(found.filter((k) => !(k in EXEMPT))).toEqual([]);
    // An exemption whose field is gone (or now refined) is dropped, not left to rot.
    expect(Object.keys(EXEMPT).filter((k) => !found.includes(k))).toEqual([]);
  });

  // Behavioural spot-checks, one per kind of field the walk covers: a
  // required field, an optional one, and a record key.
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
