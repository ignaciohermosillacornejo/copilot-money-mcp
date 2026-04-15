/**
 * E2E smoke test for GraphQL writes. Opt-in: run manually against your real
 * Copilot account. Not part of CI.
 *
 * Usage:
 *   bun run scripts/smoke-graphql.ts [--skip-destructive]
 *
 * Creates and deletes GQL-TEST-* entities. If cleanup fails, prints explicit
 * manual-cleanup instructions.
 */

import { GraphQLClient } from '../src/core/graphql/client.js';
import { FirebaseAuth } from '../src/core/auth/firebase-auth.js';
import { extractRefreshToken } from '../src/core/auth/browser-token.js';
import { CopilotDatabase } from '../src/core/database.js';

import { createTag, editTag, deleteTag } from '../src/core/graphql/tags.js';
import {
  createCategory,
  editCategory,
  deleteCategory,
} from '../src/core/graphql/categories.js';
import { editTransaction } from '../src/core/graphql/transactions.js';
import { createRecurring, deleteRecurring } from '../src/core/graphql/recurrings.js';
import { setBudget } from '../src/core/graphql/budgets.js';
import { editAccount } from '../src/core/graphql/accounts.js';

const skipDestructive = process.argv.includes('--skip-destructive');

type StepResult = { name: string; ok: boolean; detail?: string };
const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.error(`✗ ${name}: ${detail}`);
  }
}

async function main(): Promise<void> {
  const auth = new FirebaseAuth(() => extractRefreshToken());
  const client = new GraphQLClient(auth);
  const db = new CopilotDatabase();

  if (!skipDestructive) {
    await step('Tags create/edit/delete', async () => {
      const created = await createTag(client, {
        input: { name: 'GQL-TEST-TAG', colorName: 'PURPLE2' },
      });
      try {
        await editTag(client, { id: created.id, input: { name: 'GQL-TEST-TAG-2' } });
      } finally {
        await deleteTag(client, { id: created.id });
      }
    });

    await step('Categories create/edit/delete', async () => {
      const created = await createCategory(client, {
        input: {
          name: 'GQL-TEST-CAT',
          colorName: 'OLIVE1',
          emoji: '🧪',
          isExcluded: false,
        },
      });
      try {
        await editCategory(client, { id: created.id, input: { colorName: 'RED1' } });
      } finally {
        await deleteCategory(client, { id: created.id });
      }
    });

    await step('Recurrings create/delete', async () => {
      const allTxns = await db.getAllTransactions();
      const candidate = allTxns.find((t) => !t.recurring_id && t.account_id && t.item_id);
      if (!candidate) throw new Error('No transaction without a recurring found');
      if (!candidate.account_id || !candidate.item_id) {
        throw new Error(`Candidate transaction missing account_id or item_id`);
      }
      const created = await createRecurring(client, {
        input: {
          frequency: 'MONTHLY',
          transaction: {
            accountId: candidate.account_id,
            itemId: candidate.item_id,
            transactionId: candidate.transaction_id,
          },
        },
      });
      await deleteRecurring(client, { id: created.id });
    });
  }

  await step('Transaction userNotes round-trip', async () => {
    const allTxns = await db.getAllTransactions();
    const t = allTxns[0];
    if (!t) throw new Error('No transactions in local DB');
    if (!t.account_id || !t.item_id) {
      throw new Error(`Transaction ${t.transaction_id} missing account_id or item_id`);
    }
    const original = t.user_note ?? null;
    await editTransaction(client, {
      id: t.transaction_id,
      accountId: t.account_id,
      itemId: t.item_id,
      input: { userNotes: 'GQL-TEST-NOTE' },
    });
    await editTransaction(client, {
      id: t.transaction_id,
      accountId: t.account_id,
      itemId: t.item_id,
      input: { userNotes: original },
    });
  });

  await step('Budget set + clear (all-months)', async () => {
    const categories = await db.getUserCategories();
    const c = categories[0];
    if (!c) throw new Error('No user categories');
    await setBudget(client, { categoryId: c.category_id, amount: '1' });
    await setBudget(client, { categoryId: c.category_id, amount: '0' });
  });

  await step('Budget set + clear (single month)', async () => {
    const categories = await db.getUserCategories();
    const c = categories[0];
    if (!c) throw new Error('No user categories');
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await setBudget(client, { categoryId: c.category_id, amount: '1', month });
    await setBudget(client, { categoryId: c.category_id, amount: '0', month });
  });

  await step('Account rename round-trip', async () => {
    const accts = await db.getAccounts();
    const a = accts[0];
    if (!a) throw new Error('No accounts');
    const originalName = a.name;
    if (!a.item_id) throw new Error(`Account ${a.account_id} missing item_id`);
    await editAccount(client, {
      id: a.account_id,
      itemId: a.item_id,
      input: { name: 'GQL-TEST-ACCT' },
    });
    await editAccount(client, {
      id: a.account_id,
      itemId: a.item_id,
      input: { name: originalName },
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length > 0) {
    console.error('\nFailed steps:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    console.error(
      '\nIf any step created a GQL-TEST-* entity and failed before cleanup, ' +
        'check your Copilot account and remove the stragglers manually.'
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Smoke script crashed:', e);
  process.exit(1);
});
