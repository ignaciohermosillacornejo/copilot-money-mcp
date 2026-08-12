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
 * The two investment-price subcollections in the Firestore cache.
 * Single source of truth for the `price_type` filter accepted by the decoder,
 * `CopilotDatabase.getInvestmentPrices`, and the `get_investment_prices` tool
 * (param type + schema enum).
 */
export const PRICE_TYPES = ['daily', 'hf'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

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
    // Identification.
    // `security_id` is recovered from the collection path
    // (investment_prices/{security_id}/{daily|hf}) and joins to
    // `securities.security_id`. It is the only reliable identity a price
    // document has — see issue #622.
    security_id: z.string(),
    investment_id: z.string().optional(), // only when denormalized onto the doc (not observed in real data)
    ticker_symbol: z.string().optional(), // joined from `securities`; absent on the raw document

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
    price_type: z.enum(PRICE_TYPES).optional(), // always decoder-assigned from the subcollection path

    // Nested price payload. For daily docs this is keyed by day-of-month (`01`–`31`);
    // for hf docs it's keyed by intraday timestamp. Values carry the numeric price
    // plus source metadata. The schema stays loose because the key space varies by
    // price_type — consumers should inspect `prices` alongside `date`/`month`.
    prices: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type InvestmentPrice = z.infer<typeof InvestmentPriceSchema>;

/**
 * The latest point in a document's nested `prices` map.
 *
 * Real price documents carry their numbers ONLY in that map (#622) — there is
 * no scalar price field — so dropping the map by default (#605) would leave a
 * row with no price at all. The latest point is derived up front instead, which
 * is what a caller asking "what is this worth" actually wants, at ~2% of the
 * bytes.
 *
 * Keys are epoch-millis. `latest_at` is an ISO-8601 UTC instant rather than a
 * calendar date on purpose: for `hf` documents the key is an intraday
 * timestamp, and rendering that as a bare date would silently assert a market
 * timezone this project does not know.
 */
export function getLatestPricePoint(
  price: InvestmentPrice
): { latest_price: number; latest_at?: string } | undefined {
  // No early return when the series is absent: the scalar fallback below is
  // the whole point of this function for documents that never had one.
  let bestKey: number | undefined;
  let bestValue: number | undefined;
  for (const [key, value] of Object.entries(price.prices ?? {})) {
    if (typeof value !== 'number') continue;
    const ms = Number(key);
    if (!Number.isFinite(ms)) continue;
    if (bestKey === undefined || ms > bestKey) {
      bestKey = ms;
      bestValue = value;
    }
  }

  if (bestKey !== undefined && bestValue !== undefined) {
    return { latest_price: bestValue, latest_at: new Date(bestKey).toISOString() };
  }

  // No usable series. Fall back to a scalar price if the document carries one.
  // Real documents never have (#622), but the decoder reads them when present,
  // and this keeps `latest_price` meaning "the current price for this row"
  // rather than silently vanishing if Copilot ever denormalizes one — which is
  // what padding the default preset with `close_price`/`current_price` would
  // have been working around.
  const scalar = getBestPrice(price);
  if (scalar === undefined) return undefined;
  const period = getPriceDate(price);
  return { latest_price: scalar, ...(period && { latest_at: period }) };
}

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
  return price.ticker_symbol ?? price.security_id;
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
