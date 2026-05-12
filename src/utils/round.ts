/**
 * Round to 2 decimal places, avoiding floating-point artifacts like
 * `0.1 + 0.2 = 0.30000000000000004`.
 */
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compute total-return percentage matching Copilot's web UI display
 * convention (Math.floor on the signed percent — verified empirically
 * against META 8.37% and DASH -22.86%). Returns undefined when costBasis
 * is zero (no meaningful percentage) so callers can omit the field.
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
  return Math.floor((totalReturn / Math.abs(costBasis)) * 10000) / 100;
}

/**
 * Parse a string/null/undefined GraphQL amount into a number, returning
 * null when the value can't be parsed. Used by snapshot-mode live tools
 * that receive amounts as Apollo-canonical strings.
 */
export function parseAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
