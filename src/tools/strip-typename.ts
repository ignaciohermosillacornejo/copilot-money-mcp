/**
 * Remove GraphQL `__typename` keys from a tool result before serialization
 * (#597 Tier 0).
 *
 * We deliberately keep REQUESTING `__typename` — scripts/generate-graphql-operations.ts
 * injects it so our operation documents match what the web app's Apollo Client
 * sends. It is response-side noise only: the #597 audit measured it at ~22%
 * of a tag row and ~36% of a networth row. Icon unions discriminate on it
 * internally, but by the time a result reaches serialization all such
 * branching has already run, and the payload shapes ({unicode} vs {id, src})
 * distinguish themselves for consumers.
 */
export function stripTypename<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => stripTypename(item)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  // Only rebuild plain objects (prototype is Object.prototype, or null for an
  // Object.create(null) dict) by enumerating their own keys. Anything else —
  // a Date, a class instance with its own toJSON — is returned as-is so it
  // keeps serializing via its own JSON.stringify behavior; rebuilding it from
  // Object.keys() would silently flatten it to {} (a Date's fields live on
  // its prototype, not as own keys) before JSON.stringify ever runs.
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === '__typename') continue;
    // Assigning through the inherited '__proto__' setter would mutate the
    // output's prototype instead of copying data (same guard as projectRows).
    if (key === '__proto__') continue;
    out[key] = stripTypename((value as Record<string, unknown>)[key]);
  }
  return out as T;
}
