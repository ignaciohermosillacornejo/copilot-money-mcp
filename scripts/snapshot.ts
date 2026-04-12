#!/usr/bin/env bun
/**
 * LevelDB snapshot manager for skill development iteration.
 *
 * Usage:
 *   bun run snapshot:create [name]   Copy DB to snapshots/{name}/db/
 *   bun run snapshot:restore <name>  Copy snapshot back to DB path
 *   bun run snapshot:list            Show available snapshots
 *
 * The --db-path flag overrides the default database location.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, '../snapshots');

const DEFAULT_DB_PATH = join(
  process.env.HOME ?? '/tmp',
  'Library/Containers/com.copilot.production/Data/Library/Application Support',
  'firestore/__FIRAPP_DEFAULT/copilot-production-22904/main',
);

interface SnapshotMetadata {
  name: string;
  created: string;
  sourcePath: string;
  sizeBytes: number;
}

// --- helpers ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getDirSize(dirPath: string): number {
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else {
      total += statSync(full).size;
    }
  }
  return total;
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function parseArgs(): { command: string | undefined; name: string | undefined; dbPath: string } {
  const args = process.argv.slice(2);
  let command: string | undefined;
  let name: string | undefined;
  let dbPath = DEFAULT_DB_PATH;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--db-path' && args[i + 1]) {
      dbPath = args[++i];
    } else if (!command) {
      command = arg;
    } else if (!name) {
      name = arg;
    }
  }

  return { command, name, dbPath };
}

function listSnapshots(): SnapshotMetadata[] {
  if (!existsSync(SNAPSHOTS_DIR)) return [];

  const entries = readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const metaPath = join(SNAPSHOTS_DIR, e.name, 'metadata.json');
      if (!existsSync(metaPath)) return null;
      try {
        return JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapshotMetadata;
      } catch {
        return null;
      }
    })
    .filter((m): m is SnapshotMetadata => m !== null);

  return entries.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
}

// --- commands ---

function commandCreate(rawName: string | undefined, dbPath: string): void {
  if (!existsSync(dbPath)) {
    console.error(`Error: database not found at ${dbPath}`);
    process.exit(1);
  }

  const name = rawName ?? new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotDir = join(SNAPSHOTS_DIR, name);

  if (existsSync(snapshotDir)) {
    console.error(`Error: snapshot "${name}" already exists`);
    process.exit(1);
  }

  const dbDest = join(snapshotDir, 'db');
  console.log(`Creating snapshot "${name}"...`);
  copyDir(dbPath, dbDest);

  const sizeBytes = getDirSize(dbDest);
  const metadata: SnapshotMetadata = {
    name,
    created: new Date().toISOString(),
    sourcePath: dbPath,
    sizeBytes,
  };
  writeFileSync(join(snapshotDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  console.log(`Snapshot created: snapshots/${name}/`);
  console.log(`  Size: ${formatBytes(sizeBytes)}`);
  console.log(`  Source: ${dbPath}`);
}

function commandRestore(name: string | undefined, dbPath: string): void {
  if (!name) {
    console.error('Error: snapshot name is required for restore');
    console.error('Usage: bun run snapshot:restore <name>');
    process.exit(1);
  }

  const snapshotDir = join(SNAPSHOTS_DIR, name);
  const dbSrc = join(snapshotDir, 'db');

  if (!existsSync(dbSrc)) {
    console.error(`Error: snapshot "${name}" not found`);
    process.exit(1);
  }

  if (existsSync(dbPath)) {
    console.log(`Removing existing database at ${dbPath}...`);
    rmSync(dbPath, { recursive: true, force: true });
  }

  console.log(`Restoring snapshot "${name}" to ${dbPath}...`);
  copyDir(dbSrc, dbPath);

  const sizeBytes = getDirSize(dbPath);
  console.log(`Snapshot restored successfully.`);
  console.log(`  Size: ${formatBytes(sizeBytes)}`);
  console.log(`\nTip: run the refresh_database tool via MCP to reload the in-memory cache.`);
}

function commandList(): void {
  const snapshots = listSnapshots();

  if (snapshots.length === 0) {
    console.log('No snapshots found.');
    return;
  }

  console.log(`Found ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}:\n`);

  for (const snap of snapshots) {
    const date = new Date(snap.created).toLocaleString();
    console.log(`  ${snap.name}`);
    console.log(`    Created: ${date}`);
    console.log(`    Size:    ${formatBytes(snap.sizeBytes)}`);
    console.log(`    Source:  ${snap.sourcePath}`);
    console.log();
  }
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  bun run snapshot:create [name] [--db-path <path>]');
  console.log('  bun run snapshot:restore <name> [--db-path <path>]');
  console.log('  bun run snapshot:list');
  console.log();
  console.log('Commands:');
  console.log('  create   Copy the LevelDB database to snapshots/<name>/db/');
  console.log('  restore  Copy a snapshot back to the database path');
  console.log('  list     Show available snapshots sorted by date');
  console.log();
  console.log(`Default DB path: ${DEFAULT_DB_PATH}`);
}

// --- dispatch ---

const { command, name, dbPath } = parseArgs();

switch (command) {
  case 'create':
    commandCreate(name, dbPath);
    break;
  case 'restore':
    commandRestore(name, dbPath);
    break;
  case 'list':
    commandList();
    break;
  default:
    printUsage();
    break;
}
