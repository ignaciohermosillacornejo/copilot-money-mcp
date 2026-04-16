#!/usr/bin/env bun
/**
 * Verify that the optimistic in-memory cache patch (applied after each
 * successful GraphQL write) converges with the LevelDB decode once
 * Copilot's native app finishes syncing the write back to disk.
 *
 * For each write tool:
 *   1. Pick a safe target (create a disposable one where possible).
 *   2. Execute the write via CopilotMoneyTools — this applies the
 *      optimistic patch to the in-memory cache.
 *   3. Read immediately via the same tool. This is the OPTIMISTIC view —
 *      backed entirely by the patched in-memory cache.
 *   4. Force a fresh LevelDB decode: cleanupAllTempDatabases() (drops the
 *      on-disk temp copy) AND db.clearCache() (drops in-memory). Re-read.
 *      Repeat on a poll until the synced value converges with the
 *      optimistic value OR a per-entity timeout elapses.
 *   5. Compare the two values field-by-field and report match / drift.
 *   6. Restore / delete the test entity in a finally block.
 *
 * This is opt-in and runs against a real Copilot account. Not in CI.
 *
 * Usage:
 *   bun run scripts/verify-optimistic-consistency.ts
 *   bun run scripts/verify-optimistic-consistency.ts --skip budgets
 *   bun run scripts/verify-optimistic-consistency.ts --only txn
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  cleanupAllTempDatabases,
} from '../src/core/leveldb-reader.js';
import { GraphQLClient } from '../src/core/graphql/client.js';
import { FirebaseAuth } from '../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../src/core/auth/browser-token.js';
import { CopilotDatabase } from '../src/core/database.js';
import { CopilotMoneyTools } from '../src/tools/tools.js';

// --- CLI ---
const argv = process.argv.slice(2);
function argVal(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}
const PHASE_NAMES = ['tags', 'categories', 'txn', 'budgets', 'recurrings'] as const;
type PhaseName = (typeof PHASE_NAMES)[number];

const skip = new Set((argVal('--skip') ?? '').split(',').filter(Boolean));
const only = argVal('--only');

if (only && !PHASE_NAMES.includes(only as PhaseName)) {
  console.error(
    `Unknown --only phase: "${only}". Valid phases: ${PHASE_NAMES.join(', ')}`
  );
  process.exit(1);
}
for (const s of skip) {
  if (!PHASE_NAMES.includes(s as PhaseName)) {
    console.error(
      `Unknown --skip phase: "${s}". Valid phases: ${PHASE_NAMES.join(', ')}`
    );
    process.exit(1);
  }
}

function enabled(name: string): boolean {
  if (only) return name === only;
  return !skip.has(name);
}

// --- DB path ---
function findRealDatabase(): string | undefined {
  const base = join(
    homedir(),
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );
  if (!existsSync(base)) return undefined;
  const fs = join(base, 'firestore/__FIRAPP_DEFAULT');
  if (!existsSync(fs)) return undefined;
  for (const e of readdirSync(fs, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('copilot-')) {
      const m = join(fs, e.name, 'main');
      if (existsSync(m)) return m;
    }
  }
  return undefined;
}

const dbPath = findRealDatabase();
if (!dbPath) {
  console.error('Could not find Copilot Money database');
  process.exit(1);
}

// --- helpers ---

/** Force a completely fresh decode on the given database instance. */
async function freshDecode(db: CopilotDatabase): Promise<void> {
  db.clearCache();
  cleanupAllTempDatabases();
}

