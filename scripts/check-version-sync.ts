#!/usr/bin/env bun
/**
 * Assert that the version in package.json matches the version in server.json
 * (both the top-level `version` and the npm package entry's `version`),
 * manifest.json, and package-lock.json (its root `version` and the
 * `packages[""]` self-entry `version`), and that CHANGELOG.md has a
 * `## [<version>]` section for it. Also asserts the npm package entry's
 * `identifier` in server.json equals package.json#name.
 *
 * The MCP registry entry is bound to a specific published npm version, and
 * manifest.json is the version Claude Desktop reads from the .mcpb bundle —
 * drift between any of these would leave a stale pointer or bundle after a
 * release. package-lock.json carries its own self-describing version metadata
 * that a manual `version` bump can silently miss (issue #563). The release
 * workflow takes the GitHub release notes from the CHANGELOG section matching
 * the version, and v2.3.0 shipped with none (its notes were left in an empty
 * `[Unreleased]`), so a missing section fails here too. The identifier check
 * exists because npm-publish.yml waits for npm to serve package.json's
 * name@version before the registry publish, while the registry validates
 * server.json's identifier. If those names diverged, the wait would go green
 * on the wrong package and the registry would still 404. Run as part of
 * `bun run check`.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so tests can drive the real script against a synthetic repo root.
const ROOT = process.env.CHECK_VERSION_SYNC_ROOT ?? join(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const server = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8'));
const lockfile = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf-8'));
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8');

const pkgVersion: string = pkg.version;
const serverVersion: string = server.version;
const manifestVersion: string = manifest.version;
const npmPackage = (server.packages ?? []).find(
  (p: { registryType?: string }) => p.registryType === 'npm'
);
const npmPackageVersion: string | undefined = npmPackage?.version;
const pkgName: string = pkg.name;
const npmPackageIdentifier: string | undefined = npmPackage?.identifier;
const lockfileVersion: string = lockfile.version;
const lockfileSelfVersion: string | undefined = lockfile.packages?.['']?.version;

const mismatches: string[] = [];
if (serverVersion !== pkgVersion) {
  mismatches.push(
    `server.json#version (${serverVersion}) !== package.json#version (${pkgVersion})`
  );
}
if (npmPackageVersion !== pkgVersion) {
  mismatches.push(
    `server.json#packages[npm].version (${npmPackageVersion}) !== package.json#version (${pkgVersion})`
  );
}
if (npmPackageIdentifier !== pkgName) {
  mismatches.push(
    `server.json#packages[npm].identifier (${npmPackageIdentifier}) !== package.json#name (${pkgName})`
  );
}
if (manifestVersion !== pkgVersion) {
  mismatches.push(
    `manifest.json#version (${manifestVersion}) !== package.json#version (${pkgVersion})`
  );
}
if (lockfileVersion !== pkgVersion) {
  mismatches.push(
    `package-lock.json#version (${lockfileVersion}) !== package.json#version (${pkgVersion})`
  );
}
if (lockfileSelfVersion !== pkgVersion) {
  mismatches.push(
    `package-lock.json#packages[''].version (${lockfileSelfVersion}) !== package.json#version (${pkgVersion})`
  );
}

// Mirrors build-mcpb.yml's extractor: the notes are the lines after the first
// `## [` heading containing `[<version>]`, up to the next `## [` heading. A
// missing or empty section makes the release fall back to "Release v<version>".
const changelogHeading = `## [${pkgVersion}]`;
const changelogLines = changelog.split('\n');
const sectionStart = changelogLines.findIndex((line) => line.startsWith(changelogHeading));
if (sectionStart === -1) {
  mismatches.push(
    `CHANGELOG.md has no "${changelogHeading}" section (the release notes are taken from it)`
  );
} else {
  const rest = changelogLines.slice(sectionStart + 1);
  const sectionEnd = rest.findIndex((line) => line.startsWith('## ['));
  const body = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd);
  if (!body.some((line) => line.trim() !== '')) {
    mismatches.push(
      `CHANGELOG.md's "${changelogHeading}" section is empty (the release would fall back to "Release v${pkgVersion}" notes)`
    );
  }
}

if (mismatches.length > 0) {
  console.error('Version sync check failed:');
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error(
    '\nBump the version consistently across package.json, server.json (#version + ' +
      "#packages[npm].version), manifest.json, and package-lock.json (#version + #packages[''].version) " +
      "to the same value, and move CHANGELOG.md's [Unreleased] notes under a dated " +
      '## [<version>] heading, before publishing.'
  );
  process.exit(1);
}

console.log(`Versions in sync: ${pkgVersion}`);
