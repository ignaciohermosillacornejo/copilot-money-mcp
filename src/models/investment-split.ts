/**
 * Investment Split model — restored 2026-05-11 with an accurate schema
 * reflecting what's actually in Copilot's local Firestore cache.
 *
 * The cache stores one document per security under the
 * `investment_splits/{security_id}` collection. Each document contains
 * a sparse set of date-keyed double fields, where the key is the split's
 * effective date (`YYYY-MM-DD`) and the value is the adjustment
 * multiplier — what to multiply pre-split prices/quantities by to get
 * the post-split equivalent.
 *
 * Securities that have never split get an empty-fields placeholder doc.
 *
 * NOTE: do NOT add speculative fields here (split_ratio, from_factor,
 * to_factor, announcement_date, etc.). The v1.5.0 schema had them but the
 * cache never populates them. Empirically verified 2026-05-11.
 */

import { z } from 'zod';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const InvestmentSplitSchema = z
  .object({
    security_id: z.string(),
    // Map of YYYY-MM-DD → adjustment multiplier (e.g. "2024-06-10": 0.1)
    adjustments: z.record(z.string().regex(DATE_KEY), z.number()).default({}),
  })
  .passthrough();

export type InvestmentSplit = z.infer<typeof InvestmentSplitSchema>;

/**
 * Convert an adjustment multiplier to a human-readable ratio string.
 * 0.1 → "10-for-1", 0.25 → "4-for-1", 0.333... → "3-for-1", 2 → "1-for-2 reverse split".
 * Returns "unknown ratio" if the multiplier doesn't reduce to a clean integer ratio.
 */
export function formatRatio(multiplier: number): string {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 'unknown ratio';
  if (multiplier >= 1) {
    // Reverse split: 1/M shares become 1. e.g. multiplier 2 → 1-for-2 reverse.
    const denom = Math.round(multiplier);
    if (Math.abs(multiplier - denom) < 0.01) return `1-for-${denom} reverse split`;
    return 'unknown ratio';
  }
  // Regular forward split: 1 share becomes 1/multiplier shares.
  const numerator = 1 / multiplier;
  const rounded = Math.round(numerator);
  if (Math.abs(numerator - rounded) < 0.01) return `${rounded}-for-1`;
  return 'unknown ratio';
}
