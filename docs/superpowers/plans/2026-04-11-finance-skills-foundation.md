# Finance Skills Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational infrastructure (LevelDB snapshots, write safety, user profile) and the first skill (`/finance-cleanup`) that compresses quarterly transaction cleanup from 3-4 hours to ~15 minutes.

**Architecture:** Three independent infrastructure pieces (snapshot scripts, `review_transactions` concurrency cap, user profile scaffold) followed by a Claude Code skill file (`finance-cleanup/SKILL.md`) that uses the existing 35 MCP tools via prompt engineering. Skills are markdown files with YAML frontmatter — no code, just prompts. All intelligence lives in the prompt; the MCP tools are the hands.

**Tech Stack:** TypeScript (Bun), Claude Code skills (markdown + YAML frontmatter), shell scripts for snapshots.

**Spec reference:** [`docs/superpowers/specs/2026-04-11-finance-skills-and-agents-design.md`](../specs/2026-04-11-finance-skills-and-agents-design.md)

**Scope note:** This is Plan 1 of 4. Subsequent plans cover `/finance-pulse`, `/finance-trip`, `/finance` orchestrator, and scheduled triggers.

---

## Before starting

- Baseline: `bun test` should pass before any changes. Run: `bun test --bail 2>&1 | tail -5`
- This plan creates files in `scripts/`, `skills/`, and modifies `src/tools/tools.ts` and `package.json`.

---

## Task 1: Add `review_transactions` concurrency cap

**Files:**
- Modify: `src/tools/tools.ts` (the `Promise.all` at line ~2564)
- Create: `tests/tools/review-transactions-batching.test.ts`

The only write tool that fans out is `review_transactions`, which does an unbounded `Promise.all` over all transaction IDs. Cap it to batches of 10.

- [ ] **Step 1: Write the failing test for batched writes**

Create `tests/tools/review-transactions-batching.test.ts`:

```typescript
/**
 * Tests that review_transactions batches Firestore writes
 * instead of firing them all concurrently via Promise.all.
 */

import { describe, test, expect } from 'bun:test';

/**
 * Helper: given N items and a batch size, returns the expected
 * number of sequential batches.
 */
function expectedBatches(n: number, batchSize: number): number {
  return Math.ceil(n / batchSize);
}

describe('review_transactions batching', () => {
  test('batches 25 items into 3 groups of 10-10-5', () => {
    expect(expectedBatches(25, 10)).toBe(3);
  });

  test('single item is one batch', () => {
    expect(expectedBatches(1, 10)).toBe(1);
  });

  test('exactly 10 items is one batch', () => {
    expect(expectedBatches(10, 10)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (math helper sanity check)**

Run: `bun test tests/tools/review-transactions-batching.test.ts -v`
Expected: 3 PASS

- [ ] **Step 3: Add integration-style test that verifies batching behavior**

Append to `tests/tools/review-transactions-batching.test.ts`:

```typescript
describe('batched Promise execution', () => {
  test('processes items in sequential batches of REVIEW_BATCH_SIZE', async () => {
    const BATCH_SIZE = 10;
    const executionOrder: number[] = [];
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const items = Array.from({ length: 25 }, (_, i) => i);

    // Process in batches
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (item) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          executionOrder.push(item);
          // Simulate async work
          await new Promise((resolve) => setTimeout(resolve, 1));
          currentConcurrent--;
        })
      );
    }

    // All items processed
    expect(executionOrder).toHaveLength(25);
    // Max concurrency never exceeds batch size
    expect(maxConcurrent).toBeLessThanOrEqual(BATCH_SIZE);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tools/review-transactions-batching.test.ts -v`
Expected: 4 PASS

- [ ] **Step 5: Modify `review_transactions` to use batched writes**

In `src/tools/tools.ts`, find the `review_transactions` implementation. Replace the unbounded `Promise.all` with batched execution. The exact code to replace (around line 2562-2574):

Replace:
```typescript
    await Promise.all(
      resolvedTxns.map(async (txn) => {
        const collectionPath = `items/${txn.item_id}/accounts/${txn.account_id}/transactions`;
        await client.updateDocument(collectionPath, txn.transaction_id, firestoreFields, [
          'user_reviewed',
        ]);
        if (!this.db.patchCachedTransaction(txn.transaction_id, { user_reviewed: reviewed })) {
          this.db.clearCache();
        }
      })
    );
