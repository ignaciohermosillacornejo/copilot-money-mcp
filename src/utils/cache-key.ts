/**
 * Sentinel key segment for "no argument passed" so an explicit value
 * (e.g. 'ALL') never collides with an omitted argument. Semantically
 * different from any real enum value — keep their cache entries separate.
 */
export const OMITTED_ARG_SENTINEL = 'DEFAULT';

/**
 * Compose a tuple cache key from string-or-undefined parts using a
 * null-byte separator. The null byte cannot appear in any of the
 * domain values we key on (Plaid IDs, enum-string time frames, etc.),
 * so the join is injectively reversible — no two distinct argument
 * tuples can produce the same key.
 *
 * Undefined parts are normalized to OMITTED_ARG_SENTINEL so they don't
 * collide with explicit values that happen to stringify to ''.
 */
export function makeTupleKey(...parts: (string | undefined)[]): string {
  return parts.map((p) => p ?? OMITTED_ARG_SENTINEL).join('\0');
}
