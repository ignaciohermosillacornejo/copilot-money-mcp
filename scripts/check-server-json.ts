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
 *   - every packages[].packageArguments entry is a `named` argument whose name
 *     starts with `--`, with a non-empty description and a boolean isRequired
 *     (the shape every published entry has used; a typo there would only
 *     surface as a 422 in the registry publish step)
 *
 * Add new constraints here as they are discovered.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so tests can drive the real script against a synthetic server.json.
const SERVER_JSON = process.env.CHECK_SERVER_JSON_PATH ?? join(__dirname, '../server.json');
const server = JSON.parse(readFileSync(SERVER_JSON, 'utf-8'));

const DESCRIPTION_MAX = 100;
const issues: string[] = [];

const description: unknown = server.description;
if (typeof description !== 'string') {
  issues.push('description is missing or not a string');
} else if (description.length > DESCRIPTION_MAX) {
  issues.push(
    `description is ${description.length} chars (max ${DESCRIPTION_MAX}). The MCP registry rejects longer values with HTTP 422.`
  );
}

const packages: unknown = server.packages;
if (!Array.isArray(packages)) {
  issues.push('packages is missing or not an array');
} else {
  packages.forEach((pkg: { packageArguments?: unknown }, p: number) => {
    const args = pkg.packageArguments;
    if (args === undefined) return;
    if (!Array.isArray(args)) {
      issues.push(`packages[${p}].packageArguments is not an array`);
      return;
    }
    args.forEach((arg: Record<string, unknown>, a: number) => {
      const where = `packages[${p}].packageArguments[${a}]`;
      if (arg.type !== 'named')
        issues.push(`${where}.type is ${JSON.stringify(arg.type)}, expected "named"`);
      if (typeof arg.name !== 'string' || !arg.name.startsWith('--')) {
        issues.push(`${where}.name is ${JSON.stringify(arg.name)}, expected a "--flag" string`);
      }
      if (typeof arg.description !== 'string' || arg.description.trim() === '') {
        issues.push(`${where}.description is missing or empty`);
      }
      if (typeof arg.isRequired !== 'boolean') issues.push(`${where}.isRequired is not a boolean`);
    });
  });
}

if (issues.length > 0) {
  console.error('server.json failed MCP registry constraints:');
  for (const i of issues) console.error(`  - ${i}`);
  process.exit(1);
}

// Past the early-exit above, `description` is guaranteed to be a string.
console.log(
  `server.json passes MCP registry constraints (description: ${(description as string).length}/${DESCRIPTION_MAX} chars)`
);
