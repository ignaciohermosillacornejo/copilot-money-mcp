/**
 * Tool registry invariants (E1, #446).
 *
 * The server derives its tool list, dispatch, write gating, and live-reads
 * gating from the registry, so these structural invariants are what keeps
 * the MCP-visible surface consistent: a wrong classification here would
 * silently change gating or the advertised tool list.
 */

import { describe, test, expect } from 'bun:test';
import {
  ALL_TOOL_DEFS,
  READ_TOOL_DEFS,
  LIVE_TOOL_DEFS,
  WRITE_TOOL_DEFS,
  TOOL_REGISTRY,
} from '../../src/tools/registry/index.js';

describe('tool registry invariants', () => {
  test('tool names are unique and the lookup map covers every definition', () => {
    expect(TOOL_REGISTRY.size).toBe(ALL_TOOL_DEFS.length);
    for (const def of ALL_TOOL_DEFS) {
      expect(TOOL_REGISTRY.get(def.name)).toBe(def);
    }
  });

  test('every definition derives its name from its schema', () => {
    for (const def of ALL_TOOL_DEFS) {
      expect(def.name).toBe(def.schema.name);
    }
  });

  test('readOnly classification matches the MCP readOnlyHint annotation', () => {
    for (const def of ALL_TOOL_DEFS) {
      expect(def.schema.annotations?.readOnlyHint).toBe(def.readOnly);
    }
  });

  test('read and live tools are readOnly; write tools are not', () => {
    for (const def of [...READ_TOOL_DEFS, ...LIVE_TOOL_DEFS]) {
      expect(def.readOnly).toBe(true);
    }
    for (const def of WRITE_TOOL_DEFS) {
      expect(def.readOnly).toBe(false);
    }
  });

  test('exactly the live list requires --live-reads', () => {
    for (const def of LIVE_TOOL_DEFS) {
      expect(def.requiresLiveReads).toBe(true);
    }
    for (const def of [...READ_TOOL_DEFS, ...WRITE_TOOL_DEFS]) {
      expect(def.requiresLiveReads).toBeUndefined();
    }
  });

  test('live-mode swaps: exactly the historical six reads are swapped out', () => {
    const swapped = READ_TOOL_DEFS.filter((def) => def.swappedOutInLiveMode).map((def) => def.name);
    expect(swapped.sort()).toEqual([
      'get_accounts',
      'get_budgets',
      'get_categories',
      'get_holdings',
      'get_recurring_transactions',
      'get_transactions',
    ]);
    // No live or write tool carries the flag — it only makes sense on
    // cache-mode reads.
    for (const def of [...LIVE_TOOL_DEFS, ...WRITE_TOOL_DEFS]) {
      expect(def.swappedOutInLiveMode).toBeUndefined();
    }
  });

  test('list sizes match the known tool surface (14 cache reads + 17 live + 17 writes)', () => {
    expect(READ_TOOL_DEFS.length).toBe(14);
    expect(LIVE_TOOL_DEFS.length).toBe(17);
    expect(WRITE_TOOL_DEFS.length).toBe(17);
  });
});
