/**
 * Shared context-budget ratchet harness.
 *
 * Extracted from `tests/context-budget.test.ts` so a live-tool budget suite
 * can reuse the exact same measure/assert logic instead of forking it —
 * two independently-maintained ratchets would drift (see `path-divergence`
 * in `docs/bugs/README.md`).
 *
 * `registerContextBudgetChecks` is deliberately generic over the tool list,
 * the budget table, and how a measurable result is obtained for one tool:
 * cache-mode reads call `def.handler(ctx, args)` directly; a live suite is
 * expected to go through a stubbed server call instead. Neither case is
 * hard-coded here.
 */

import { test, expect } from 'bun:test';

/** Serialize exactly like `src/server.ts` does for tool responses. */
export function serializedSize(value: unknown): number {
  return JSON.stringify(value).length;
}

export interface ContextBudgetSuite<T extends { name: string }> {
  /** Tools this budget table must cover exactly (order doesn't matter). */
  defs: readonly T[];
  /** Tool name -> max size in chars. Ratchet: only ever lowered. */
  budgets: Record<string, number>;
  /**
   * Produces the value to measure for one tool — e.g. a handler's response,
   * or a schema object. Sync or async; the result is passed to
   * `serializedSize`.
   */
  getResult: (def: T) => unknown | Promise<unknown>;
  /** Noun phrase for the completeness-guard test title, e.g. "eligible read tools". */
  subject: string;
  /** Adjective for the per-tool test title, e.g. "response" or "schema". */
  kind: string;
}

/**
 * Registers one completeness-guard test plus one "stays within budget" test
 * per tool. Call from inside a `describe()` block — this doesn't create its
 * own, so callers control grouping/titles around it.
 */
export function registerContextBudgetChecks<T extends { name: string }>(
  suite: ContextBudgetSuite<T>
): void {
  const { defs, budgets, getResult, subject, kind } = suite;

  test(`budget table covers exactly the ${subject} (completeness guard)`, () => {
    const names = defs.map((def) => def.name).sort();
    // Guard against a vacuously-empty filter: the table itself is the floor.
    expect(names.length).toBeGreaterThan(0);
    // Bidirectional: a new tool without a budget fails, and so does a stale
    // budget entry for a removed/renamed tool.
    expect(Object.keys(budgets).sort()).toEqual(names);
  });

  for (const def of defs) {
    test(`${def.name} ${kind} stays within budget`, async () => {
      const value = await getResult(def);
      const size = serializedSize(value);
      if (process.env.CONTEXT_BUDGET_PRINT) {
        console.log(`[${kind}] ${def.name}: ${size} chars`);
      }
      expect(size).toBeGreaterThan(0);
      // `?? 0`: belt-and-braces so a missing entry can never pass vacuously,
      // even though the completeness guard above already fails on it.
      expect(size).toBeLessThanOrEqual(budgets[def.name] ?? 0);
    });
  }
}
