/**
 * Repair step for nested values the schema rejects (#902).
 *
 * WHY NESTED, AND ONLY NESTED. Every top-level field of a decoded document is
 * produced by a typed getter in `src/core/decoder.ts` (`getNumber`,
 * `getString`, explicit null handling for `limit` / `verification_status`), so
 * the decoder has already decided its type before Zod sees it. Nested
 * containers are different: `holdings`, `items`, `contributions`, `history`,
 * `daily_data` and friends are copied verbatim with `toPlainObject`, so every
 * leaf inside them reaches Zod exactly as Copilot wrote it. Zod is the ONLY
 * type check those leaves get — and a Zod failure used to cost the whole
 * document.
 *
 * That is how one holding with `institution_price: null` (an MX-linked 401k,
 * #902) removed an entire account from `get_accounts` and its balance from
 * every total. It is the third instance of the same shape: #302 (null
 * `vested_*`, fixed by widening those two fields) and #659 (non-finite price,
 * fixed by stripping `NaN`/`±Infinity` at the choke point). Both fixes were
 * narrower than the class: #302 covered two fields, #659 covered one kind of
 * bad value. This covers the placement: any value the schema rejects, anywhere
 * below the top level.
 *
 * THE REPAIR. Driven by Zod's own issue paths, in rounds:
 *
 *   1. A rejected value that is PRESENT is removed. Optional fields accept
 *      absence, so a bad optional leaf costs exactly that leaf.
 *   2. A rejected value that is ABSENT (a required nested field — either
 *      missing on the wire or removed by step 1) cannot be fixed by removal,
 *      so the node that encloses it is removed instead: one holding, one
 *      contribution, one history snapshot.
 *
 * Rounds repeat until the document validates, nothing more can be removed, or
 * `MAX_ROUNDS` runs out. The last two are give-ups, reported as such.
 *
 * WHAT IT NEVER TOUCHES. A path of length < 2 — a top-level field. Those come
 * from the decoder's typed getters, so a failure there is genuine shape drift
 * on a field we chose to read (a required id missing, a balance that is now a
 * string), and it still drops the document and warns as before. Climbing from
 * a nested path to a top-level one is refused for the same reason: the repair
 * may empty `holdings`, but it never deletes `holdings` itself.
 *
 * One consequence, unreachable today and stated so a red sweep is easy to
 * read: a required field inside an OPTIONAL top-level object (`details:
 * z.object({ total: z.number() }).optional()` with a bad `total`) would climb
 * to `details` and stop, dropping the document even though removing
 * `details` would have validated. No model has a top-level object field — all
 * nested containers are arrays or records, whose entries sit at depth 2 — and
 * `tests/core/nested-field-sweep.test.ts` goes red the day one is added. The
 * fix then is to allow the climb when that top-level field accepts
 * `undefined`.
 *
 * Record KEYS are covered too: Zod v4 reports a key that fails its key schema
 * as `invalid_key` at `[record, badKey]` — depth 2, and present — so the bad
 * entry is removed like any other.
 *
 * Nothing here is silent: `validateOrWarn` logs every removed path and counts
 * the document as `repaired`, which `decode_health` reports as partial loss.
 */

import type { ZodType } from 'zod';

/** One node the repair removed, with the Zod issue that caused it. */
export interface NestedRemoval {
  /** Dotted path of the removed node, in the coordinates of its round. */
  path: string;
  code: string;
  message: string;
}

export interface NestedRepairResult<T> {
  data: T;
  /** Empty when `data` already validated (no repair needed). */
  removed: NestedRemoval[];
}

/** Paths shorter than this are top-level fields — never repaired. */
const MIN_REPAIR_DEPTH = 2;

/**
 * Upper bound on parse/remove rounds. A leaf removal followed by an
 * enclosing-node removal is two rounds; nested objects inside array elements
 * can need a third. The bound only exists so a pathological schema cannot
 * loop — every round must remove something or the repair gives up.
 */
const MAX_ROUNDS = 8;

type Segment = PropertyKey;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when `path` names a node that exists in `value` (even if its value is null). */
function exists(value: unknown, path: readonly Segment[]): boolean {
  let node: unknown = value;
  for (const segment of path) {
    if (Array.isArray(node)) {
      const index = typeof segment === 'number' ? segment : Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
      node = node[index];
    } else if (isPlainObject(node)) {
      const key = String(segment);
      if (!Object.prototype.hasOwnProperty.call(node, key)) return false;
      node = node[key];
    } else {
      return false;
    }
  }
  return true;
}

