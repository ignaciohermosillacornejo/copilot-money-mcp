/**
 * Tier-2 reversible round-trip check definitions (issue #438, Epic B #421).
 *
 * One round-trip per MCP write tool: create→verify→delete, or
 * set→verify→revert. The verification step always RE-READS the object
 * through the corresponding read query — never trusts the mutation echo —
 * because the whole point of Tier 2 is catching accepted-but-ignored
 * writes (the risk class the 2026-06 write-field audit found).
 *
 * !!! MUTATING !!! Everything in this file sends real writes to the LIVE
 * Copilot endpoint when run through scripts/smoke/roundtrip.ts. It is a
 * local, consciously-run, attended gate — never scheduled, never part of
 * `bun run smoke` (Tier 1 stays non-mutating).
 *
 * Safety model:
 * - Every created object carries the `__smoke__<timestamp>` marker in its
 *   name; names and amounts are synthetic (100/200) — no real PII.
 * - Checks only mutate objects the run itself created. The single
 *   unavoidable contact with user data is that created transactions must
 *   reference a real account_id/item_id (first account from the Accounts
 *   query, same pick as the Tier-0 read smoke); those transactions are
 *   deleted and sweep-verified in the same run.
 * - Created objects register a cleanup closure in the CleanupRegistry; the
 *   runner executes it LIFO in a `finally`, then runs a final residue
 *   sweep that fails loudly with the leftover ids.
 * - Copilot's bulk-edit mutation is NEVER used (enforced by a source-scan
 *   unit test in tests/scripts/roundtrip-coverage.test.ts).
 *
 * Coverage is ratcheted: tests/scripts/roundtrip-coverage.test.ts enforces
 * a bijection between `WRITE_TOOL_DEFS` (src/tools/registry) and the checks
 * here, and between each check's `appliesSurfaces` and the conformance
 * ledger's `Mutation.<x>:applies` entries — a new write tool cannot ship
 * without a round-trip.
 */

import type { GraphQLClient } from '../../src/core/graphql/client.js';
import {
  createTransaction,
  deleteTransaction,
  editTransaction,
  addTransactionToRecurring,
  splitTransaction,
} from '../../src/core/graphql/transactions.js';
import { createTag, editTag, deleteTag } from '../../src/core/graphql/tags.js';
import { createCategory, editCategory, deleteCategory } from '../../src/core/graphql/categories.js';
import { setBudget } from '../../src/core/graphql/budgets.js';
import {
  createRecurring,
  editRecurring,
  deleteRecurring,
  type RecurringStateValue,
} from '../../src/core/graphql/recurrings.js';
import { fetchAccounts } from '../../src/core/graphql/queries/accounts.js';
import { fetchTags } from '../../src/core/graphql/queries/tags.js';
import { fetchCategories, type CategoryBudget } from '../../src/core/graphql/queries/categories.js';
import { fetchRecurrings } from '../../src/core/graphql/queries/recurrings.js';
import {
  buildTransactionFilter,
  buildTransactionSort,
  fetchTransactionsPage,
  paginateTransactions,
  type TransactionNode,
} from '../../src/core/graphql/queries/transactions.js';

// ---------------------------------------------------------------------------
// Marker convention
// ---------------------------------------------------------------------------

/** Every object this suite creates carries this prefix in its name. */
export const MARKER_PREFIX = '__smoke__';

/** Per-run marker, e.g. `__smoke__1765432100000`. */
export function makeMarker(now: number = Date.now()): string {
  return `${MARKER_PREFIX}${String(now)}`;
}

// ---------------------------------------------------------------------------
// Cleanup registry
// ---------------------------------------------------------------------------

export type RoundtripLog = (msg: string, fields?: Record<string, unknown>) => void;

export type CleanupKind = 'tag' | 'category' | 'transaction' | 'recurring';

export interface CleanupItem {
  kind: CleanupKind;
  id: string;
  /** Marker-bearing label (synthetic — safe to log). */
  label: string;
  cleanup: () => Promise<void>;
}

export interface CleanupFailure {
  kind: CleanupKind;
  id: string;
  label: string;
  error: string;
}

/**
 * Tracks every object the run created and still owns. Checks that delete
 * their target themselves (delete_tag, delete_transaction, ...) call
 * `remove()` after VERIFYING the deletion; everything else is deleted LIFO
 * by `runAll()` in the runner's `finally`.
 */
export class CleanupRegistry {
  private items: CleanupItem[] = [];

  add(item: CleanupItem): void {
    this.items.push(item);
  }

