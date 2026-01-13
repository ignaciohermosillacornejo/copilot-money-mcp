/**
 * Investment Split model for Copilot Money data.
 *
 * Represents stock split information stored in Copilot's /investment_splits/{split_id}
 * Firestore collection. Stock splits affect share counts and price history calculations.
 *
 * Example splits:
 * - Apple 4:1 split (2020): 1 share became 4 shares
 * - Tesla 3:1 split (2022): 1 share became 3 shares
 * - Google 20:1 split (2022): 1 share became 20 shares
 */

import { z } from 'zod';

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Split ratio format regex (e.g., "2:1", "4:1", "3:2").
 */
const SPLIT_RATIO_REGEX = /^(\d+):(\d+)$/;

/**
 * Parsed split ratio with calculated multiplier.
 */
export interface ParsedSplitRatio {
  /** Post-split shares (numerator) - e.g., 4 in a 4:1 split */
  to: number;
  /** Pre-split shares (denominator) - e.g., 1 in a 4:1 split */
  from: number;
  /** Split multiplier (to/from) - e.g., 4.0 for a 4:1 split */
  multiplier: number;
}

/**
 * Investment Split schema with validation.
 *
 * Represents a stock split event that affects share counts and historical prices.
 */
export const InvestmentSplitSchema = z
  .object({
    // Identification
    split_id: z.string(), // Document ID in Firestore
    ticker_symbol: z.string().optional(), // Stock ticker (e.g., "AAPL", "TSLA")
    investment_id: z.string().optional(), // Reference to investment_prices collection

    // Split details
    split_date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(),
    split_ratio: z.string().optional(), // Format: "to:from" (e.g., "4:1", "2:1")

    // Parsed factors (may be pre-calculated in Firestore)
    from_factor: z.number().optional(), // Pre-split shares (denominator)
    to_factor: z.number().optional(), // Post-split shares (numerator)
    multiplier: z.number().optional(), // Calculated: to_factor / from_factor

    // Additional metadata
    announcement_date: z.string().optional(), // When split was announced
    record_date: z.string().optional(), // Record date for split
    ex_date: z.string().optional(), // Ex-dividend/split date
    description: z.string().optional(), // Human-readable description
    source: z.string().optional(), // Data source identifier
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type InvestmentSplit = z.infer<typeof InvestmentSplitSchema>;

/**
 * Parse a split ratio string into its components.
 *
 * @param ratio - Split ratio string (e.g., "4:1", "2:1", "3:2")
 * @returns Parsed ratio with to, from, and multiplier, or null if invalid
 *
 * @example
 * parseSplitRatio("4:1") // => { to: 4, from: 1, multiplier: 4.0 }
 * parseSplitRatio("3:2") // => { to: 3, from: 2, multiplier: 1.5 }
 */
export function parseSplitRatio(ratio: string): ParsedSplitRatio | null {
  const match = ratio.match(SPLIT_RATIO_REGEX);
  if (!match || !match[1] || !match[2]) {
    return null;
  }

  const to = parseInt(match[1], 10);
  const from = parseInt(match[2], 10);

  if (from === 0) {
    return null; // Avoid division by zero
  }

  return {
    to,
    from,
    multiplier: to / from,
  };
}

/**
 * Get the split multiplier from an investment split record.
 * Uses pre-calculated multiplier if available, otherwise calculates from ratio or factors.
 *
 * @param split - Investment split record
 * @returns Split multiplier (e.g., 4.0 for a 4:1 split), or undefined if unavailable
 */
export function getSplitMultiplier(split: InvestmentSplit): number | undefined {
  // Use pre-calculated multiplier if available
  if (split.multiplier !== undefined) {
    return split.multiplier;
  }

  // Calculate from factors if available
  if (split.to_factor !== undefined && split.from_factor !== undefined && split.from_factor !== 0) {
    return split.to_factor / split.from_factor;
  }

  // Parse from ratio string if available
  if (split.split_ratio) {
    const parsed = parseSplitRatio(split.split_ratio);
    if (parsed) {
      return parsed.multiplier;
    }
  }

  return undefined;
}

/**
 * Get a human-readable display string for a split.
 *
 * @param split - Investment split record
 * @returns Display string like "4-for-1 split" or "2-for-1 reverse split"
 *
 * @example
 * getSplitDisplayString({ split_ratio: "4:1" }) // => "4-for-1 split"
 * getSplitDisplayString({ to_factor: 1, from_factor: 2 }) // => "1-for-2 reverse split"
 */
export function getSplitDisplayString(split: InvestmentSplit): string {
  let to: number | undefined;
  let from: number | undefined;

  // Try to get factors from various sources
  if (split.to_factor !== undefined && split.from_factor !== undefined) {
    to = split.to_factor;
    from = split.from_factor;
  } else if (split.split_ratio) {
    const parsed = parseSplitRatio(split.split_ratio);
    if (parsed) {
      to = parsed.to;
      from = parsed.from;
    }
  }

  if (to === undefined || from === undefined) {
    return 'Stock split';
  }

  // Determine if it's a regular split or reverse split
  const isReverse = to < from;
  const suffix = isReverse ? ' reverse split' : ' split';

  return `${to}-for-${from}${suffix}`;
}

/**
 * Get a display name for the investment in a split.
 *
 * @param split - Investment split record
 * @returns Ticker symbol if available, otherwise split_id
 */
export function getSplitDisplayName(split: InvestmentSplit): string {
  return split.ticker_symbol ?? split.investment_id ?? split.split_id;
}

/**
 * Check if a split is a reverse split (consolidation).
 * Reverse splits reduce share count (e.g., 1:2 means 2 shares become 1).
 *
 * @param split - Investment split record
 * @returns true if reverse split, false if regular split, undefined if unknown
 */
export function isReverseSplit(split: InvestmentSplit): boolean | undefined {
  const multiplier = getSplitMultiplier(split);
  if (multiplier === undefined) {
    return undefined;
  }
  return multiplier < 1;
}

/**
 * Adjust a historical price for a split.
 * For forward splits, divide the price by the multiplier.
 * For reverse splits, multiply the price by the inverse.
 *
 * @param price - Historical price before split adjustment
 * @param split - Investment split record
 * @returns Adjusted price, or original price if adjustment not possible
 *
 * @example
 * // Apple 4:1 split: $400 pre-split = $100 post-split
 * adjustPriceForSplit(400, { split_ratio: "4:1" }) // => 100
 */
export function adjustPriceForSplit(price: number, split: InvestmentSplit): number {
  const multiplier = getSplitMultiplier(split);
  if (multiplier === undefined || multiplier === 0) {
    return price;
  }
  return Math.round((price / multiplier) * 100) / 100;
}

/**
 * Adjust share quantity for a split.
 * For forward splits, multiply shares by the multiplier.
 *
 * @param shares - Number of shares before split
 * @param split - Investment split record
 * @returns Adjusted share count, or original if adjustment not possible
 *
 * @example
 * // Apple 4:1 split: 100 shares pre-split = 400 shares post-split
 * adjustSharesForSplit(100, { split_ratio: "4:1" }) // => 400
 */
export function adjustSharesForSplit(shares: number, split: InvestmentSplit): number {
  const multiplier = getSplitMultiplier(split);
  if (multiplier === undefined) {
    return shares;
  }
  return Math.round(shares * multiplier * 100) / 100;
}

/**
 * Format split date in a readable way.
 *
 * @param split - Investment split record
 * @returns Formatted date string or undefined
 */
export function formatSplitDate(split: InvestmentSplit): string | undefined {
  if (!split.split_date) {
    return undefined;
  }

  try {
    const date = new Date(split.split_date);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return split.split_date;
  }
}
