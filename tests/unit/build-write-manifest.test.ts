/**
 * Tests for the writes-enabled manifest transform used by the local-only
 * pack:mcpb:write build. The committed manifest.json describes the read-only
 * bundle published to Claude Desktop; this transform layers the 14 write
 * tools, adds --write to mcp_config.args, and renames the bundle so it can
 * be installed alongside the read-only one without colliding.
 */

import { describe, test, expect } from 'bun:test';
import { buildWriteManifest } from '../../scripts/build-write-manifest.js';
import { createToolSchemas, createWriteToolSchemas } from '../../src/tools/tools.js';

interface ManifestTool {
  name: string;
  description: string;
}

interface ManifestForTest {
  name: string;
  display_name: string;
  description: string;
  tools: ManifestTool[];
  server: { mcp_config: { args: string[] } };
  [key: string]: unknown;
}

function readOnlyFixture(): ManifestForTest {
  return {
    manifest_version: '0.3',
    name: 'copilot-money-mcp',
    display_name: 'Copilot Money MCP Server',
    description: 'Read-only personal finance tools.',
    version: '2.0.0',
    tools: createToolSchemas().map((s) => ({ name: s.name, description: s.description })),
    server: {
      type: 'node',
      entry_point: 'dist/cli.js',
      mcp_config: {
        command: '${__dirname}/dist/launcher.sh',
        args: ['${__dirname}/dist/cli.js'],
      },
    },
  };
}

describe('buildWriteManifest', () => {
  test('produces a manifest with all 31 tools (read + write)', () => {
    const result = buildWriteManifest(readOnlyFixture());
    expect(result.tools.length).toBe(createToolSchemas().length + createWriteToolSchemas().length);
  });

  test('includes every write tool by name', () => {
    const result = buildWriteManifest(readOnlyFixture());
    const names = new Set(result.tools.map((t) => t.name));
    for (const schema of createWriteToolSchemas()) {
      expect(names.has(schema.name)).toBe(true);
    }
  });

  test('keeps every read tool by name', () => {
    const result = buildWriteManifest(readOnlyFixture());
    const names = new Set(result.tools.map((t) => t.name));
    for (const schema of createToolSchemas()) {
      expect(names.has(schema.name)).toBe(true);
    }
  });

  test('appends --write to mcp_config.args', () => {
    const result = buildWriteManifest(readOnlyFixture());
    expect(result.server.mcp_config.args).toContain('--write');
  });

  test('does not duplicate --write if already present', () => {
    const fixture = readOnlyFixture();
    fixture.server.mcp_config.args.push('--write');
    const result = buildWriteManifest(fixture);
    const writeArgs = result.server.mcp_config.args.filter((a: string) => a === '--write');
    expect(writeArgs.length).toBe(1);
  });

  test('renames bundle so it does not collide with the read-only install', () => {
    const result = buildWriteManifest(readOnlyFixture());
    expect(result.name).not.toBe('copilot-money-mcp');
    expect(result.name).toContain('write');
  });

  test('does not mutate the input manifest', () => {
    const fixture = readOnlyFixture();
    const originalToolCount = fixture.tools.length;
    const originalArgs = [...fixture.server.mcp_config.args];
    const originalName = fixture.name;
    buildWriteManifest(fixture);
    expect(fixture.tools.length).toBe(originalToolCount);
    expect(fixture.server.mcp_config.args).toEqual(originalArgs);
    expect(fixture.name).toBe(originalName);
  });

  test('description reports an accurate read/write split (no hardcoded read count)', () => {
    const result = buildWriteManifest(readOnlyFixture());
    const readCount = createToolSchemas().length;
    const writeCount = createWriteToolSchemas().length;
    expect(result.description).toContain(`${readCount} read`);
    expect(result.description).toContain(`${writeCount} write`);
  });

  test('preserves custom descriptions for read tools already in the manifest', () => {
    const fixture = readOnlyFixture();
    const customTool = fixture.tools[0];
    customTool.description = 'CUSTOM_OVERRIDE_DESCRIPTION';
    const result = buildWriteManifest(fixture);
    const matched = result.tools.find((t) => t.name === customTool.name);
    expect(matched?.description).toBe('CUSTOM_OVERRIDE_DESCRIPTION');
  });
});
