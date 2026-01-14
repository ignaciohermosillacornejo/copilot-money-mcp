/**
 * Category model for Copilot Money data.
 *
 * Represents user-defined categories stored in Copilot's
 * /users/{user_id}/categories/ Firestore collection.
 *
 * These are custom categories created by users in the Copilot Money app,
 * distinct from the standard Plaid category taxonomy.
 */

import { z } from 'zod';

/**
 * Category schema with validation.
 *
 * Categories have a hierarchical structure with parent_category_id
 * for nested organization.
 */
export const CategorySchema = z
  .object({
    // Required fields
    category_id: z.string(),

    // Display information
    name: z.string().optional(),
    emoji: z.string().optional(),
    color: z.string().optional(),
    bg_color: z.string().optional(),

    // Hierarchy
    parent_category_id: z.string().optional(),
    children_category_ids: z.array(z.string()).optional(),
    order: z.number().optional(),

    // Behavior flags
    excluded: z.boolean().optional(),
    is_other: z.boolean().optional(),
    auto_budget_lock: z.boolean().optional(),
    auto_delete_lock: z.boolean().optional(),

    // Plaid mapping - links custom categories to standard Plaid categories
    plaid_category_ids: z.array(z.string()).optional(),

    // Rules for auto-categorization
    partial_name_rules: z.array(z.string()).optional(),

    // Metadata
    user_id: z.string().optional(),
  })
  .strict();

export type Category = z.infer<typeof CategorySchema>;

/**
 * Get the best display name for a category.
 */
export function getCategoryDisplayName(category: Category): string {
  return category.name ?? category.category_id;
}
