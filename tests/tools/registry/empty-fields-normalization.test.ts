/**
 * `fields: []` means "omitted", for every tool (PR B review, Minor 4).
 *
 * Before this, an empty array reached `expandFieldSelection`, which maps it to
 * `undefined` = "no projection" — so `fields: []` bypassed the v3 diet
 * entirely and returned FULL rows, the opposite of what a caller (or a client
 * serializing an empty selection) expects. The settled v3 design is
 * `[] == omitted`.
 *
 * The rule cannot live in `projectRows`: by then each handler has already
 * folded "omitted" into its own default (`args.fields ?? ['default']` for a
 * terse-by-default tool, `undefined`/`compact` for `get_transactions`), and an
 * explicit `[]` survives `??` unchanged — so the engine sees `[]` from both
 * kinds of tool and cannot tell which default to stand in for. `defineTool`
 * drops the empty array BEFORE the handler runs, which routes the call down
 * that tool's own omitted path rather than guessing one.
 *
 * This file pins the wrapper and the helper. The per-tool consequence — that
 * a real dispatched call with `fields: []` returns byte-identical output to
 * the same call without `fields` — is pinned in tests/e2e/server.test.ts,
 * where a fixture-backed server exists.
 */

import { describe, expect, test } from 'bun:test';
import { defineTool, type ToolContext } from '../../../src/tools/registry/types.js';
import { dropEmptyFieldSelection } from '../../../src/tools/field-selection.js';

const ctx = {} as ToolContext;

/** Records whatever args the inner handler is actually handed. */
function spyTool(): { def: ReturnType<typeof defineTool>; seen: () => unknown } {
  let received: unknown;
  const def = defineTool({
    schema: {
      name: 'spy_tool',
      description: 'test double',
      inputSchema: { type: 'object' as const, properties: {} },
      annotations: { readOnlyHint: true },
    },
    handler: (_ctx, args) => {
      received = args;
      return Promise.resolve(null);
    },
    readOnly: true,
  });
  return { def, seen: () => received };
}

describe('dropEmptyFieldSelection', () => {
  test('removes an empty fields array without mutating the caller object', () => {
    const args = { fields: [], limit: 5 };
    expect(dropEmptyFieldSelection(args)).toEqual({ limit: 5 });
    expect(args).toEqual({ fields: [], limit: 5 });
  });

  test('leaves a non-empty fields array alone', () => {
    const args = { fields: ['name'] };
    expect(dropEmptyFieldSelection(args)).toEqual({ fields: ['name'] });
  });

  test('passes a non-array fields through so the engine can still throw on it', () => {
    // projectRows' assertFieldsArray is the guard for a host that skipped
    // schema validation; swallowing the bad value here would defeat it.
    expect(dropEmptyFieldSelection({ fields: 'name' })).toEqual({ fields: 'name' });
  });

  test('handles undefined args and args without fields', () => {
    expect(dropEmptyFieldSelection(undefined)).toBeUndefined();
    expect(dropEmptyFieldSelection({ limit: 1 })).toEqual({ limit: 1 });
  });
});

describe('defineTool applies the rule to every registered tool', () => {
  test('the handler never sees an empty fields array', async () => {
    const { def, seen } = spyTool();
    await def.handler(ctx, { fields: [], account_type: 'credit' });
    expect(seen()).toEqual({ account_type: 'credit' });
  });

  test('everything else reaches the handler untouched', async () => {
    const { def, seen } = spyTool();
    await def.handler(ctx, { fields: ['default', 'logo'], limit: 3 });
    expect(seen()).toEqual({ fields: ['default', 'logo'], limit: 3 });

    await def.handler(ctx, undefined);
    expect(seen()).toBeUndefined();
  });
});
