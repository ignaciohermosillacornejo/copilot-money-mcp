/**
 * Guards the workaround for modelcontextprotocol/mcpb#229: Claude Desktop
 * routes `mcp_config.command === "node"` through an Electron UtilityProcess
 * that enforces macOS hardened-runtime library validation and rejects
 * ad-hoc-signed npm prebuilds (classic-level, etc.). Pointing `command` at
 * our launcher script keeps us on the plain `exec` spawn path where native
 * deps load normally. If someone reverts `command` back to `"node"`, the
 * extension breaks on macOS at install time — so fail loudly in CI.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

interface McpConfig {
  command: string;
  args?: string[];
  platform_overrides?: Record<string, { command?: string; args?: string[] }>;
}

interface Manifest {
  server: {
    type: string;
    entry_point: string;
    mcp_config: McpConfig;
  };
}

describe('manifest server config', () => {
  const manifestPath = join(import.meta.dir, '../../manifest.json');
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const { mcp_config } = manifest.server;

  test('base command is not the literal string "node"', () => {
    expect(mcp_config.command).not.toBe('node');
  });

  test('base command points at launcher.sh', () => {
    expect(mcp_config.command).toBe('${__dirname}/dist/launcher.sh');
  });

  test('win32 override exists so Windows still uses node directly', () => {
    expect(mcp_config.platform_overrides?.win32?.command).toBe('node');
  });
});
