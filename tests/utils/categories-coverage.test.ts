/**
 * Additional coverage tests for src/utils/categories.ts
 *
 * This file specifically tests uncovered branches:
 * - Line 925: lowercase category ID matching
 * - Lines 931-934: snake_case to Title Case conversion for unknown categories
 */

import { describe, expect, test } from 'bun:test';
import {
  getCategoryName,
  isTransferCategory,
  isIncomeCategory,
  CATEGORY_NAMES,
  TRANSFER_CATEGORIES,
  INCOME_CATEGORIES,
} from '../../src/utils/categories';

describe('categories.ts coverage tests', () => {
  describe('getCategoryName - lowercase matching (line 925)', () => {
    test('should match uppercase category ID to lowercase entry', () => {
      // "income" exists in CATEGORY_NAMES, test with uppercase
      const result = getCategoryName('INCOME');
      expect(result).toBe('Income');
    });

    test('should match mixed case category ID to lowercase entry', () => {
      // "groceries" exists in CATEGORY_NAMES
      const result = getCategoryName('GROCERIES');
      expect(result).toBe('Groceries');
    });

    test('should match PascalCase category ID to lowercase entry', () => {
      const result = getCategoryName('Entertainment');
      expect(result).toBe('Entertainment');
    });

    test('should match uppercase snake_case category ID', () => {
      // "food_and_drink" exists in CATEGORY_NAMES
      const result = getCategoryName('FOOD_AND_DRINK');
      expect(result).toBe('Food & Drink');
    });
  });

  describe('getCategoryName - snake_case to Title Case conversion (lines 931-934)', () => {
    test('should convert unknown snake_case category to Title Case', () => {
      // This category does not exist in CATEGORY_NAMES
      const result = getCategoryName('my_custom_category');
      expect(result).toBe('My Custom Category');
    });

    test('should convert unknown multi-word snake_case to Title Case', () => {
      const result = getCategoryName('some_very_long_category_name');
      expect(result).toBe('Some Very Long Category Name');
    });

    test('should handle single underscore unknown category', () => {
      const result = getCategoryName('unknown_category');
      expect(result).toBe('Unknown Category');
    });

    test('should handle uppercase unknown snake_case category', () => {
      // Should first try lowercase, then fall through to snake_case conversion
      const result = getCategoryName('UNKNOWN_CUSTOM_TYPE');
      expect(result).toBe('Unknown Custom Type');
    });
  });

  describe('getCategoryName - edge cases', () => {
    test('should return original for unknown category without underscores', () => {
      const result = getCategoryName('unknowncategory123');
      expect(result).toBe('unknowncategory123');
    });

    test('should handle empty string', () => {
      const result = getCategoryName('');
      expect(result).toBe('');
    });

    test('should handle numeric category IDs', () => {
      // "13000000" exists in CATEGORY_NAMES
      const result = getCategoryName('13000000');
      expect(result).toBe('Food & Drink');
    });
  });

  describe('exported constants', () => {
    test('CATEGORY_NAMES should have expected structure', () => {
      expect(CATEGORY_NAMES).toBeDefined();
      expect(typeof CATEGORY_NAMES).toBe('object');
      expect(CATEGORY_NAMES['income']).toBe('Income');
    });

    test('TRANSFER_CATEGORIES should be a Set', () => {
      expect(TRANSFER_CATEGORIES).toBeInstanceOf(Set);
      expect(TRANSFER_CATEGORIES.has('transfer_in')).toBe(true);
    });

    test('INCOME_CATEGORIES should be a Set', () => {
      expect(INCOME_CATEGORIES).toBeInstanceOf(Set);
      expect(INCOME_CATEGORIES.has('income')).toBe(true);
    });
  });

  describe('isTransferCategory', () => {
    test('should return false for undefined', () => {
      expect(isTransferCategory(undefined)).toBe(false);
    });

    test('should return true for exact match', () => {
      expect(isTransferCategory('transfer_in')).toBe(true);
    });

    test('should return true for lowercase match', () => {
      expect(isTransferCategory('TRANSFER_IN')).toBe(true);
    });

    test('should return true for category containing "transfer"', () => {
      expect(isTransferCategory('my_transfer_type')).toBe(true);
    });

    test('should return true for category containing "payment"', () => {
      expect(isTransferCategory('some_payment_type')).toBe(true);
    });

    test('should return true for credit_card', () => {
      expect(isTransferCategory('credit_card')).toBe(true);
    });

    test('should return false for non-transfer category', () => {
      expect(isTransferCategory('groceries')).toBe(false);
    });
  });

  describe('isIncomeCategory', () => {
    test('should return false for undefined', () => {
      expect(isIncomeCategory(undefined)).toBe(false);
    });

    test('should return true for exact match', () => {
      expect(isIncomeCategory('income')).toBe(true);
    });

    test('should return true for lowercase match', () => {
      expect(isIncomeCategory('INCOME')).toBe(true);
    });

    test('should return true for category containing "income"', () => {
      expect(isIncomeCategory('my_income_source')).toBe(true);
    });

    test('should return true for category containing "payroll"', () => {
      expect(isIncomeCategory('company_payroll')).toBe(true);
    });

    test('should return true for category containing "salary"', () => {
      expect(isIncomeCategory('monthly_salary')).toBe(true);
    });

    test('should return true for category containing "wage"', () => {
      expect(isIncomeCategory('hourly_wage')).toBe(true);
    });

    test('should return false for non-income category', () => {
      expect(isIncomeCategory('groceries')).toBe(false);
    });
  });
});