  /** Deregister after a check has already deleted (and verified) the object. */
  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
  }

  get pending(): ReadonlyArray<Omit<CleanupItem, 'cleanup'>> {
    return this.items.map(({ kind, id, label }) => ({ kind, id, label }));
  }

  /**
   * Delete every still-registered object, LIFO (dependents before their
   * dependencies). Never throws — failures are collected and returned so
   * the runner reports every leftover id loudly instead of dying on the
   * first one.
   */
  async runAll(log: RoundtripLog): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = [];
    while (this.items.length > 0) {
      const item = this.items.pop()!;
      try {
        await item.cleanup();
        log(`cleanup: deleted ${item.kind} '${item.label}'`, { id: item.id });
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ kind: item.kind, id: item.id, label: item.label, error });
        log(`cleanup: FAILED to delete ${item.kind} '${item.label}'`, { id: item.id, error });
      }
    }
    return failures;
  }
}

// ---------------------------------------------------------------------------
// Run context + shared helpers
// ---------------------------------------------------------------------------

export interface RoundtripAccountRef {
  accountId: string;
  itemId: string;
}

export interface RoundtripState {
  marker: string;
  /** First account from the Accounts query — host for created transactions. */
  account?: RoundtripAccountRef;
  tagId?: string;
  categoryId?: string;
  recurringId?: string;
  /** Primary smoke transaction (created/edited/reviewed/deleted across checks). */
  txnA?: { id: string } & RoundtripAccountRef;
}

export interface RoundtripContext {
  client: GraphQLClient;
  state: RoundtripState;
  registry: CleanupRegistry;
  log: RoundtripLog;
}

