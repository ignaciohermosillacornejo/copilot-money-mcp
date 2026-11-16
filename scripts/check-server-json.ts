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
 *   - the named arguments describe the CLI's own flags (`CLI_FLAGS` in
 *     src/cli-args.ts), both ways: every published flag is listed and every
 *     listed one is published; an on/off flag says `format: "boolean"`, a
 *     value-taking one carries the flag's `format` (`filepath` for a path) and
 *     its exact `choices` (`--browser`: `validBrowserNames()`). A client that
 *     follows server.json renders the command line from these fields, so a flag
 *     described as the wrong kind is passed in a form the CLI does not read.
 *
 * Add new constraints here as they are discovered.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CLI_FLAGS } from '../src/cli-args.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so tests can drive the real script against a synthetic server.json.
const SERVER_JSON = process.env.CHECK_SERVER_JSON_PATH ?? join(__dirname, '../server.json');
const parsed: unknown = JSON.parse(readFileSync(SERVER_JSON, 'utf-8'));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

if (!isObject(parsed)) {
  console.error(`server.json is ${JSON.stringify(parsed)}, expected an object`);
  process.exit(1);
}
const server = parsed;

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

/** Compare one named server.json argument with the CLI flag of that name. */
function checkAgainstCli(where: string, arg: Record<string, unknown>, name: string): void {
  const flag = CLI_FLAGS.find((f) => f.name === name);
  if (!flag) {
    issues.push(`${where}.name ${name} is not a flag the CLI parses (CLI_FLAGS, src/cli-args.ts)`);
    return;
  }
  if (!flag.published) {
    issues.push(`${where}.name ${name} is listed but CLI_FLAGS marks it unpublished`);
  }
  const expectedFormat = !flag.takesValue ? 'boolean' : 'format' in flag ? flag.format : 'string';
  const format = arg.format ?? 'string';
  if (format !== expectedFormat) {
    issues.push(
      `${where} (${name}).format is ${JSON.stringify(arg.format)}, expected "${expectedFormat}"` +
        (flag.takesValue ? '' : ' (an on/off flag; the CLI reads it bare or as =true / =false)')
    );
  }
  const expectedChoices = 'choices' in flag ? flag.choices() : undefined;
  if (JSON.stringify(arg.choices) !== JSON.stringify(expectedChoices)) {
    issues.push(
      `${where} (${name}).choices is ${JSON.stringify(arg.choices)}, expected ` +
        `${JSON.stringify(expectedChoices)} (from CLI_FLAGS, src/cli-args.ts)`
    );
  }
}

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
    const listed = new Set<string>();
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
      if (arg.type === 'named' && typeof arg.name === 'string') {
        checkAgainstCli(where, arg, arg.name);
        listed.add(arg.name);
      }
    });
    for (const flag of CLI_FLAGS) {
      if (flag.published && !listed.has(flag.name)) {
        issues.push(
          `packages[${p}].packageArguments has no ${flag.name}, which CLI_FLAGS marks published`
        );
      }
    }
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