/** Poll a predicate against a freshly-decoded read until true or timeout. */
async function pollUntilFreshMatches<T>(
  db: CopilotDatabase,
  read: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutSec: number,
  intervalSec: number
): Promise<{ matched: boolean; elapsedSec: number; lastValue: T }> {
  const start = Date.now();
  let lastValue!: T;
  while (true) {
    await freshDecode(db);
    lastValue = await read();
    if (predicate(lastValue)) {
      return { matched: true, elapsedSec: (Date.now() - start) / 1000, lastValue };
    }
    const elapsed = (Date.now() - start) / 1000;
    if (elapsed >= timeoutSec) {
      return { matched: false, elapsedSec: elapsed, lastValue };
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

function heading(name: string): void {
  console.log();
  console.log(`=== ${name} ===`);
}

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

type Result = {
  name: string;
  optimisticValue: unknown;
  syncedValue: unknown;
  matched: boolean;
  syncSec: number | null;
  note?: string;
  error?: string;
};

const results: Result[] = [];

/**
 * Run a probe phase, swallowing unexpected errors so the summary still
 * prints for the other phases. Records the error as a Result so it's
 * visible in the final output. Returning from the inner function so
 * cleanup in its own try/finally blocks still runs.
 */
async function runPhase(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  UNEXPECTED ERROR in ${name}: ${msg}`);
    results.push({
      name,
      optimisticValue: null,
      syncedValue: null,
      matched: false,
      syncSec: null,
      error: msg,
    });
  }
}

// --- main ---
async function main(): Promise<void> {
  console.log(`=== Optimistic ↔ LevelDB consistency probe ===`);
  console.log(`DB: ${dbPath}`);
  console.log(`Started: ${nowIso()}`);
  if (skip.size > 0) console.log(`Skipping: ${[...skip].join(', ')}`);
  if (only) console.log(`Only: ${only}`);

  const auth = new FirebaseAuth(() => extractRefreshToken());
  const client = new GraphQLClient(auth);
  const db = new CopilotDatabase(dbPath);
  const tools = new CopilotMoneyTools(db, client);

  // Prime the cache so patchers have somewhere to write.
  await db.getAllTransactions();

  const marker = Date.now().toString(36);

  // 1) TAGS: create a disposable tag, verify it shows up optimistically, then after fresh decode.
  if (enabled('tags')) {
    await runPhase('tags.create', async () => {
    heading('tags — create then delete');
    const tagName = `opt-probe-${marker}`;
    let tagId: string | undefined;
    try {
      const created = await tools.createTag({ name: tagName, color_name: 'OLIVE1' });
      tagId = created.tag_id;
      console.log(`  created tag ${tagId} (name="${tagName}") — optimistic cache now has it`);

      // Optimistic read
      const tagsOpt = await db.getTags();
      const optFound = tagsOpt.find((t) => t.tag_id === tagId);
      console.log(`  optimistic read: ${optFound ? 'FOUND' : 'NOT FOUND'} name="${optFound?.name}"`);

      // Fresh-decode poll until synced tag appears OR timeout
      const synced = await pollUntilFreshMatches(
        db,
        () => db.getTags(),
        (tags) => tags.some((t) => t.tag_id === tagId),
        60,
        5
      );
      const syncedFound = synced.lastValue.find((t) => t.tag_id === tagId);
      console.log(
        `  synced read (after ${synced.elapsedSec.toFixed(1)}s fresh decode): ${synced.matched ? `FOUND name="${syncedFound?.name}"` : 'NOT FOUND (timed out)'}`
      );
      results.push({
        name: 'tags.create',
        optimisticValue: { tag_id: optFound?.tag_id, name: optFound?.name },
        syncedValue: { tag_id: syncedFound?.tag_id, name: syncedFound?.name },
        matched:
          !!optFound &&
          !!syncedFound &&
          optFound.tag_id === syncedFound.tag_id &&
          optFound.name === syncedFound.name,
        syncSec: synced.matched ? synced.elapsedSec : null,
      });
    } finally {
      if (tagId) {
        try {
          await tools.deleteTag({ tag_id: tagId });
          console.log(`  cleanup: deleted tag ${tagId} ✓`);
        } catch (e) {
          console.log(`  cleanup: deleteTag FAILED — manual cleanup for id=${tagId}: ${e}`);
        }
      }
    }
    });
  }

  // 2) CATEGORIES: create a disposable category, verify and delete.
  if (enabled('categories')) {
    await runPhase('categories.create', async () => {
    heading('categories — create then delete');
    const catName = `opt-probe-${marker}`;
    let catId: string | undefined;
    try {
      const created = await tools.createCategory({
        name: catName,
        color_name: 'OLIVE1',
        emoji: '🧪',
        is_excluded: false,
      });
      catId = created.category_id;
      console.log(`  created category ${catId} (name="${catName}")`);

      const catsOpt = await db.getUserCategories();
      const optFound = catsOpt.find((c) => c.category_id === catId);
      console.log(`  optimistic: ${optFound ? `FOUND name="${optFound.name}"` : 'NOT FOUND'}`);

      const synced = await pollUntilFreshMatches(
        db,
        () => db.getUserCategories(),
        (cats) => cats.some((c) => c.category_id === catId),
        60,
        5
      );
      const syncedFound = synced.lastValue.find((c) => c.category_id === catId);
      console.log(
        `  synced (${synced.elapsedSec.toFixed(1)}s): ${synced.matched ? `FOUND name="${syncedFound?.name}"` : 'NOT FOUND (timed out)'}`
      );
      results.push({
        name: 'categories.create',
        optimisticValue: { id: optFound?.category_id, name: optFound?.name },
        syncedValue: { id: syncedFound?.category_id, name: syncedFound?.name },
        matched:
          !!optFound &&
          !!syncedFound &&
          optFound.category_id === syncedFound.category_id &&
          optFound.name === syncedFound.name,
        syncSec: synced.matched ? synced.elapsedSec : null,
      });
    } finally {
      if (catId) {
        try {
          await tools.deleteCategory({ category_id: catId });
          console.log(`  cleanup: deleted category ${catId} ✓`);
        } catch (e) {
          console.log(`  cleanup: deleteCategory FAILED — manual cleanup for id=${catId}: ${e}`);
        }
      }
    }
    });
  }

  // 3) TRANSACTIONS: edit a note on a real transaction, then restore.
  if (enabled('txn')) {
    await runPhase('transactions.update_note', async () => {
    heading('transactions — edit note then restore');
    const all = await db.getAllTransactions();
    const target = all.find((t) => t.account_id && t.item_id && !t.is_pending);
    if (!target) {
      console.log('  (no suitable transaction found; skipping)');
    } else {
      const original = target.user_note ?? '';
      const newNote = `opt-probe-${marker}`;
      try {
        await tools.updateTransaction({
          transaction_id: target.transaction_id,
          note: newNote,
        });
        console.log(
          `  edited txn ${target.transaction_id} note="${newNote}" (original="${original}")`
        );

        const txnsOpt = await db.getAllTransactions();
        const optFound = txnsOpt.find((t) => t.transaction_id === target.transaction_id);
        console.log(`  optimistic note="${optFound?.user_note}"`);

        const synced = await pollUntilFreshMatches(
          db,
          () => db.getAllTransactions(),
          (txns) => txns.find((t) => t.transaction_id === target.transaction_id)?.user_note === newNote,
          60,
          5
        );
        const syncedFound = synced.lastValue.find(
          (t) => t.transaction_id === target.transaction_id
        );
        console.log(
          `  synced (${synced.elapsedSec.toFixed(1)}s) note="${syncedFound?.user_note}" ${synced.matched ? '✓' : '(timed out)'}`
        );
        results.push({
          name: 'transactions.update_note',
          optimisticValue: { note: optFound?.user_note },
          syncedValue: { note: syncedFound?.user_note },
          matched: optFound?.user_note === syncedFound?.user_note,
          syncSec: synced.matched ? synced.elapsedSec : null,
        });
      } finally {
        try {
          await tools.updateTransaction({
            transaction_id: target.transaction_id,
            note: original,
          });
          console.log(`  cleanup: restored note ✓`);
        } catch (e) {
          console.log(
            `  cleanup: restore FAILED — manual: set note on ${target.transaction_id} to "${original}": ${e}`
          );
        }
      }
    }
    });
  }

  // 4) BUDGETS: set amount on a LEAF category (no children), then restore.
  if (enabled('budgets')) {
    await runPhase('budgets.set_leaf', async () => {
    heading('budgets — setBudget on a leaf category, then restore');
    const cats = await db.getUserCategories();
    const userCatIds = new Set(cats.map((c) => c.category_id));
    const isLeaf = (c: { children_category_ids?: string[]; category_id: string }): boolean => {
      if (c.children_category_ids && c.children_category_ids.length > 0) return false;
      // Also check reverse: is anyone's parent == c?
      return !cats.some((other) => other.parent_category_id === c.category_id);
    };
    const leafCat = cats.find((c) => isLeaf(c) && userCatIds.has(c.category_id));
    if (!leafCat) {
      console.log('  (no leaf category found; skipping)');
    } else {
      const existingBudgets = await db.getBudgets();
      const existing = existingBudgets.find((b) => b.category_id === leafCat.category_id);
      const originalAmount = existing?.amount ?? 0;
      const testAmount = '123.45';
      const parsedTestAmount = 123.45;
      try {
        await tools.setBudget({
          category_id: leafCat.category_id,
          amount: testAmount,
        });
        console.log(
          `  set budget for "${leafCat.name}" (${leafCat.category_id}) to ${testAmount} (original=${originalAmount})`
        );

        const optBudgets = await tools.getBudgets({});
        const opt = optBudgets.budgets.find((b) => b.category_id === leafCat.category_id);
        console.log(`  optimistic amount=${opt?.amount}`);

        // Budgets sync slower — allow 5 min
        const synced = await pollUntilFreshMatches(
          db,
          async () => {
            const res = await tools.getBudgets({});
            return res.budgets.find((b) => b.category_id === leafCat.category_id);
          },
          (b) => b !== undefined && Math.abs((b.amount ?? 0) - parsedTestAmount) < 0.005,
          300,
          15
        );
        console.log(
          `  synced (${synced.elapsedSec.toFixed(1)}s) amount=${synced.lastValue?.amount} ${synced.matched ? '✓' : '(timed out)'}`
        );
        results.push({
          name: 'budgets.set_leaf',
          optimisticValue: { amount: opt?.amount },
          syncedValue: { amount: synced.lastValue?.amount },
          matched:
            opt !== undefined &&
            synced.lastValue !== undefined &&
            Math.abs((opt.amount ?? 0) - (synced.lastValue.amount ?? 0)) < 0.005,
          syncSec: synced.matched ? synced.elapsedSec : null,
          note: synced.matched
            ? undefined
            : 'Timed out — budget sync to LevelDB can exceed 5 min for some setups. Optimistic value is still correct.',
        });
      } finally {
        try {
          await tools.setBudget({
            category_id: leafCat.category_id,
            amount: originalAmount.toFixed(2),
          });
          console.log(`  cleanup: restored budget to ${originalAmount} ✓`);
        } catch (e) {
          console.log(
            `  cleanup: restore FAILED — manual: setBudget category=${leafCat.category_id} amount=${originalAmount}: ${e}`
          );
        }
      }
    }
    });
  }

  // 5) RECURRINGS: toggle state on an existing recurring and restore.
  if (enabled('recurrings')) {
    await runPhase('recurrings.set_state', async () => {
    heading('recurrings — setRecurringState then restore');
    const recurrings = await db.getRecurring();
    const target = recurrings.find((r) => r.state === 'active');
    if (!target) {
      console.log('  (no active recurring found; skipping)');
      return;
    }
    // Capture the actual current state and uppercase it for the GraphQL enum
    // restore. The decoder yields lowercase ('active'), the API expects upper.
    const originalState = (target.state ?? 'active').toUpperCase();
    try {
      await tools.setRecurringState({ recurring_id: target.recurring_id, state: 'PAUSED' });
      console.log(`  paused recurring ${target.recurring_id} "${target.name}"`);

      const optAll = await db.getRecurring();
      const opt = optAll.find((r) => r.recurring_id === target.recurring_id);
      console.log(`  optimistic state=${opt?.state}`);

      const synced = await pollUntilFreshMatches(
        db,
        () => db.getRecurring(),
        (recs) =>
          recs.find((r) => r.recurring_id === target.recurring_id)?.state === 'paused',
        60,
        5
      );
      const syncedR = synced.lastValue.find((r) => r.recurring_id === target.recurring_id);
      console.log(
        `  synced (${synced.elapsedSec.toFixed(1)}s) state=${syncedR?.state} ${synced.matched ? '✓' : '(timed out)'}`
      );
      results.push({
        name: 'recurrings.set_state',
        optimisticValue: { state: opt?.state },
        syncedValue: { state: syncedR?.state },
        matched: opt?.state === syncedR?.state,
        syncSec: synced.matched ? synced.elapsedSec : null,
      });
    } finally {
      try {
        await tools.setRecurringState({
          recurring_id: target.recurring_id,
          state: originalState,
        });
        console.log(`  cleanup: restored state ✓`);
      } catch (e) {
        console.log(
          `  cleanup: restore FAILED — manual: setRecurringState ${target.recurring_id} to ${originalState}: ${e}`
        );
      }
    }
    });
  }

  // --- summary ---
  console.log();
  console.log(`=== Summary ===`);
  console.log(
    `${'test'.padEnd(26)}${'match'.padEnd(8)}${'sync'.padEnd(12)}optimistic vs synced`
  );
  console.log('─'.repeat(90));
  for (const r of results) {
    const match = r.matched ? '✓' : '✗';
    const sync = r.syncSec === null ? 'timeout' : `${r.syncSec.toFixed(1)}s`;
    console.log(
      `${r.name.padEnd(26)}${match.padEnd(8)}${sync.padEnd(12)}${JSON.stringify(r.optimisticValue)} vs ${JSON.stringify(r.syncedValue)}`
    );
    if (r.note) console.log(`  note: ${r.note}`);
  }
  const failed = results.filter((r) => !r.matched);
  console.log();
  console.log(
    `Result: ${results.length - failed.length}/${results.length} matched. ${failed.length > 0 ? 'DRIFT DETECTED.' : 'ALL CONSISTENT.'}`
  );
  console.log(`Finished: ${nowIso()}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
