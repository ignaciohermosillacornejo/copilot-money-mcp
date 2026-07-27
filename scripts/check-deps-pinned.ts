#!/usr/bin/env bun
/**
 * Assert that every dependency in package.json resolves deterministically.
 *
 * A floating specifier — `latest`, `*`, `x`, or an empty string — resolves to
 * whatever the registry serves at install time. Two installs of the same commit
 * can then produce different trees, which is exactly the property the packaging
 * and release path depends on not having: `scripts/pack-mcpb.ts` and the CI
 * license job both exist to make the shipped artifact reproducible, and CI pins
 * `license-checker@25.0.1` for the same reason.
 *
 * `@anthropic-ai/mcpb` was pinned to `latest` and sits on that path (issue
 * #585), which is what motivated this check. Ranges (`^`, `~`, `>=`) are fine —
 * they are recorded in package-lock.json, so the resolution is still pinned in
 * practice and upgrades arrive as reviewable dependabot PRs. Run as part of
 * `bun run check`.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so tests can drive the real script against synthetic manifests.
const PACKAGE_JSON =
  process.env.CHECK_DEPS_PINNED_PACKAGE_JSON ?? join(__dirname, '../package.json');

const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Specifiers that let the registry pick the version at install time.
 *
 * Deliberately narrow: only the forms that carry no version information at all.
 * A range like `^2.1.2` still floats within a major, but npm records the
 * resolution in package-lock.json and dependabot proposes bumps as PRs, so the
 * install stays reproducible and the upgrade stays reviewable.
 */
function isFloating(spec: string): boolean {
  const normalized = spec.trim().toLowerCase();
  return normalized === '' || normalized === 'latest' || normalized === '*' || normalized === 'x';
}

const offenders: string[] = [];
for (const field of DEPENDENCY_FIELDS) {
  const deps: Record<string, string> = pkg[field] ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (isFloating(spec)) {
      offenders.push(`${field}.${name} = ${JSON.stringify(spec)}`);
    }
  }
}

if (offenders.length > 0) {
  console.error('Dependency pinning check failed — floating specifiers found:');
  for (const o of offenders) console.error(`  - ${o}`);
  console.error(
    '\nA floating specifier resolves to whatever the registry serves at install ' +
      'time, so the same commit can build a different tree tomorrow. Replace each ' +
      'with a range on the currently resolved version, e.g. "^2.1.2" — check with ' +
      '`npm view <name> version`, or read it out of package-lock.json.',
  );
  process.exit(1);
}

const total = DEPENDENCY_FIELDS.reduce(
  (n, field) => n + Object.keys(pkg[field] ?? {}).length,
  0,
);
console.log(`All ${total} dependency specifiers are pinned or ranged`);
