/**
 * Tests for budget.ts to improve coverage.
 * Specifically tests the getBudgetDisplayName helper function.
 */

import { describe, expect, it } from 'bun:test';
import { getBudgetDisplayName, type Budget } from '../../src/models/budget';

describe('getBudgetDisplayName', () => {
  it('returns name when name is defined', () => {
    const budget: Budget = {
      budget_id: 'budget-1',
      name: 'Groceries Budget',
      category_id: 'cat-groceries',
    };

    expect(getBudgetDisplayName(budget)).toBe('Groceries Budget');
  });

  it('returns category_id when name is undefined', () => {
    const budget: Budget = {
      budget_id: 'budget-2',
      category_id: 'cat-entertainment',
    };

    expect(getBudgetDisplayName(budget)).toBe('cat-entertainment');
  });

  it('returns "Unknown Budget" when both name and category_id are undefined', () => {
    const budget: Budget = {
      budget_id: 'budget-3',
    };

    expect(getBudgetDisplayName(budget)).toBe('Unknown Budget');
  });

  it('returns name even when name is empty string', () => {
    // Empty string is falsy but defined, so ?? won't fall through
    const budget: Budget = {
      budget_id: 'budget-4',
      name: '',
      category_id: 'fallback-category',
    };

    // Note: nullish coalescing (??) only checks for null/undefined, not empty string
    expect(getBudgetDisplayName(budget)).toBe('');
  });
});
