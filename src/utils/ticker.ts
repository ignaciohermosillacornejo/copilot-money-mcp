/**
 * Ticker comparison shared by the cache and live holdings filters (#825).
 *
 * The cash sleeve has a different ticker in each mode: the cache stores
 * `CUR:USD`, while GraphQL returns `USD`. A `ticker_symbol` filter therefore
 * matched in one mode and not the other. Rows keep the ticker their mode
 * returns; only the comparison is widened, and only for CASH rows:
 *
 *   - any row matches its own ticker, case-insensitively;
 *   - a cash row also matches its ticker with the `CUR:` prefix added or
 *     removed, so `USD` and `CUR:USD` both select the cash sleeve in both modes.
 *
 * The cash condition is what keeps `CUR:USD` from matching a SECURITY whose
 * ticker is `USD` (#860 review). A bare `USD` filter matches both the cash
 * sleeve and such a security, in both modes, because both are spelled USD.
 */
function stripCurrencyPrefix(ticker: string): string {
  const lower = ticker.trim().toLowerCase();
  return lower.startsWith('cur:') ? lower.slice(4) : lower;
}

export function tickerMatches(
  rowTicker: string | null | undefined,
  filter: string,
  rowIsCash: boolean
): boolean {
  if (!rowTicker) return false;
  if (rowTicker.trim().toLowerCase() === filter.trim().toLowerCase()) return true;
  return rowIsCash && stripCurrencyPrefix(rowTicker) === stripCurrencyPrefix(filter);
}

/**
 * Whether a security type names the cash sleeve. Case-insensitive, because
 * GraphQL says `CASH` and the cache says `cash`; every cash check in both
 * modes goes through this (#860 review).
 */
export function isCashSecurityType(type: string | null | undefined): boolean {
  return type?.toLowerCase() === 'cash';
}
