/**
 * Full Plaid category taxonomy with hierarchical structure.
 *
 * Provides a complete hierarchical representation of Plaid categories,
 * including parent-child relationships, category search, and navigation.
 */

/**
 * Category node in the hierarchy.
 */
export interface CategoryNode {
  /** Category ID (snake_case or numeric) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Display name (shorter, for UI) */
  display_name: string;
  /** Parent category ID (undefined for root categories) */
  parent_id?: string;
  /** Full path from root (e.g., "Food & Drink > Restaurants > Pizza") */
  path: string;
  /** Depth in hierarchy (0 = root) */
  depth: number;
  /** Whether this is a leaf node (no children) */
  is_leaf: boolean;
  /** Category type (income, expense, transfer) */
  type: 'income' | 'expense' | 'transfer';
  /** Child category IDs */
  children: string[];
}

/**
 * Root category definitions.
 */
const ROOT_CATEGORIES: CategoryNode[] = [
  // Income
  {
    id: 'income',
    name: 'Income',
    display_name: 'Income',
    path: 'Income',
    depth: 0,
    is_leaf: false,
    type: 'income',
    children: [
      'income_dividends',
      'income_interest_earned',
      'income_retirement_pension',
      'income_tax_refund',
      'income_unemployment',
      'income_wages',
      'income_other_income',
    ],
  },
  // Transfer In
  {
    id: 'transfer_in',
    name: 'Transfer In',
    display_name: 'Transfer In',
    path: 'Transfer In',
    depth: 0,
    is_leaf: false,
    type: 'transfer',
    children: [
      'transfer_in_account_transfer',
      'transfer_in_cash_advances_and_loans',
      'transfer_in_deposit',
      'transfer_in_investment_and_retirement_funds',
      'transfer_in_savings',
      'transfer_in_other_transfer_in',
    ],
  },
  // Transfer Out
  {
    id: 'transfer_out',
    name: 'Transfer Out',
    display_name: 'Transfer Out',
    path: 'Transfer Out',
    depth: 0,
    is_leaf: false,
    type: 'transfer',
    children: [
      'transfer_out_account_transfer',
      'transfer_out_investment_and_retirement_funds',
      'transfer_out_savings',
      'transfer_out_withdrawal',
      'transfer_out_other_transfer_out',
    ],
  },
  // Loan Payments
  {
    id: 'loan_payments',
    name: 'Loan Payments',
    display_name: 'Loan Payments',
    path: 'Loan Payments',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'loan_payments_car_payment',
      'loan_payments_credit_card_payment',
      'loan_payments_personal_loan_payment',
      'loan_payments_mortgage_payment',
      'loan_payments_student_loan_payment',
      'loan_payments_other_payment',
    ],
  },
  // Bank Fees
  {
    id: 'bank_fees',
    name: 'Bank Fees',
    display_name: 'Bank Fees',
    path: 'Bank Fees',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'bank_fees_atm_fees',
      'bank_fees_foreign_transaction_fees',
      'bank_fees_insufficient_funds',
      'bank_fees_interest_charge',
      'bank_fees_overdraft_fees',
      'bank_fees_other_bank_fees',
    ],
  },
  // Entertainment
  {
    id: 'entertainment',
    name: 'Entertainment',
    display_name: 'Entertainment',
    path: 'Entertainment',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'entertainment_casinos_and_gambling',
      'entertainment_music_and_audio',
      'entertainment_sporting_events_amusement_parks_and_museums',
      'entertainment_tv_and_movies',
      'entertainment_video_games',
      'entertainment_other_entertainment',
    ],
  },
  // Food and Drink
  {
    id: 'food_and_drink',
    name: 'Food and Drink',
    display_name: 'Food & Drink',
    path: 'Food & Drink',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'food_and_drink_beer_wine_and_liquor',
      'food_and_drink_coffee',
      'food_and_drink_fast_food',
      'food_and_drink_groceries',
      'food_and_drink_restaurant',
      'food_and_drink_vending_machines',
      'food_and_drink_other_food_and_drink',
    ],
  },
  // General Merchandise (Shopping)
  {
    id: 'general_merchandise',
    name: 'General Merchandise',
    display_name: 'Shopping',
    path: 'Shopping',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'general_merchandise_bookstores_and_newsstands',
      'general_merchandise_clothing_and_accessories',
      'general_merchandise_convenience_stores',
      'general_merchandise_department_stores',
      'general_merchandise_discount_stores',
      'general_merchandise_electronics',
      'general_merchandise_gifts_and_novelties',
      'general_merchandise_office_supplies',
      'general_merchandise_online_marketplaces',
      'general_merchandise_pet_supplies',
      'general_merchandise_sporting_goods',
      'general_merchandise_superstores',
      'general_merchandise_tobacco_and_vape',
      'general_merchandise_other_general_merchandise',
    ],
  },
  // Home Improvement
  {
    id: 'home_improvement',
    name: 'Home Improvement',
    display_name: 'Home',
    path: 'Home Improvement',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'home_improvement_furniture',
      'home_improvement_hardware',
      'home_improvement_repair_and_maintenance',
      'home_improvement_security',
      'home_improvement_other_home_improvement',
    ],
  },
  // Medical
  {
    id: 'medical',
    name: 'Medical',
    display_name: 'Medical',
    path: 'Medical',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'medical_dental_care',
      'medical_eye_care',
      'medical_nursing_care',
      'medical_pharmacies_and_supplements',
      'medical_primary_care',
      'medical_veterinary_services',
      'medical_other_medical',
    ],
  },
  // Personal Care
  {
    id: 'personal_care',
    name: 'Personal Care',
    display_name: 'Personal Care',
    path: 'Personal Care',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'personal_care_gyms_and_fitness_centers',
      'personal_care_hair_and_beauty',
      'personal_care_laundry_and_dry_cleaning',
      'personal_care_other_personal_care',
    ],
  },
  // General Services
  {
    id: 'general_services',
    name: 'General Services',
    display_name: 'Services',
    path: 'Services',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'general_services_accounting_and_financial_planning',
      'general_services_automotive',
      'general_services_childcare',
      'general_services_consulting_and_legal',
      'general_services_education',
      'general_services_insurance',
      'general_services_postage_and_shipping',
      'general_services_storage',
      'general_services_other_general_services',
    ],
  },
  // Government and Non-Profit
  {
    id: 'government_and_non_profit',
    name: 'Government and Non-Profit',
    display_name: 'Government',
    path: 'Government & Non-Profit',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'government_and_non_profit_donations',
      'government_and_non_profit_government_departments_and_agencies',
      'government_and_non_profit_tax_payment',
      'government_and_non_profit_other_government_and_non_profit',
    ],
  },
  // Transportation
  {
    id: 'transportation',
    name: 'Transportation',
    display_name: 'Transportation',
    path: 'Transportation',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'transportation_bikes_and_scooters',
      'transportation_gas',
      'transportation_parking',
      'transportation_public_transit',
      'transportation_taxis_and_ride_shares',
      'transportation_tolls',
      'transportation_other_transportation',
    ],
  },
  // Travel
  {
    id: 'travel',
    name: 'Travel',
    display_name: 'Travel',
    path: 'Travel',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: ['travel_flights', 'travel_lodging', 'travel_rental_cars', 'travel_other_travel'],
  },
  // Rent and Utilities
  {
    id: 'rent_and_utilities',
    name: 'Rent and Utilities',
    display_name: 'Rent & Utilities',
    path: 'Rent & Utilities',
    depth: 0,
    is_leaf: false,
    type: 'expense',
    children: [
      'rent_and_utilities_gas_and_electricity',
      'rent_and_utilities_internet_and_cable',
      'rent_and_utilities_rent',
      'rent_and_utilities_sewage_and_waste_management',
      'rent_and_utilities_telephone',
      'rent_and_utilities_water',
      'rent_and_utilities_other_utilities',
    ],
  },
];