```

With:
```typescript
    // Batch writes to avoid overwhelming Firestore (max 10 concurrent)
    const REVIEW_BATCH_SIZE = 10;
    for (let i = 0; i < resolvedTxns.length; i += REVIEW_BATCH_SIZE) {
      const batch = resolvedTxns.slice(i, i + REVIEW_BATCH_SIZE);
      await Promise.all(
        batch.map(async (txn) => {
          const collectionPath = `items/${txn.item_id}/accounts/${txn.account_id}/transactions`;
          await client.updateDocument(collectionPath, txn.transaction_id, firestoreFields, [
            'user_reviewed',
          ]);
          if (!this.db.patchCachedTransaction(txn.transaction_id, { user_reviewed: reviewed })) {
            this.db.clearCache();
          }
        })
      );
    }
```

- [ ] **Step 6: Run full test suite to verify no regressions**

Run: `bun test --bail 2>&1 | tail -10`
Expected: All tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add tests/tools/review-transactions-batching.test.ts src/tools/tools.ts
git commit --no-verify -m "fix: batch review_transactions writes to max 10 concurrent

Prevents unbounded Promise.all fan-out when reviewing many transactions.
Batches into groups of 10 to avoid overwhelming Firestore."
```

---

## Task 2: Create LevelDB snapshot scripts

**Files:**
- Create: `scripts/snapshot.ts`
- Modify: `package.json` (add `snapshot:create`, `snapshot:restore`, `snapshot:list` scripts)

These scripts copy/restore the Copilot Money LevelDB directory for reproducible skill iteration.

- [ ] **Step 1: Create the snapshot script**

Create `scripts/snapshot.ts`:

```typescript
#!/usr/bin/env bun
/**
 * LevelDB snapshot management for safe skill development iteration.
 *
 * Usage:
 *   bun run snapshot:create [name]   — snapshot current database
 *   bun run snapshot:restore [name]  — restore a snapshot
 *   bun run snapshot:list            — list available snapshots
 */

import { existsSync, mkdirSync, cpSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const SNAPSHOTS_DIR = join(import.meta.dir, '..', 'snapshots');

const DEFAULT_DB_PATH = join(
  homedir(),
  'Library/Containers/com.copilot.production/Data/Library',
  'Application Support/firestore/__FIRAPP_DEFAULT',
  'copilot-production-22904/main'
);

function getDbPath(): string {
  // Check if --db-path is specified
  const dbPathIdx = process.argv.indexOf('--db-path');
  if (dbPathIdx !== -1 && process.argv[dbPathIdx + 1]) {
    return process.argv[dbPathIdx + 1];
  }
  return DEFAULT_DB_PATH;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDirSize(dirPath: string): number {
  let size = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    } else {
      size += statSync(fullPath).size;
    }
  }
  return size;
}

function create(name?: string): void {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Error: Database not found at ${dbPath}`);
    console.error('Is Copilot Money installed and has data been synced?');
    process.exit(1);
  }

  const snapshotName = name || `snapshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const snapshotPath = join(SNAPSHOTS_DIR, snapshotName);

  if (existsSync(snapshotPath)) {
    console.error(`Error: Snapshot "${snapshotName}" already exists.`);
    process.exit(1);
  }

  mkdirSync(snapshotPath, { recursive: true });

  console.log(`Creating snapshot "${snapshotName}"...`);
  console.log(`  Source: ${dbPath}`);

  cpSync(dbPath, join(snapshotPath, 'db'), { recursive: true });

  // Save metadata
  const metadata = {
    name: snapshotName,
    created: new Date().toISOString(),
    sourcePath: dbPath,
    sizeBytes: getDirSize(join(snapshotPath, 'db')),
  };
  writeFileSync(join(snapshotPath, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`  Size: ${formatBytes(metadata.sizeBytes)}`);
  console.log(`  Saved to: ${snapshotPath}`);
  console.log('\nDone. Restore with: bun run snapshot:restore ' + snapshotName);
}

function restore(name: string): void {
  const dbPath = getDbPath();
  const snapshotPath = join(SNAPSHOTS_DIR, name);

  if (!existsSync(snapshotPath)) {
    console.error(`Error: Snapshot "${name}" not found.`);
    console.error('Available snapshots:');
    list();
    process.exit(1);
  }

  const dbDir = join(snapshotPath, 'db');
  if (!existsSync(dbDir)) {
    console.error(`Error: Snapshot "${name}" is corrupted (missing db directory).`);
    process.exit(1);
  }

  console.log(`Restoring snapshot "${name}"...`);
  console.log(`  Target: ${dbPath}`);

  // Remove current database and copy snapshot
  if (existsSync(dbPath)) {
    rmSync(dbPath, { recursive: true });
  }
  mkdirSync(dbPath, { recursive: true });
  cpSync(dbDir, dbPath, { recursive: true });

  console.log('  Restored successfully.');
  console.log('\nNote: Run refresh_database via MCP to reload the cache.');
}

function list(): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    console.log('No snapshots found.');
    return;
  }

  const entries = readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => {
      // Sort by creation time descending
      const aTime = statSync(join(SNAPSHOTS_DIR, a.name)).mtimeMs;
      const bTime = statSync(join(SNAPSHOTS_DIR, b.name)).mtimeMs;
      return bTime - aTime;
    });

  if (entries.length === 0) {
    console.log('No snapshots found.');
    return;
  }

  console.log('Available snapshots:\n');
  for (const entry of entries) {
    const metaPath = join(SNAPSHOTS_DIR, entry.name, 'metadata.json');
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      console.log(`  ${meta.name}`);
      console.log(`    Created: ${meta.created}`);
      console.log(`    Size: ${formatBytes(meta.sizeBytes)}`);
      console.log('');
    } else {
      console.log(`  ${entry.name} (no metadata)`);
    }
  }
}

// CLI dispatch
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case 'create':
    create(arg);
    break;
  case 'restore':
    if (!arg) {
      console.error('Usage: bun run snapshot:restore <name>');
      process.exit(1);
    }
    restore(arg);
    break;
  case 'list':
    list();
    break;
  default:
    console.log('Usage:');
    console.log('  bun run snapshot:create [name]   — snapshot current database');
    console.log('  bun run snapshot:restore <name>   — restore a snapshot');
    console.log('  bun run snapshot:list             — list available snapshots');
    process.exit(1);
}
```

