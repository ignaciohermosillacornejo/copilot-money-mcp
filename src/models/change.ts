/**
 * Schemas for Firestore sync tracking documents (changes collections).
 *
 * These are sparse/minimal documents used by Copilot Money to track sync state.
 * Three collection patterns:
 *   - changes/{id}           — top-level change markers
 *   - changes/{id}/t/{id}    — transaction change sub-documents
 *   - changes/{id}/a/{id}    — account change sub-documents
 */

import { z } from 'zod';

export const ChangeSchema = z
  .object({
    change_id: z.string(),
  })
  .passthrough();
export type Change = z.infer<typeof ChangeSchema>;

export const TransactionChangeSchema = z
  .object({
    change_id: z.string(),
    parent_change_id: z.string().optional(),
  })
  .passthrough();
export type TransactionChange = z.infer<typeof TransactionChangeSchema>;

export const AccountChangeSchema = z
  .object({
    change_id: z.string(),
    parent_change_id: z.string().optional(),
  })
  .passthrough();
export type AccountChange = z.infer<typeof AccountChangeSchema>;
