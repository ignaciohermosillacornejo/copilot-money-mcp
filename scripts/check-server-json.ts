#!/usr/bin/env bun
/**
 * Validate server.json against the MCP registry's submission constraints.
 *
 * Catches violations locally + in CI so they fail fast, instead of surfacing
 * inside the auto-release pipeline's MCP-registry publish step where
 * `continue-on-error: true` would let a 422 go unnoticed.
 *
 * Currently checks:
 *   - description length <= 100 (the registry rejects longer values with HTTP 422)
 *
 * Add new constraints here as they are discovered.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const server = JSON.parse(readFileSync(join(__dirname, '../server.json'), 'utf-8'));

const DESCRIPTION_MAX = 100;
const issues: string[] = [];

const description: unknown = server.description;
if (typeof description !== 'string') {
  issues.push('description is missing or not a string');
} else if (description.length > DESCRIPTION_MAX) {
  issues.push(
    `description is ${description.length} chars (max ${DESCRIPTION_MAX}). The MCP registry rejects longer values with HTTP 422.`,
  );
}

if (issues.length > 0) {
  console.error('server.json failed MCP registry constraints:');
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}

const len = typeof description === 'string' ? description.length : 0;
console.log(`server.json passes MCP registry constraints (description: ${len}/${DESCRIPTION_MAX} chars)`);
