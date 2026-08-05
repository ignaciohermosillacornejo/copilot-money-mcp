/**
 * Class-level detector for issue #622.
 *
 * Every collection here is reachable by TWO decode paths: a standalone
 * `decodeX(dbPath)` and the single-pass `decodeAllCollections(dbPath)`. Each
 * path carries its own collection-matching predicate, and nothing forced them
 * to agree — which is precisely how #622 hid. The standalone investment-price
 * decoder matched the LEAF segment (`investment_prices`) while real documents
 * live under `investment_prices/{securityId}/daily`, so it returned zero rows;
 * the aggregate path had a bespoke extra clause and returned all of them. Both
 * were "tested", neither test compared them, and the disagreement was invisible.
 *
 * This test makes the two paths prove they agree. It needs no real data: any
 * future decoder whose predicate matches a different set of documents than its
 * aggregate branch fails here, whatever the underlying cause (parent-vs-leaf
 * segment, nesting depth, a renamed collection).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeInvestmentPrices,
  decodeItems,
  decodeCategories,
  decodeAllCollections,
} from '../../src/core/decoder.js';
import { createCombinedDb } from '../helpers/test-db.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'decode-parity-'));
const DB_PATH = path.join(FIXTURES_DIR, 'combined');

const SEC_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f70819a2b3c4d5e6f7081';
const SEC_B = 'f0e1d2c3b4a59687756433221100ffeeddccbbaa99887766554433221100abcd';

beforeAll(async () => {
  await createCombinedDb(DB_PATH, {
    transactions: [
      {
        transaction_id: 'txn_7hK2mQ9xLp4RwN6vBz3T',
        name: 'Coffee Shop',
        amount: 5,
        date: '2024-03-01',
        account_id: 'acc_3vBn8KwJcM1XzQ5tLf7H',
      },
    ],
    // current_balance is load-bearing: processAccount returns null without it.
    accounts: [
      {
        account_id: 'acc_3vBn8KwJcM1XzQ5tLf7H',
        name: 'Checking',
        account_type: 'depository',
        current_balance: 100,
      },
    ],
    categories: [{ category_id: 'cat_9dTr4XmPqW2LbY6nJv8K', name: 'Food' }],
    items: [{ item_id: 'itm_5pQw8ZnRvL3MxK7cHt2J', institution_name: 'Synthetic Bank' }],
    budgets: [
      {
        budget_id: 'bgt_2xKf7VnQdR9WzM4pLc6T',
        category_id: 'cat_9dTr4XmPqW2LbY6nJv8K',
        amount: 100,
      },
    ],
    goals: [{ goal_id: 'gol_6bXs2VmNqT9LzR4kWd8P', name: 'Trip', target_amount: 1000 }],
    goalHistory: [
      { goal_id: 'gol_6bXs2VmNqT9LzR4kWd8P', month: '2024-02', total_contribution: 100 },
    ],
    recurring: [{ recurring_id: 'rec_8kLm3PqXvB7NzT5wJd2R', name: 'Gym' }],
    // Two securities sharing a period, across BOTH subcollection leaves — the
    // exact arrangement the pre-fix decoder collapsed.
    investmentPrices: [
      {
        security_id: SEC_A,
        price_type: 'daily',
        period: '2024-02',
        prices: { '1706745600000': 10 },
      },
      {
        security_id: SEC_B,
        price_type: 'daily',
        period: '2024-02',
        prices: { '1706745600000': 20 },
      },
      {
        security_id: SEC_A,
        price_type: 'hf',
        period: '2024-02-01',
        prices: { '1706745600000': 30 },
      },
    ],
  });
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('processors must not parse the raw LevelDB key (#622)', () => {
  // Defect 3 of #622: price_type came from `key.includes('/daily/')`, where
  // `key` is the raw LevelDB key. Production keys are binary ordered-code, so
  // the literal never appears and the test always failed — but the fixture
  // writer emits utf8 string keys, where it DOES appear. Raw-key logic is
  // therefore untestable by construction: it takes one path in fixtures and the
  // opposite path in production, and no synthetic test can catch the difference.
  //
  // Structure must come from the PARSED collection path instead. This ratchet
  // pins that: no `process*` helper may take the raw key.
  test('no process* helper accepts a raw `key` parameter', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '../../src/core/decoder.ts'), 'utf8');

    // Extract each parameter list by counting balanced parens rather than
    // matching `[^)]*` — a param typed `cb: () => void` closes the naive
    // pattern early, truncating everything after it and letting a later
    // `key: string` slip through unseen. The ratchet would then be silently
    // weaker than it looks, which is the failure mode it exists to prevent.
    function paramsOf(startIndex: number): string {
      let depth = 0;
      for (let i = startIndex; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) return src.slice(startIndex + 1, i);
        }
      }
      return '';
    }

    const offenders: string[] = [];
    const declaration = /function (process\w+)\(/g;
    let found = 0;
    let m: RegExpExecArray | null;
    while ((m = declaration.exec(src)) !== null) {
      found++;
      const params = paramsOf(m.index + m[0].length - 1);
      // Top-level `key:` only — a nested object type like
      // `opts: { key: string }` is not a raw-key parameter.
      const topLevel = params.replace(/\{[^}]*\}/g, '');
      if (/\bkey\s*:/.test(topLevel)) offenders.push(m[1]!);
    }

    // Guard against the scan silently matching nothing: a rename or a refactor
    // to arrow functions would leave this vacuously green while the invariant
    // went unchecked.
    expect(src).toContain('function processInvestmentPrice(');
    expect(found).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('standalone vs aggregate decode parity (#622)', () => {
  const cases: Array<{
    name: string;
    standalone: () => Promise<unknown[]>;
    aggregate: (r: Awaited<ReturnType<typeof decodeAllCollections>>) => unknown[];
  }> = [
    {
      name: 'transactions',
      standalone: () => decodeTransactions(DB_PATH),
      aggregate: (r) => r.transactions,
    },
    { name: 'accounts', standalone: () => decodeAccounts(DB_PATH), aggregate: (r) => r.accounts },
    {
      name: 'recurring',
      standalone: () => decodeRecurring(DB_PATH),
      aggregate: (r) => r.recurring,
    },
    { name: 'budgets', standalone: () => decodeBudgets(DB_PATH), aggregate: (r) => r.budgets },
    { name: 'goals', standalone: () => decodeGoals(DB_PATH), aggregate: (r) => r.goals },
    {
      name: 'goalHistory',
      standalone: () => decodeGoalHistory(DB_PATH),
      aggregate: (r) => r.goalHistory,
    },
    {
      name: 'investmentPrices',
      standalone: () => decodeInvestmentPrices(DB_PATH),
      aggregate: (r) => r.investmentPrices,
    },
    { name: 'items', standalone: () => decodeItems(DB_PATH), aggregate: (r) => r.items },
    {
      name: 'categories',
      standalone: () => decodeCategories(DB_PATH),
      aggregate: (r) => r.categories,
    },
  ];

  for (const c of cases) {
    // Sequential, never Promise.all: each decode opens its own iterator over a
    // temp copy of the same database, and concurrent iterations collide.
    test(`${c.name}: both paths return the same rows`, async () => {
      const viaStandalone = await c.standalone();
      const viaAggregate = c.aggregate(await decodeAllCollections(DB_PATH));

      // Guard against the whole comparison passing vacuously on two empty sets:
      // the fixture seeds every collection, so zero rows means the fixture (or
      // both predicates) broke, which is itself worth failing on.
      expect(viaStandalone.length).toBeGreaterThan(0);
      expect(viaAggregate.length).toBe(viaStandalone.length);
      expect(new Set(viaAggregate.map((r) => JSON.stringify(r)))).toEqual(
        new Set(viaStandalone.map((r) => JSON.stringify(r)))
      );
    });
  }
});
