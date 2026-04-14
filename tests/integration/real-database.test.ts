/**
 * Real Database Integration Tests
 *
 * These tests run against an actual Copilot Money database to verify
 * field mapping accuracy and data parsing correctness.
 *
 * The tests are designed to:
 * 1. Skip gracefully if no real database is found (e.g., CI environments)
 * 2. Verify that all parsed data passes Zod schema validation
 * 3. Report statistics about the data found
 * 4. Catch field mapping issues that synthetic tests might miss
 *
 * IMPORTANT: These tests are OPT-IN due to long load times on large databases.
 * They will only run when the RUN_REAL_DB_TESTS environment variable is set.
 *
 * IMPORTANT: You must quit the Copilot Money app before running these tests!
 * LevelDB does not allow concurrent access from multiple processes.
 *
 * To run these tests locally:
 * 1. Quit the Copilot Money app (Cmd+Q)
 * 2. Run: RUN_REAL_DB_TESTS=1 bun test tests/integration/real-database.test.ts
 * 3. Restart Copilot Money when done
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CopilotDatabase } from '../../src/core/database.js';
import {
  TransactionSchema,
  AccountSchema,
  RecurringSchema,
  BudgetSchema,
  GoalSchema,
  GoalHistorySchema,
  InvestmentPriceSchema,
  InvestmentSplitSchema,
  ItemSchema,
  CategorySchema,
} from '../../src/models/index.js';
import type {
  Transaction,
  Account,
  Recurring,
  Budget,
  Goal,
  GoalHistory,
  InvestmentPrice,
  InvestmentSplit,
  Item,
  Category,
} from '../../src/models/index.js';
import type { UserAccountCustomization } from '../../src/core/decoder.js';

/**
 * Find the real Copilot Money database path.
 * Returns undefined if not found.
 */
