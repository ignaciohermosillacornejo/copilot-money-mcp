/**
 * Round to 2 decimal places, avoiding floating-point artifacts like
 * `0.1 + 0.2 = 0.30000000000000004`.
 */
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compute total-return percentage matching Copilot's web UI display
 * convention: truncated toward zero at two decimals. The #825 release pass
 * saw -12.446% shown as -12.44%, where the earlier Math.floor gave -12.45; a
 * positive value truncates the same either way (META 8.37%). Ledger:
 * `CopilotWebUi.totalReturnPercent:truncatedTowardZero`. Returns undefined
 * when costBasis is zero (no meaningful percentage) so callers can omit the
 * field.
 *
 * Math.abs in the denominator preserves the sign of totalReturn for
 * negative basis (short positions / margin accounts), so a short that
 * goes against you reports a negative percentage instead of flipping
 * sign via negative ÷ negative.
 */
export function computeTotalReturnPercent(
  totalReturn: number,
  costBasis: number
): number | undefined {
  if (costBasis === 0) return undefined;
  // Snapped to 9 places before truncating, so float error (0.57% computing
  // as 56.99999999999999 hundredths) does not cost a hundredth; `+ 0` folds
  // -0 to 0, so a tiny loss does not print as "-0".
  const hundredths = Number(((totalReturn / Math.abs(costBasis)) * 10000).toFixed(9));
  return Math.trunc(hundredths) / 100 + 0;
}

/**
 * Parse a string/number/null/undefined GraphQL amount into a number,
 * returning null when the value can't be parsed. Used by snapshot-mode live
 * tools that receive amounts as either Apollo-canonical strings or (for
 * monthlySpending/networthHistory — server type drift, #537) plain numbers.
 */
export function parseAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
