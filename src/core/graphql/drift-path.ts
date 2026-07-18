/**
 * Normalize a Zod issue path into a dedupe key segment: array indices (numeric
 * segments) collapse to `*`, so a single drift on an array field warns once
 * instead of once per element (issue #552). String keys pass through unchanged.
 * Shared by both warn-mode response validators (read + mutation) so their dedupe
 * behavior can't drift apart.
 */
export function normalizeDriftPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((seg) => (typeof seg === 'number' ? '*' : String(seg))).join('.');
}