function findRealDatabase(): string | undefined {
  const home = homedir();

  // Known possible locations for Copilot Money database (macOS)
  const possiblePaths = [
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/firestore/__FIRAPP_DEFAULT',
      'copilot-production-22904/main'
    ),
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/Copilot/FirestoreDB/data'
    ),
    join(home, 'Library/Application Support/Copilot/FirestoreDB/data'),
    join(home, 'Library/Containers/com.copilot.production/Data/Documents/FirestoreDB'),
  ];

  // Also try to dynamically find paths matching patterns
  const containerBase = join(
    home,
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );
  if (existsSync(containerBase)) {
    try {
      const firestorePath = join(containerBase, 'firestore/__FIRAPP_DEFAULT');
      if (existsSync(firestorePath)) {
        const entries = readdirSync(firestorePath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('copilot-')) {
            const mainPath = join(firestorePath, entry.name, 'main');
            if (existsSync(mainPath)) {
              possiblePaths.unshift(mainPath);
            }
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Check each path for validity
  for (const path of possiblePaths) {
    try {
      if (existsSync(path)) {
        const files = readdirSync(path);
        if (files.some((file) => file.endsWith('.ldb') || file.startsWith('MANIFEST-'))) {
          return path;
        }
      }
    } catch {
      // Continue to next path
    }
  }

  return undefined;
}

// Check if tests are enabled via environment variable
const RUN_REAL_DB_TESTS = process.env.RUN_REAL_DB_TESTS === '1';

// Find database once at module load time
const REAL_DB_PATH = findRealDatabase();
const HAS_REAL_DB = REAL_DB_PATH !== undefined && RUN_REAL_DB_TESTS;

interface DataStats {
  count: number;
  validCount: number;
  invalidCount: number;
  errors: string[];
}

// Validation helper
function validateWithSchema<T>(
  items: T[],
  schema: {
    safeParse: (item: T) => {
      success: boolean;
      error?: { issues: Array<{ path: (string | number)[]; message: string }> };
    };
  },
  idExtractor: (item: T) => string
): DataStats {
  const stats: DataStats = {
    count: items.length,
    validCount: 0,
    invalidCount: 0,
    errors: [],
  };

  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      stats.validCount++;
    } else {
      stats.invalidCount++;
      if (stats.errors.length < 5 && result.error) {
        stats.errors.push(
          `${idExtractor(item)}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        );
      }
    }
  }

  return stats;
}

// Skip all tests if no real database
const describeWithRealDb = HAS_REAL_DB ? describe : describe.skip;

/**
 * Loaded data container - populated once in beforeAll
 */
interface LoadedData {
  transactions: Transaction[];
  accounts: Account[];
  recurring: Recurring[];
  budgets: Budget[];
  goals: Goal[];
  goalHistory: GoalHistory[];
  investmentPrices: InvestmentPrice[];
  investmentSplits: InvestmentSplit[];
  items: Item[];
  userCategories: Category[];
  userAccounts: UserAccountCustomization[];
  categoryNameMap: Map<string, string>;
  accountNameMap: Map<string, string>;
}

describeWithRealDb('Real Copilot Money Database Integration', () => {
  let db: CopilotDatabase;
  let data: LoadedData;

  // Load all data once to avoid LevelDB concurrency issues
  // Use 120 second timeout since database copy and loading can be slow
  beforeAll(async () => {
    if (!REAL_DB_PATH) {
      throw new Error('Real database path not found');
    }
    console.log(`\n📂 Using real database: ${REAL_DB_PATH}\n`);
    db = new CopilotDatabase(REAL_DB_PATH);

    console.log('⏳ Loading all data from database...');
    const startTime = Date.now();

    try {
      // Load all data types sequentially to avoid LevelDB locking issues
      const transactions = await db.getAllTransactions();
      const accounts = await db.getAccounts();
      const recurring = await db.getRecurring();
      const budgets = await db.getBudgets();
      const goals = await db.getGoals();
      const goalHistory = await db.getGoalHistory();
      const investmentPrices = await db.getInvestmentPrices();
      const investmentSplits = await db.getInvestmentSplits();
      const items = await db.getItems();
      const userCategories = await db.getUserCategories();
      const userAccounts = await db.getUserAccounts();
      const categoryNameMap = await db.getCategoryNameMap();
      const accountNameMap = await db.getAccountNameMap();

      data = {
        transactions,
        accounts,
        recurring,
        budgets,
        goals,
        goalHistory,
        investmentPrices,
        investmentSplits,
        items,
        userCategories,
        userAccounts,
        categoryNameMap,
        accountNameMap,
      };

      const elapsed = Date.now() - startTime;
      console.log(`✅ Data loaded in ${elapsed}ms\n`);

      // Print summary
      console.log('📊 Data Summary:');
      console.log(`   Transactions: ${transactions.length.toLocaleString()}`);
      console.log(`   Accounts: ${accounts.length}`);
      console.log(`   Recurring: ${recurring.length}`);
      console.log(`   Budgets: ${budgets.length}`);
      console.log(`   Goals: ${goals.length}`);
      console.log(`   Goal History: ${goalHistory.length}`);
      console.log(`   Investment Prices: ${investmentPrices.length.toLocaleString()}`);
      console.log(`   Investment Splits: ${investmentSplits.length}`);
      console.log(`   Items: ${items.length}`);
      console.log(`   User Categories: ${userCategories.length}`);
      console.log(`   User Accounts: ${userAccounts.length}`);
      console.log('');
    } catch (error) {
      // Check for common LevelDB errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCode = (error as { code?: string })?.code;

      if (errorCode === 'LEVEL_LOCKED' || errorMsg.includes('lock') || errorMsg.includes('LOCK')) {
        console.error('\n❌ Database is locked by another process.');
        console.error('   The Copilot Money app is likely running.');
        console.error('\n   To run these tests:');
        console.error('   1. Quit Copilot Money (Cmd+Q)');
        console.error('   2. Run the tests again');
        console.error('   3. Restart Copilot Money when done\n');
      } else if (
        errorCode === 'LEVEL_ITERATOR_NOT_OPEN' ||
        errorMsg.includes('Iterator is not open')
      ) {
        console.error('\n❌ Database access error - iterator closed unexpectedly.');
        console.error('   This usually means the Copilot Money app is running.');
        console.error('\n   To run these tests:');
        console.error('   1. Quit Copilot Money (Cmd+Q)');
        console.error('   2. Run the tests again');
        console.error('   3. Restart Copilot Money when done\n');
      }
      throw error;
    }
  }, 300000); // 5 minute timeout for large database loading

  test('database is available and accessible', () => {
    expect(db.isAvailable()).toBe(true);
    expect(db.getDbPath()).toBe(REAL_DB_PATH);
  });

  describe('Transactions', () => {
    test('has transactions', () => {
      expect(data.transactions.length).toBeGreaterThan(0);
    });

    test('all transactions pass schema validation', () => {
      const stats = validateWithSchema(
        data.transactions,
        TransactionSchema,
        (t) => `Transaction ${t.transaction_id}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Transaction validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });

    test('transaction dates parse to valid Date objects', () => {
      // Schema already enforces YYYY-MM-DD format via regex; this adds the
      // runtime parse check (e.g., 2025-02-31 would match the regex but fail here).
      for (const txn of data.transactions) {
        const parsed = new Date(txn.date);
        expect(parsed.toString()).not.toBe('Invalid Date');
      }
    });

    test('transaction amounts are reasonable', () => {
      for (const txn of data.transactions) {
        expect(Math.abs(txn.amount)).toBeLessThan(10_000_000);
        expect(Number.isFinite(txn.amount)).toBe(true);
      }
    });
  });

  describe('Accounts', () => {
    test('has accounts', () => {
      expect(data.accounts.length).toBeGreaterThan(0);
    });

    test('all accounts pass schema validation', () => {
      const stats = validateWithSchema(
        data.accounts,
        AccountSchema,
        (a) => `Account ${a.account_id}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Account validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });

    test('accounts have required fields', () => {
      for (const acc of data.accounts) {
        expect(acc.account_id).toBeDefined();
        expect(typeof acc.account_id).toBe('string');
        expect(acc.current_balance).toBeDefined();
        expect(typeof acc.current_balance).toBe('number');
      }
    });

    test('account types are recognized', () => {
      const knownTypes = ['depository', 'credit', 'investment', 'loan', 'brokerage', 'other'];
      for (const acc of data.accounts) {
        if (acc.account_type) {
          expect(knownTypes).toContain(acc.account_type.toLowerCase());
        }
      }
    });
  });

  describe('Recurring Transactions', () => {
    test('recurring transactions pass schema validation (if any exist)', () => {
      if (data.recurring.length === 0) {
        console.log('   (No recurring transactions found - this is OK)');
        return;
      }

      const stats = validateWithSchema(
        data.recurring,
        RecurringSchema,
        (r) => `Recurring ${r.recurring_id}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Recurring validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });

    test('recurring transactions have required fields', () => {
      for (const rec of data.recurring) {
        expect(rec.recurring_id).toBeDefined();
        expect(typeof rec.recurring_id).toBe('string');
      }
    });
  });

  describe('Budgets', () => {
    test('budgets pass schema validation (if any exist)', () => {
      if (data.budgets.length === 0) {
        console.log('   (No budgets found - this is OK)');
        return;
      }

      const stats = validateWithSchema(data.budgets, BudgetSchema, (b) => `Budget ${b.budget_id}`);

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Budget validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Goals', () => {
    test('goals pass schema validation (if any exist)', () => {
      if (data.goals.length === 0) {
        console.log('   (No goals found - this is OK)');
        return;
      }

      const stats = validateWithSchema(data.goals, GoalSchema, (g) => `Goal ${g.goal_id}`);

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Goal validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Goal History', () => {
    test('goal history passes schema validation (if any exist)', () => {
      if (data.goalHistory.length === 0) {
        console.log('   (No goal history found - this is OK)');
        return;
      }

      const stats = validateWithSchema(
        data.goalHistory,
        GoalHistorySchema,
        (h) => `GoalHistory ${h.goal_id}/${h.month}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Goal history validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Investment Prices', () => {
    test('investment prices pass schema validation (if any exist)', () => {
      if (data.investmentPrices.length === 0) {
        console.log('   (No investment prices found - this is OK)');
        return;
      }

      // Only validate a sample for large datasets
      const sample = data.investmentPrices.slice(0, 1000);
      const stats = validateWithSchema(
        sample,
        InvestmentPriceSchema,
        (p) => `InvestmentPrice ${p.investment_id}`
      );

      console.log(`   Validated sample: ${sample.length} of ${data.investmentPrices.length}`);

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Investment price validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Investment Splits', () => {
    test('investment splits pass schema validation (if any exist)', () => {
      if (data.investmentSplits.length === 0) {
        console.log('   (No investment splits found - this is OK)');
        return;
      }

      const stats = validateWithSchema(
        data.investmentSplits,
        InvestmentSplitSchema,
        (s) => `InvestmentSplit ${s.split_id}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Investment split validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Items (Institution Connections)', () => {
    test('items pass schema validation (if any exist)', () => {
      if (data.items.length === 0) {
        console.log('   (No items found - this is OK)');
        return;
      }

      const stats = validateWithSchema(data.items, ItemSchema, (i) => `Item ${i.item_id}`);

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Item validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('User Categories', () => {
    test('categories pass schema validation (if any exist)', () => {
      if (data.userCategories.length === 0) {
        console.log('   (No user categories found - this is OK)');
        return;
      }

      const stats = validateWithSchema(
        data.userCategories,
        CategorySchema,
        (c) => `Category ${c.category_id}`
      );

      if (stats.invalidCount > 0) {
        console.log(`\n⚠️  Category validation errors (${stats.invalidCount}):`);
        stats.errors.forEach((e) => console.log(`   ${e}`));
      }

      expect(stats.invalidCount).toBe(0);
    });
  });

  describe('Cross-Entity Validation', () => {
    test('transactions reference valid accounts', () => {
      const accountIds = new Set(data.accounts.map((a) => a.account_id));
      const sampleTxns = data.transactions.slice(0, 500);

      let orphanCount = 0;
      for (const txn of sampleTxns) {
        if (txn.account_id && !accountIds.has(txn.account_id)) {
          orphanCount++;
        }
      }

      console.log(`\n📊 Cross-Entity Validation:`);
      console.log(`   Transactions checked: ${sampleTxns.length}`);
      console.log(`   Orphan transactions (no matching account): ${orphanCount}`);

      // Allow some orphans (accounts might be hidden/deleted)
      const orphanRate = sampleTxns.length > 0 ? orphanCount / sampleTxns.length : 0;
      expect(orphanRate).toBeLessThan(0.1); // Less than 10% orphans
    });

    test('transaction custom category references resolve (if user categories exist)', () => {
      if (data.categoryNameMap.size === 0) {
        console.log('   (No user categories - skipping category validation)');
        return;
      }

      const sampleTxns = data.transactions.slice(0, 500);
      let customCategoryCount = 0;
      let unmappedCustomCount = 0;

      for (const txn of sampleTxns) {
        if (txn.category_id && !txn.category_id.includes('_')) {
          // Likely a custom category (UUIDs don't have underscores, Plaid IDs do)
          customCategoryCount++;
          if (!data.categoryNameMap.has(txn.category_id)) {
            unmappedCustomCount++;
          }
        }
      }

      // Allow a small fraction of unmapped custom categories (deleted categories
      // may still be referenced by historical transactions), but a large gap
      // indicates a real decoding or resolution bug.
      const unmappedRate = customCategoryCount > 0 ? unmappedCustomCount / customCategoryCount : 0;
      expect(unmappedRate).toBeLessThan(0.1);
    });
  });
});
