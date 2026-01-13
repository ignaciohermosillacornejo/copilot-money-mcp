#!/usr/bin/env bun
/**
 * Sync manifest.json tools with actual tool definitions.
 *
 * Usage: bun run sync-manifest
 *
 * This script reads the tool schemas from createToolSchemas() and updates
 * the manifest.json tools array to match, preserving custom descriptions
 * where they exist but adding any missing tools.
 */

import { createToolSchemas } from '../src/tools/tools.js';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, '../manifest.json');

interface ManifestTool {
  name: string;
  description: string;
}

interface Manifest {
  tools: ManifestTool[];
  [key: string]: unknown;
}

function truncateDescription(description: string, maxLength: number = 150): string {
  // Get the first sentence or truncate at maxLength
  const firstSentence = description.split('. ')[0];
  if (firstSentence.length <= maxLength) {
    return firstSentence.endsWith('.') ? firstSentence : firstSentence + '.';
  }
  return description.slice(0, maxLength - 3) + '...';
}

function main() {
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
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
