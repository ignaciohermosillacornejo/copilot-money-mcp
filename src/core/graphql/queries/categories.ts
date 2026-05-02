/**
 * GraphQL query wrapper for Categories.
 *
 * Always queries with {spend: false, budget: true, rollovers: false} so the
 * cached payload carries category.budget.current and category.budget.histories.
 * PR #3 (Budgets) projects budgets from the same cache — querying without
 * `budget: true` would warm the cache with the wrong shape.
 *
 * Returns a flat list — childCategories are recursively flattened so the
 * SnapshotCache can key on `id` without duplicating rows. Each child loses
 * its own (empty) childCategories field after flattening.
 */

import type { GraphQLClient } from '../client.js';
import { CATEGORIES } from '../operations.generated.js';

export interface CategoryIcon {
  __typename: 'EmojiUnicode' | 'Genmoji';
  unicode?: string;
  id?: string;
  src?: string;
}

export interface CategoryBudgetMonthly {
  unassignedRolloverAmount: string | null;
  childRolloverAmount: string | null;
  unassignedAmount: string | null;
  resolvedAmount: string | null;
  rolloverAmount: string | null;
  childAmount: string | null;
  goalAmount: string | null;
  amount: string | null;
  month: string;
  id: string;
}

export interface CategoryBudget {
  current: CategoryBudgetMonthly | null;
  histories: CategoryBudgetMonthly[];
}

export interface CategoryNode {
  id: string;
  name: string;
  templateId: string | null;
  colorName: string | null;
  icon: CategoryIcon | null;
  isExcluded: boolean;
  isRolloverDisabled: boolean;
  canBeDeleted: boolean;
  /** Present when the request set budget:true. */
  budget?: CategoryBudget | null;
}

interface CategoryResponseNode extends CategoryNode {
  childCategories?: CategoryNode[];
}

interface CategoriesResponse {
  categories: CategoryResponseNode[];
}

const VARS = { spend: false, budget: true, rollovers: false } as const;

export async function fetchCategories(client: GraphQLClient): Promise<CategoryNode[]> {
  const data = await client.query<typeof VARS, CategoriesResponse>('Categories', CATEGORIES, VARS);
  const flat: CategoryNode[] = [];
  for (const cat of data.categories) {
    const { childCategories, ...parent } = cat;
    flat.push(parent);
    if (childCategories) {
      for (const child of childCategories) {
        flat.push(child);
      }
    }
  }
  return flat;
}