/** Returned for a deliberately skipped check; failures THROW instead. */
export interface RoundtripOutcome {
  skipped?: string;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// --- re-read helpers (verification always goes through these) ---------------

async function readTransactionsByMarker(
  client: GraphQLClient,
  search: string
): Promise<TransactionNode[]> {
  const filter = buildTransactionFilter({ matchString: search });
  return paginateTransactions(
    (after) =>
      fetchTransactionsPage(client, { first: 25, after, filter, sort: buildTransactionSort() }),
    {}
  );
}

async function readTransactionById(
  client: GraphQLClient,
  marker: string,
  id: string
): Promise<TransactionNode | undefined> {
  const rows = await readTransactionsByMarker(client, marker);
  return rows.find((node) => node.id === id);
}

async function readSmokeCategoryBudget(
  client: GraphQLClient,
  categoryId: string
): Promise<CategoryBudget | null | undefined> {
  const rows = await fetchCategories(client, { rollovers: false });
  return rows.find((cat) => cat.id === categoryId)?.budget;
}

/**
 * Resolve the budget amount visible for a month (YYYY-MM). Accepts either
 * `amount` or `resolvedAmount` — which of the two reflects a freshly-set
 * default budget is an assumption that stays unverified until the first
 * attended run; drift to NEITHER fails the check.
 */
export function budgetAmountForMonth(
  budget: CategoryBudget | null | undefined,
  month: string
): number | undefined {
  const nodes = [budget?.current, ...(budget?.histories ?? [])].filter(
    (node): node is NonNullable<typeof node> => node != null
  );
  const node = nodes.find((candidate) => candidate.month.startsWith(month));
  const raw = node?.amount ?? node?.resolvedAmount;
  if (raw == null) return undefined;
  return Number.isFinite(raw) ? raw : undefined;
}

// --- lazily-created prerequisites (support `--only <domain>` runs) ----------

async function ensureAccount(ctx: RoundtripContext): Promise<RoundtripAccountRef> {
  if (!ctx.state.account) {
    const rows = await fetchAccounts(ctx.client);
    const first = rows[0];
    check(
      first,
      'prereq: the Accounts query returned no accounts — cannot host smoke transactions'
    );
    ctx.state.account = { accountId: first.id, itemId: first.itemId };
    // Account name/balance are real user data — log only that a pick happened.
    ctx.log('prereq: using the first account from the Accounts query as transaction host');
  }
  return ctx.state.account;
}

async function ensureCategory(ctx: RoundtripContext): Promise<string> {
  if (!ctx.state.categoryId) {
    const name = `${ctx.state.marker}-cat`;
    const created = await createCategory(ctx.client, {
      input: { name, colorName: 'GREEN1', emoji: '🧪', isExcluded: false },
    });
    ctx.state.categoryId = created.id;
    ctx.registry.add({
      kind: 'category',
      id: created.id,
      label: name,
      cleanup: () => deleteCategory(ctx.client, { id: created.id }).then(() => undefined),
    });
    ctx.log(`prereq: created category '${name}'`, { id: created.id });
  }
  return ctx.state.categoryId;
}

async function createSmokeTransaction(
  ctx: RoundtripContext,
  suffix: string,
  amount: number
): Promise<{ id: string } & RoundtripAccountRef> {
  const account = await ensureAccount(ctx);
  const categoryId = await ensureCategory(ctx);
  const name = `${ctx.state.marker}-${suffix}`;
  const created = await createTransaction(ctx.client, {
    accountId: account.accountId,
    itemId: account.itemId,
    input: { name, date: todayIso(), amount, categoryId, type: 'REGULAR' },
  });
  const ref = { id: created.id, ...account };
  ctx.registry.add({
    kind: 'transaction',
    id: created.id,
    label: name,
    cleanup: () =>
      deleteTransaction(ctx.client, {
        id: created.id,
        accountId: account.accountId,
        itemId: account.itemId,
      }).then(() => undefined),
  });
  ctx.log(`prereq: created transaction '${name}'`, { id: created.id });
  return ref;
}

async function ensureTxnA(ctx: RoundtripContext): Promise<{ id: string } & RoundtripAccountRef> {
  if (!ctx.state.txnA) {
    ctx.state.txnA = await createSmokeTransaction(ctx, 'txn-a', 100);
  }
  return ctx.state.txnA;
}

// ---------------------------------------------------------------------------
// The checks — one per write tool, in run order (creates before mutators
// before deletes, so a full run is itself a create→mutate→delete arc).
// ---------------------------------------------------------------------------

export const ROUNDTRIP_DOMAINS = [
  'tags',
  'categories',
  'budgets',
  'transactions',
  'recurring',
] as const;
export type RoundtripDomain = (typeof ROUNDTRIP_DOMAINS)[number];

export interface RoundtripCheck {
  /** MCP write-tool name — must exist in WRITE_TOOL_DEFS (ratchet-tested). */
  tool: string;
  domain: RoundtripDomain;
  /** One-line plan entry: flow → target object (printed by --list). */
  flow: string;
  /** Ledger `Mutation.<x>:applies` surfaces this check verifies. */
  appliesSurfaces: readonly string[];
  run: (ctx: RoundtripContext) => Promise<RoundtripOutcome | undefined>;
}

export const ROUNDTRIP_CHECKS: readonly RoundtripCheck[] = [
  {
    tool: 'create_tag',
    domain: 'tags',
    flow: 'create marker tag → verify via Tags re-read (deleted by the delete_tag check)',
    appliesSurfaces: ['Mutation.createTag:applies'],
    run: async (ctx) => {
      const name = `${ctx.state.marker}-tag`;
      const created = await createTag(ctx.client, { input: { name, colorName: 'BLUE1' } });
      ctx.state.tagId = created.id;
      ctx.registry.add({
        kind: 'tag',
        id: created.id,
        label: name,
        cleanup: () => deleteTag(ctx.client, { id: created.id }).then(() => undefined),
      });
      const after = (await fetchTags(ctx.client)).find((tag) => tag.id === created.id);
      check(after, `create_tag: created id ${created.id} missing from Tags re-read`);
      check(after.name === name, `create_tag: re-read name '${after.name}', expected '${name}'`);
      check(
        after.colorName === 'BLUE1',
        `create_tag: re-read colorName '${String(after.colorName)}', expected 'BLUE1'`
      );
      return undefined;
    },
  },
  {
    tool: 'update_tag',
    domain: 'tags',
    flow: 'rename + recolor the run-created tag → verify via Tags re-read',
    appliesSurfaces: ['Mutation.editTag:applies'],
    run: async (ctx) => {
      const tagId = ctx.state.tagId;
      if (!tagId) return { skipped: 'no run-created tag (create_tag did not pass)' };
      const name = `${ctx.state.marker}-tag-edited`;
      await editTag(ctx.client, { id: tagId, input: { name, colorName: 'RED1' } });
      const after = (await fetchTags(ctx.client)).find((tag) => tag.id === tagId);
      check(after, `update_tag: tag ${tagId} missing from Tags re-read`);
      check(
        after.name === name,
        `update_tag: write accepted but re-read name is '${after.name}', expected '${name}'`
      );
      check(
        after.colorName === 'RED1',
        `update_tag: write accepted but re-read colorName is '${String(after.colorName)}', expected 'RED1'`
      );
      return undefined;
    },
  },
  {
    tool: 'create_category',
    domain: 'categories',
    flow: 'create marker category → verify via Categories re-read (deleted by delete_category)',
    appliesSurfaces: ['Mutation.createCategory:applies'],
    run: async (ctx) => {
      const categoryId = await ensureCategory(ctx);
      const after = (await fetchCategories(ctx.client, { rollovers: false })).find(
        (cat) => cat.id === categoryId
      );
      check(after, `create_category: created id ${categoryId} missing from Categories re-read`);
      check(
        after.name === `${ctx.state.marker}-cat`,
        `create_category: re-read name '${after.name}', expected '${ctx.state.marker}-cat'`
      );
      check(
        after.colorName === 'GREEN1',
        `create_category: re-read colorName '${String(after.colorName)}', expected 'GREEN1'`
      );
      check(after.isExcluded === false, 'create_category: re-read isExcluded should be false');
      return undefined;
    },
  },
  {
    tool: 'update_category',
    domain: 'categories',
    flow: 'rename + toggle isExcluded on the run-created category → verify via Categories re-read',
    appliesSurfaces: ['Mutation.editCategory:applies'],
    run: async (ctx) => {
      const categoryId = ctx.state.categoryId;
      if (!categoryId) return { skipped: 'no run-created category (create_category did not pass)' };
      const name = `${ctx.state.marker}-cat-edited`;
      try {
        await editCategory(ctx.client, { id: categoryId, input: { name, isExcluded: true } });
        const after = (await fetchCategories(ctx.client, { rollovers: false })).find(
          (cat) => cat.id === categoryId
        );
        check(after, `update_category: category ${categoryId} missing from Categories re-read`);
        check(
          after.name === name,
          `update_category: write accepted but re-read name is '${after.name}', expected '${name}'`
        );
        check(
          after.isExcluded === true,
          'update_category: write accepted but re-read isExcluded is still false'
        );
      } finally {
        // Restore isExcluded=false even when verification failed, so the
        // set_budget check downstream sees a normal (non-excluded) category
        // (the category itself is deleted at the end either way).
        try {
          await editCategory(ctx.client, { id: categoryId, input: { isExcluded: false } });
        } catch (err: unknown) {
          ctx.log('update_category: WARNING — failed to restore isExcluded', {
            categoryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return undefined;
    },
  },
  {
    tool: 'set_budget',
    domain: 'budgets',
    flow: 'set default budget 100 then monthly budget 200 on the run-created category → verify via Categories budget re-read → clear both',
    appliesSurfaces: [
      'Mutation.editCategoryBudget:applies',
      'Mutation.editCategoryBudgetMonthly:applies',
    ],
    run: async (ctx) => {
      const categoryId = await ensureCategory(ctx);
      const month = currentMonth();
      try {
        // Default branch (Mutation.editCategoryBudget).
        await setBudget(ctx.client, { categoryId, amount: '100' });
        let amount = budgetAmountForMonth(
          await readSmokeCategoryBudget(ctx.client, categoryId),
          month
        );
        check(
          amount === 100,
          `set_budget(default): re-read budget for ${month} is ${String(amount)}, expected 100`
        );
        // Monthly branch (Mutation.editCategoryBudgetMonthly).
        await setBudget(ctx.client, { categoryId, amount: '200', month });
        amount = budgetAmountForMonth(await readSmokeCategoryBudget(ctx.client, categoryId), month);
        check(
          amount === 200,
          `set_budget(monthly): re-read budget for ${month} is ${String(amount)}, expected 200`
        );
      } finally {
        // Revert both branches to the cleared state ('0') even if a verify
        // failed mid-flight — the category is run-created and deleted in
        // cleanup, but leave no budget behind if that deletion ever fails.
        try {
          await setBudget(ctx.client, { categoryId, amount: '0', month });
          await setBudget(ctx.client, { categoryId, amount: '0' });
        } catch (err: unknown) {
          ctx.log('set_budget: WARNING — failed to clear the smoke budget', {
            categoryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return undefined;
    },
  },
  {
    tool: 'create_transaction',
    domain: 'transactions',
    flow: 'create marker transaction (amount 100) on the first account → verify via Transactions re-read (deleted by delete_transaction)',
    appliesSurfaces: ['Mutation.createTransaction:applies'],
    run: async (ctx) => {
      const txn = await ensureTxnA(ctx);
      const after = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
      check(after, `create_transaction: created id ${txn.id} missing from Transactions re-read`);
      check(
        after.name === `${ctx.state.marker}-txn-a`,
        `create_transaction: re-read name '${after.name}', expected '${ctx.state.marker}-txn-a'`
      );
      // Sign convention (expense vs income) is the server's business — assert
      // magnitude so a flipped sign doesn't mask an ignored amount.
      check(
        Math.abs(after.amount) === 100,
        `create_transaction: re-read |amount| ${String(Math.abs(after.amount))}, expected 100`
      );
      check(
        after.categoryId === ctx.state.categoryId,
        'create_transaction: re-read categoryId does not match the requested category'
      );
      check(after.type === 'REGULAR', `create_transaction: re-read type '${after.type}'`);
      return undefined;
    },
  },
  {
    tool: 'update_transaction',
    domain: 'transactions',
    flow: 'rename + set note + flip date -3d + flip type→INTERNAL_TRANSFER and verify category cleared on the run-created transaction → verify via Transactions re-read → revert type/category',
    appliesSurfaces: ['Mutation.editTransaction:applies'],
    run: async (ctx) => {
      const txn = ctx.state.txnA;
      if (!txn) return { skipped: 'no run-created transaction (create_transaction did not pass)' };
      const name = `${ctx.state.marker}-txn-a-edited`;
      const note = `${ctx.state.marker} note`;
      await editTransaction(ctx.client, {
        id: txn.id,
        accountId: txn.accountId,
        itemId: txn.itemId,
        input: { name, userNotes: note },
      });
      const after = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
      check(after, `update_transaction: transaction ${txn.id} missing from re-read`);
      check(
        after.name === name,
        `update_transaction: write accepted but re-read name is '${after.name}', expected '${name}'`
      );
      check(
        after.userNotes === note,
        `update_transaction: write accepted but re-read userNotes is '${String(after.userNotes)}', expected '${note}'`
      );

      // date round-trip (#569). The txn was created with today's date; move it
      // back 3 days. The echo is checked, but persistence is pinned via an
      // independent re-read (the echo proves the write was accepted, not that
      // the value reached storage). This is a run-created transaction — not
      // sourced from an institution sync, and no sync fires during the run — so
      // nothing reverts the date mid-run.
      const newDate = daysAgoIso(3);
      const dateEcho = await editTransaction(ctx.client, {
        id: txn.id,
        accountId: txn.accountId,
        itemId: txn.itemId,
        input: { date: newDate },
      });
      check(
        dateEcho.changed.date === newDate,
        `update_transaction: date echo is '${String(dateEcho.changed.date)}', expected '${newDate}'`
      );
      const afterDate = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
      check(afterDate, `update_transaction: transaction ${txn.id} missing from date re-read`);
      check(
        afterDate.date === newDate,
        `update_transaction: date write not persisted; re-read date is '${afterDate.date}', expected '${newDate}' (YYYY-MM-DD)`
      );

      // type round-trip (#415). INTERNAL_TRANSFER avoids INCOME's net-positive
      // sign rule and exercises the verified behavior: the server applies the
      // type AND silently clears the category. Pin both via re-read, then revert.
      try {
        await editTransaction(ctx.client, {
          id: txn.id,
          accountId: txn.accountId,
          itemId: txn.itemId,
          input: { type: 'INTERNAL_TRANSFER' },
        });
        const afterType = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
        check(afterType, `update_transaction: transaction ${txn.id} missing from type re-read`);
        check(
          afterType.type === 'INTERNAL_TRANSFER',
          `update_transaction: type write not applied; re-read type is '${afterType.type}', expected INTERNAL_TRANSFER`
        );
        check(
          !afterType.categoryId,
          `update_transaction: INTERNAL_TRANSFER must clear the category, but re-read categoryId is '${String(afterType.categoryId)}'`
        );
      } finally {
        // Restore REGULAR + the original category so downstream checks (e.g.
        // create_recurring) see a normal categorized transaction.
        await editTransaction(ctx.client, {
          id: txn.id,
          accountId: txn.accountId,
          itemId: txn.itemId,
          input: { type: 'REGULAR', categoryId: ctx.state.categoryId },
        });
      }
      return undefined;
    },
  },
  {
    tool: 'review_transactions',
    domain: 'transactions',
    flow: 'capture isReviewed on the run-created transaction → flip → verify via re-read → restore original in finally',
    appliesSurfaces: ['Mutation.editTransaction:applies'],
    run: async (ctx) => {
      const txn = ctx.state.txnA;
      if (!txn) return { skipped: 'no run-created transaction (create_transaction did not pass)' };
      const before = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
      check(before, `review_transactions: transaction ${txn.id} missing from pre-read`);
      const original = before.isReviewed;
      const flipped = !original;
      try {
        await editTransaction(ctx.client, {
          id: txn.id,
          accountId: txn.accountId,
          itemId: txn.itemId,
          input: { isReviewed: flipped },
        });
        const after = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
        check(
          after?.isReviewed === flipped,
          `review_transactions: write accepted but re-read isReviewed is ` +
            `${String(after?.isReviewed)}, expected ${String(flipped)}`
        );
      } finally {
        // Restore the captured original even when verification failed.
        try {
          await editTransaction(ctx.client, {
            id: txn.id,
            accountId: txn.accountId,
            itemId: txn.itemId,
            input: { isReviewed: original },
          });
        } catch (err: unknown) {
          ctx.log('review_transactions: WARNING — failed to restore isReviewed', {
            id: txn.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return undefined;
    },
  },
  {
    tool: 'create_recurring',
    domain: 'recurring',
    flow: 'create recurring (MONTHLY) from the run-created transaction → verify via Recurrings re-read (deleted by delete_recurring)',
    appliesSurfaces: ['Mutation.createRecurring:applies'],
    run: async (ctx) => {
      const txn = await ensureTxnA(ctx);
      const created = await createRecurring(ctx.client, {
        input: {
          frequency: 'MONTHLY',
          transaction: { accountId: txn.accountId, itemId: txn.itemId, transactionId: txn.id },
        },
      });
      ctx.state.recurringId = created.id;
      ctx.registry.add({
        kind: 'recurring',
        id: created.id,
        // Deliberately NOT `created.name`: the server derives the recurring's
        // name (usually from the marker-bearing transaction, but that
        // derivation is the server's), and labels are logged — so a
        // server-derived name could leak real merchant data into output.
        // A synthetic marker label keeps logs PII-safe regardless.
        label: `${ctx.state.marker}-recurring`,
        cleanup: () => deleteRecurring(ctx.client, { id: created.id }).then(() => undefined),
      });
      const after = (await fetchRecurrings(ctx.client)).find((rec) => rec.id === created.id);
      check(after, `create_recurring: created id ${created.id} missing from Recurrings re-read`);
      check(
        after.frequency.toUpperCase() === 'MONTHLY',
        `create_recurring: re-read frequency '${after.frequency}', expected MONTHLY`
      );
      return undefined;
    },
  },
  {
    tool: 'update_recurring',
    domain: 'recurring',
    flow: 'flip the run-created recurring MONTHLY→WEEKLY → verify via Recurrings re-read',
    appliesSurfaces: ['Mutation.editRecurring:applies'],
    run: async (ctx) => {
      const recurringId = ctx.state.recurringId;
      if (!recurringId)
        return { skipped: 'no run-created recurring (create_recurring did not pass)' };
      await editRecurring(ctx.client, { id: recurringId, input: { frequency: 'WEEKLY' } });
      const after = (await fetchRecurrings(ctx.client)).find((rec) => rec.id === recurringId);
      check(after, `update_recurring: recurring ${recurringId} missing from re-read`);
      check(
        after.frequency.toUpperCase() === 'WEEKLY',
        `update_recurring: write accepted but re-read frequency is '${after.frequency}', expected WEEKLY`
      );
      return undefined;
    },
  },
  {
    tool: 'set_recurring_state',
    domain: 'recurring',
    flow: 'capture state on the run-created recurring → flip ACTIVE↔PAUSED → verify via re-read → restore original in finally',
    appliesSurfaces: ['Mutation.editRecurring:applies'],
    run: async (ctx) => {
      const recurringId = ctx.state.recurringId;
      if (!recurringId)
        return { skipped: 'no run-created recurring (create_recurring did not pass)' };
      const before = (await fetchRecurrings(ctx.client)).find((rec) => rec.id === recurringId);
      check(before, `set_recurring_state: recurring ${recurringId} missing from pre-read`);
      const original = before.state.toUpperCase() as RecurringStateValue;
      const flipped: RecurringStateValue = original === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
      try {
        await editRecurring(ctx.client, { id: recurringId, input: { state: flipped } });
        const after = (await fetchRecurrings(ctx.client)).find((rec) => rec.id === recurringId);
        check(
          after?.state.toUpperCase() === flipped,
          `set_recurring_state: write accepted but re-read state is ` +
            `'${String(after?.state)}', expected ${flipped}`
        );
      } finally {
        // Restore the captured original even when verification failed.
        try {
          await editRecurring(ctx.client, { id: recurringId, input: { state: original } });
        } catch (err: unknown) {
          ctx.log('set_recurring_state: WARNING — failed to restore state', {
            id: recurringId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return undefined;
    },
  },
  {
    tool: 'add_transaction_to_recurring',
    domain: 'recurring',
    flow: 'create a second marker transaction → attach to the run-created recurring → verify recurringId via re-read',
    appliesSurfaces: ['Mutation.addTransactionToRecurring:applies'],
    run: async (ctx) => {
      const recurringId = ctx.state.recurringId;
      if (!recurringId)
        return { skipped: 'no run-created recurring (create_recurring did not pass)' };
      const txnB = await createSmokeTransaction(ctx, 'txn-b', 100);
      await addTransactionToRecurring(ctx.client, {
        id: txnB.id,
        accountId: txnB.accountId,
        itemId: txnB.itemId,
        input: { recurringId },
      });
      const after = await readTransactionById(ctx.client, ctx.state.marker, txnB.id);
      check(after, `add_transaction_to_recurring: transaction ${txnB.id} missing from re-read`);
      check(
        after.recurringId === recurringId,
        `add_transaction_to_recurring: write accepted but re-read recurringId is ` +
          `${String(after.recurringId)}, expected the smoke recurring`
      );
      return undefined;
    },
  },
  {
    tool: 'split_transaction',
    domain: 'transactions',
    flow: 'create a third marker transaction (amount 200) → split into 2×100 children → verify children via re-read (no unsplit mutation exists; parent + children are all run-created and deleted in cleanup)',
    appliesSurfaces: ['Mutation.splitTransaction:applies'],
    run: async (ctx) => {
      const parent = await createSmokeTransaction(ctx, 'txn-c', 200);
      const date = todayIso();
      const categoryId = await ensureCategory(ctx);
      const result = await splitTransaction(ctx.client, {
        id: parent.id,
        accountId: parent.accountId,
        itemId: parent.itemId,
        input: [
          { name: `${ctx.state.marker}-split-a`, date, amount: 100, categoryId },
          { name: `${ctx.state.marker}-split-b`, date, amount: 100, categoryId },
        ],
      });
      for (const child of result.splitTransactions) {
        ctx.registry.add({
          kind: 'transaction',
          id: child.id,
          label: child.name,
          cleanup: () =>
            deleteTransaction(ctx.client, {
              id: child.id,
              accountId: parent.accountId,
              itemId: parent.itemId,
            }).then(() => undefined),
        });
      }
      // Verify via RE-READ, not the mutation echo: both children must come
      // back from the Transactions query pointing at the parent. (Copilot
      // hides the parent in its UI after a split but does not delete it —
      // cleanup deletes children and parent explicitly.)
      const rows = await readTransactionsByMarker(ctx.client, ctx.state.marker);
      const children = rows.filter((node) => node.parentId === parent.id);
      check(
        children.length === 2,
        `split_transaction: re-read found ${String(children.length)} children with ` +
          `parentId=${parent.id}, expected 2`
      );
      for (const child of children) {
        check(
          Math.abs(child.amount) === 100,
          `split_transaction: child ${child.id} re-read |amount| ` +
            `${String(Math.abs(child.amount))}, expected 100`
        );
      }
      return undefined;
    },
  },
  {
    tool: 'delete_recurring',
    domain: 'recurring',
    flow: 'delete the run-created recurring → verify absence via Recurrings re-read',
    appliesSurfaces: ['Mutation.deleteRecurring:applies'],
    run: async (ctx) => {
      const recurringId = ctx.state.recurringId;
      if (!recurringId)
        return { skipped: 'no run-created recurring (create_recurring did not pass)' };
      await deleteRecurring(ctx.client, { id: recurringId });
      const after = (await fetchRecurrings(ctx.client)).find((rec) => rec.id === recurringId);
      check(
        after === undefined,
        `delete_recurring: recurring ${recurringId} still present on re-read`
      );
      ctx.registry.remove(recurringId);
      ctx.state.recurringId = undefined;
      return undefined;
    },
  },
  {
    tool: 'delete_transaction',
    domain: 'transactions',
    flow: 'delete the run-created transaction → verify absence via Transactions re-read',
    appliesSurfaces: ['Mutation.deleteTransaction:applies'],
    run: async (ctx) => {
      const txn = ctx.state.txnA;
      if (!txn) return { skipped: 'no run-created transaction (create_transaction did not pass)' };
      await deleteTransaction(ctx.client, {
        id: txn.id,
        accountId: txn.accountId,
        itemId: txn.itemId,
      });
      const after = await readTransactionById(ctx.client, ctx.state.marker, txn.id);
      check(after === undefined, `delete_transaction: ${txn.id} still present on re-read`);
      ctx.registry.remove(txn.id);
      ctx.state.txnA = undefined;
      return undefined;
    },
  },
  {
    tool: 'delete_tag',
    domain: 'tags',
    flow: 'delete the run-created tag → verify absence via Tags re-read',
    appliesSurfaces: ['Mutation.deleteTag:applies'],
    run: async (ctx) => {
      const tagId = ctx.state.tagId;
      if (!tagId) return { skipped: 'no run-created tag (create_tag did not pass)' };
      await deleteTag(ctx.client, { id: tagId });
      const after = (await fetchTags(ctx.client)).find((tag) => tag.id === tagId);
      check(after === undefined, `delete_tag: tag ${tagId} still present on re-read`);
      ctx.registry.remove(tagId);
      ctx.state.tagId = undefined;
      return undefined;
    },
  },
  {
    tool: 'delete_category',
    domain: 'categories',
    flow: 'delete the run-created category → verify absence via Categories re-read',
    appliesSurfaces: ['Mutation.deleteCategory:applies'],
    run: async (ctx) => {
      const categoryId = ctx.state.categoryId;
      if (!categoryId) return { skipped: 'no run-created category (create_category did not pass)' };
      await deleteCategory(ctx.client, { id: categoryId });
      const after = (await fetchCategories(ctx.client, { rollovers: false })).find(
        (cat) => cat.id === categoryId
      );
      check(
        after === undefined,
        `delete_category: category ${categoryId} still present on re-read`
      );
      ctx.registry.remove(categoryId);
      ctx.state.categoryId = undefined;
      return undefined;
    },
  },
];

// ---------------------------------------------------------------------------
// Residue detection — shared by the pre-flight check and the final sweep
// ---------------------------------------------------------------------------

export interface ResidueRecord {
  kind: CleanupKind;
  id: string;
  name: string;
}

export interface ResidueReaders {
  tags: () => Promise<Array<{ id: string; name: string }>>;
  categories: () => Promise<Array<{ id: string; name: string }>>;
  recurrings: () => Promise<Array<{ id: string; name: string }>>;
  /** Server-side matchString search for MARKER_PREFIX. */
  transactions: () => Promise<Array<{ id: string; name: string }>>;
}

/**
 * Recurrings are the one collection whose names the SERVER derives (from
 * the source transaction), so a crashed prior run may have left a recurring
 * whose name was normalized away from the raw `__smoke__` marker. The
 * word-boundary regex catches 'Smoke 176...' style derivations without
 * matching e.g. 'Smokehouse BBQ'.
 *
 * Known approximation: a real recurring whose name contains the standalone
 * word ("Smoke's BBQ", "Smoke Shop") WILL match, and the pre-flight check
 * will refuse to start. That's the safe direction for an attended local
 * gate — a false refusal is a one-line message the maintainer can act on,
 * while a false negative would leave residue undetected.
 */
const RECURRING_RESIDUE_RE = /\bsmoke\b/i;

export function isResidueName(kind: CleanupKind, name: string): boolean {
  if (name.includes(MARKER_PREFIX)) return true;
  if (kind === 'recurring') return RECURRING_RESIDUE_RE.test(name);
  return false;
}

/** Every marker-bearing object currently visible on the server. */
export async function collectResidue(readers: ResidueReaders): Promise<ResidueRecord[]> {
  const sources: ReadonlyArray<[CleanupKind, ResidueReaders[keyof ResidueReaders]]> = [
    ['tag', readers.tags],
    ['category', readers.categories],
    ['recurring', readers.recurrings],
    ['transaction', readers.transactions],
  ];
  const residue: ResidueRecord[] = [];
  for (const [kind, read] of sources) {
    for (const row of await read()) {
      if (isResidueName(kind, row.name)) residue.push({ kind, id: row.id, name: row.name });
    }
  }
  return residue;
}

export function buildResidueReaders(client: GraphQLClient): ResidueReaders {
  return {
    tags: () => fetchTags(client),
    categories: () => fetchCategories(client, { rollovers: false }),
    recurrings: () => fetchRecurrings(client),
    transactions: () => readTransactionsByMarker(client, MARKER_PREFIX),
  };
}

// ---------------------------------------------------------------------------
// Runner plumbing (kept here so it stays unit-testable without executing
// scripts/smoke/roundtrip.ts, whose import runs main()).
// ---------------------------------------------------------------------------

export interface RoundtripArgs {
  /** Print the plan and exit without auth or mutations. */
  list: boolean;
  /** Restrict the run to one domain's checks. */
  only?: RoundtripDomain;
}

export function parseRoundtripArgs(argv: readonly string[]): RoundtripArgs {
  const args: RoundtripArgs = { list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--list') {
      args.list = true;
    } else if (arg === '--only') {
      const value = argv[++i];
      if (!value || !(ROUNDTRIP_DOMAINS as readonly string[]).includes(value)) {
        throw new Error(
          `--only requires one of: ${ROUNDTRIP_DOMAINS.join(', ')} (got '${value ?? ''}')`
        );
      }
      args.only = value as RoundtripDomain;
    } else {
      throw new Error(`unknown argument '${arg}' (usage: roundtrip.ts [--list] [--only <domain>])`);
    }
  }
  return args;
}

/** Human-readable plan, printed by --list and at the start of a real run. */
export function formatPlan(checks: readonly RoundtripCheck[]): string {
  const width = Math.max(...checks.map((c) => c.tool.length), 'TOOL'.length);
  const lines = checks.map(
    (c, i) => `  ${String(i + 1).padStart(2)}. ${c.tool.padEnd(width)}  [${c.domain}]  ${c.flow}`
  );
  return [`[roundtrip] Plan — ${String(checks.length)} round-trips:`, ...lines].join('\n');
}
