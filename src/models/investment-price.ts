/**
 * Investment Price model for Copilot Money data.
 *
 * Represents historical and real-time price data for investments (stocks, crypto, ETFs)
 * stored in Copilot's /investment_prices/{hash} Firestore collection.
 *
 * Two subcollections:
 * - /daily/{month}: Historical monthly price data (YYYY-MM format)
 * - /hf/{date}: High-frequency intraday price data (YYYY-MM-DD format)
 */

import { z } from 'zod';

/**
 * Date format regex for YYYY-MM-DD validation.
 */
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Month format regex for YYYY-MM validation.
 */
const MONTH_REGEX = /^\d{4}-\d{2}$/;

/**
 * Investment Price schema with validation.
 *
 * Represents price data for stocks, cryptocurrencies, and other investments.
 * Each document contains price information for a specific date/month.
 */
export const InvestmentPriceSchema = z
  .object({
    // Identification
    investment_id: z.string(), // SHA-256 hash or document ID
    ticker_symbol: z.string().optional(), // e.g., "AAPL", "BTC-USD", "VTSAX"

    // Price data (multiple fields for different price types)
    price: z.number().optional(),
    close_price: z.number().optional(),
    current_price: z.number().optional(),
    institution_price: z.number().optional(),

    // Date/time information
    date: z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD format').optional(), // For hf data
    month: z.string().regex(MONTH_REGEX, 'Must be YYYY-MM format').optional(), // For daily data
    close_price_as_of: z.string().optional(), // ISO timestamp

    // Additional OHLCV data
    high: z.number().optional(),
    low: z.number().optional(),
    open: z.number().optional(),
    volume: z.number().optional(),

    // Metadata
    currency: z.string().optional(), // "USD", etc.
    source: z.string().optional(), // Data source identifier
    price_type: z.string().optional(), // "daily" or "hf"
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type InvestmentPrice = z.infer<typeof InvestmentPriceSchema>;

/**
 * Get the best available price from an investment price record.
 * Tries fields in order of preference: current_price, close_price, price, institution_price.
 */
export function getBestPrice(price: InvestmentPrice): number | undefined {
  return price.current_price ?? price.close_price ?? price.price ?? price.institution_price;
}

/**
 * Get the date or month from a price record.
 */
export function getPriceDate(price: InvestmentPrice): string | undefined {
  return price.date ?? price.month;
}

/**
 * Check if this is high-frequency (intraday) price data.
 */
export function isHighFrequencyPrice(price: InvestmentPrice): boolean {
  return price.price_type === 'hf' || (!!price.date && !price.month);
}

/**
 * Check if this is daily (monthly aggregated) price data.
 */
export function isDailyPrice(price: InvestmentPrice): boolean {
  return price.price_type === 'daily' || (!!price.month && !price.date);
}

/**
 * Get a display name for the investment.
 */
export function getInvestmentDisplayName(price: InvestmentPrice): string {
  return price.ticker_symbol ?? price.investment_id;
}

/**
 * Format price as currency string.
 */
export function formatPrice(price: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}