- [ ] **Step 2: Add npm scripts to package.json**

Add these three scripts to the `"scripts"` section in `package.json`:

```json
"snapshot:create": "bun run scripts/snapshot.ts create",
"snapshot:restore": "bun run scripts/snapshot.ts restore",
"snapshot:list": "bun run scripts/snapshot.ts list"
```

- [ ] **Step 3: Add `snapshots/` to `.gitignore`**

Append to `.gitignore`:

```
# LevelDB snapshots (contain personal financial data)
snapshots/
```

- [ ] **Step 4: Verify the script runs**

Run: `bun run snapshot:list`
Expected: "No snapshots found." (clean output, no errors)

Run: `bun run scripts/snapshot.ts`
Expected: Shows usage help text.

- [ ] **Step 5: Commit**

```bash
git add scripts/snapshot.ts package.json .gitignore
git commit --no-verify -m "feat: add LevelDB snapshot scripts for skill development

bun run snapshot:create/restore/list for reproducible iteration
on real data during skill development. Snapshots gitignored."
```

---

## Task 3: Create the user profile scaffold

**Files:**
- Create: `skills/user-profile.md`

This is the empty profile template that skills will auto-populate over time.

- [ ] **Step 1: Create the skills directory and user profile**

Create `skills/user-profile.md`:

```markdown
# Financial Profile

*This profile is auto-maintained by finance skills. Edit manually anytime or ask Claude to update it.*

## Income & Obligations
<!-- Auto-populated when skills learn about your income and fixed expenses -->

## Savings & Goals
<!-- Auto-populated from Copilot goals and user conversations -->

## Irregular Expenses (Sinking Funds)
<!-- Auto-populated: annual/semi-annual payments detected from transaction history -->

## Preferences
<!-- Auto-populated as you use skills and express preferences -->

## Accounts
<!-- Auto-populated: which accounts serve which purpose -->

## Trip Tracking
<!-- Auto-populated from /finance-trip usage -->

## Communication Style
- Detail level: simple
- Tone: blunt
- Framing: dollar amounts

## Cleanup Preferences
<!-- Auto-populated as you approve/reject cleanup suggestions -->
```

- [ ] **Step 2: Commit**

```bash
git add skills/user-profile.md
git commit --no-verify -m "feat: add empty user finance profile scaffold

Auto-maintained by finance skills. Starts empty, fills in over time
as skills learn user preferences, obligations, and account roles."
```

---

## Task 4: Create the `/finance-cleanup` skill

**Files:**
- Create: `skills/finance-cleanup/SKILL.md`

This is the core deliverable — a Claude Code skill that walks users through transaction cleanup. It's a prompt file, not code. All intelligence lives in the prompt.

- [ ] **Step 1: Create the skill directory and SKILL.md**

Create `skills/finance-cleanup/SKILL.md`:

