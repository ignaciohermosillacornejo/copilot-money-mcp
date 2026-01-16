#!/usr/bin/env bun
/**
 * Profile database loading performance.
 *
 * Usage: RUN_REAL_DB_TESTS=1 bun run scripts/profile-database.ts
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CopilotDatabase } from '../src/core/database.js';

function findRealDatabase(): string | undefined {
  const home = homedir();
  const containerBase = join(
    home,
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );

  if (!existsSync(containerBase)) return undefined;

  const firestorePath = join(containerBase, 'firestore/__FIRAPP_DEFAULT');
  if (!existsSync(firestorePath)) return undefined;

  const entries = readdirSync(firestorePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('copilot-')) {
      const mainPath = join(firestorePath, entry.name, 'main');
      if (existsSync(mainPath)) {
        return mainPath;
      }
    }
  }

  return undefined;
}

function getDatabaseSize(dbPath: string): number {
  let totalSize = 0;
  const files = readdirSync(dbPath);
  for (const file of files) {
    const filePath = join(dbPath, file);
    const stat = statSync(filePath);
    if (stat.isFile()) {
      totalSize += stat.size;
    }
  }
  return totalSize;
}

async function profile() {
  if (process.env.RUN_REAL_DB_TESTS !== '1') {
    console.log('Set RUN_REAL_DB_TESTS=1 to run this script');
    process.exit(1);
  }

  const dbPath = findRealDatabase();
  if (!dbPath) {
    console.log('No real database found');
    process.exit(1);
  }

  const dbSize = getDatabaseSize(dbPath);
  console.log(`\n📂 Database: ${dbPath}`);
  console.log(`📊 Size: ${(dbSize / 1024 / 1024).toFixed(2)} MB\n`);

  const timings: Record<string, number> = {};

  // Initialize database
  console.log('⏳ Initializing database...');
  let start = performance.now();
  const db = new CopilotDatabase(dbPath);
  timings['init'] = performance.now() - start;
  console.log(`   Init: ${timings['init'].toFixed(0)}ms`);

  // Load each entity type and time it
  const entityLoaders = [
    { name: 'transactions', loader: () => db.getAllTransactions() },
    { name: 'accounts', loader: () => db.getAccounts() },
    { name: 'recurring', loader: () => db.getRecurring() },
    { name: 'budgets', loader: () => db.getBudgets() },
    { name: 'goals', loader: () => db.getGoals() },
    { name: 'goalHistory', loader: () => db.getGoalHistory() },
    { name: 'investmentPrices', loader: () => db.getInvestmentPrices() },
    { name: 'investmentSplits', loader: () => db.getInvestmentSplits() },
    { name: 'items', loader: () => db.getItems() },
    { name: 'userCategories', loader: () => db.getUserCategories() },
    { name: 'userAccounts', loader: () => db.getUserAccounts() },
  ];

  console.log('\n⏳ Loading entities...');
  const counts: Record<string, number> = {};

  for (const { name, loader } of entityLoaders) {
    start = performance.now();
    const result = await loader();
    timings[name] = performance.now() - start;
    counts[name] = Array.isArray(result) ? result.length : 0;
    console.log(
      `   ${name}: ${timings[name].toFixed(0)}ms (${counts[name].toLocaleString()} items)`
    );
  }

  // Summary
  const totalTime = Object.values(timings).reduce((a, b) => a + b, 0);
  const totalItems = Object.values(counts).reduce((a, b) => a + b, 0);

  console.log('\n📈 Summary:');
  console.log(`   Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`   Total items: ${totalItems.toLocaleString()}`);
  console.log(`   Throughput: ${((dbSize / 1024 / 1024) / (totalTime / 1000)).toFixed(2)} MB/s`);

  // Find slowest operations
  const sorted = Object.entries(timings).sort(([, a], [, b]) => b - a);
  console.log('\n🐌 Slowest operations:');
  for (const [name, time] of sorted.slice(0, 5)) {
    const pct = ((time / totalTime) * 100).toFixed(1);
    console.log(`   ${name}: ${time.toFixed(0)}ms (${pct}%)`);
  }
}

profile().catch(console.error);
