/**
 * Round to 2 decimal places, avoiding floating-point artifacts like
 * `0.1 + 0.2 = 0.30000000000000004`.
 */
export function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}
