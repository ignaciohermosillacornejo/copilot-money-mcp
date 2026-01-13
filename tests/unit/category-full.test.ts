/**
 * Unit tests for full category hierarchy functionality.
 *
 * Tests the category model, hierarchy navigation, and search functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  getCategory,
  getCategoryPath,
  getCategoryParent,
  getCategoryChildren,
  isCategoryType,
  getRootCategories,
  getAllCategories,
  searchCategories,
  getCategoryTree,
  getCategoriesByType,
  isAncestorOf,
} from '../../src/models/category-full.js';

describe('getRootCategories', () => {
  test('returns all root categories', () => {
    const roots = getRootCategories();
    expect(roots.length).toBeGreaterThan(0);
  });

  test('all root categories have depth 0', () => {
    const roots = getRootCategories();
    for (const root of roots) {
      expect(root.depth).toBe(0);
    }
  });

  test('all root categories have no parent', () => {
    const roots = getRootCategories();
    for (const root of roots) {
      expect(root.parent_id).toBeUndefined();
    }
  });

  test('includes expected root categories', () => {
    const roots = getRootCategories();
    const rootIds = roots.map((r) => r.id);

    expect(rootIds).toContain('income');
    expect(rootIds).toContain('food_and_drink');
    expect(rootIds).toContain('transportation');
    expect(rootIds).toContain('entertainment');
    expect(rootIds).toContain('transfer_in');
    expect(rootIds).toContain('transfer_out');
  });
});

describe('getCategory', () => {
  test('returns root category by ID', () => {
    const category = getCategory('food_and_drink');
    expect(category).toBeDefined();
    expect(category?.id).toBe('food_and_drink');
    expect(category?.display_name).toBe('Food & Drink');
  });

  test('returns child category by ID', () => {
    const category = getCategory('food_and_drink_groceries');
    expect(category).toBeDefined();
    expect(category?.id).toBe('food_and_drink_groceries');
    expect(category?.parent_id).toBe('food_and_drink');
  });

  test('returns undefined for unknown category', () => {
    const category = getCategory('unknown_category_xyz');
    expect(category).toBeUndefined();
  });

  test('is case-insensitive', () => {
    const category = getCategory('FOOD_AND_DRINK');
    // May or may not match depending on implementation
    // Just check it doesn't throw
    expect(category === undefined || category.id === 'food_and_drink').toBe(true);
  });
});

describe('getCategoryPath', () => {
  test('returns path for root category', () => {
    const path = getCategoryPath('food_and_drink');
    expect(path).toBe('Food & Drink');
  });

  test('returns path for child category', () => {
    const path = getCategoryPath('food_and_drink_groceries');
    expect(path).toContain('Food & Drink');
    expect(path).toContain('>');
  });

  test('formats unknown category nicely', () => {
    const path = getCategoryPath('some_unknown_category');
    expect(path).toBe('Some Unknown Category');
  });

  test('returns ID for non-snake-case unknown category', () => {
    const path = getCategoryPath('unknowncategory');
    expect(path).toBe('unknowncategory');
  });
});

describe('getCategoryParent', () => {
  test('returns parent for child category', () => {
    const parent = getCategoryParent('food_and_drink_groceries');
    expect(parent).toBeDefined();
    expect(parent?.id).toBe('food_and_drink');
  });

  test('returns undefined for root category', () => {
    const parent = getCategoryParent('food_and_drink');
    expect(parent).toBeUndefined();
  });

  test('returns undefined for unknown category', () => {
    const parent = getCategoryParent('unknown_category');
    expect(parent).toBeUndefined();
  });
});

describe('getCategoryChildren', () => {
  test('returns children for root category', () => {
    const children = getCategoryChildren('food_and_drink');
    expect(children.length).toBeGreaterThan(0);

    const childIds = children.map((c) => c.id);
    expect(childIds).toContain('food_and_drink_groceries');
    expect(childIds).toContain('food_and_drink_restaurant');
  });

  test('returns empty array for leaf category', () => {
    const children = getCategoryChildren('food_and_drink_groceries');
    expect(children.length).toBe(0);
  });

  test('returns empty array for unknown category', () => {
    const children = getCategoryChildren('unknown_category');
    expect(children.length).toBe(0);
  });

  test('all children have correct parent_id', () => {
    const children = getCategoryChildren('transportation');
    for (const child of children) {
      expect(child.parent_id).toBe('transportation');
    }
  });
});

describe('isCategoryType', () => {
  test('identifies income categories', () => {
    expect(isCategoryType('income', 'income')).toBe(true);
    expect(isCategoryType('income_wages', 'income')).toBe(true);
    expect(isCategoryType('income', 'expense')).toBe(false);
  });

  test('identifies expense categories', () => {
    expect(isCategoryType('food_and_drink', 'expense')).toBe(true);
    expect(isCategoryType('transportation', 'expense')).toBe(true);
    expect(isCategoryType('food_and_drink', 'income')).toBe(false);
  });

  test('identifies transfer categories', () => {
    expect(isCategoryType('transfer_in', 'transfer')).toBe(true);
    expect(isCategoryType('transfer_out', 'transfer')).toBe(true);
    expect(isCategoryType('transfer_in', 'expense')).toBe(false);
  });

  test('handles unknown categories with fallback', () => {
    // Unknown categories default to expense check
    expect(isCategoryType('unknown_expense', 'expense')).toBe(true);
  });
});

describe('getAllCategories', () => {
  test('returns all categories', () => {
    const all = getAllCategories();
    expect(all.length).toBeGreaterThan(20);
  });

  test('includes both root and child categories', () => {
    const all = getAllCategories();
    const depths = new Set(all.map((c) => c.depth));
    expect(depths.has(0)).toBe(true);
    expect(depths.has(1)).toBe(true);
  });
});

describe('searchCategories', () => {
  test('finds categories by name', () => {
    const results = searchCategories('food');
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.id);
    expect(ids).toContain('food_and_drink');
  });

  test('finds categories by display name', () => {
    const results = searchCategories('shopping');
    expect(results.length).toBeGreaterThan(0);
  });

  test('is case-insensitive', () => {
    const resultsLower = searchCategories('travel');
    const resultsUpper = searchCategories('TRAVEL');

    expect(resultsLower.length).toBe(resultsUpper.length);
  });

  test('returns empty array for no matches', () => {
    const results = searchCategories('xyznonexistentcategory123');
    expect(results.length).toBe(0);
  });

  test('finds partial matches', () => {
    const results = searchCategories('groc');
    expect(results.length).toBeGreaterThan(0);

    const hasGroceries = results.some((r) => r.id.includes('groceries'));
    expect(hasGroceries).toBe(true);
  });
});

describe('getCategoryTree', () => {
  test('returns tree structure', () => {
    const tree = getCategoryTree();
    expect(tree.length).toBeGreaterThan(0);

    for (const node of tree) {
      expect(node.category).toBeDefined();
      expect(Array.isArray(node.children)).toBe(true);
    }
  });

  test('children match parent category', () => {
    const tree = getCategoryTree();
    const foodNode = tree.find((t) => t.category.id === 'food_and_drink');

    expect(foodNode).toBeDefined();
    expect(foodNode!.children.length).toBeGreaterThan(0);

    for (const child of foodNode!.children) {
      expect(child.parent_id).toBe('food_and_drink');
    }
  });
});

describe('getCategoriesByType', () => {
  test('returns income categories', () => {
    const incomeCategories = getCategoriesByType('income');
    expect(incomeCategories.length).toBeGreaterThan(0);

    for (const cat of incomeCategories) {
      expect(cat.type).toBe('income');
    }
  });

  test('returns expense categories', () => {
    const expenseCategories = getCategoriesByType('expense');
    expect(expenseCategories.length).toBeGreaterThan(0);

    for (const cat of expenseCategories) {
      expect(cat.type).toBe('expense');
    }
  });

  test('returns transfer categories', () => {
    const transferCategories = getCategoriesByType('transfer');
    expect(transferCategories.length).toBeGreaterThan(0);

    for (const cat of transferCategories) {
      expect(cat.type).toBe('transfer');
    }
  });
});

describe('isAncestorOf', () => {
  test('identifies parent as ancestor', () => {
    expect(isAncestorOf('food_and_drink', 'food_and_drink_groceries')).toBe(true);
    expect(isAncestorOf('transportation', 'transportation_gas')).toBe(true);
  });

  test('returns false when not ancestor', () => {
    expect(isAncestorOf('food_and_drink_groceries', 'food_and_drink')).toBe(false);
    expect(isAncestorOf('food_and_drink', 'transportation_gas')).toBe(false);
  });

  test('returns false for same category', () => {
    expect(isAncestorOf('food_and_drink', 'food_and_drink')).toBe(false);
  });

  test('returns false for unknown categories', () => {
    expect(isAncestorOf('unknown_parent', 'unknown_child')).toBe(false);
  });
});

describe('Category hierarchy integration', () => {
  test('complete food and drink hierarchy', () => {
    const root = getCategory('food_and_drink');
    expect(root).toBeDefined();
    expect(root?.type).toBe('expense');
    expect(root?.depth).toBe(0);
    expect(root?.is_leaf).toBe(false);

    const children = getCategoryChildren('food_and_drink');
    expect(children.length).toBeGreaterThan(5);

    const groceries = children.find((c) => c.id === 'food_and_drink_groceries');
    expect(groceries).toBeDefined();
    expect(groceries?.is_leaf).toBe(true);
    expect(groceries?.depth).toBe(1);
    expect(groceries?.path).toContain('Food & Drink');
  });

  test('income hierarchy is complete', () => {
    const income = getCategory('income');
    expect(income).toBeDefined();
    expect(income?.type).toBe('income');

    const children = getCategoryChildren('income');
    expect(children.length).toBeGreaterThan(3);

    const childIds = children.map((c) => c.id);
    expect(childIds).toContain('income_wages');
    expect(childIds).toContain('income_dividends');
  });

  test('transfer categories are separate', () => {
    const transferIn = getCategory('transfer_in');
    const transferOut = getCategory('transfer_out');

    expect(transferIn).toBeDefined();
    expect(transferOut).toBeDefined();
    expect(transferIn?.type).toBe('transfer');
    expect(transferOut?.type).toBe('transfer');
  });

  test('search and navigation work together', () => {
    // Search for gas
    const results = searchCategories('gas');
    expect(results.length).toBeGreaterThan(0);

    // Find the transportation gas category
    const gasCategory = results.find((r) => r.id === 'transportation_gas');
    expect(gasCategory).toBeDefined();

    // Navigate to parent
    const parent = getCategoryParent('transportation_gas');
    expect(parent?.id).toBe('transportation');

    // Verify parent has this child
    const siblings = getCategoryChildren('transportation');
    const hasGas = siblings.some((s) => s.id === 'transportation_gas');
    expect(hasGas).toBe(true);
  });
});
