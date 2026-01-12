/**
 * Category model for Copilot Money data.
 *
 * Categories can be hierarchical with parent-child relationships.
 */

import { z } from 'zod';

/**
 * Category schema with validation.
 */
export const CategorySchema = z
  .object({
    // Required fields
    category_id: z.string(),
    name: z.string(),

    // Optional fields
    parent_category_id: z.string().optional(),
    icon: z.string().optional(),
    color: z.string().optional(),
  })
  .strict();

export type Category = z.infer<typeof CategorySchema>;
