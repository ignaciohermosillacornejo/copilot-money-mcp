/**
 * Repair step for non-finite numbers decoded out of the Firestore cache.
 *
 * Firestore stores IEEE-754 doubles, and IEEE-754 has three values JSON and
 * Zod do not: `NaN`, `Infinity`, `-Infinity`. Copilot writes them — a holding
 * whose quantity is 0 gets an `Infinity` price (issue #659) — and the decoder
 * reads them back faithfully, because the wire format says so.
 *
 * Zod v4 rejects all three from `z.number()`, and a rejected leaf costs the
 * WHOLE document at `validateOrWarn`: one bad price removed an entire
 * investment account from `get_accounts` and 18 months of holdings history
 * from `get_holdings`. That is the same shape as issue #302 ("a validation
 * failure that discards the whole document is worse than no validation"), so
 * the fix belongs at the choke point rather than on the one field that hit it.
 *
 * This helper takes a decoded document and returns it with every non-finite
 * numeric leaf removed, plus the paths that were removed so the caller can say
 * so out loud. Removing rather than nulling is deliberate: schemas declare
 * these fields `z.number().optional()`, which accepts absence and rejects
 * `null`, so nulling would keep dropping the document.
 */

/** A repaired document plus the dotted paths of the leaves that were removed. */
export interface NonFiniteStripResult {
  value: unknown;
  paths: string[];
}

/**
 * True for plain objects only. Buffers (Firestore `bytes`) and any other
 * class instance are treated as opaque leaves — walking into them could
 * corrupt them, and none of them carry decoded numbers.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonFinite(value: unknown): boolean {
  return typeof value === 'number' && !Number.isFinite(value);
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * Recursive walk. Returns the ORIGINAL reference when nothing below it
 * changed, so a clean document (the overwhelmingly common case) costs one
 * traversal and zero allocations.
 */
function walk(value: unknown, prefix: string, paths: string[]): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let changed = false;
    value.forEach((element, index) => {
      const path = join(prefix, String(index));
      if (isNonFinite(element)) {
        // Dropping the element shifts later indices. No model declares an
        // array of bare numbers where position carries meaning, and leaving
        // the element in place would fail validation anyway — the document is
        // worth more than the index.
        paths.push(path);
        changed = true;
        return;
      }
      const repaired = walk(element, path, paths);
      if (repaired !== element) changed = true;
      out.push(repaired);
    });
    return changed ? out : value;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const [key, child] of Object.entries(value)) {
      const path = join(prefix, key);
      if (isNonFinite(child)) {
        paths.push(path);
        changed = true;
        continue;
      }
      const repaired = walk(child, path, paths);
      if (repaired !== child) changed = true;
      out[key] = repaired;
    }
    return changed ? out : value;
  }

  return value;
}

/**
 * Remove every `NaN` / `±Infinity` leaf nested inside `data`.
 *
 * A non-finite value at the root is returned unchanged: there is no container
 * to remove it from, and every decoded document is an object.
 *
 * @returns the repaired value (the input itself when nothing was non-finite)
 *   and the dotted paths of the removed leaves, in document order.
 */
export function stripNonFiniteNumbers(data: unknown): NonFiniteStripResult {
  const paths: string[] = [];
  const value = walk(data, '', paths);
  return { value, paths };
}