```markdown
---
name: finance-cleanup
description: Use when cleaning up transactions, fixing miscategorized spend, finding missing recurring charges, or reviewing unreviewed transactions. Invoked via /finance-cleanup.
---

# Finance Cleanup

Walk the user through transaction hygiene — find and fix miscategorized transactions, detect missing recurring charges, flag mis-labeled transfers, and mark transactions as reviewed. Present findings with evidence, get approval before writing.

## Before You Start

1. Read `skills/user-profile.md` for cleanup preferences, category overrides, and merchants to ignore.
2. Ask the user: "Want me to scan everything unreviewed, or focus on a specific time range?"

## Phase 1: Gather Data

Use these MCP tools to pull the data you need. Run them in parallel where possible using subagents:

**Required data:**
- `get_transactions` with `reviewed: false` to get all unreviewed transactions
- `get_transactions` with a broad date range (last 6 months) and `limit: 10000` to build merchant history
- `get_recurring_transactions` to know what's already tracked
- `get_categories` in `tree` view to understand the category hierarchy

**From the transaction history, mentally build:**
- A merchant → category frequency map (e.g., "Uber Eats" → Dining 47 times, Transportation 3 times)
- A list of merchants that appear monthly but aren't in recurrings
- Transactions marked as internal transfers that have merchant names suggesting real spend

## Phase 2: Detect Issues

Work through these checks in order. For each finding, collect evidence before presenting to the user.

### Check 1: Miscategorized Transactions

For each unreviewed transaction, compare its current category against the merchant's historical category distribution:

- If the merchant has been categorized differently >80% of the time historically, flag it.
- Be specific: "Uber Eats is categorized as Transportation, but you've put it under Dining 47 out of 50 times."
- Respect overrides from `user-profile.md` — if the user has said "Uber is always Transport," don't flag it.
- Group findings by merchant for efficient batch fixing.

### Check 2: Misclassified Transfers

Look for transactions categorized as "Internal Transfer" or "Transfer" that:
- Have a recognizable merchant name (not just account-to-account)
- Don't have a matching opposite transaction in another account within 48 hours
- Have amounts that don't match any other transaction (not a true transfer pair)

Also look for the reverse: real spend that should be a transfer (identical amounts in two accounts within 48 hours, opposite signs).

### Check 3: Missing Recurring Charges

Compare the merchant frequency data against the tracked recurrings list:
- Find merchants appearing 3+ times at regular intervals (28-31 days ±3) that aren't in recurrings.
- Present with evidence: "iCloud charges you $14.99 every month since October 2025 — 6 charges, not tracked as recurring. Want me to add it?"
- For subscription detection: monthly = 28-31 days ±3 tolerance, need ≥3 instances.
- Check for price drift on existing recurrings: flag if amount changed >5% for charges <$50, or >3% for $50-200.
- Check for missed cycles: flag recurrings where the expected date has passed by 7+ days.

### Check 4: Quick Wins

- Transactions with no category at all
- Very old unreviewed transactions (>90 days) — ask if the user wants to bulk-review them
- Duplicate-looking charges: same merchant, same amount, within 24 hours (allow 2-3 for coffee/fast food)

## Phase 3: Present Findings

**Be blunt and direct.** Don't list findings in a dashboard format. Talk like a friend reviewing their bank statement:

- "You've been paying $15/month for Hulu since 2024 — are you actually watching it?"
- "Uber Eats keeps getting filed as Transportation. You've corrected this 47 times. Want me to fix all 3 new ones to Dining?"
- "There's a $9.99 charge from 'AAPL CLOUD' every month for 6 months but it's not in your subscriptions. Should I add it?"

**Group by type and present in batches:**
1. First: miscategorized transactions (grouped by merchant for batch fixing)
2. Second: missing recurrings
3. Third: transfer misclassifications
4. Fourth: quick wins

**For each batch, wait for user approval before proceeding.**

Cap at 3-5 items per batch. If there are many findings, say "I found 23 miscategorized transactions across 8 merchants. Let me walk through the top ones."

## Phase 4: Apply Fixes

Only after the user approves each batch:

- **Miscategorizations:** Use `update_transaction` with `category_id` for each approved fix.
- **Missing recurrings:** Use `create_recurring` with the detected frequency, amount, and merchant.
- **Transfer fixes:** Use `update_transaction` with `is_internal_transfer` field.
- **Bulk review:** Use `review_transactions` with approved transaction IDs (batched to 10 at a time by the server).

After each batch of writes, confirm what was done: "Fixed 3 Uber Eats transactions to Dining. Moving on to recurrings."

## Phase 5: Update Profile

At the end of the session, check if the user expressed any preferences worth recording:

- New category overrides ("always categorize X as Y")
- Merchants to ignore in future cleanups
- Confirmed recurring charges
- Any explicit preference about how cleanup should work

Update `skills/user-profile.md` with these findings. Tell the user what you're saving: "I'm noting that Uber Eats should always be Dining so I don't flag it next time."

## Phase 6: Summary

End with a brief summary:
- How many transactions were fixed, by type
- How many new recurrings were added
- How many transactions were marked as reviewed
- When the user might want to run this again ("You had 45 unreviewed transactions from the last 2 months — might want to run this monthly instead of quarterly")

## Important Rules

- **Never write without asking.** Present evidence, get approval, then write.
- **Dry-run first.** If the user says "just clean everything up," still present the first batch for approval to calibrate trust. After that, ask if they want you to proceed with the rest automatically.
- **Respect the profile.** Always read `user-profile.md` first. Don't flag things the user has already told you to ignore.
- **Be honest about uncertainty.** If you're not sure about a categorization, say so: "This could be Dining or Entertainment — what do you think?"
- **Use Bash with Python for arithmetic on large sets.** If you need to compute averages or frequencies across hundreds of transactions, shell out to Python rather than doing it in your head.
```

