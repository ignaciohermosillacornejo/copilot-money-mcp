/**
 * Class-level detector for the #494 bug class: a live tool's `time_frame`
 * input-schema enum drifting from the canonical, conformance-gated
 * `ALL_TIME_FRAMES` set (e.g. by hardcoding a literal list that includes
 * server-invalid values like bare "MONTH"/"YEAR").
 *
 * This gate covers the whole class — every current and future live tool that
 * exposes a `time_frame` enum must reuse ALL_TIME_FRAMES — not just the
 * networth instance that triggered #494.
 */
import { describe, expect, test } from 'bun:test';
import * as liveRegistry from '../../../src/tools/registry/live.js';
import { ALL_TIME_FRAMES } from '../../../src/core/graphql/queries/_shared.js';

interface ToolEntry {
  schema: {
    name: string;
    inputSchema: { properties?: Record<string, { enum?: string[] }> };
  };
}

function isToolEntry(v: unknown): v is ToolEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    'schema' in v &&
    typeof (v as ToolEntry).schema?.name === 'string'
  );
}

const toolsWithTimeFrame = Object.entries(liveRegistry)
  .filter((e): e is [string, ToolEntry] => isToolEntry(e[1]))
  .filter(([, t]) => t.schema.inputSchema.properties?.time_frame?.enum);

describe('live tool time_frame enum conformance (#494 class detector)', () => {
  test('guards the gate: at least one live tool exposes a time_frame enum', () => {
    expect(toolsWithTimeFrame.length).toBeGreaterThan(0);
  });

  for (const [exportName, tool] of toolsWithTimeFrame) {
    test(`${tool.schema.name} (${exportName}) time_frame enum equals ALL_TIME_FRAMES`, () => {
      const en = tool.schema.inputSchema.properties!.time_frame!.enum;
      expect(en).toEqual([...ALL_TIME_FRAMES]);
    });
  }
});
