/**
 * GraphQL query wrapper for Categories.
 *
 * Always queries with {spend: false, budget: true}; the caller passes
 * `rollovers` explicitly so the value mirrors the user's actual
 * `budgetingConfig.rolloversConfig.isEnabled` setting (see audit C6).
 * The cached payload carries category.budget.current and
 * category.budget.histories — PR #3 (Budgets) projects budgets from the
 * same cache, so querying without `budget: true` would warm the cache
 * with the wrong shape.
 *
 * Returns a flat list — childCategories are flattened one level deep (the
 * GraphQL query does not request grandchildren) so the SnapshotCache can
 * key on `id` without duplicating rows. Each parent loses its
 * childCategories field after flattening.
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
  /**
   * The id of this category's parent, or `null` if this is a top-level
   * category (parent OR standalone).
   *
   * Note: `parentId === null` does NOT distinguish parents-with-children
   * from standalone categories. To detect parents specifically, build a
   * Set of parent ids:
   * `new Set(categories.filter((c): c is CategoryNode & { parentId: string } => c.parentId !== null).map(c => c.parentId))`.
   * The type predicate narrows the result to `Set<string>` (without it
   * TypeScript infers `Set<string | null>`).
   *
   * Populated by `fetchCategories` during flatten — Copilot's GraphQL
   * `Categories` query returns a tree (`categories[].childCategories[]`)
   * which we collapse to a single keyed list, recording the relationship
   * here so consumers can rebuild the hierarchy.
   */
  parentId: string | null;
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

// Raw GraphQL response shape — does NOT include parentId. The flatten step
// synthesizes parentId for both parent rows (null) and child rows (parent.id).
type CategoryRawFields = Omit<CategoryNode, 'parentId'>;

interface CategoryResponseNode extends CategoryRawFields {
  childCategories?: CategoryRawFields[];
}

interface CategoriesResponse {
  categories: CategoryResponseNode[];
}

export interface FetchCategoriesOpts {
  /** Whether to include rollover effects in the budget computation. */
  rollovers: boolean;
}

interface CategoriesVariables {
  spend: false;
  budget: true;
  rollovers: boolean;
}

export async function fetchCategories(
  client: GraphQLClient,
  opts: FetchCategoriesOpts
): Promise<CategoryNode[]> {
  const variables: CategoriesVariables = {
    spend: false,
    budget: true,
    rollovers: opts.rollovers,
  };
  const data = await client.query<CategoriesVariables, CategoriesResponse>(
    'Categories',
    CATEGORIES,
    variables
  );
  const flat: CategoryNode[] = [];
  for (const cat of data.categories) {
    const { childCategories, ...rawParent } = cat;
    flat.push({ ...rawParent, parentId: null });
    if (childCategories) {
      for (const child of childCategories) {
        flat.push({ ...child, parentId: rawParent.id });
      }
    }
  }
  return flat;
}
