/**
 * Unit tests for CopilotDatabase abstraction layer.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { CopilotDatabase } from "../../src/core/database.js";
import type { Transaction, Account } from "../../src/models/index.js";

// Mock the decoder functions
const mockTransactions: Transaction[] = [
  {
    transaction_id: "txn1",
    amount: 50.0,
    date: "2024-01-15",
    name: "Coffee Shop",
    category_id: "food_dining",
    account_id: "acc1",
  },
  {
    transaction_id: "txn2",
    amount: 120.5,
    date: "2024-01-20",
    name: "Grocery Store",
    category_id: "groceries",
    account_id: "acc1",
  },
  {
    transaction_id: "txn3",
    amount: 25.0,
    date: "2024-02-10",
    original_name: "Fast Food",
    category_id: "food_dining",
    account_id: "acc2",
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
    current_balance: 500.0,
    official_name: "Savings Account",
    account_type: "savings",
  },
];

describe("CopilotDatabase", () => {
  let db: CopilotDatabase;

  beforeEach(() => {
    db = new CopilotDatabase("/fake/path");
    // Override the private _transactions and _accounts fields
    (db as any)._transactions = [...mockTransactions];
    (db as any)._accounts = [...mockAccounts];
  });

  describe("getTransactions", () => {
    test("returns all transactions when no filters applied", () => {
      const result = db.getTransactions();
      expect(result).toHaveLength(3);
    });

    test("filters by start date", () => {
      const result = db.getTransactions({ startDate: "2024-02-01" });
      expect(result).toHaveLength(1);
      expect(result[0].transaction_id).toBe("txn3");
    });

    test("filters by end date", () => {
      const result = db.getTransactions({ endDate: "2024-01-31" });
      expect(result).toHaveLength(2);
    });

    test("filters by category (case-insensitive)", () => {
      const result = db.getTransactions({ category: "FOOD" });
      expect(result).toHaveLength(2);
      expect(result.every((txn) => txn.category_id?.includes("food"))).toBe(
        true
      );
    });

    test("filters by merchant name", () => {
      const result = db.getTransactions({ merchant: "coffee" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Coffee Shop");
    });

    test("filters by account ID", () => {
      const result = db.getTransactions({ accountId: "acc1" });
      expect(result).toHaveLength(2);
    });

    test("filters by min amount", () => {
      const result = db.getTransactions({ minAmount: 50.0 });
      expect(result).toHaveLength(2);
    });

    test("filters by max amount", () => {
      const result = db.getTransactions({ maxAmount: 50.0 });
      expect(result).toHaveLength(2);
    });

    test("applies limit correctly", () => {
      const result = db.getTransactions({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    test("combines multiple filters", () => {
      const result = db.getTransactions({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        category: "food",
      });
      expect(result).toHaveLength(1);
      expect(result[0].transaction_id).toBe("txn1");
    });
  });

  describe("searchTransactions", () => {
    test("finds transactions by merchant name", () => {
      const result = db.searchTransactions("grocery");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Grocery Store");
    });

    test("is case-insensitive", () => {
      const result = db.searchTransactions("COFFEE");
      expect(result).toHaveLength(1);
    });

    test("uses original_name when name is not present", () => {
      const result = db.searchTransactions("fast");
      expect(result).toHaveLength(1);
      expect(result[0].original_name).toBe("Fast Food");
    });

    test("applies limit correctly", () => {
      const result = db.searchTransactions("food", 0);
      expect(result).toHaveLength(0);
    });
  });

  describe("getAccounts", () => {
    test("returns all accounts when no filter applied", () => {
      const result = db.getAccounts();
      expect(result).toHaveLength(2);
    });

    test("filters by account type", () => {
      const result = db.getAccounts("checking");
      expect(result).toHaveLength(1);
      expect(result[0].account_type).toBe("checking");
    });

    test("account type filter is case-insensitive", () => {
      const result = db.getAccounts("SAVINGS");
      expect(result).toHaveLength(1);
    });
  });

  describe("getCategories", () => {
    test("returns unique categories from transactions", () => {
      const result = db.getCategories();
      expect(result).toHaveLength(2);

      const categoryIds = result.map((c) => c.category_id);
      expect(categoryIds).toContain("food_dining");
      expect(categoryIds).toContain("groceries");
    });

    test("category name defaults to category_id", () => {
      const result = db.getCategories();
      const foodCategory = result.find((c) => c.category_id === "food_dining");
      expect(foodCategory?.name).toBe("food_dining");
    });
  });

  describe("isAvailable", () => {
    test("returns false for non-existent path", () => {
      const db = new CopilotDatabase("/fake/nonexistent/path");
      expect(db.isAvailable()).toBe(false);
    });
  });

  describe("getDbPath", () => {
    test("returns the database path", () => {
      expect(db.getDbPath()).toBe("/fake/path");
    });
  });
});
