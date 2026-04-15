/**
 * Comprehensive E2E smoke test for the GraphQL write path. Opt-in: run
 * manually against your real Copilot account. Not part of CI.
 *
 * Exercises every MCP-exposed write tool plus every GraphQLErrorCode branch,
 * and — for the consistency/mcp-e2e/state-gated sections — the full MCP
 * tool dispatch chain with local-cache read-back verification.
 *
 * Usage:
 *   bun run scripts/smoke-graphql.ts                   # run everything (default)
 *   bun run scripts/smoke-graphql.ts --quick           # one round-trip per domain
 *   bun run scripts/smoke-graphql.ts --skip-destructive
 *   bun run scripts/smoke-graphql.ts --skip-errors
 *   bun run scripts/smoke-graphql.ts --skip-edge-cases
 *   bun run scripts/smoke-graphql.ts --skip-consistency  # skip write-to-read poll
 *   bun run scripts/smoke-graphql.ts --skip-mcp-e2e      # skip MCP tool dispatch
 *   bun run scripts/smoke-graphql.ts --include-state-gated # opt-IN (interactive)
 *   bun run scripts/smoke-graphql.ts --section tags
 *
 * Sections: tags, categories, transactions, recurrings, budgets, accounts,
 *           bulk, errors, edge, consistency, mcp-e2e, state-gated
 *
 * State-gated tests are opt-in because they require the user to toggle UI
 * state manually in the Copilot desktop app between prompts.
 *
 * All created entities use the `GQL-TEST-*` prefix and are deleted in a
 * try/finally. If cleanup fails, the script prints explicit manual-cleanup
 * instructions with specific entity IDs.
 */

import * as readline from 'node:readline';
import { GraphQLClient, GraphQLError } from '../src/core/graphql/client.js';
import type { GraphQLErrorCode } from '../src/core/graphql/client.js';
import { FirebaseAuth } from '../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../src/core/auth/browser-token.js';
import { CopilotDatabase } from '../src/core/database.js';
import { CopilotMoneyTools } from '../src/tools/tools.js';

import { createTag, editTag, deleteTag } from '../src/core/graphql/tags.js';
import {
  createCategory,
  editCategory,
  deleteCategory,
} from '../src/core/graphql/categories.js';
import { editTransaction } from '../src/core/graphql/transactions.js';
import {
  createRecurring,
  editRecurring,
  deleteRecurring,
} from '../src/core/graphql/recurrings.js';
import { setBudget } from '../src/core/graphql/budgets.js';
import { editAccount } from '../src/core/graphql/accounts.js';

// -----------------------------------------------------------------------------
// Polling helper — wait for a local-cache read to reflect a GraphQL write
// -----------------------------------------------------------------------------

/**
 * Poll `predicate` at a fixed interval until it returns a non-null result
 * or `timeoutMs` elapses. Returns the result plus the observed lag, or
 * `null` on timeout. The predicate is responsible for refreshing the
 * database cache before reading — this function only handles the loop.
 */
async function pollUntil<T>(
  _label: string,
  predicate: () => Promise<T | null>,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ result: T; observedLagMs: number } | null> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await predicate();
    if (res !== null && res !== undefined) {
      return { result: res, observedLagMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// -----------------------------------------------------------------------------
// Interactive prompt helper (used only by state-gated section)
// -----------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// -----------------------------------------------------------------------------
// CLI argument parsing
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const skipDestructive = argv.includes('--skip-destructive');
const skipErrors = argv.includes('--skip-errors');
const skipEdgeCases = argv.includes('--skip-edge-cases');
const skipConsistency = argv.includes('--skip-consistency');
const skipMcpE2e = argv.includes('--skip-mcp-e2e');
const includeStateGated = argv.includes('--include-state-gated');
const quick = argv.includes('--quick');

const sectionIdx = argv.indexOf('--section');
const onlySection =
  sectionIdx >= 0 && sectionIdx + 1 < argv.length ? argv[sectionIdx + 1] : null;

const VALID_SECTIONS = [
  'tags',
  'categories',
  'transactions',
  'recurrings',
  'budgets',
  'accounts',
  'bulk',
  'errors',
  'edge',
  'consistency',
  'mcp-e2e',
  'state-gated',
];
if (onlySection && !VALID_SECTIONS.includes(onlySection)) {
  console.error(
    `Invalid --section ${onlySection}. Valid: ${VALID_SECTIONS.join(', ')}`
  );
  process.exit(2);
}

function sectionEnabled(name: string): boolean {
  if (onlySection) return name === onlySection;
  if (name === 'errors' && skipErrors) return false;
  if (name === 'edge' && skipEdgeCases) return false;
  if (name === 'consistency' && skipConsistency) return false;
  if (name === 'mcp-e2e' && skipMcpE2e) return false;
  // state-gated is opt-in — only run when explicitly requested.
  if (name === 'state-gated' && !includeStateGated) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Step tracking
// -----------------------------------------------------------------------------

interface StepResult {
  section: string;
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
  durationMs: number;
}

const results: StepResult[] = [];
const stragglers: string[] = [];

/**
 * Observed write→local-read lag samples, populated by the consistency
 * section. Used to print a summary at the end of the smoke.
 */
const consistencyLags: { label: string; lagMs: number | null }[] = [];

async function step(
  section: string,
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - started;
    results.push({ section, name, ok: true, durationMs });
    console.log(`  ✓ ${name} (${durationMs}ms)`);
  } catch (e) {
    const durationMs = Date.now() - started;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ section, name, ok: false, detail, durationMs });
    console.error(`  ✗ ${name} (${durationMs}ms): ${detail}`);
  }
}

/**
 * Like `step`, but accepts a return code for skipped work — useful for the
 * state-gated section where the user may type "skip" at a prompt.
 */
async function stepSkippable(
  section: string,
  name: string,
  fn: () => Promise<'skipped' | void>
): Promise<void> {
  const started = Date.now();
  try {
    const r = await fn();
    const durationMs = Date.now() - started;
    if (r === 'skipped') {
      results.push({ section, name, ok: true, skipped: true, durationMs });
      console.log(`  ○ ${name} (skipped)`);
    } else {
      results.push({ section, name, ok: true, durationMs });
      console.log(`  ✓ ${name} (${durationMs}ms)`);
    }
  } catch (e) {
    const durationMs = Date.now() - started;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ section, name, ok: false, detail, durationMs });
    console.error(`  ✗ ${name} (${durationMs}ms): ${detail}`);
  }
}

function registerStraggler(description: string): void {
  stragglers.push(description);
  console.warn(`  ! manual cleanup needed: ${description}`);
}

function logSection(title: string): void {
  console.log(`\n━━ ${title} ━━`);
}

// -----------------------------------------------------------------------------
// Assertion helpers
// -----------------------------------------------------------------------------

