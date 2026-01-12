/**
 * Integration tests for CopilotDatabase.
 *
 * Note: These tests require a demo database at tests/fixtures/demo_database.
 * For now, tests use mocked data. To run with real database:
 * 1. Copy Copilot Money database to tests/fixtures/demo_database
 * 2. Uncomment the real database tests below
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { CopilotDatabase } from "../../src/core/database.js";
import type { Transaction, Account } from "../../src/models/index.js";

// Mock transactions for testing
const mockTransactions: Transaction[] = [
  {
    transaction_id: "txn1",
    amount: 50.0,
    date: "2026-01-15",
    name: "Starbucks",
    category_id: "food_dining",
    account_id: "acc1",
  },
  {
    transaction_id: "txn2",
    amount: 15.5,
    date: "2026-01-10",
    name: "Starbucks Coffee",
    category_id: "food_dining",
    account_id: "acc1",
  },
  {
    transaction_id: "txn3",
    amount: 120.0,
    date: "2026-01-08",
    name: "Whole Foods",
    category_id: "groceries",
    account_id: "acc2",
  },
  {
    transaction_id: "txn4",
    amount: 8.0,
    date: "2026-01-05",
    name: "Starbucks",
    category_id: "food_dining",
    account_id: "acc1",
  },
  {
    transaction_id: "txn5",
    amount: 250.0,
    date: "2025-12-20",
    name: "Target",
    category_id: "shopping",
    account_id: "acc1",
  },
];

const mockAccounts: Account[] = [
  {
    account_id: "acc1",
    current_balance: 1500.0,
    name: "Checking Account",
    account_type: "checking",
  },
  {
    account_id: "acc2",
    current_balance: 2500.0,
    name: "Savings Account",
    account_type: "savings",
  },
  {
    account_id: "acc3",
    current_balance: 500.0,
    name: "Credit Card",
    account_type: "credit",
  },
];

describe("CopilotDatabase Integration", () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase("/fake/path");
    // Mock the internal data
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
  });

  describe("initialization", () => {
    test("can be initialized", () => {
      const db = new CopilotDatabase("/fake/path");
      expect(db).toBeDefined();
    });

    test("reports database not available for missing path", () => {
      const db = new CopilotDatabase("/nonexistent/path");
      expect(db.isAvailable()).toBe(false);
    });
  });

  describe("getTransactions", () => {
    test("returns transactions without filters", () => {
      const txns = db.getTransactions({ limit: 10 });
      expect(txns.length).toBeLessThanOrEqual(10);
      expect(txns.every((txn) => txn.transaction_id)).toBe(true);
    });

    test("filters transactions by date range", () => {
      const txns = db.getTransactions({
        startDate: "2026-01-01",
        endDate: "2026-01-10",
        limit: 1000,
      });

      expect(
        txns.every((txn) => txn.date >= "2026-01-01" && txn.date <= "2026-01-10")
      ).toBe(true);
    });

    test("filters transactions by merchant name", () => {
      const txns = db.getTransactions({ merchant: "starbucks", limit: 100 });

      expect(txns.length).toBe(3); // Three Starbucks transactions
      expect(
        txns.every((txn) =>
          (txn.name || txn.original_name || "")
            .toLowerCase()
            .includes("starbucks")
        )
      ).toBe(true);
    });

    test("filters transactions by amount range", () => {
      const txns = db.getTransactions({
        minAmount: 10.0,
        maxAmount: 20.0,
        limit: 100,
      });

      expect(txns.every((txn) => txn.amount >= 10.0 && txn.amount <= 20.0)).toBe(
        true
      );
    });

    test("filters transactions by category", () => {
      const txns = db.getTransactions({ category: "food", limit: 100 });

      expect(
        txns.every(
          (txn) =>
            txn.category_id && txn.category_id.toLowerCase().includes("food")
        )
      ).toBe(true);
    });

    test("filters transactions by account ID", () => {
      const txns = db.getTransactions({ accountId: "acc1", limit: 100 });

      expect(txns.every((txn) => txn.account_id === "acc1")).toBe(true);
      expect(txns.length).toBe(4); // Four transactions on acc1
    });

    test("respects limit parameter", () => {
      const limits = [1, 2, 5];
      for (const limit of limits) {
        const txns = db.getTransactions({ limit });
        expect(txns.length).toBeLessThanOrEqual(limit);
      }
    });

    test("combines multiple filters", () => {
      const txns = db.getTransactions({
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        minAmount: 5.0,
        category: "food",
        limit: 100,
      });

      for (const txn of txns) {
        expect(txn.date >= "2026-01-01" && txn.date <= "2026-12-31").toBe(true);
        expect(txn.amount >= 5.0).toBe(true);
        expect(
          txn.category_id && txn.category_id.toLowerCase().includes("food")
        ).toBe(true);
      }
    });

    test("returns empty array for impossible filters", () => {
      const txns = db.getTransactions({
        startDate: "1900-01-01",
        endDate: "1900-01-31",
        limit: 100,
      });

      expect(txns).toEqual([]);
    });
  });

  describe("searchTransactions", () => {
    test("searches transactions by merchant name", () => {
      const txns = db.searchTransactions("starbucks", 20);

      expect(txns.length).toBe(3);
    });

    test("is case-insensitive", () => {
      const results1 = db.searchTransactions("STARBUCKS", 10);
      const results2 = db.searchTransactions("starbucks", 10);

      expect(results1.length).toBe(results2.length);
    });

    test("respects limit parameter", () => {
      const txns = db.searchTransactions("test", 1);
      expect(txns.length).toBeLessThanOrEqual(1);
    });

    test("returns empty array for no matches", () => {
      const txns = db.searchTransactions("xyznonexistent123", 100);
      expect(txns).toEqual([]);
    });
  });

  describe("getAccounts", () => {
    test("returns all accounts", () => {
      const accounts = db.getAccounts();

      expect(accounts.length).toBe(3);
      expect(accounts.every((acc) => acc.account_id)).toBe(true);
      expect(accounts.every((acc) => acc.current_balance !== undefined)).toBe(
        true
      );
    });

    test("filters accounts by type", () => {
      const accounts = db.getAccounts("checking");

      expect(accounts.length).toBe(1);
      expect(accounts[0].account_type).toBe("checking");
    });

    test("account type filter is case-insensitive", () => {
      const results1 = db.getAccounts("SAVINGS");
      const results2 = db.getAccounts("savings");

      expect(results1.length).toBe(results2.length);
    });
  });

  describe("getCategories", () => {
    test("returns unique categories", () => {
      const categories = db.getCategories();

      expect(categories.length).toBeGreaterThan(0);

      // Check uniqueness
      const categoryIds = categories.map((c) => c.category_id);
      const uniqueIds = new Set(categoryIds);
      expect(categoryIds.length).toBe(uniqueIds.size);
    });

    test("category name is human-readable", () => {
      const categories = db.getCategories();

      // All categories should have human-readable names
      for (const cat of categories) {
        expect(cat.name).toBeDefined();
        expect(cat.name.length).toBeGreaterThan(0);
      }

      // Check specific mappings
      const foodCategory = categories.find((c) => c.category_id === "food_dining");
      if (foodCategory) {
        expect(foodCategory.name).toBe("Food & Drink");
      }
    });
  });
});

/*
 * REAL DATABASE TESTS
 *
 * Uncomment these tests when you have a demo database at tests/fixtures/demo_database
 */

/*
import { existsSync } from "fs";
import { join } from "path";

const DEMO_DB_PATH = join(__dirname, "../fixtures/demo_database");
const hasDemoDb = existsSync(DEMO_DB_PATH);

if (hasDemoDb) {
  describe("CopilotDatabase with Real Data", () => {
    let db: CopilotDatabase;

    beforeEach(() => {
      db = new CopilotDatabase(DEMO_DB_PATH);
    });

    test("database is available", () => {
      expect(db.isAvailable()).toBe(true);
    });

    test("can decode transactions", () => {
      const txns = db.getTransactions({ limit: 10 });
      expect(txns.length).toBeGreaterThan(0);
    });

    test("can decode accounts", () => {
      const accounts = db.getAccounts();
      expect(accounts.length).toBeGreaterThan(0);
    });

    test("transactions are sorted by date descending", () => {
      const txns = db.getTransactions({ limit: 50 });

      for (let i = 0; i < txns.length - 1; i++) {
        expect(txns[i].date >= txns[i + 1].date).toBe(true);
      }
    });
  });
}
*/
