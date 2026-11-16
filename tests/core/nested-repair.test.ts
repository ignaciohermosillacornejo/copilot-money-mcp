/**
 * Direct tests for `repairNestedIssues` (#902): the edges that the
 * `validateOrWarn` tests and the model sweep do not reach. The behaviour
 * through the real choke point is pinned in `tests/core/schema-warn.test.ts`
 * and swept across every model in `tests/core/nested-field-sweep.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { repairNestedIssues } from '../../src/core/nested-repair.js';

describe('repairNestedIssues', () => {
  test('returns the parsed data and no removals when the document is already valid', () => {
    const Schema = z.object({ id: z.string(), items: z.array(z.number()).optional() });

    expect(repairNestedIssues(Schema, { id: 'x', items: [1] })).toEqual({
      ok: true,
      data: { id: 'x', items: [1] },
      removed: [],
    });
  });

  test('reports each removal with the Zod issue that caused it', () => {
    const Schema = z.object({
      id: z.string(),
      items: z.array(z.object({ price: z.number().optional() })),
    });

    const result = repairNestedIssues(Schema, { id: 'x', items: [{ price: null }] });

    expect(result).toMatchObject({ ok: true, data: { id: 'x', items: [{}] } });
    expect(result.ok && result.removed).toEqual([
      {
        path: 'items.0.price',
        code: 'invalid_type',
        message: 'Invalid input: expected number, received null',
      },
    ]);
  });

  test('gives up after its round bound rather than looping', () => {
    // Every level is required, so each round can only climb one level from
    // the bad leaf. Ten levels need more rounds than the bound allows, so the
    // repair must report `exhausted` (the caller then drops and warns) instead
    // of iterating without limit.
    let leaf: z.ZodType = z.object({ value: z.number() });
    let bad: unknown = { value: null };
    for (let depth = 0; depth < 10; depth++) {
      leaf = z.object({ child: leaf });
      bad = { child: bad };
    }
    const Schema = z.object({ id: z.string(), items: z.array(leaf) });

    expect(repairNestedIssues(Schema, { id: 'x', items: [bad] })).toEqual({
      ok: false,
      reason: 'exhausted',
    });
  });

  test('an issue path that runs through a scalar removes the scalar', () => {
    // A refinement can report an issue at a path deeper than the data goes.
    // The node at that path does not exist, so the repair treats it like a
    // missing required field and removes the nearest enclosing node: here
    // the scalar the path ran through.
    const Schema = z
      .object({
        id: z.string(),
        items: z.array(z.object({ name: z.string().optional() })),
      })
      .superRefine((doc, ctx) => {
        if (doc.items[0]?.name !== undefined) {
          ctx.addIssue({ code: 'custom', path: ['items', 0, 'name', 'deeper'], message: 'bad' });
        }
      });

    const result = repairNestedIssues(Schema, { id: 'x', items: [{ name: 'n' }] });

    expect(result).toMatchObject({ ok: true, data: { id: 'x', items: [{}] } });
    expect(result.ok && result.removed.map((r) => r.path)).toEqual(['items.0.name']);
  });

  test('reports no-progress when a round can remove nothing', () => {
    // The issue path runs two levels past the data: neither the node nor its
    // parent exists, so there is nothing to remove.
    const Schema = z
      .object({ id: z.string(), items: z.array(z.object({ name: z.string() })) })
      .superRefine((_doc, ctx) => {
        ctx.addIssue({ code: 'custom', path: ['items', 0, 'name', 'a', 'b'], message: 'bad' });
      });

    expect(repairNestedIssues(Schema, { id: 'x', items: [{ name: 'n' }] })).toEqual({
      ok: false,
      reason: 'no-progress',
    });
  });

  test('refuses a top-level failure outright', () => {
    const Schema = z.object({ id: z.string(), items: z.array(z.number()).optional() });

    expect(repairNestedIssues(Schema, { id: 42, items: [1] })).toEqual({
      ok: false,
      reason: 'top-level',
    });
  });

  test('refuses to climb from a nested required field into a top-level one', () => {
    const Schema = z.object({
      id: z.string(),
      details: z.object({ total: z.number() }).optional(),
    });

    expect(repairNestedIssues(Schema, { id: 'x', details: { total: null } })).toEqual({
      ok: false,
      reason: 'top-level',
    });
  });

  test('removes a record entry whose KEY fails the key schema', () => {
    // Zod v4 reports the bad key at `[record, key]`, so it is removed like a
    // bad value would be.
    const Schema = z.object({
      id: z.string(),
      adjustments: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number()),
    });

    const result = repairNestedIssues(Schema, {
      id: 'x',
      adjustments: { '2026-01-15': 2, 'not-a-date': 3 },
    });

    expect(result).toMatchObject({ ok: true, data: { id: 'x', adjustments: { '2026-01-15': 2 } } });
    expect(result.ok && result.removed.map((r) => r.code)).toEqual(['invalid_key']);
  });

  test('uses supplied first-round issues instead of re-parsing', () => {
    const Schema = z.object({
      id: z.string(),
      items: z.array(z.object({ price: z.number().optional() })),
    });
    const data = { id: 'x', items: [{ price: null }] };
    const first = Schema.safeParse(data);
    if (first.success) throw new Error('fixture must fail');

    expect(repairNestedIssues(Schema, data, first.error.issues)).toMatchObject({
      ok: true,
      data: { id: 'x', items: [{}] },
    });
  });
});
