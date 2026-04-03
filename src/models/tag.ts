/**
 * Tag model for Copilot Money data.
 *
 * Represents user-defined tags for categorizing transactions,
 * stored in /users/{user_id}/tags/{tag_id} Firestore collection.
 */

import { z } from 'zod';

/**
 * Tag schema with validation.
 *
 * Represents a user-created tag that can be applied to transactions
 * for custom categorization beyond the standard Plaid taxonomy.
 */
export const TagSchema = z
  .object({
    tag_id: z.string(),
    name: z.string().optional(),
    color_name: z.string().optional(),
    hex_color: z.string().optional(),
  })
  .passthrough();

export type Tag = z.infer<typeof TagSchema>;

export function getTagDisplayName(tag: Tag): string {
  return tag.name || tag.tag_id;
}