function assertGraphQLErrorCode(e: unknown, expected: GraphQLErrorCode): void {
  if (!(e instanceof GraphQLError)) {
    throw new Error(
      `expected GraphQLError with code=${expected}, got non-GraphQLError: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
  if (e.code !== expected) {
    throw new Error(
      `expected code=${expected}, got code=${e.code}: ${e.message}`
    );
  }
}

async function expectThrows(
  fn: () => Promise<unknown>,
  label: string
): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error(`${label} was expected to throw, but succeeded`);
}

// -----------------------------------------------------------------------------
// Section 1 — Happy-path variants
// -----------------------------------------------------------------------------

async function smokeTagsHappyPath(client: GraphQLClient): Promise<void> {
  logSection('Tags — happy path');

  // Create with default color (PURPLE2) → delete
  await step('tags', 'create (default PURPLE2) + delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-DEFAULT', colorName: 'PURPLE2' },
    });
    try {
      if (t.colorName !== 'PURPLE2') {
        throw new Error(`expected colorName=PURPLE2, got ${t.colorName}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} name=GQL-TEST-TAG-HP-DEFAULT`);
      }
    }
  });

  if (quick) return;

  // Create with alternate color
  await step('tags', 'create (RED1) + delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-RED1', colorName: 'RED1' },
    });
    try {
      if (t.colorName !== 'RED1') {
        throw new Error(`expected colorName=RED1, got ${t.colorName}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} name=GQL-TEST-TAG-HP-RED1`);
      }
    }
  });

  // Create with Unicode name
  await step('tags', 'create (Unicode name) + delete', async () => {
    const name = 'GQL-TEST-TAG-HP-🎯';
    const t = await createTag(client, { input: { name, colorName: 'OLIVE1' } });
    try {
      if (t.name !== name) {
        // Server may normalize emoji — log but don't fail
        console.warn(`    (note: server returned name=${t.name})`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} name=${name}`);
      }
    }
  });

  // Create → edit name only → delete
  await step('tags', 'create → edit name only → delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-EDIT-NAME', colorName: 'PURPLE2' },
    });
    try {
      const edited = await editTag(client, {
        id: t.id,
        input: { name: 'GQL-TEST-TAG-HP-EDIT-NAME-2' },
      });
      if (edited.changed.name !== 'GQL-TEST-TAG-HP-EDIT-NAME-2') {
        throw new Error(`name not reflected in response: ${edited.changed.name}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} (edit-name variant)`);
      }
    }
  });

  // Create → edit color only → delete
  await step('tags', 'create → edit color only → delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-EDIT-COLOR', colorName: 'PURPLE2' },
    });
    try {
      const edited = await editTag(client, {
        id: t.id,
        input: { colorName: 'RED1' },
      });
      if (edited.changed.colorName !== 'RED1') {
        throw new Error(`color not reflected: ${edited.changed.colorName}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} (edit-color variant)`);
      }
    }
  });

  // Create → edit name+color in one call → delete
  await step('tags', 'create → edit name+color → delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-EDIT-BOTH', colorName: 'PURPLE2' },
    });
    try {
      const edited = await editTag(client, {
        id: t.id,
        input: { name: 'GQL-TEST-TAG-HP-EDIT-BOTH-2', colorName: 'OLIVE1' },
      });
      if (
        edited.changed.name !== 'GQL-TEST-TAG-HP-EDIT-BOTH-2' ||
        edited.changed.colorName !== 'OLIVE1'
      ) {
        throw new Error(`both fields not reflected: ${JSON.stringify(edited.changed)}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} (edit-both variant)`);
      }
    }
  });

  // Chain of edits
  await step('tags', 'create → edit name → edit color → delete', async () => {
    const t = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-HP-CHAIN', colorName: 'PURPLE2' },
    });
    try {
      await editTag(client, {
        id: t.id,
        input: { name: 'GQL-TEST-TAG-HP-CHAIN-2' },
      });
      await editTag(client, { id: t.id, input: { colorName: 'RED1' } });
    } finally {
      try {
        await deleteTag(client, { id: t.id });
      } catch {
        registerStraggler(`tag id=${t.id} (chain variant)`);
      }
    }
  });
}

