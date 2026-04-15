#!/usr/bin/env bun
/**
 * Sync manifest.json tools with actual tool definitions.
 *
 * Usage:
 *   bun run sync-manifest          # regenerates the read-only manifest.json
 *   bun run sync-manifest -- --write  # writes manifest.write.json (local-only,
 *                                       writes-enabled bundle metadata, gitignored)
 *
 * This script reads tool schemas from createToolSchemas() and updates the
 * read-only `manifest.json` tools array to match, preserving custom
 * descriptions. With `--write`, it instead generates a writes-enabled variant
 * at `manifest.write.json` for the local `pack:mcpb:write` build.
 */

import { createToolSchemas } from '../src/tools/tools.js';
import { buildWriteManifest } from './build-write-manifest.js';
import { truncateDescription, type Manifest, type ManifestTool } from './manifest-utils.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, '../manifest.json');
const writeManifestPath = join(__dirname, '../manifest.write.json');

function main() {
  const writeMode = process.argv.includes('--write');
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  if (writeMode) {
    const writeManifest = buildWriteManifest(manifest);
    writeFileSync(writeManifestPath, JSON.stringify(writeManifest, null, 2) + '\n');
    console.log(
      `✓ Wrote manifest.write.json with ${writeManifest.tools.length} tools (writes-enabled, local-only)`
    );
    return;
  }

  const schemas = createToolSchemas();

  // Build a map of existing manifest tool descriptions (to preserve custom ones)
  const existingDescriptions = new Map<string, string>();
  for (const tool of manifest.tools) {
    existingDescriptions.set(tool.name, tool.description);
  }

  // Generate tools array from schemas
  const tools: ManifestTool[] = schemas.map((schema) => {
    // Use existing custom description if available, otherwise use schema description
    const description =
      existingDescriptions.get(schema.name) || truncateDescription(schema.description);
    return {
      name: schema.name,
      description,
    };
  });

  // Update manifest
  manifest.tools = tools;

  // Write back with proper formatting
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`✓ Updated manifest.json with ${tools.length} tools`);

  // Report what changed
  const schemaNames = new Set(schemas.map((s) => s.name));
  const existingNames = new Set(existingDescriptions.keys());

  const added = [...schemaNames].filter((name) => !existingNames.has(name));
  const removed = [...existingNames].filter((name) => !schemaNames.has(name));

  if (added.length > 0) {
    console.log(`\nAdded ${added.length} tools:`);
    added.forEach((name) => console.log(`  + ${name}`));
  }

  if (removed.length > 0) {
    console.log(`\nRemoved ${removed.length} tools:`);
    removed.forEach((name) => console.log(`  - ${name}`));
  }

  if (added.length === 0 && removed.length === 0) {
    console.log('\nNo changes needed - manifest was already in sync.');
  }
}

main();
