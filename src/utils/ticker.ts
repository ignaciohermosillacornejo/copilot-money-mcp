/**
 * Ticker comparison shared by the cache and live holdings filters (#825).
 *
 * The cash sleeve has a different ticker in each mode: the cache stores
 * `CUR:USD`, while GraphQL returns `USD`. A `ticker_symbol` filter therefore
 * matched in one mode and not the other. Comparing case-insensitively, with a
 * leading `CUR:` currency prefix ignored on both sides, makes `USD` and
 * `CUR:USD` select the same row in both modes. Each row keeps the ticker its
 * mode returns; only the comparison is normalised.
 */
export function normalizeTickerForMatch(ticker: string): string {
  const lower = ticker.trim().toLowerCase();
  return lower.startsWith('cur:') ? lower.slice(4) : lower;
}

export function tickerMatches(rowTicker: string | null | undefined, filter: string): boolean {
  if (!rowTicker) return false;
  return normalizeTickerForMatch(rowTicker) === normalizeTickerForMatch(filter);
}
