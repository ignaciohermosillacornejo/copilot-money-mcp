#!/usr/bin/env bun
/**
 * Pack the project into a self-contained .mcpb bundle.
 *
 * Usage: bun run scripts/pack-mcpb.ts
 *
 * The output bundle embeds production `node_modules/` so that native
 * dependencies (classic-level ships prebuilds for every supported platform)
 * resolve when Claude Desktop extracts and runs the bundle with its built-in
 * Node runtime. Dev dependencies are left out by installing with `npm --omit=dev`
 * in an isolated staging directory; the dev workspace is untouched.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const stagingDir = join(repoRoot, '.mcpb-staging');
const outputPath = join(repoRoot, 'copilot-money-mcp.mcpb');

const STAGED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'dist',
  'docs/EXAMPLE_QUERIES.md',
  'icon.png',
  'manifest.json',
  'package.json',
  'skills',
];

function run(cmd: string, cwd: string): void {
  execSync(cmd, { stdio: 'inherit', cwd });
}

function copyInto(src: string, dest: string): void {
  const srcPath = join(repoRoot, src);
  if (!existsSync(srcPath)) {
    throw new Error(`Expected source path missing: ${src}`);
  }
  const destPath = join(dest, src);
  mkdirSync(dirname(destPath), { recursive: true });
  cpSync(srcPath, destPath, { recursive: true });
}

if (existsSync(outputPath)) rmSync(outputPath);
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });

run('bun run build', repoRoot);

mkdirSync(stagingDir, { recursive: true });
try {
  for (const path of STAGED_FILES) copyInto(path, stagingDir);

  // Install production deps into the staging dir. --ignore-scripts skips lifecycle
  // hooks (husky, etc.) that we don't need; classic-level's native build is not
  // required because node-gyp-build picks an appropriate prebuilt binary at load
  // time from node_modules/classic-level/prebuilds/.
  run('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stagingDir);

  run(`bunx @anthropic-ai/mcpb pack . ${JSON.stringify(outputPath)}`, stagingDir);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}

if (!existsSync(outputPath)) {
  console.error(`Expected bundle at ${outputPath} but it was not created`);
  process.exit(1);
}
console.log(`\nBundle: ${outputPath}`);
