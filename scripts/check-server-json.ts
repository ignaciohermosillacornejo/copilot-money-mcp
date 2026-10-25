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
 *   - every packages[].packageArguments entry is an object with a non-empty
 *     description and a boolean isRequired; a `named` one has a `--flag` name and
 *     a `positional` one a value or valueHint (a typo there would otherwise only
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const packages: unknown = server.packages;
if (!Array.isArray(packages)) {
  issues.push('packages is missing or not an array');
} else {
  packages.forEach((pkg: unknown, p: number) => {
    if (!isObject(pkg)) {
      issues.push(`packages[${p}] is ${JSON.stringify(pkg)}, expected an object`);
      return;
    }
    const args = pkg.packageArguments;
    if (args === undefined) return;
    if (!Array.isArray(args)) {
      issues.push(`packages[${p}].packageArguments is not an array`);
      return;
    }
    args.forEach((arg: unknown, a: number) => {
      const where = `packages[${p}].packageArguments[${a}]`;
      if (!isObject(arg)) {
        issues.push(`${where} is ${JSON.stringify(arg)}, expected an object`);
        return;
      }
      if (arg.type === 'named') {
        if (typeof arg.name !== 'string' || !arg.name.startsWith('--')) {
          issues.push(`${where}.name is ${JSON.stringify(arg.name)}, expected a "--flag" string`);
        }
      } else if (arg.type === 'positional') {
        if (typeof arg.value !== 'string' && typeof arg.valueHint !== 'string') {
          issues.push(`${where} is positional but has neither a value nor a valueHint string`);
        }
      } else {
        issues.push(
          `${where}.type is ${JSON.stringify(arg.type)}, expected "named" or "positional"`
        );
      }
      if (typeof arg.description !== 'string' || arg.description.trim() === '') {
        issues.push(`${where}.description is missing or empty`);
      }
      if (typeof arg.isRequired !== 'boolean') {
        issues.push(`${where}.isRequired is not a boolean`);
      }
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