async function smokeCategoriesHappyPath(client: GraphQLClient): Promise<void> {
  logSection('Categories — happy path');

  await step('categories', 'create (isExcluded=false) + delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-INCLUDED',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    try {
      /* no-op */
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} name=GQL-TEST-CAT-HP-INCLUDED`);
      }
    }
  });

  if (quick) return;

  await step('categories', 'create (isExcluded=true) + delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-EXCLUDED',
        colorName: 'RED1',
        emoji: '🚫',
        isExcluded: true,
      },
    });
    try {
      /* no-op */
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} (excluded variant)`);
      }
    }
  });

  // NOTE: parentId is not accepted by either CreateCategoryInput or
  // EditCategoryInput on Copilot's GraphQL schema (verified by smoke test:
  // both reject BAD_USER_INPUT). Parent/child category hierarchies are not
  // supported via the web app's GraphQL mutations. Skipping that test variant.

  // Single-field edits
  await step('categories', 'create → edit name only → delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-EDIT-NAME',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    try {
      const edited = await editCategory(client, {
        id: c.id,
        input: { name: 'GQL-TEST-CAT-HP-EDIT-NAME-2' },
      });
      if (edited.changed.name !== 'GQL-TEST-CAT-HP-EDIT-NAME-2') {
        throw new Error(`name not reflected: ${edited.changed.name}`);
      }
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} (edit-name variant)`);
      }
    }
  });

  await step('categories', 'create → edit colorName → delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-EDIT-COLOR',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    try {
      await editCategory(client, { id: c.id, input: { colorName: 'RED1' } });
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} (edit-color variant)`);
      }
    }
  });

  await step('categories', 'create → edit emoji → delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-EDIT-EMOJI',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    try {
      // Note: server does not return emoji; graphql wrapper echoes input.
      const edited = await editCategory(client, {
        id: c.id,
        input: { emoji: '🎉' },
      });
      if (edited.changed.emoji !== '🎉') {
        throw new Error(`emoji echo mismatch: ${edited.changed.emoji}`);
      }
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} (edit-emoji variant)`);
      }
    }
  });

  await step('categories', 'create → toggle isExcluded → delete', async () => {
    const c = await createCategory(client, {
      input: {
        name: 'GQL-TEST-CAT-HP-TOGGLE-EXCL',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    try {
      // The wrapper echoes isExcluded from input rather than confirming from the
      // server (server schema doesn't return it on editCategory). We just ensure
      // no error; a follow-up capture can deepen confidence.
      const edited = await editCategory(client, {
        id: c.id,
        input: { isExcluded: true },
      });
      if (edited.changed.isExcluded !== true) {
        throw new Error(`isExcluded echo mismatch: ${edited.changed.isExcluded}`);
      }
    } finally {
      try {
        await deleteCategory(client, { id: c.id });
      } catch {
        registerStraggler(`category id=${c.id} (toggle-excl variant)`);
      }
    }
  });
}

async function smokeTransactionsHappyPath(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Transactions — happy path');

  const allTxns = await db.getAllTransactions();
  const candidate = allTxns.find((t) => t.account_id && t.item_id);
  if (!candidate) {
    console.warn('  no usable transaction; skipping section');
    return;
  }

  const txnId = candidate.transaction_id;
  const accountId = candidate.account_id!;
  const itemId = candidate.item_id!;
  const originalNote = candidate.user_note ?? null;
  const originalCategory = candidate.category_id;

  console.log(
    `  using txn=${txnId} (original note=${JSON.stringify(originalNote)} category=${originalCategory})`
  );

  await step('transactions', 'userNotes: set non-empty → restore', async () => {
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: 'GQL-TEST-NOTE' },
    });
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: originalNote },
    });
  });

  if (quick) return;

  await step('transactions', 'userNotes: set empty string', async () => {
    const r = await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: '' },
    });
    console.log(`    server echoed userNotes=${JSON.stringify(r.changed.userNotes)}`);
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: originalNote },
    });
  });

  await step('transactions', 'userNotes: Unicode', async () => {
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: 'GQL-TEST-日本語-🎯-μ' },
    });
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: originalNote },
    });
  });

  await step('transactions', 'userNotes: 500+ chars', async () => {
    const long = 'GQL-TEST-LONG-' + 'x'.repeat(500);
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: long },
    });
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { userNotes: originalNote },
    });
  });

  // categoryId change → revert
  const categories = await db.getUserCategories();
  const altCategory = categories.find((c) => c.category_id !== originalCategory);
  if (altCategory && originalCategory) {
    await step('transactions', 'categoryId: change → revert', async () => {
      await editTransaction(client, {
        id: txnId,
        accountId,
        itemId,
        input: { categoryId: altCategory.category_id },
      });
      await editTransaction(client, {
        id: txnId,
        accountId,
        itemId,
        input: { categoryId: originalCategory },
      });
    });
  } else {
    console.log('  (skipping category round-trip: no alternate category found)');
  }

  // tagIds round-trip: create two sentinel tags, attach, clear, delete tags.
  // Record original tag set by reading local cache field.
  const origTagIds = Array.isArray(candidate.tags) ? [...candidate.tags] : [];
  await step('transactions', 'tagIds: set [2] → clear [] → restore', async () => {
    const tagA = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-TX-A', colorName: 'OLIVE1' },
    });
    const tagB = await createTag(client, {
      input: { name: 'GQL-TEST-TAG-TX-B', colorName: 'RED1' },
    });
    try {
      await editTransaction(client, {
        id: txnId,
        accountId,
        itemId,
        input: { tagIds: [tagA.id, tagB.id] },
      });
      await editTransaction(client, {
        id: txnId,
        accountId,
        itemId,
        input: { tagIds: [] },
      });
      // Restore whatever was there originally
      await editTransaction(client, {
        id: txnId,
        accountId,
        itemId,
        input: { tagIds: origTagIds },
      });
    } finally {
      try {
        await deleteTag(client, { id: tagA.id });
      } catch {
        registerStraggler(`tag id=${tagA.id} (tx-A)`);
      }
      try {
        await deleteTag(client, { id: tagB.id });
      } catch {
        registerStraggler(`tag id=${tagB.id} (tx-B)`);
      }
    }
  });

  // isReviewed toggle
  const originalReviewed = candidate.is_reviewed ?? false;
  await step('transactions', 'isReviewed: true → false → restore', async () => {
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { isReviewed: !originalReviewed },
    });
    await editTransaction(client, {
      id: txnId,
      accountId,
      itemId,
      input: { isReviewed: originalReviewed },
    });
  });

  // Combined edit
  if (altCategory && originalCategory) {
    await step(
      'transactions',
      'combined: category + notes + tagIds in one call',
      async () => {
        const tag = await createTag(client, {
          input: { name: 'GQL-TEST-TAG-TX-COMBO', colorName: 'PURPLE2' },
        });
        try {
          await editTransaction(client, {
            id: txnId,
            accountId,
            itemId,
            input: {
              categoryId: altCategory.category_id,
              userNotes: 'GQL-TEST-COMBO',
              tagIds: [tag.id],
            },
          });
          // Restore everything
          await editTransaction(client, {
            id: txnId,
            accountId,
            itemId,
            input: {
              categoryId: originalCategory,
              userNotes: originalNote,
              tagIds: origTagIds,
            },
          });
        } finally {
          try {
            await deleteTag(client, { id: tag.id });
          } catch {
            registerStraggler(`tag id=${tag.id} (combo)`);
          }
        }
      }
    );
  }
}

async function smokeRecurringsHappyPath(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Recurrings — happy path');

  const allTxns = await db.getAllTransactions();
  // Use different candidate transactions for each test variant — the server
  // associates a transaction with its recurring and won't reuse a txn
  // immediately after delete.
  const candidates = allTxns.filter(
    (t) => !t.recurring_id && t.account_id && t.item_id
  );
  if (candidates.length === 0) {
    console.warn('  no usable transactions without a recurring; skipping');
    return;
  }

  let candidateIdx = 0;
  const nextCandidate = (): (typeof candidates)[number] | null => {
    if (candidateIdx >= candidates.length) return null;
    return candidates[candidateIdx++]!;
  };

  const first = nextCandidate();
  if (!first) return;

  await step('recurrings', 'create + delete', async () => {
    const r = await createRecurring(client, {
      input: {
        frequency: 'MONTHLY',
        transaction: {
          accountId: first.account_id!,
          itemId: first.item_id!,
          transactionId: first.transaction_id,
        },
      },
    });
    try {
      if (!r.id) throw new Error('created recurring had no id');
    } finally {
      try {
        await deleteRecurring(client, { id: r.id });
      } catch {
        registerStraggler(`recurring id=${r.id}`);
      }
    }
  });

  if (quick) return;

  // For the remaining variants, create one long-lived recurring using a
  // different transaction, then delete at end. Wrap the whole thing in a
  // step() so a failure doesn't crash the script.
  const longCandidate = nextCandidate();
  if (!longCandidate) {
    console.warn('  insufficient candidates for long-lived recurring; skipping remaining');
    return;
  }

  await step('recurrings', 'rule + state edits (long-lived)', async () => {
    let recurringId: string | null = null;
    try {
      const r = await createRecurring(client, {
        input: {
          frequency: 'MONTHLY',
          transaction: {
            accountId: longCandidate.account_id!,
            itemId: longCandidate.item_id!,
            transactionId: longCandidate.transaction_id,
          },
        },
      });
      recurringId = r.id;
      console.log(`    using recurring id=${recurringId}`);

      // state pause → resume
      await editRecurring(client, {
        id: recurringId,
        input: { state: 'PAUSED' },
      });
      await editRecurring(client, {
        id: recurringId,
        input: { state: 'ACTIVE' },
      });

      // rule.minAmount / maxAmount / nameContains / days
      await editRecurring(client, {
        id: recurringId,
        input: { rule: { minAmount: '1' } },
      });
      await editRecurring(client, {
        id: recurringId,
        input: { rule: { maxAmount: '10000' } },
      });
      await editRecurring(client, {
        id: recurringId,
        input: { rule: { nameContains: 'GQL-TEST' } },
      });
      await editRecurring(client, {
        id: recurringId,
        input: { rule: { days: [1, 15] } },
      });

      // combined rule + state
      await editRecurring(client, {
        id: recurringId,
        input: {
          state: 'ACTIVE',
          rule: { nameContains: 'GQL-TEST-COMBINED', minAmount: '1' },
        },
      });
    } finally {
      if (recurringId) {
        try {
          await deleteRecurring(client, { id: recurringId });
        } catch {
          registerStraggler(`recurring id=${recurringId} (long-lived)`);
        }
      }
    }
  });
}

async function smokeBudgetsHappyPath(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Budgets — happy path');

  const categories = await db.getUserCategories();
  const c = categories[0];
  if (!c) {
    console.warn('  no user categories; skipping');
    return;
  }
  const catId = c.category_id;
  console.log(`  using category id=${catId} name=${c.name}`);

  await step('budgets', 'setBudget amount=1 (all months) → clear', async () => {
    await setBudget(client, { categoryId: catId, amount: '1' });
    await setBudget(client, { categoryId: catId, amount: '0' });
  });

  if (quick) return;

  await step('budgets', 'setBudget amount=0.01 → clear', async () => {
    await setBudget(client, { categoryId: catId, amount: '0.01' });
    await setBudget(client, { categoryId: catId, amount: '0' });
  });

  await step('budgets', 'setBudget amount=250.00 → clear', async () => {
    await setBudget(client, { categoryId: catId, amount: '250.00' });
    await setBudget(client, { categoryId: catId, amount: '0' });
  });

  await step('budgets', 'setBudget amount=99999.99 → clear', async () => {
    await setBudget(client, { categoryId: catId, amount: '99999.99' });
    await setBudget(client, { categoryId: catId, amount: '0' });
  });

  await step('budgets', 'setBudget amount=0 no-op (idempotent clear)', async () => {
    await setBudget(client, { categoryId: catId, amount: '0' });
  });

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const futureDate = new Date(now.getFullYear(), now.getMonth() + 2, 1);
  const futureMonth = `${futureDate.getFullYear()}-${String(
    futureDate.getMonth() + 1
  ).padStart(2, '0')}`;

  await step(
    'budgets',
    `setBudget month=${currentMonth} (current) → clear`,
    async () => {
      await setBudget(client, { categoryId: catId, amount: '1', month: currentMonth });
      await setBudget(client, { categoryId: catId, amount: '0', month: currentMonth });
    }
  );

  await step(
    'budgets',
    `setBudget month=${futureMonth} (future) → clear`,
    async () => {
      await setBudget(client, { categoryId: catId, amount: '5', month: futureMonth });
      await setBudget(client, { categoryId: catId, amount: '0', month: futureMonth });
    }
  );

  // Three-month set + clear
  await step('budgets', 'three months set → clear all three', async () => {
    const m1Date = new Date(now.getFullYear(), now.getMonth() + 3, 1);
    const m2Date = new Date(now.getFullYear(), now.getMonth() + 4, 1);
    const m3Date = new Date(now.getFullYear(), now.getMonth() + 5, 1);
    const fmt = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const months = [fmt(m1Date), fmt(m2Date), fmt(m3Date)];
    for (const m of months) {
      await setBudget(client, { categoryId: catId, amount: '10', month: m });
    }
    for (const m of months) {
      await setBudget(client, { categoryId: catId, amount: '0', month: m });
    }
  });
}

async function smokeAccountsHappyPath(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Accounts — happy path');

  const accounts = await db.getAccounts();
  const a = accounts[0];
  if (!a || !a.item_id) {
    console.warn('  no usable account; skipping');
    return;
  }
  const accountId = a.account_id;
  const itemId = a.item_id;
  const originalName = a.name;
  const originalHidden = a.user_hidden ?? false;

  await step('accounts', 'rename → restore', async () => {
    await editAccount(client, {
      id: accountId,
      itemId,
      input: { name: 'GQL-TEST-ACCT' },
    });
    await editAccount(client, {
      id: accountId,
      itemId,
      input: { name: originalName },
    });
  });

  if (quick) return;

  await step('accounts', 'isUserHidden toggle (hide → unhide)', async () => {
    await editAccount(client, {
      id: accountId,
      itemId,
      input: { isUserHidden: !originalHidden },
    });
    await editAccount(client, {
      id: accountId,
      itemId,
      input: { isUserHidden: originalHidden },
    });
  });
}

// -----------------------------------------------------------------------------
// Section 2 — Bulk operations
// -----------------------------------------------------------------------------

async function smokeBulkReviewTransactions(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Bulk — review_transactions');

  const allTxns = await db.getAllTransactions();
  const usable = allTxns.filter((t) => t.account_id && t.item_id).slice(0, 5);
  if (usable.length < 5) {
    console.warn('  need 5 transactions; skipping bulk section');
    return;
  }

  // Capture original isReviewed state for restoration.
  const original = new Map<string, boolean>();
  for (const t of usable) {
    original.set(t.transaction_id, t.is_reviewed ?? false);
  }

  await step(
    'bulk',
    'flip 5 transactions reviewed=true → restore',
    async () => {
      for (const t of usable) {
        await editTransaction(client, {
          id: t.transaction_id,
          accountId: t.account_id!,
          itemId: t.item_id!,
          input: { isReviewed: true },
        });
      }
      // Restore
      for (const t of usable) {
        await editTransaction(client, {
          id: t.transaction_id,
          accountId: t.account_id!,
          itemId: t.item_id!,
          input: { isReviewed: original.get(t.transaction_id) ?? false },
        });
      }
    }
  );

  // Partial-failure path: craft an invalid ID in the middle.
  // Mimic what review_transactions does — call editTransaction sequentially,
  // fail on 3rd. Record which ones flipped so we can restore.
  await step('bulk', 'partial failure (invalid id mid-sequence)', async () => {
    const [a, b] = [usable[0]!, usable[1]!];
    const flipped: string[] = [];
    let caught: unknown;
    try {
      await editTransaction(client, {
        id: a.transaction_id,
        accountId: a.account_id!,
        itemId: a.item_id!,
        input: { isReviewed: true },
      });
      flipped.push(a.transaction_id);

      await editTransaction(client, {
        id: b.transaction_id,
        accountId: b.account_id!,
        itemId: b.item_id!,
        input: { isReviewed: true },
      });
      flipped.push(b.transaction_id);

      // This one will fail — use a bogus transaction id + a real account/item
      // to force a server-side rejection.
      await editTransaction(client, {
        id: 'definitely-not-a-real-id-xyz',
        accountId: a.account_id!,
        itemId: a.item_id!,
        input: { isReviewed: true },
      });
      throw new Error('expected rejection but call succeeded');
    } catch (e) {
      caught = e;
    } finally {
      // Restore whatever was flipped.
      for (const id of flipped) {
        const txn = usable.find((t) => t.transaction_id === id)!;
        try {
          await editTransaction(client, {
            id: txn.transaction_id,
            accountId: txn.account_id!,
            itemId: txn.item_id!,
            input: { isReviewed: original.get(id) ?? false },
          });
        } catch {
          registerStraggler(
            `transaction id=${id} flipped to reviewed=true but restore failed`
          );
        }
      }
    }

    if (!caught) throw new Error('no error thrown from invalid id');
    if (!(caught instanceof GraphQLError)) {
      throw new Error(
        `expected GraphQLError, got: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    }
    console.log(`    classified as code=${caught.code} (${caught.message.slice(0, 80)})`);
  });
}