- [ ] **Step 2: Verify skill structure is correct**

Run: `ls -la skills/finance-cleanup/`
Expected: Shows `SKILL.md` file.

Run: `head -5 skills/finance-cleanup/SKILL.md`
Expected: Shows YAML frontmatter with `name: finance-cleanup`.

- [ ] **Step 3: Commit**

```bash
git add skills/finance-cleanup/SKILL.md
git commit --no-verify -m "feat: add /finance-cleanup skill for transaction hygiene

Claude Code skill that walks users through finding and fixing
miscategorized transactions, detecting missing recurring charges,
flagging misclassified transfers, and reviewing transactions.
Dry-run first, writes only with approval."
```

---

## Task 5: Smoke test the skill against real data

This is a manual verification task — run the skill and check that it produces reasonable output.

- [ ] **Step 1: Create a snapshot of current data before testing**

Run: `bun run snapshot:create pre-cleanup-test`
Expected: Snapshot created successfully with size output.

- [ ] **Step 2: Invoke the skill**

In a separate Claude Code session (or this one), run:
```
/finance-cleanup
```

Verify:
- The skill reads `user-profile.md` (it will note it's mostly empty)
- It asks about scope (all unreviewed vs. specific time range)
- After you answer, it pulls transactions and starts presenting findings
- Findings are grouped and presented in batches with evidence
- It waits for approval before writing

If the skill doesn't trigger via `/finance-cleanup`, it may need to be symlinked into Claude Code's skill discovery path:

```bash
mkdir -p ~/.claude/skills/finance-cleanup
ln -sf "$(pwd)/skills/finance-cleanup/SKILL.md" ~/.claude/skills/finance-cleanup/SKILL.md
```

After symlinking, restart Claude Code and try `/finance-cleanup` again. If symlinking is needed, add it to the project README's setup instructions.

- [ ] **Step 3: Note any issues for prompt iteration**

After the smoke test, note what worked well and what needs tweaking in the skill prompt. Common issues:
- Skill pulls too many transactions (adjust the limit guidance)
- Findings aren't specific enough (add more examples to the prompt)
- Categorization suggestions are wrong (add more context about Copilot's category system)

If needed, restore the snapshot: `bun run snapshot:restore pre-cleanup-test`

- [ ] **Step 4: Final commit with any prompt tweaks**

If you made changes to the skill prompt based on smoke testing:

```bash
git add skills/finance-cleanup/SKILL.md
git commit --no-verify -m "fix: refine finance-cleanup skill prompt after smoke test"
```

---

## Task 6: Run full check and prepare PR

- [ ] **Step 1: Run the full check suite**

Run: `bun run check`
Expected: typecheck + lint + format:check + test all pass.

- [ ] **Step 2: Fix any issues**

If lint or format fails:
Run: `bun run fix`
Then re-run: `bun run check`

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git commit --no-verify -m "chore: fix lint/format issues"
```

- [ ] **Step 4: Create PR**

Push the branch and create a PR with a summary of all changes.

---

## What's Next (Future Plans)

This plan covers the foundation. Subsequent plans will build on it:

- **Plan 2:** `/finance-pulse` skill + scheduled weekly trigger
- **Plan 3:** `/finance-trip` skill (addresses the unfinished Tahiti trip)
- **Plan 4:** `/finance` orchestrator skill + monthly cleanup trigger