const SEP = '\u0000';
const keyOf = (path: readonly Segment[]): string => path.map(String).join(SEP);

/**
 * Copy-on-write removal of every node in `targets`. Returns the ORIGINAL
 * reference when nothing was removed, so the caller can detect "no progress".
 * Array elements are filtered, so later indices shift — fine, because the next
 * round re-reads issue paths from a fresh parse.
 */
function removeAll(value: unknown, targets: readonly (readonly Segment[])[]): unknown {
  const remove = new Set(targets.map(keyOf));
  const prefixes = new Set<string>();
  for (const target of targets) {
    for (let i = 1; i < target.length; i++) prefixes.add(keyOf(target.slice(0, i)));
  }

  const walk = (node: unknown, prefix: Segment[]): unknown => {
    if (prefix.length > 0 && !prefixes.has(keyOf(prefix))) return node;
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      let changed = false;
      for (const [index, child] of node.entries()) {
        const path = [...prefix, index];
        if (remove.has(keyOf(path))) {
          changed = true;
          continue;
        }
        const next = walk(child, path);
        if (next !== child) changed = true;
        out.push(next);
      }
      return changed ? out : node;
    }
    if (isPlainObject(node)) {
      const out: Record<string, unknown> = {};
      let changed = false;
      for (const [key, child] of Object.entries(node)) {
        const path = [...prefix, key];
        if (remove.has(keyOf(path))) {
          changed = true;
          continue;
        }
        const next = walk(child, path);
        if (next !== child) changed = true;
        out[key] = next;
      }
      return changed ? out : node;
    }
    return node;
  };

  return walk(value, []);
}

/** Why a document could not be repaired. */
export type NestedRepairFailureReason =
  /** An issue (or the node a climb would remove) is a top-level field. */
  | 'top-level'
  /** A round found nothing it could remove. */
  | 'no-progress'
  /** `MAX_ROUNDS` ran out before the document validated. */
  | 'exhausted';

export interface NestedRepairFailure {
  ok: false;
  reason: NestedRepairFailureReason;
}

export type NestedRepairOutcome<T> = ({ ok: true } & NestedRepairResult<T>) | NestedRepairFailure;

/**
 * Parse `data`; if it fails only below the top level, remove the offending
 * nested nodes until it validates.
 *
 * `firstIssues` lets a caller that has already parsed `data` (and seen it
 * fail) skip the first, identical parse.
 *
 * @returns `{ ok: true, data, removed }`, or `{ ok: false, reason }` when the
 *   document cannot be repaired. The reason is reported so a caller can tell
 *   the expected refusal (`top-level`) from the repair giving up
 *   (`exhausted` or `no-progress`), which would otherwise look exactly like
 *   the pre-#902 drop.
 *   Never mutates `data`.
 */
export function repairNestedIssues<T>(
  schema: ZodType<T>,
  data: unknown,
  firstIssues?: readonly { path: PropertyKey[]; code: string; message: string }[]
): NestedRepairOutcome<T> {
  let current = data;
  const removed: NestedRemoval[] = [];
  let pending = firstIssues;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let issues = pending;
    pending = undefined;
    if (!issues) {
      const result = schema.safeParse(current);
      if (result.success) return { ok: true, data: result.data, removed };
      issues = result.error.issues;
    }

    const targets: Segment[][] = [];
    const seen = new Set<string>();
    for (const issue of issues) {
      if (issue.path.length < MIN_REPAIR_DEPTH) return { ok: false, reason: 'top-level' };
      // A present-but-rejected value is removed; an absent one (required
      // field) takes its enclosing node with it.
      const target = exists(current, issue.path) ? [...issue.path] : issue.path.slice(0, -1);
      if (target.length < MIN_REPAIR_DEPTH) return { ok: false, reason: 'top-level' };
      // An issue path two or more levels past the data climbs to a node that
      // does not exist either. Nothing is removed for it, so nothing is
      // claimed: `removed` feeds the warn, and must only name real removals.
      // If no issue in the round yields a real target, `removeAll` returns the
      // same reference and the round reports `no-progress`.
      if (!exists(current, target)) continue;
      const key = keyOf(target);
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
      removed.push({
        path: target.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      });
    }

    const next = removeAll(current, targets);
    if (next === current) return { ok: false, reason: 'no-progress' };
    current = next;
  }

  // One last parse: the final round's removal may have been the one that
  // made the document valid.
  const last = schema.safeParse(current);
  if (last.success) return { ok: true, data: last.data, removed };
  return { ok: false, reason: 'exhausted' };
}