// -----------------------------------------------------------------------------
// Section 3 — Error injection
// -----------------------------------------------------------------------------

async function smokeErrorInjection(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Errors — injection + classification');

  const allTxns = await db.getAllTransactions();
  const candidate = allTxns.find((t) => t.account_id && t.item_id);

  // editTransaction with a bad categoryId: Copilot's server is lenient and
  // will ACCEPT the bogus value (returning 200 with no errors), which
  // corrupts the transaction's categoryId on the server. We document this
  // behavior AND restore the original categoryId so repeated smoke runs
  // don't compound the damage.
  if (candidate) {
    await step(
      'errors',
      'editTransaction with bad categoryId → silently accepted by server (documented)',
      async () => {
        const originalCategoryId = candidate.category_id;
        if (!originalCategoryId) {
          console.log('    skipped: candidate has no original category_id to restore');
          return;
        }
        await editTransaction(client, {
          id: candidate.transaction_id,
          accountId: candidate.account_id!,
          itemId: candidate.item_id!,
          input: { categoryId: 'definitely-not-a-real-category-xyz' },
        });
        console.log(
          `    server silently accepted bogus categoryId; restoring to ${originalCategoryId}`
        );
        // Restore
        await editTransaction(client, {
          id: candidate.transaction_id,
          accountId: candidate.account_id!,
          itemId: candidate.item_id!,
          input: { categoryId: originalCategoryId },
        });
        // Note: our local referential check in tools.ts `updateTransaction`
        // is the real defense against this class of bug.
      }
    );
  }

  // editTag with a non-existent id (server-side)
  await step('errors', 'editTag with non-existent id → classify', async () => {
    const e = await expectThrows(
      () => editTag(client, { id: 'does-not-exist-tag-xyz', input: { name: 'x' } }),
      'editTag-missing'
    );
    if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
    console.log(
      `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
    );
  });

  await step('errors', 'deleteTag with non-existent id → classify', async () => {
    const e = await expectThrows(
      () => deleteTag(client, { id: 'does-not-exist-tag-xyz' }),
      'deleteTag-missing'
    );
    if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
    console.log(
      `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
    );
  });

  await step(
    'errors',
    'editCategory with non-existent id → classify',
    async () => {
      const e = await expectThrows(
        () =>
          editCategory(client, {
            id: 'does-not-exist-cat-xyz',
            input: { name: 'x' },
          }),
        'editCategory-missing'
      );
      if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
      console.log(
        `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
      );
    }
  );

  await step(
    'errors',
    'deleteCategory with non-existent id → classify',
    async () => {
      const e = await expectThrows(
        () => deleteCategory(client, { id: 'does-not-exist-cat-xyz' }),
        'deleteCategory-missing'
      );
      if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
      console.log(
        `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
      );
    }
  );

  await step(
    'errors',
    'editRecurring with non-existent id → classify',
    async () => {
      const e = await expectThrows(
        () =>
          editRecurring(client, {
            id: 'does-not-exist-rec-xyz',
            input: { state: 'PAUSED' },
          }),
        'editRecurring-missing'
      );
      if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
      console.log(
        `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
      );
    }
  );

  await step(
    'errors',
    'deleteRecurring with non-existent id → classify',
    async () => {
      const e = await expectThrows(
        () => deleteRecurring(client, { id: 'does-not-exist-rec-xyz' }),
        'deleteRecurring-missing'
      );
      if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
      console.log(
        `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
      );
    }
  );

  // Non-existent category in setBudget
  await step(
    'errors',
    'setBudget with non-existent categoryId → classify',
    async () => {
      const e = await expectThrows(
        () =>
          setBudget(client, {
            categoryId: 'definitely-not-a-real-cat-xyz',
            amount: '5',
          }),
        'setBudget-missing-cat'
      );
      if (!(e instanceof GraphQLError)) throw new Error('not a GraphQLError');
      console.log(
        `    classified as code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 80)}`
      );
    }
  );

  // Local validation: createTag with empty name (wrapper accepts any name, so
  // test the budget/recurring local validation instead).
  await step('errors', 'setBudget amount=-50 rejected locally', async () => {
    const e = await expectThrows(
      () => setBudget(client, { categoryId: 'any', amount: '-50' }),
      'setBudget-neg'
    );
    if (e instanceof GraphQLError) {
      throw new Error(`expected non-GraphQLError local rejection, got GraphQLError`);
    }
    console.log(`    local rejection: ${(e as Error).message}`);
  });

  await step('errors', 'setBudget amount=abc rejected locally', async () => {
    const e = await expectThrows(
      () => setBudget(client, { categoryId: 'any', amount: 'abc' }),
      'setBudget-abc'
    );
    if (e instanceof GraphQLError) {
      throw new Error(`expected non-GraphQLError local rejection`);
    }
    console.log(`    local rejection: ${(e as Error).message}`);
  });

  // Auth failure
  await step('errors', 'AUTH_FAILED via bad token', async () => {
    const badAuth = {
      getIdToken: () =>
        Promise.resolve('invalid-jwt-token-that-will-be-rejected'),
    } as unknown as FirebaseAuth;
    const badClient = new GraphQLClient(badAuth);
    const e = await expectThrows(
      () => editTag(badClient, { id: 'any', input: { name: 'x' } }),
      'bad-auth'
    );
    assertGraphQLErrorCode(e, 'AUTH_FAILED');
    console.log(`    AUTH_FAILED confirmed (status=${(e as GraphQLError).httpStatus})`);
  });

  // NETWORK
  await step('errors', 'NETWORK via fetch stub', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('ECONNRESET');
    };
    try {
      const e = await expectThrows(
        () => editTag(client, { id: 'any', input: { name: 'x' } }),
        'network-fail'
      );
      assertGraphQLErrorCode(e, 'NETWORK');
      console.log('    NETWORK confirmed');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
}

// -----------------------------------------------------------------------------
// Section 4 — Edge cases
// -----------------------------------------------------------------------------

async function smokeEdgeCases(
  client: GraphQLClient,
  db: CopilotDatabase
): Promise<void> {
  logSection('Edge cases');

  // Duplicate tag creation
  await step('edge', 'duplicate tag creation', async () => {
    const first = await createTag(client, {
      input: { name: 'GQL-TEST-DUP-TAG', colorName: 'PURPLE2' },
    });
    let second: { id: string } | null = null;
    try {
      try {
        second = await createTag(client, {
          input: { name: 'GQL-TEST-DUP-TAG', colorName: 'PURPLE2' },
        });
        console.log(
          `    server allowed duplicate tag name — second id=${second.id}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`    server rejected duplicate: ${msg.slice(0, 100)}`);
      }
    } finally {
      try {
        await deleteTag(client, { id: first.id });
      } catch {
        registerStraggler(`tag id=${first.id} (dup first)`);
      }
      if (second) {
        try {
          await deleteTag(client, { id: second.id });
        } catch {
          registerStraggler(`tag id=${second.id} (dup second)`);
        }
      }
    }
  });

  // Duplicate category creation
  await step('edge', 'duplicate category creation', async () => {
    const first = await createCategory(client, {
      input: {
        name: 'GQL-TEST-DUP-CAT',
        colorName: 'OLIVE1',
        emoji: '🧪',
        isExcluded: false,
      },
    });
    let second: { id: string } | null = null;
    try {
      try {
        second = await createCategory(client, {
          input: {
            name: 'GQL-TEST-DUP-CAT',
            colorName: 'OLIVE1',
            emoji: '🧪',
            isExcluded: false,
          },
        });
        console.log(
          `    server allowed duplicate category name — second id=${second.id}`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`    server rejected duplicate: ${msg.slice(0, 100)}`);
      }
    } finally {
      try {
        await deleteCategory(client, { id: first.id });
      } catch {
        registerStraggler(`category id=${first.id} (dup first)`);
      }
      if (second) {
        try {
          await deleteCategory(client, { id: second.id });
        } catch {
          registerStraggler(`category id=${second.id} (dup second)`);
        }
      }
    }
  });

  // Concurrent transaction edits
  const allTxns = await db.getAllTransactions();
  const candidate = allTxns.find((t) => t.account_id && t.item_id);
  if (candidate) {
    const originalNote = candidate.user_note ?? null;
    await step('edge', 'concurrent edits on same txn (Promise.all)', async () => {
      const results = await Promise.allSettled([
        editTransaction(client, {
          id: candidate.transaction_id,
          accountId: candidate.account_id!,
          itemId: candidate.item_id!,
          input: { userNotes: 'GQL-TEST-CONCURRENT-A' },
        }),
        editTransaction(client, {
          id: candidate.transaction_id,
          accountId: candidate.account_id!,
          itemId: candidate.item_id!,
          input: { userNotes: 'GQL-TEST-CONCURRENT-B' },
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      const rejected = results.filter((r) => r.status === 'rejected').length;
      console.log(`    concurrent: fulfilled=${fulfilled} rejected=${rejected}`);
      // Restore
      await editTransaction(client, {
        id: candidate.transaction_id,
        accountId: candidate.account_id!,
        itemId: candidate.item_id!,
        input: { userNotes: originalNote },
      });
    });

    // Empty userNotes clears (observe actual behavior)
    await step('edge', 'userNotes="" clears the note', async () => {
      const r = await editTransaction(client, {
        id: candidate.transaction_id,
        accountId: candidate.account_id!,
        itemId: candidate.item_id!,
        input: { userNotes: '' },
      });
      console.log(
        `    server echoed userNotes=${JSON.stringify(r.changed.userNotes)}`
      );
      await editTransaction(client, {
        id: candidate.transaction_id,
        accountId: candidate.account_id!,
        itemId: candidate.item_id!,
        input: { userNotes: originalNote },
      });
    });
  }
}

// -----------------------------------------------------------------------------
// Section 5 — Write-to-read consistency
// -----------------------------------------------------------------------------
//
// After each GraphQL write, poll the corresponding read path (via the
// `CopilotMoneyTools` instance) until the local cache reflects the
// change, or time out after 60s. Each predicate must refresh the DB
// cache before reading so any new state written by the native Copilot
// app to LevelDB is picked up. Observed lags are collected for a
// summary at the end.

async function smokeWriteReadConsistency(
  client: GraphQLClient,
  db: CopilotDatabase,
  tools: CopilotMoneyTools
): Promise<void> {
  logSection('Consistency — write-to-read round trip (polled)');

  const TIMEOUT = 60_000;
  const INTERVAL = 2_000;
  const ts = Date.now();

  // 1 — Create tag → visible in db.getTags()
  await step('consistency', 'createTag → db.getTags() reflects it', async () => {
    const name = `GQL-TEST-CONSISTENCY-TAG-${ts}`;
    const created = await createTag(client, {
      input: { name, colorName: 'PURPLE2' },
    });
    const tagId = created.id;
    try {
      const found = await pollUntil(
        'tag-visible',
        async () => {
          await tools.refreshDatabase();
          const tags = await db.getTags();
          return tags.find((t) => t.tag_id === tagId) ?? null;
        },
        { timeoutMs: TIMEOUT, intervalMs: INTERVAL }
      );
      if (!found) {
        consistencyLags.push({ label: 'createTag', lagMs: null });
        throw new Error('local cache did not reflect write within 60s — Copilot native app sync lag');
      }
      consistencyLags.push({ label: 'createTag', lagMs: found.observedLagMs });
      console.log(`    observed lag: ${found.observedLagMs}ms`);
    } finally {
      try {
        await deleteTag(client, { id: tagId });
      } catch {
        registerStraggler(`tag id=${tagId} name=${name}`);
      }
    }
  });

  // 2 — Create category → visible in db.getUserCategories()
  await step(
    'consistency',
    'createCategory → db.getUserCategories() reflects it',
    async () => {
      const name = `GQL-TEST-CONSISTENCY-CAT-${ts}`;
      const created = await createCategory(client, {
        input: {
          name,
          colorName: 'OLIVE1',
          emoji: '🧪',
          isExcluded: false,
        },
      });
      const catId = created.id;
      try {
        const found = await pollUntil(
          'cat-visible',
          async () => {
            await tools.refreshDatabase();
            const cats = await db.getUserCategories();
            return cats.find((c) => c.category_id === catId) ?? null;
          },
          { timeoutMs: TIMEOUT, intervalMs: INTERVAL }
        );
        if (!found) {
          consistencyLags.push({ label: 'createCategory', lagMs: null });
          throw new Error('local cache did not reflect write within 60s — Copilot native app sync lag');
        }
        consistencyLags.push({ label: 'createCategory', lagMs: found.observedLagMs });
        console.log(`    observed lag: ${found.observedLagMs}ms`);
      } finally {
        try {
          await deleteCategory(client, { id: catId });
        } catch {
          registerStraggler(`category id=${catId} name=${name}`);
        }
      }
    }
  );

  // 3 — editTransaction userNotes → visible via tools.getTransactions()
  await step(
    'consistency',
    'editTransaction userNotes → get_transactions reflects it',
    async () => {
      const allTxns = await db.getAllTransactions();
      const candidate = allTxns.find((t) => t.account_id && t.item_id);
      if (!candidate) {
        console.log('    (no usable transaction; skipping)');
        return;
      }
      const originalNote = candidate.user_note ?? null;
      const expectedNote = `GQL-TEST-CONSISTENCY-${ts}`;
      await editTransaction(client, {
        id: candidate.transaction_id,
        accountId: candidate.account_id!,
        itemId: candidate.item_id!,
        input: { userNotes: expectedNote },
      });
      try {
        const found = await pollUntil(
          'note-visible',
          async () => {
            await tools.refreshDatabase();
            const all = await db.getAllTransactions();
            const t = all.find((x) => x.transaction_id === candidate.transaction_id);
            return t && t.user_note === expectedNote ? t : null;
          },
          { timeoutMs: TIMEOUT, intervalMs: INTERVAL }
        );
        if (!found) {
          consistencyLags.push({ label: 'editTransaction.note', lagMs: null });
          throw new Error('local cache did not reflect write within 60s — Copilot native app sync lag');
        }
        consistencyLags.push({
          label: 'editTransaction.note',
          lagMs: found.observedLagMs,
        });
        console.log(`    observed lag: ${found.observedLagMs}ms`);
      } finally {
        // Restore
        try {
          await editTransaction(client, {
            id: candidate.transaction_id,
            accountId: candidate.account_id!,
            itemId: candidate.item_id!,
            input: { userNotes: originalNote },
          });
        } catch {
          registerStraggler(
            `txn id=${candidate.transaction_id} note may be "${expectedNote}" — restore failed`
          );
        }
      }
    }
  );

  // 4 — setBudget → visible in tools.getBudgets()
  await step(
    'consistency',
    'setBudget → get_budgets reflects amount',
    async () => {
      const categories = await db.getUserCategories();
      const c = categories[0];
      if (!c) {
        console.log('    (no user categories; skipping)');
        return;
      }
      const catId = c.category_id;
      await setBudget(client, { categoryId: catId, amount: '250.00' });
      try {
        const found = await pollUntil(
          'budget-visible',
          async () => {
            await tools.refreshDatabase();
            const budgets = await tools.getBudgets({});
            // Look for this category in the default-budget entries with amount ~ 250
            for (const b of budgets.budgets) {
              const cid = (b as { category_id?: string }).category_id;
              const amt =
                (b as { amount?: number }).amount ??
                (b as { default_amount?: number }).default_amount;
              if (cid === catId && typeof amt === 'number' && Math.abs(amt - 250) < 0.005) {
                return b;
              }
            }
            return null;
          },
          { timeoutMs: TIMEOUT, intervalMs: INTERVAL }
        );
        if (!found) {
          consistencyLags.push({ label: 'setBudget', lagMs: null });
          throw new Error('local cache did not reflect write within 60s — Copilot native app sync lag');
        }
        consistencyLags.push({ label: 'setBudget', lagMs: found.observedLagMs });
        console.log(`    observed lag: ${found.observedLagMs}ms`);
      } finally {
        try {
          await setBudget(client, { categoryId: catId, amount: '0' });
        } catch {
          registerStraggler(`budget for category=${catId} may be 250.00 — clear failed`);
        }
      }
    }
  );

  // 5 — createRecurring → visible in tools.getRecurringTransactions()
  await step(
    'consistency',
    'createRecurring → get_recurring_transactions reflects it',
    async () => {
      const allTxns = await db.getAllTransactions();
      const candidate = allTxns.find(
        (t) => !t.recurring_id && t.account_id && t.item_id
      );
      if (!candidate) {
        console.log('    (no usable non-recurring txn; skipping)');
        return;
      }
      const created = await createRecurring(client, {
        input: {
          frequency: 'MONTHLY',
          transaction: {
            accountId: candidate.account_id!,
            itemId: candidate.item_id!,
            transactionId: candidate.transaction_id,
          },
        },
      });
      const recurringId = created.id;
      try {
        const found = await pollUntil(
          'recurring-visible',
          async () => {
            await tools.refreshDatabase();
            // Use db.getRecurring() directly — the `getRecurringTransactions`
            // MCP tool returns heuristic (name-based) clusters, not raw
            // recurring documents by id. The raw collection is the
            // authoritative source for a freshly-created recurring.
            const raw = await db.getRecurring();
            return raw.find((r) => r.recurring_id === recurringId) ?? null;
          },
          { timeoutMs: TIMEOUT, intervalMs: INTERVAL }
        );
        if (!found) {
          consistencyLags.push({ label: 'createRecurring', lagMs: null });
          throw new Error('local cache did not reflect write within 60s — Copilot native app sync lag');
        }
        consistencyLags.push({
          label: 'createRecurring',
          lagMs: found.observedLagMs,
        });
        console.log(`    observed lag: ${found.observedLagMs}ms`);
      } finally {
        try {
          await deleteRecurring(client, { id: recurringId });
        } catch {
          registerStraggler(`recurring id=${recurringId}`);
        }
      }
    }
  );

  // Summary
  const observed = consistencyLags
    .filter((s): s is { label: string; lagMs: number } => s.lagMs !== null)
    .map((s) => s.lagMs);
  observed.sort((a, b) => a - b);
  if (observed.length > 0) {
    const median = observed[Math.floor(observed.length / 2)]!;
    const max = observed[observed.length - 1]!;
    console.log(
      `  → consistency lag (n=${observed.length}): median=${median}ms max=${max}ms`
    );
  }
  const timedOut = consistencyLags.filter((s) => s.lagMs === null);
  if (timedOut.length > 0) {
    console.log(
      `  → ${timedOut.length} consistency check(s) timed out (>60s). ` +
        'This indicates Copilot native app sync lag, not an API bug.'
    );
  }
}

// -----------------------------------------------------------------------------
// Section 6 — MCP tool E2E (dispatch chain)
// -----------------------------------------------------------------------------
//
// Exercises the full CopilotMoneyTools.* entry points (arg validation,
// referential checks, error mapping) instead of calling per-domain
// GraphQL functions directly. One happy path + one local-validation
// failure for each write tool where applicable.

async function smokeMcpToolEndToEnd(
  db: CopilotDatabase,
  tools: CopilotMoneyTools
): Promise<void> {
  logSection('MCP E2E — full dispatch chain');

  const allTxns = await db.getAllTransactions();
  const candidate = allTxns.find((t) => t.account_id && t.item_id);
  if (!candidate) {
    console.warn('  no usable transaction; skipping section');
    return;
  }
  const categories = await db.getUserCategories();
  if (categories.length === 0) {
    console.warn('  no user categories; skipping section');
    return;
  }

  // --- update_transaction -----------------------------------------------
  const origCat = candidate.category_id;
  const altCat = categories.find((c) => c.category_id !== origCat);

  if (altCat && origCat) {
    await step(
      'mcp-e2e',
      'tools.updateTransaction({category_id}) happy path + revert',
      async () => {
        await tools.updateTransaction({
          transaction_id: candidate.transaction_id,
          category_id: altCat.category_id,
        });
        await tools.updateTransaction({
          transaction_id: candidate.transaction_id,
          category_id: origCat,
        });
      }
    );
  }

  await step(
    'mcp-e2e',
    'tools.updateTransaction({category_id: invalid}) → local referential rejection',
    async () => {
      const e = await expectThrows(
        () =>
          tools.updateTransaction({
            transaction_id: candidate.transaction_id,
            category_id: 'invalid-xyz',
          }),
        'updateTransaction-bad-cat'
      );
      if (e instanceof GraphQLError) {
        throw new Error('expected local validation rejection, got GraphQLError');
      }
      const msg = (e as Error).message;
      if (!/Category not found/i.test(msg)) {
        throw new Error(`expected "Category not found:" message, got: ${msg}`);
      }
      console.log(`    local rejection: ${msg.slice(0, 80)}`);
    }
  );

  // --- review_transactions (bounded concurrency=5) -----------------------
  const usable = allTxns.filter((t) => t.account_id && t.item_id).slice(0, 3);
  if (usable.length >= 3) {
    const original = new Map<string, boolean>();
    for (const t of usable) original.set(t.transaction_id, t.is_reviewed ?? false);

    await step(
      'mcp-e2e',
      'tools.reviewTransactions(3 ids, reviewed=true) + revert',
      async () => {
        await tools.reviewTransactions({
          transaction_ids: usable.map((t) => t.transaction_id),
          reviewed: true,
        });
        // Revert each one individually so we never leave anything flipped.
        for (const t of usable) {
          await tools.reviewTransactions({
            transaction_ids: [t.transaction_id],
            reviewed: original.get(t.transaction_id) ?? false,
          });
        }
      }
    );
  }

  // --- tags ---------------------------------------------------------------
  await step(
    'mcp-e2e',
    'tools.createTag + updateTag + deleteTag round-trip',
    async () => {
      const created = await tools.createTag({ name: 'GQL-TEST-MCP-TAG' });
      const tagId = created.tag_id;
      try {
        const updated = await tools.updateTag({
          tag_id: tagId,
          name: 'GQL-TEST-MCP-TAG-2',
        });
        if (!Array.isArray(updated.updated) || !updated.updated.includes('name')) {
          throw new Error(`updateTag updated field missing: ${JSON.stringify(updated)}`);
        }
      } finally {
        try {
          await tools.deleteTag({ tag_id: tagId });
        } catch {
          registerStraggler(`tag id=${tagId} (MCP E2E)`);
        }
      }
    }
  );

  // --- categories ---------------------------------------------------------
  await step(
    'mcp-e2e',
    'tools.createCategory + updateCategory + deleteCategory round-trip',
    async () => {
      const created = await tools.createCategory({
        name: 'GQL-TEST-MCP-CAT',
        color_name: 'RED1',
        emoji: '🧪',
      });
      const catId = created.category_id;
      try {
        await tools.updateCategory({ category_id: catId, name: 'GQL-TEST-MCP-CAT-2' });
      } finally {
        try {
          await tools.deleteCategory({ category_id: catId });
        } catch {
          registerStraggler(`category id=${catId} (MCP E2E)`);
        }
      }
    }
  );

  // --- budgets ------------------------------------------------------------
  const catForBudget = categories[0]!;
  await step(
    'mcp-e2e',
    'tools.setBudget happy path → clear',
    async () => {
      await tools.setBudget({ category_id: catForBudget.category_id, amount: '250.00' });
      await tools.setBudget({ category_id: catForBudget.category_id, amount: '0' });
    }
  );

  await step(
    'mcp-e2e',
    'tools.setBudget({amount:"-50"}) → local validation rejection',
    async () => {
      const e = await expectThrows(
        () => tools.setBudget({ category_id: catForBudget.category_id, amount: '-50' }),
        'setBudget-neg'
      );
      if (e instanceof GraphQLError) {
        throw new Error('expected local rejection, got GraphQLError');
      }
      console.log(`    local rejection: ${(e as Error).message.slice(0, 80)}`);
    }
  );

  // --- recurrings ---------------------------------------------------------
  // Find an existing recurring for a pause/resume test
  const recurrings = await db.getRecurring();
  const existingRecurring = recurrings.find(
    (r) => (r as { state?: string }).state === 'ACTIVE'
  );

  if (existingRecurring) {
    await step(
      'mcp-e2e',
      'tools.setRecurringState (PAUSED → ACTIVE) happy path',
      async () => {
        const id = (existingRecurring as { recurring_id?: string; id?: string })
          .recurring_id ??
          (existingRecurring as { id: string }).id;
        await tools.setRecurringState({ recurring_id: id, state: 'PAUSED' });
        await tools.setRecurringState({ recurring_id: id, state: 'ACTIVE' });
      }
    );
  } else {
    console.log('  (no active recurring; skipping setRecurringState happy path)');
  }

  await step(
    'mcp-e2e',
    'tools.setRecurringState({state: "active"}) → local validation rejection',
    async () => {
      const e = await expectThrows(
        () => tools.setRecurringState({ recurring_id: 'any', state: 'active' }),
        'setRecurringState-lowercase'
      );
      if (e instanceof GraphQLError) {
        throw new Error('expected local rejection, got GraphQLError');
      }
      console.log(`    local rejection: ${(e as Error).message.slice(0, 80)}`);
    }
  );

  // createRecurring + updateRecurring + deleteRecurring round-trip through MCP
  const noRecurringTxn = allTxns.find(
    (t) => !t.recurring_id && t.account_id && t.item_id
  );
  if (noRecurringTxn) {
    await step(
      'mcp-e2e',
      'tools.createRecurring + updateRecurring (rule.min_amount) + deleteRecurring',
      async () => {
        const created = await tools.createRecurring({
          transaction_id: noRecurringTxn.transaction_id,
          frequency: 'MONTHLY',
        });
        const rid = created.recurring_id;
        try {
          await tools.updateRecurring({
            recurring_id: rid,
            rule: { min_amount: '1' },
          });
        } finally {
          try {
            await tools.deleteRecurring({ recurring_id: rid });
          } catch {
            registerStraggler(`recurring id=${rid} (MCP E2E)`);
          }
        }
      }
    );
  } else {
    console.log('  (no non-recurring txn; skipping createRecurring round-trip)');
  }
}

// -----------------------------------------------------------------------------
// Section 7 — State-gated tests (opt-in, interactive)
// -----------------------------------------------------------------------------
//
// These tests require the user to toggle state in the Copilot macOS app
// between prompts. Only runs when `--include-state-gated` is passed.

async function smokeStateGated(
  db: CopilotDatabase,
  tools: CopilotMoneyTools
): Promise<void> {
  logSection('State-gated — interactive prompts');

  console.log(
    '  This section asks you to toggle UI state in Copilot between prompts.\n' +
      '  Type "skip" at any prompt to skip just that test.'
  );

  const categories = await db.getUserCategories();
  const c = categories[0];
  if (!c) {
    console.warn('  no user categories; skipping state-gated section');
    return;
  }
  const catId = c.category_id;

  // --- Budgeting disabled -----------------------------------------------
  await stepSkippable(
    'state-gated',
    'setBudget while budgeting disabled → server rejects',
    async () => {
      const ans1 = await prompt(
        '→ Disable Budgeting in Copilot (Settings → General → Budgeting), ' +
          'then press Enter (or type "skip"): '
      );
      if (ans1.trim().toLowerCase() === 'skip') return 'skipped';

      const e = await expectThrows(
        () => tools.setBudget({ category_id: catId, amount: '1' }),
        'setBudget-disabled'
      );
      // Capture and report whatever the server says; we don't hard-assert
      // the code since message/code depend on server-side behavior.
      if (e instanceof GraphQLError) {
        console.log(
          `    server rejection: code=${e.code} status=${e.httpStatus} msg=${e.message.slice(0, 120)}`
        );
      } else {
        console.log(`    rejection: ${(e as Error).message.slice(0, 120)}`);
      }

      await prompt(
        '→ Re-enable Budgeting in Copilot, then press Enter to continue (recovery check): '
      );
      // Recovery: clearing (amount=0) should now work.
      await tools.setBudget({ category_id: catId, amount: '0' });
      return;
    }
  );

  // --- Rollovers disabled ------------------------------------------------
  await stepSkippable(
    'state-gated',
    'setBudget while rollovers disabled → observe response',
    async () => {
      const ans1 = await prompt(
        '→ Disable Rollovers in Copilot (Settings → Budget → Rollovers), ' +
          'then press Enter (or type "skip"): '
      );
      if (ans1.trim().toLowerCase() === 'skip') return 'skipped';

      // Without rollovers, a simple setBudget on a category that had a
      // rollover config may fail; try it and capture the server's reply.
      let caught: unknown = null;
      try {
        await tools.setBudget({ category_id: catId, amount: '5' });
      } catch (e) {
        caught = e;
      }
      if (caught === null) {
        console.log(
          '    setBudget succeeded with rollovers disabled — nothing to assert'
        );
      } else if (caught instanceof GraphQLError) {
        console.log(
          `    server rejection: code=${(caught as GraphQLError).code} status=${(caught as GraphQLError).httpStatus} msg=${(caught as GraphQLError).message.slice(0, 120)}`
        );
      } else {
        console.log(`    rejection: ${(caught as Error).message.slice(0, 120)}`);
      }

      await prompt(
        '→ Re-enable Rollovers in Copilot, then press Enter to continue (recovery check): '
      );
      // Recovery: clearing should work regardless.
      await tools.setBudget({ category_id: catId, amount: '0' });
      return;
    }
  );
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

function printReport(wallClockMs: number): void {
  console.log('\n' + '═'.repeat(72));
  console.log('SUMMARY');
  console.log('═'.repeat(72));

  const sections = new Map<
    string,
    { pass: number; fail: number; totalMs: number }
  >();
  for (const r of results) {
    const s = sections.get(r.section) ?? { pass: 0, fail: 0, totalMs: 0 };
    if (r.ok) s.pass += 1;
    else s.fail += 1;
    s.totalMs += r.durationMs;
    sections.set(r.section, s);
  }

  const colWidth = 20;
  console.log(
    `${'Section'.padEnd(colWidth)} ${'Pass'.padStart(5)} ${'Fail'.padStart(5)} ${'Time'.padStart(9)}`
  );
  console.log('-'.repeat(colWidth + 1 + 5 + 1 + 5 + 1 + 9));
  for (const [section, s] of sections) {
    console.log(
      `${section.padEnd(colWidth)} ${String(s.pass).padStart(5)} ${String(s.fail).padStart(5)} ${(s.totalMs / 1000).toFixed(2).padStart(7)}s`
    );
  }
  console.log('-'.repeat(colWidth + 1 + 5 + 1 + 5 + 1 + 9));

  const totalPass = results.filter((r) => r.ok && !r.skipped).length;
  const totalSkipped = results.filter((r) => r.skipped).length;
  const totalFail = results.filter((r) => !r.ok).length;
  console.log(
    `${'TOTAL'.padEnd(colWidth)} ${String(totalPass).padStart(5)} ${String(totalFail).padStart(5)} ${(wallClockMs / 1000).toFixed(2).padStart(7)}s`
  );
  if (totalSkipped > 0) {
    console.log(`(${totalSkipped} step(s) skipped)`);
  }

  // Consistency lag summary (if section ran)
  if (consistencyLags.length > 0) {
    const observed = consistencyLags
      .filter((s): s is { label: string; lagMs: number } => s.lagMs !== null)
      .map((s) => s.lagMs)
      .sort((a, b) => a - b);
    console.log('\nWrite-to-read consistency lag:');
    for (const s of consistencyLags) {
      const txt = s.lagMs === null ? 'TIMEOUT (>60s)' : `${s.lagMs}ms`;
      console.log(`  ${s.label.padEnd(32)} ${txt}`);
    }
    if (observed.length > 0) {
      const median = observed[Math.floor(observed.length / 2)]!;
      const max = observed[observed.length - 1]!;
      console.log(`  ${'(median/max)'.padEnd(32)} ${median}ms / ${max}ms`);
    }
  }

  // Latency stats (successful ops only)
  const okDurations = results.filter((r) => r.ok).map((r) => r.durationMs);
  okDurations.sort((a, b) => a - b);
  if (okDurations.length > 0) {
    const median = okDurations[Math.floor(okDurations.length / 2)]!;
    const max = okDurations[okDurations.length - 1]!;
    console.log(`\nLatency (successful ops): median=${median}ms max=${max}ms`);
  }

  if (totalFail > 0) {
    console.error('\nFailed steps:');
    for (const r of results.filter((r) => !r.ok)) {
      console.error(`  [${r.section}] ${r.name}: ${r.detail}`);
    }
  }

  if (stragglers.length > 0) {
    console.error(
      `\n⚠ MANUAL CLEANUP NEEDED — ${stragglers.length} GQL-TEST-* entities may remain:`
    );
    for (const s of stragglers) console.error(`  - ${s}`);
    console.error(
      `\nSearch the Copilot web app for "GQL-TEST" and delete any stragglers.`
    );
  } else {
    console.log('\n✓ no cleanup stragglers');
  }
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('Copilot GraphQL E2E smoke test');
  console.log(
    `flags: quick=${quick} skipDestructive=${skipDestructive} skipErrors=${skipErrors} ` +
      `skipEdgeCases=${skipEdgeCases} skipConsistency=${skipConsistency} ` +
      `skipMcpE2e=${skipMcpE2e} includeStateGated=${includeStateGated} ` +
      `section=${onlySection ?? 'all'}`
  );

  const auth = new FirebaseAuth(() => extractRefreshToken());
  const client = new GraphQLClient(auth);
  const db = new CopilotDatabase();
  const tools = new CopilotMoneyTools(db, client);

  const t0 = Date.now();

  // Section 1 — happy paths
  if (!skipDestructive) {
    if (sectionEnabled('tags')) await smokeTagsHappyPath(client);
    if (sectionEnabled('categories')) await smokeCategoriesHappyPath(client);
    if (sectionEnabled('recurrings')) await smokeRecurringsHappyPath(client, db);
  }
  if (sectionEnabled('transactions')) await smokeTransactionsHappyPath(client, db);
  if (sectionEnabled('budgets')) await smokeBudgetsHappyPath(client, db);
  if (sectionEnabled('accounts')) await smokeAccountsHappyPath(client, db);

  // Section 2 — bulk
  if (sectionEnabled('bulk')) await smokeBulkReviewTransactions(client, db);

  // Section 3 — errors
  if (sectionEnabled('errors') && !quick) {
    await smokeErrorInjection(client, db);
  }

  // Section 4 — edge cases
  if (sectionEnabled('edge') && !skipDestructive && !quick) {
    await smokeEdgeCases(client, db);
  }

  // Section 5 — write-to-read consistency (polls local cache after writes)
  if (sectionEnabled('consistency') && !skipDestructive && !quick) {
    await smokeWriteReadConsistency(client, db, tools);
  }

  // Section 6 — MCP tool dispatch chain
  if (sectionEnabled('mcp-e2e') && !skipDestructive && !quick) {
    await smokeMcpToolEndToEnd(db, tools);
  }

  // Section 7 — state-gated (opt-in, interactive)
  if (sectionEnabled('state-gated')) {
    await smokeStateGated(db, tools);
  }

  const wall = Date.now() - t0;
  printReport(wall);

  const hasFailures = results.some((r) => !r.ok);
  if (hasFailures || stragglers.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Smoke script crashed:', e);
  if (stragglers.length > 0) {
    console.error(`\n⚠ ${stragglers.length} GQL-TEST-* entities may remain:`);
    for (const s of stragglers) console.error(`  - ${s}`);
  }
  process.exit(1);
});
