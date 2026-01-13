/**
 * Tests to ensure manifest.json stays in sync with actual tool definitions.
 *
 * When tools are added, removed, or renamed, this test will fail until
 * manifest.json is updated to match.
 */

import { describe, test, expect } from 'bun:test';
import { createToolSchemas } from '../../src/tools/tools.js';
import { readFileSync } from 'fs';
import { join } from 'path';

interface ManifestTool {
  name: string;
  description: string;
}

interface Manifest {
  tools: ManifestTool[];
}

describe('Manifest Tool Sync', () => {
  const actualSchemas = createToolSchemas();
  const manifestPath = join(import.meta.dir, '../../manifest.json');
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  test('manifest.json tool count matches actual tool count', () => {
    const actualToolNames = actualSchemas.map((s) => s.name).sort();
    const manifestToolNames = manifest.tools.map((t) => t.name).sort();

    expect(manifestToolNames.length).toBe(actualToolNames.length);
  });

  test('all actual tools are listed in manifest.json', () => {
    const manifestToolNames = new Set(manifest.tools.map((t) => t.name));
    const missingFromManifest: string[] = [];

    for (const schema of actualSchemas) {
      if (!manifestToolNames.has(schema.name)) {
        missingFromManifest.push(schema.name);
      }
    }

    if (missingFromManifest.length > 0) {
      throw new Error(
        `Tools missing from manifest.json:\n` +
          missingFromManifest.map((name) => `  - ${name}`).join('\n') +
          `\n\nAdd these tools to manifest.json or run: bun run sync-manifest`
      );
    }
  });

  test('all manifest tools exist in actual tool schemas', () => {
    const actualToolNames = new Set(actualSchemas.map((s) => s.name));
    const extraInManifest: string[] = [];

    for (const tool of manifest.tools) {
      if (!actualToolNames.has(tool.name)) {
        extraInManifest.push(tool.name);
      }
    }

    if (extraInManifest.length > 0) {
      throw new Error(
        `Tools in manifest.json that don't exist in code:\n` +
          extraInManifest.map((name) => `  - ${name}`).join('\n') +
          `\n\nRemove these tools from manifest.json or add them to createToolSchemas()`
      );
    }
  });

  test('manifest tool names match exactly (bidirectional check)', () => {
    const actualToolNames = actualSchemas.map((s) => s.name).sort();
    const manifestToolNames = manifest.tools.map((t) => t.name).sort();

    expect(manifestToolNames).toEqual(actualToolNames);
  });
});