/**
 * Map of category ID to CategoryNode for quick lookup.
 */
const categoryMap = new Map<string, CategoryNode>();

/**
 * Build the category hierarchy from root categories.
 */
function buildCategoryHierarchy(): void {
  // Add root categories
  for (const root of ROOT_CATEGORIES) {
    categoryMap.set(root.id, root);

    // Add children
    for (const childId of root.children) {
      const childName = formatCategoryId(childId);
      const childDisplayName = getChildDisplayName(childId);

      const child: CategoryNode = {
        id: childId,
        name: childName,
        display_name: childDisplayName,
        parent_id: root.id,
        path: `${root.path} > ${childDisplayName}`,
        depth: 1,
        is_leaf: true,
        type: root.type,
        children: [],
      };

      categoryMap.set(childId, child);
    }
  }
}

/**
 * Format a category ID to a readable name.
 */
function formatCategoryId(id: string): string {
  // Remove prefix and convert to Title Case
  const parts = id.split('_');
  return parts.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

/**
 * Get a short display name for a child category.
 */
function getChildDisplayName(childId: string): string {
  const parts = childId.split('_');
  // Skip the parent prefix (e.g., "food_and_drink_" from "food_and_drink_groceries")
  // Find where the child-specific part starts by looking for common patterns
  let startIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const partsSoFar = parts.slice(0, i + 1).join('_');
    if (ROOT_CATEGORIES.some((r) => r.id === partsSoFar)) {
      startIdx = i + 1;
    }
  }

  const childParts = parts.slice(startIdx);
  if (childParts.length === 0) {
    return formatCategoryId(childId);
  }

  return childParts
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// Initialize hierarchy
buildCategoryHierarchy();

/**
 * Get a category by ID.
 *
 * @param categoryId - Category ID to look up
 * @returns CategoryNode or undefined if not found
 */
export function getCategory(categoryId: string): CategoryNode | undefined {
  return categoryMap.get(categoryId) ?? categoryMap.get(categoryId.toLowerCase());
}

/**
 * Get the full path for a category.
 *
 * @param categoryId - Category ID
 * @returns Full path string (e.g., "Food & Drink > Restaurants")
 */
export function getCategoryPath(categoryId: string): string {
  const category = getCategory(categoryId);
  if (category) {
    return category.path;
  }

  // For unknown categories, try to format nicely
  if (categoryId.includes('_')) {
    return formatCategoryId(categoryId);
  }

  return categoryId;
}

/**
 * Get the parent category of a category.
 *
 * @param categoryId - Category ID
 * @returns Parent CategoryNode or undefined if root or not found
 */
export function getCategoryParent(categoryId: string): CategoryNode | undefined {
  const category = getCategory(categoryId);
  if (!category || !category.parent_id) {
    return undefined;
  }
  return getCategory(category.parent_id);
}

/**
 * Get all child categories of a category.
 *
 * @param categoryId - Category ID
 * @returns Array of child CategoryNodes
 */
export function getCategoryChildren(categoryId: string): CategoryNode[] {
  const category = getCategory(categoryId);
  if (!category) {
    return [];
  }

  return category.children
    .map((childId) => getCategory(childId))
    .filter((child): child is CategoryNode => child !== undefined);
}

/**
 * Check if a category is of a specific type.
 *
 * @param categoryId - Category ID
 * @param type - Category type to check
 * @returns true if category matches the type
 */
export function isCategoryType(
  categoryId: string,
  type: 'income' | 'expense' | 'transfer'
): boolean {
  const category = getCategory(categoryId);
  if (category) {
    return category.type === type;
  }

  // Fallback for unknown categories
  const lowerId = categoryId.toLowerCase();
  if (type === 'income') {
    return lowerId.startsWith('income');
  }
  if (type === 'transfer') {
    return lowerId.startsWith('transfer');
  }
  // Default to expense for unknown categories
  return type === 'expense';
}

/**
 * Get all root categories.
 *
 * @returns Array of root CategoryNodes
 */
export function getRootCategories(): CategoryNode[] {
  return [...ROOT_CATEGORIES];
}

/**
 * Get all categories.
 *
 * @returns Array of all CategoryNodes
 */
export function getAllCategories(): CategoryNode[] {
  return Array.from(categoryMap.values());
}

/**
 * Search categories by name or keyword.
 *
 * @param query - Search query (case-insensitive)
 * @returns Array of matching CategoryNodes
 */
export function searchCategories(query: string): CategoryNode[] {
  const lowerQuery = query.toLowerCase();
  const results: CategoryNode[] = [];

  for (const category of categoryMap.values()) {
    if (
      category.name.toLowerCase().includes(lowerQuery) ||
      category.display_name.toLowerCase().includes(lowerQuery) ||
      category.id.toLowerCase().includes(lowerQuery) ||
      category.path.toLowerCase().includes(lowerQuery)
    ) {
      results.push(category);
    }
  }

  // Sort by relevance (exact matches first, then by depth)
  results.sort((a, b) => {
    const aExact =
      a.name.toLowerCase() === lowerQuery || a.display_name.toLowerCase() === lowerQuery;
    const bExact =
      b.name.toLowerCase() === lowerQuery || b.display_name.toLowerCase() === lowerQuery;

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    return a.depth - b.depth;
  });

  return results;
}

/**
 * Get the category hierarchy as a tree structure.
 *
 * @returns Tree structure with root categories and their children
 */
export function getCategoryTree(): Array<{
  category: CategoryNode;
  children: CategoryNode[];
}> {
  return ROOT_CATEGORIES.map((root) => ({
    category: root,
    children: getCategoryChildren(root.id),
  }));
}

/**
 * Get categories by type.
 *
 * @param type - Category type
 * @returns Array of CategoryNodes of the specified type
 */
export function getCategoriesByType(type: 'income' | 'expense' | 'transfer'): CategoryNode[] {
  return Array.from(categoryMap.values()).filter((cat) => cat.type === type);
}

/**
 * Check if one category is an ancestor of another.
 *
 * @param ancestorId - Potential ancestor category ID
 * @param descendantId - Potential descendant category ID
 * @returns true if ancestorId is an ancestor of descendantId
 */
export function isAncestorOf(ancestorId: string, descendantId: string): boolean {
  let current = getCategory(descendantId);

  while (current && current.parent_id) {
    if (current.parent_id === ancestorId) {
      return true;
    }
    current = getCategory(current.parent_id);
  }

  return false;
}
