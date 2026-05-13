#!/usr/bin/env bun
/**
 * Assert that the version in package.json matches the version in server.json
 * (both the top-level `version` and the npm package entry's `version`) and in
 * manifest.json.
 *
 * The MCP registry entry is bound to a specific published npm version, and
 * manifest.json is the version Claude Desktop reads from the .mcpb bundle —
 * drift between any of these would leave a stale pointer or bundle after a
 * release. Run as part of `bun run check`.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
const server = JSON.parse(readFileSync(join(__dirname, '../server.json'), 'utf-8'));
const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf-8'));

const pkgVersion: string = pkg.version;
const serverVersion: string = server.version;
const manifestVersion: string = manifest.version;
const npmPackage = (server.packages ?? []).find(
  (p: { registryType?: string }) => p.registryType === 'npm',
);
const npmPackageVersion: string | undefined = npmPackage?.version;

const mismatches: string[] = [];
if (serverVersion !== pkgVersion) {
  mismatches.push(`server.json#version (${serverVersion}) !== package.json#version (${pkgVersion})`);
}
if (npmPackageVersion !== pkgVersion) {
  mismatches.push(
    `server.json#packages[npm].version (${npmPackageVersion}) !== package.json#version (${pkgVersion})`,
  );
}
if (manifestVersion !== pkgVersion) {
  mismatches.push(
    `manifest.json#version (${manifestVersion}) !== package.json#version (${pkgVersion})`,
  );
}

if (mismatches.length > 0) {
  console.error('Version sync check failed:');
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error(
    '\nBump all four version fields (package.json, server.json#version, server.json#packages[npm].version, manifest.json) to the same value before publishing.',
  );
  process.exit(1);
}

console.log(`Versions in sync: ${pkgVersion}`);
