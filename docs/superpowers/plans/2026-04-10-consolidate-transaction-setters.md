# Consolidate Transaction Setters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse 7 single-field transaction setter tools (`set_transaction_category`, `set_transaction_note`, `set_transaction_tags`, `set_transaction_excluded`, `set_transaction_name`, `set_internal_transfer`, `set_transaction_goal`) into one multi-field `update_transaction` tool. Net tool count: 41 → 35.

**Architecture:** The 7 setters all target the same Firestore path (`items/{item_id}/accounts/{account_id}/transactions/{id}`) and route through shared helpers. The new tool builds two parallel field maps (`firestoreFields` for wire, `cacheFields` for in-memory model) by key presence, then issues a single atomic `updateDocument` call. `goal_id: null` is special-cased: Firestore gets `""`, cache gets `undefined`. The `writeTransactionFields` helper is deleted as dead code (all 6 callers are among the removed setters; `setTransactionGoal` and `reviewTransactions` both inline their own `updateDocument` calls today).

**Tech Stack:** TypeScript, Bun test runner, MCP SDK (JSON Schema with `additionalProperties: false` for strict validation), Firestore REST client.

**Spec reference:** [`docs/superpowers/specs/2026-04-10-consolidate-transaction-setters-design.md`](../specs/2026-04-10-consolidate-transaction-setters-design.md)

**Branch:** `feat/consolidate-transaction-setters` (already created off `main`; spec already committed).

---

## Before starting

- Work on branch `feat/consolidate-transaction-setters`. The design spec is already committed.
- Baseline: `bun test` should show **1629 pass, 0 fail** before any changes.
- Run this check before starting to confirm: `bun test --bail 2>&1 | tail -5`

---

## Task 1: Write failing unit tests for `updateTransaction`

**Files:**
- Create: `tests/tools/update-transaction.test.ts`

The goal is a brand-new unit test file that exercises every behavior from the spec's testing strategy. Tests will fail initially because the method doesn't exist — that's the TDD red state.

- [ ] **Step 1: Create the test file with complete test suite**

Create `tests/tools/update-transaction.test.ts` with this exact content:

```typescript
/**
 * Unit tests for the consolidated update_transaction tool.
 *
 * Covers the 7 fields previously split across setTransactionCategory,
 * setTransactionNote, setTransactionTags, setTransactionExcluded,
 * setTransactionName, setInternalTransfer, and setTransactionGoal.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

interface UpdateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
  mask: string[];
}

function makeMockFirestoreClient(updateCalls: UpdateCall[]) {
  return {
    requireUserId: async () => 'user123',
    getUserId: () => 'user123',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
      updateCalls.push({ collection, docId, fields, mask });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDocument: async () => {},
    deleteDocument: async () => {},
  };
}

function makeTools(overrides?: {
  transactions?: unknown[];
  goals?: unknown[];
  categories?: unknown[];
}) {
  const mockDb = new CopilotDatabase('/nonexistent');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any).dbPath = '/fake';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._transactions = overrides?.transactions ?? [
    {
      transaction_id: 'txn1',
      amount: 50,
      date: '2024-01-15',
      name: 'Coffee Shop',
      category_id: 'food',
      user_note: 'pre-existing note',
      user_id: 'user123',
      item_id: 'item1',
      account_id: 'acct1',
      tag_ids: [],
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._goals = overrides?.goals ?? [
    { goal_id: 'goal1', name: 'Vacation', target_amount: 1000 },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._userCategories = overrides?.categories ?? [
    { category_id: 'food', name: 'Food' },
    { category_id: 'groceries', name: 'Groceries' },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockDb as any)._allCollectionsLoaded = true;

  const updateCalls: UpdateCall[] = [];
  const mockClient = makeMockFirestoreClient(updateCalls);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = new CopilotMoneyTools(mockDb, mockClient as any);

  return { tools, mockDb, updateCalls };
}

describe('updateTransaction — single-field updates', () => {
  test('category_id: sets category and writes correct mask', async () => {
    const { tools, updateCalls } = makeTools();
    const result = await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.updated).toEqual(['category_id']);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('items/item1/accounts/acct1/transactions');
    expect(updateCalls[0].docId).toBe('txn1');
    expect(updateCalls[0].mask).toEqual(['category_id']);
    expect(updateCalls[0].fields).toEqual({ category_id: { stringValue: 'groceries' } });
  });

  test('note: non-empty string sets user_note', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', note: 'hello' });
    expect(updateCalls[0].mask).toEqual(['user_note']);
    expect(updateCalls[0].fields).toEqual({ user_note: { stringValue: 'hello' } });
  });

  test('note: empty string clears the note (matches existing setTransactionNote)', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', note: '' });
    expect(updateCalls[0].mask).toEqual(['user_note']);
    expect(updateCalls[0].fields).toEqual({ user_note: { stringValue: '' } });
  });

  test('tag_ids: non-empty array sets tags', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1', 'tag2'] });
    expect(updateCalls[0].mask).toEqual(['tag_ids']);
    expect(updateCalls[0].fields).toEqual({
      tag_ids: {
        arrayValue: {
          values: [{ stringValue: 'tag1' }, { stringValue: 'tag2' }],
        },
      },
    });
  });

  test('tag_ids: empty array clears all tags', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: [] });
    expect(updateCalls[0].mask).toEqual(['tag_ids']);
    expect(updateCalls[0].fields).toEqual({ tag_ids: { arrayValue: { values: [] } } });
  });

  test('excluded: true marks excluded', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', excluded: true });
    expect(updateCalls[0].mask).toEqual(['excluded']);
    expect(updateCalls[0].fields).toEqual({ excluded: { booleanValue: true } });
  });

  test('excluded: false un-excludes', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', excluded: false });
    expect(updateCalls[0].fields).toEqual({ excluded: { booleanValue: false } });
  });

  test('name: trims whitespace before writing', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', name: '  Renamed  ' });
    expect(updateCalls[0].mask).toEqual(['name']);
    expect(updateCalls[0].fields).toEqual({ name: { stringValue: 'Renamed' } });
  });

  test('internal_transfer: true marks transfer', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', internal_transfer: true });
    expect(updateCalls[0].mask).toEqual(['internal_transfer']);
    expect(updateCalls[0].fields).toEqual({ internal_transfer: { booleanValue: true } });
  });

  test('goal_id: links to an existing goal', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', goal_id: 'goal1' });
    expect(updateCalls[0].mask).toEqual(['goal_id']);
    expect(updateCalls[0].fields).toEqual({ goal_id: { stringValue: 'goal1' } });
  });

  test('goal_id: null unlinks (Firestore empty string, cache undefined)', async () => {
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    await tools.updateTransaction({ transaction_id: 'txn1', goal_id: null });
    // Firestore wire: empty string
    expect(updateCalls[0].mask).toEqual(['goal_id']);
    expect(updateCalls[0].fields).toEqual({ goal_id: { stringValue: '' } });
    // Cache: undefined (goal_id key removed from the in-memory transaction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.goal_id).toBeUndefined();
  });
});

describe('updateTransaction — multi-field atomic', () => {
  test('three fields in one patch produce one updateDocument call with merged mask', async () => {
    const { tools, updateCalls } = makeTools();
    await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      note: 'weekly shopping',
      tag_ids: ['tag1'],
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask.sort()).toEqual(['category_id', 'tag_ids', 'user_note']);
    expect(updateCalls[0].fields).toEqual({
      category_id: { stringValue: 'groceries' },
      user_note: { stringValue: 'weekly shopping' },
      tag_ids: { arrayValue: { values: [{ stringValue: 'tag1' }] } },
    });
  });

  test('multi-field with goal_id unlink: Firestore empty string, cache undefined', async () => {
    const { tools, mockDb, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Coffee Shop',
          category_id: 'food',
          user_id: 'user123',
          item_id: 'item1',
          account_id: 'acct1',
          goal_id: 'goal1',
        },
      ],
    });
    await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      goal_id: null,
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask.sort()).toEqual(['category_id', 'goal_id']);
    expect(updateCalls[0].fields).toEqual({
      category_id: { stringValue: 'groceries' },
      goal_id: { stringValue: '' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('groceries');
    expect(cachedTxn.goal_id).toBeUndefined();
  });
});

describe('updateTransaction — omitted-key preservation', () => {
  test('sending only tag_ids does NOT touch user_note', async () => {
    const { tools, mockDb, updateCalls } = makeTools();
    await tools.updateTransaction({ transaction_id: 'txn1', tag_ids: ['tag1'] });
    expect(updateCalls[0].mask).not.toContain('user_note');
    // Cache preserves pre-existing note
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.user_note).toBe('pre-existing note');
  });
});

describe('updateTransaction — validation errors', () => {
  test('empty patch (only transaction_id) throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(tools.updateTransaction({ transaction_id: 'txn1' })).rejects.toThrow(
      /at least one field/i
    );
    expect(updateCalls).toHaveLength(0);
  });

  test('unknown field throws and no write is issued', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools.updateTransaction({ transaction_id: 'txn1', bogus_field: 'x' } as any)
    ).rejects.toThrow();
    expect(updateCalls).toHaveLength(0);
  });

  test('whitespace-only name throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', name: '   ' })
    ).rejects.toThrow(/name must not be empty/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('non-existent goal_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', goal_id: 'ghost' })
    ).rejects.toThrow(/Goal not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('non-existent transaction_id throws', async () => {
    const { tools, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({ transaction_id: 'missing', category_id: 'food' })
    ).rejects.toThrow(/Transaction not found/i);
    expect(updateCalls).toHaveLength(0);
  });

  test('transaction missing item_id or account_id throws', async () => {
    const { tools, updateCalls } = makeTools({
      transactions: [
        {
          transaction_id: 'txn1',
          amount: 50,
          date: '2024-01-15',
          name: 'Orphan',
          category_id: 'food',
          user_id: 'user123',
          // no item_id / account_id
        },
      ],
    });
    await expect(
      tools.updateTransaction({ transaction_id: 'txn1', category_id: 'food' })
    ).rejects.toThrow(/item_id or account_id/i);
    expect(updateCalls).toHaveLength(0);
  });
});

describe('updateTransaction — atomicity on validation failure', () => {
  test('valid category_id + invalid goal_id: no Firestore write, no cache mutation', async () => {
    const { tools, mockDb, updateCalls } = makeTools();
    await expect(
      tools.updateTransaction({
        transaction_id: 'txn1',
        category_id: 'groceries',
        goal_id: 'ghost',
      })
    ).rejects.toThrow(/Goal not found/i);
    expect(updateCalls).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('food'); // unchanged
  });
});

describe('updateTransaction — cache patching', () => {
  test('successful update patches the in-memory cache with cacheFields', async () => {
    const { tools, mockDb } = makeTools();
    await tools.updateTransaction({
      transaction_id: 'txn1',
      category_id: 'groceries',
      note: 'new note',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cachedTxn = (mockDb as any)._transactions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(cachedTxn.category_id).toBe('groceries');
    expect(cachedTxn.user_note).toBe('new note');
  });
});
```

- [ ] **Step 2: Run the failing test suite**

Run: `bun test tests/tools/update-transaction.test.ts`

Expected: every test fails with an error like `tools.updateTransaction is not a function` (or similar TypeError). The test file should compile cleanly even though the method doesn't exist yet — the calls are through `as any`-style loose typing.

If tests fail for a DIFFERENT reason (compile error, import error, fixture error), fix those before moving on. You're looking for "method not found" as the failure mode.

- [ ] **Step 3: Commit**

```bash
git add tests/tools/update-transaction.test.ts
git commit -m "$(cat <<'EOF'
test: add failing tests for update_transaction

TDD red state for the consolidated transaction-setter tool.
Covers single-field updates, multi-field atomicity, goal_id
unlink asymmetry, omitted-key preservation, validation errors,
atomicity on failure, and cache patching.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement `updateTransaction` method, schema, and dispatch

**Files:**
- Modify: `src/tools/tools.ts` — add schema entry in `createWriteToolSchemas()` and add method in `CopilotMoneyTools`
- Modify: `src/server.ts` — add dispatch case and `WRITE_TOOLS` entry

This task introduces the new tool in one shot: schema + method + wiring. After this, the Task 1 tests pass.

- [ ] **Step 1: Add the `update_transaction` JSON Schema entry**

In `src/tools/tools.ts`, find the `createWriteToolSchemas()` function (starts around line 4807). Add the new schema entry at the **top** of the returned array (before the existing `set_transaction_category` entry) so the new tool surfaces first:

```typescript
export function createWriteToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'update_transaction',
      description:
        'Update one or more fields on a transaction in a single atomic write. ' +
        'Pass transaction_id plus any combination of category_id, note, tag_ids, ' +
        'excluded, name, internal_transfer, or goal_id. Omitted fields are preserved ' +
        '(e.g., sending only tag_ids does not erase the note). Pass note="" to clear ' +
        'the note. Pass tag_ids=[] to clear all tags. Pass goal_id=null to unlink the ' +
        'goal. At least one mutable field must be provided besides transaction_id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction ID to update (from get_transactions results)',
          },
          category_id: {
            type: 'string',
            description: 'New category ID to assign (from get_categories results)',
          },
          note: {
            type: 'string',
            description: 'User note text. Pass empty string to clear.',
          },
          tag_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tag IDs to set. Pass empty array to clear all tags.',
          },
          excluded: {
            type: 'boolean',
            description: 'Whether the transaction is excluded from spending reports.',
          },
          name: {
            type: 'string',
            description: 'Display name (will be trimmed; must be non-empty if present).',
          },
          internal_transfer: {
            type: 'boolean',
            description: 'Whether the transaction is an internal transfer.',
          },
          goal_id: {
            type: ['string', 'null'],
            description:
              'Financial goal ID to link to. Pass null to unlink the existing goal.',
          },
        },
        required: ['transaction_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      name: 'set_transaction_category',
      // ... existing entry ...
```

Leave the 7 existing setter schema entries unchanged for now — they will be deleted in Task 5.

- [ ] **Step 2: Add the `updateTransaction` method to `CopilotMoneyTools`**

In `src/tools/tools.ts`, locate `reviewTransactions` (around line 2496). Add the new method immediately **before** `reviewTransactions` so transaction-mutation methods stay grouped:

```typescript
  /**
   * Update one or more fields on a transaction in a single atomic write.
   *
   * Consolidates the behavior of the previous 7 set_transaction_* tools.
   * Omitted fields are preserved. note="" clears the note. tag_ids=[]
   * clears all tags. goal_id=null unlinks (Firestore gets "", cache gets undefined).
   */
  async updateTransaction(args: {
    transaction_id: string;
    category_id?: string;
    note?: string;
    tag_ids?: string[];
    excluded?: boolean;
    name?: string;
    internal_transfer?: boolean;
    goal_id?: string | null;
  }): Promise<{
    success: true;
    transaction_id: string;
    updated: string[];
  }> {
    const { transaction_id } = args;

    // Reject unknown fields (equivalent to JSON Schema additionalProperties: false,
    // but re-checked here as a defense in depth in case the method is called directly
    // without going through the MCP dispatch layer).
    const allowedKeys = new Set([
      'transaction_id',
      'category_id',
      'note',
      'tag_ids',
      'excluded',
      'name',
      'internal_transfer',
      'goal_id',
    ]);
    for (const key of Object.keys(args)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`update_transaction: unknown field "${key}"`);
      }
    }

    // Require at least one mutable field besides transaction_id.
    const mutableKeys = Object.keys(args).filter((k) => k !== 'transaction_id');
    if (mutableKeys.length === 0) {
      throw new Error('update_transaction requires at least one field to update');
    }

    // Per-field validation (runs BEFORE any Firestore call for atomicity).
    let trimmedName: string | undefined;
    if ('name' in args && args.name !== undefined) {
      trimmedName = args.name.trim();
      if (trimmedName.length === 0) {
        throw new Error('Transaction name must not be empty');
      }
    }
    if ('category_id' in args && args.category_id !== undefined) {
      validateDocId(args.category_id, 'category_id');
    }
    if ('goal_id' in args && args.goal_id !== null && args.goal_id !== undefined) {
      validateDocId(args.goal_id, 'goal_id');
      const goals = await this.db.getGoals();
      const goal = goals.find((g) => g.goal_id === args.goal_id);
      if (!goal) {
        throw new Error(`Goal not found: ${args.goal_id}`);
      }
    }

    // Resolve the transaction and its Firestore path.
    const { collectionPath } = await this.resolveTransaction(transaction_id);

    // Build two parallel field maps by key presence (NOT by destructuring — see spec).
    const firestoreFields: Record<string, unknown> = {};
    const cacheFields: Partial<Transaction> = {};

    if ('category_id' in args && args.category_id !== undefined) {
      firestoreFields.category_id = args.category_id;
      cacheFields.category_id = args.category_id;
    }
    if ('note' in args && args.note !== undefined) {
      firestoreFields.user_note = args.note;
      cacheFields.user_note = args.note;
    }
    if ('tag_ids' in args && args.tag_ids !== undefined) {
      firestoreFields.tag_ids = args.tag_ids;
      cacheFields.tag_ids = args.tag_ids;
    }
    if ('excluded' in args && args.excluded !== undefined) {
      firestoreFields.excluded = args.excluded;
      cacheFields.excluded = args.excluded;
    }
    if ('name' in args && trimmedName !== undefined) {
      firestoreFields.name = trimmedName;
      cacheFields.name = trimmedName;
    }
    if ('internal_transfer' in args && args.internal_transfer !== undefined) {
      firestoreFields.internal_transfer = args.internal_transfer;
      cacheFields.internal_transfer = args.internal_transfer;
    }
    if ('goal_id' in args) {
      // Firestore wants empty string to unlink; cache wants undefined (matches Zod model).
      firestoreFields.goal_id = args.goal_id ?? '';
      cacheFields.goal_id = args.goal_id ?? undefined;
    }

    // Single atomic Firestore write + cache patch.
    const client = this.getFirestoreClient();
    const firestoreValue = toFirestoreFields(firestoreFields);
    const updateMask = Object.keys(firestoreFields);
    await client.updateDocument(collectionPath, transaction_id, firestoreValue, updateMask);

    if (!this.db.patchCachedTransaction(transaction_id, cacheFields)) {
      this.db.clearCache();
    }

    return {
      success: true,
      transaction_id,
      updated: updateMask,
    };
  }
```

**Imports check:** `Transaction` must be imported from `../models/transaction.js`. Check the top of `src/tools/tools.ts` — if `Transaction` isn't already imported, add it to the existing import from that module. `validateDocId` and `toFirestoreFields` should already be imported (they're used by the existing setters).

- [ ] **Step 3: Add `update_transaction` to `WRITE_TOOLS` in `src/server.ts`**

In `src/server.ts`, find the `WRITE_TOOLS` set (around line 96). Add `'update_transaction'` as the first entry:

```typescript
  private static readonly WRITE_TOOLS = new Set([
    'update_transaction',
    'set_transaction_category',
    'set_transaction_note',
    'set_transaction_tags',
    // ... rest unchanged for now ...
```

- [ ] **Step 4: Add the dispatch case in `src/server.ts`**

In the `handleCallTool` switch statement (cases start around line 252), add a new case for `update_transaction` immediately **before** `case 'set_transaction_category':`:

```typescript
        case 'update_transaction':
          result = await this.tools.updateTransaction(
            typedArgs as Parameters<typeof this.tools.updateTransaction>[0]
          );
          break;
        case 'set_transaction_category':
          // ... existing ...
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `bun test tests/tools/update-transaction.test.ts`

Expected: all tests green.

If any test fails, read the error and fix the implementation before moving on. Do NOT modify the test expectations — the tests encode the spec's contract.

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `bun test --bail`

Expected: all tests pass, including the 1629 baseline plus the new update_transaction tests. At this point the old setter tests still exist and still pass (we haven't touched them).

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`

Expected: no errors. Fix any type issues in the new method.

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/server.ts
git commit -m "$(cat <<'EOF'
feat: add update_transaction consolidated write tool

Introduces update_transaction alongside the existing 7 setters.
Supports atomic multi-field updates via paired firestoreFields/
cacheFields maps, key-presence semantics for omitted fields, and
goal_id=null unlink (Firestore empty string, cache undefined).

Old setters remain for now — they will be removed in a follow-up
commit after their tests are migrated.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `update_transaction` coverage to other test files

**Files:**
- Modify: `tests/unit/server-write-dispatch.test.ts` — add dispatch map entry
- Modify: `tests/unit/server.test.ts` — add schema-listing and write-gate tests
- Modify: `tests/e2e/server.test.ts` — add E2E dispatch tests

Task 4 will delete the old setter tests. Before that, we need the new tool covered in the same test files so coverage doesn't regress.

- [ ] **Step 1: Add `update_transaction` to the dispatch map in `tests/unit/server-write-dispatch.test.ts`**

Open the file and find the dispatch config map starting around line 17. Add this entry at the top of the object (before `set_transaction_category`):

```typescript
  update_transaction: {
    method: 'updateTransaction',
    args: { transaction_id: 'txn1', category_id: 'food' },
  },
```

Keep the existing 7 setter entries in place for now — they will be deleted in Task 4.

- [ ] **Step 2: Run the dispatch test to confirm update_transaction routes correctly**

Run: `bun test tests/unit/server-write-dispatch.test.ts`

Expected: all tests pass including the new entry.

- [ ] **Step 3: Update tool-listing assertions in `tests/unit/server.test.ts`**

Open `tests/unit/server.test.ts`. Find the test `'handleListTools returns only read tools by default'` (around line 230). Inside the test body, add this assertion alongside the existing `.not.toContain(...)` checks:

```typescript
    expect(toolNames).not.toContain('update_transaction');
```

Then find the test `'handleListTools returns read + write tools when writeEnabled'` (around line 242). In its body, add `update_transaction` as the first `.toContain(...)` assertion for write tools:

```typescript
    expect(toolNames).toContain('update_transaction');
```

(Leave the existing setter `.toContain(...)` assertions in place for now — Task 4 will remove them.)

- [ ] **Step 4: Add a write-gate rejection test for update_transaction in `tests/unit/server.test.ts`**

Find the test `'handleCallTool rejects write tool when not in write mode'` (around line 320). Immediately after its closing `});`, add this new test using the exact same pattern as the surrounding rejection tests:

```typescript
  test('handleCallTool rejects update_transaction when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'food',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });
```

- [ ] **Step 5: Add a schema-lookup assertion in `tests/unit/server.test.ts`**

Find the test `'returns write tool schemas with proper annotations'` inside the `describe('createWriteToolSchemas', ...)` block (around line 509). Inside its body, add these assertions after the existing `setCat` / `setNote` checks (they'll be deleted in Task 4 — for now we're adding alongside):

```typescript
    const updateTxn = schemas.find((s) => s.name === 'update_transaction');
    expect(updateTxn).toBeDefined();
    expect(updateTxn!.annotations?.readOnlyHint).toBe(false);
    expect(updateTxn!.annotations?.idempotentHint).toBe(true);
    expect(updateTxn!.inputSchema.required).toEqual(['transaction_id']);
    expect(updateTxn!.inputSchema.additionalProperties).toBe(false);
```

- [ ] **Step 6: Run `tests/unit/server.test.ts`**

Run: `bun test tests/unit/server.test.ts`

Expected: all tests pass.

- [ ] **Step 7: Add E2E dispatch tests in `tests/e2e/server.test.ts`**

Open `tests/e2e/server.test.ts`. The file has a describe block `'handleCallTool — write tools'` starting at line 686 with a `beforeEach` that sets up `writeServer` via `_injectForTesting`. The existing test pattern uses literal transaction IDs like `'txn1'` and category IDs like `'custom_cat_1'` or `'food_dining'`. Results are parsed with `parseToolResult(result) as any`.

Inside the `describe('handleCallTool — write tools', ...)` block (line 686), add these three tests as the **last** tests in the block (immediately before its closing `});`):

```typescript
  test('update_transaction multi-field call produces one write', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'custom_cat_1',
      note: 'e2e test note',
      tag_ids: [],
    });
    expect(result.isError).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.transaction_id).toBe('txn1');
    expect(data.updated.sort()).toEqual(['category_id', 'tag_ids', 'user_note']);
  });

  test('update_transaction with goal_id: null unlinks the goal', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      goal_id: null,
    });
    expect(result.isError).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = parseToolResult(result) as any;
    expect(data.success).toBe(true);
    expect(data.updated).toEqual(['goal_id']);
  });

  test('update_transaction rejects empty patch', async () => {
    const result = await writeServer.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/at least one field/i);
  });
```

If `createMockDb()` in this file doesn't include a goal fixture that matches `'txn1'`'s `goal_id`, the "unlinks the goal" test may need a pre-existing goal linked to txn1 — check what the mock returns. If it doesn't, skip the assertion-by-cache for this E2E test (the unit tests already cover that) and just verify the dispatch returns success.

- [ ] **Step 8: Run the E2E test file**

Run: `bun test tests/e2e/server.test.ts`

Expected: all tests pass.

- [ ] **Step 9: Run the full test suite**

Run: `bun test --bail`

Expected: 1629 baseline + new update_transaction tests across multiple files, all passing.

- [ ] **Step 10: Commit**

```bash
git add tests/
git commit -m "$(cat <<'EOF'
test: add update_transaction coverage to dispatch, server, and e2e suites

Covers the new consolidated tool in the same places the old setters
are tested. Old setter tests remain for now — they will be removed
in the next commit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete old setter tests

**Files (8 total):**
- Modify: `tests/tools/tools.test.ts`
- Modify: `tests/tools/write-tools.test.ts`
- Modify: `tests/tools/write-tools-phase4.test.ts`
- Modify: `tests/tools/unit-coverage-gaps.test.ts`
- Modify: `tests/unit/server-write-dispatch.test.ts`
- Modify: `tests/unit/server.test.ts`
- Modify: `tests/e2e/server.test.ts`
- Modify: `tests/integration/tools.test.ts`

The old setter source still exists, so these deletions are safe — tests that pass now can be removed without breaking anything else.

- [ ] **Step 1: Delete describe blocks in `tests/tools/tools.test.ts`**

Delete these three entire `describe(...)` blocks (opening `describe(` through matching closing `});`):
- `describe('setTransactionCategory', () => { ... });` — starts at line 2186
- `describe('setTransactionNote', () => { ... });` — starts at line 2312
- `describe('setTransactionTags', () => { ... });` — starts at line 2490

Use Read to load each range first, then Edit to delete from the `describe(` line through the matching closing `});`.

- [ ] **Step 2: Delete describe blocks in `tests/tools/write-tools.test.ts`**

Delete these four entire `describe(...)` blocks:
- `describe('setTransactionExcluded', ...)` — line 68
- `describe('setTransactionName', ...)` — line 134
- `describe('setInternalTransfer', ...)` — line 214
- `describe('setTransactionGoal', ...)` — line 267

Same approach: read each block, edit to delete it. The file's header comment (lines 1-8) mentions "setTransactionExcluded, setTransactionName, setInternalTransfer, setTransactionGoal" — update the comment to remove those names and mention `update_transaction` instead, or delete the header entirely if the remaining content is just unrelated tool tests.

- [ ] **Step 3: Delete describe blocks in `tests/tools/write-tools-phase4.test.ts`**

Delete these three `describe(...)` blocks:
- `describe('setTransactionCategory', ...)` — line 102
- `describe('setTransactionNote', ...)` — line 195
- `describe('setTransactionTags', ...)` — line 282

- [ ] **Step 4: Delete/update individual tests in `tests/tools/unit-coverage-gaps.test.ts`**

This file has 7 scattered `test(...)` calls (not in their own describe blocks). Delete these tests:
- Line 280: `test('createTag then setTransactionTags with the new tag_id', ...)`
- Line 294: `test('setTransactionGoal link then unlink', ...)`
- Line 310: `test('setTransactionCategory then setTransactionNote on same transaction', ...)`
- Line 326: `test('createCategory then setTransactionCategory with it', ...)`
- Line 404: `test('setTransactionName with a 500-character name succeeds', ...)`
- Line 415: `test('setTransactionNote with empty string clears the note', ...)`
- Line 425: `test('setTransactionTags with empty array clears all tags', ...)`

For each, delete from `test(` through the matching closing `});`. Some of these (e.g., "setTransactionNote with empty string clears the note", "setTransactionTags with empty array clears all tags", "setTransactionName with a 500-character name succeeds") exercise edge cases that the new `update-transaction.test.ts` already covers in its single-field test group — no replacement needed.

The "createTag then setTransactionTags" and "createCategory then setTransactionCategory" tests exercise cross-tool flows. Replace each deleted test with an equivalent that uses `update_transaction`:

```typescript
  test('createTag then update_transaction sets the new tag', async () => {
    // ... existing setup that creates a tag ...
    const updateResult = await tools.updateTransaction({
      transaction_id: TEST_TXN_ID,
      tag_ids: [newTagId],
    });
    expect(updateResult.success).toBe(true);
    expect(updateResult.updated).toEqual(['tag_ids']);
  });

  test('createCategory then update_transaction assigns it', async () => {
    // ... existing setup that creates a category ...
    const updateResult = await tools.updateTransaction({
      transaction_id: TEST_TXN_ID,
      category_id: newCategoryId,
    });
    expect(updateResult.success).toBe(true);
    expect(updateResult.updated).toEqual(['category_id']);
  });
```

Preserve whatever fixture variables the existing tests use.

- [ ] **Step 5: Delete old setter entries from `tests/unit/server-write-dispatch.test.ts`**

Open the file and find the dispatch config map (lines 17-47 in the original). Delete the 7 entries for the removed setters:
- `set_transaction_category`
- `set_transaction_note`
- `set_transaction_tags`
- `set_transaction_excluded`
- `set_transaction_name`
- `set_internal_transfer`
- `set_transaction_goal`

Keep the `update_transaction` entry added in Task 3 and any other tool entries (e.g., `review_transactions`, budget/goal/tag tools).

- [ ] **Step 6: Delete/update old setter assertions in `tests/unit/server.test.ts`**

Make these precise edits:

**A. Remove setter `.not.toContain(...)` assertions** (around lines 236-237). Delete these two lines:
```typescript
    expect(toolNames).not.toContain('set_transaction_category');
    expect(toolNames).not.toContain('set_transaction_note');
```
(Keep `expect(toolNames).not.toContain('update_transaction');` added in Task 3, and keep the `create_tag`/`delete_tag` assertions.)

**B. Remove setter `.toContain(...)` assertions** (around lines 248-253). Delete these six lines:
```typescript
    expect(toolNames).toContain('set_transaction_category');
    expect(toolNames).toContain('set_transaction_note');
    expect(toolNames).toContain('set_transaction_excluded');
    expect(toolNames).toContain('set_transaction_name');
    expect(toolNames).toContain('set_internal_transfer');
    expect(toolNames).toContain('set_transaction_goal');
```
(Keep `expect(toolNames).toContain('update_transaction');` added in Task 3.)

**C. Update the annotations test** at line 268 (`'write tool has correct annotations'`). Change the schema lookup from `set_transaction_category` to `update_transaction`:

```typescript
  test('write tool has correct annotations', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const writeTool = result.tools.find((t) => t.name === 'update_transaction');

    expect(writeTool).toBeDefined();
    expect(writeTool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
```

**D. Update the generic write-gate rejection test** at line 320 (`'handleCallTool rejects write tool when not in write mode'`). Change the dispatched tool name from `set_transaction_category` to `update_transaction`:

```typescript
  test('handleCallTool rejects write tool when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'food',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('--write mode');
  });
```

(After this, delete the specific `update_transaction` write-gate test you added in Task 3 Step 4 — it's now redundant with the general one. Or keep it and delete the general one. Pick one. The plan assumes you delete the Task 3 Step 4 addition since the general test now covers the same case.)

**E. Delete the specific setter write-gate rejection tests.** Find and delete these five entire `test(...)` blocks:
- `test('handleCallTool rejects set_transaction_note when not in write mode', ...)` (line 331)
- `test('handleCallTool rejects set_transaction_excluded when not in write mode', ...)` (line 368)
- `test('handleCallTool rejects set_transaction_name when not in write mode', ...)` (line 379)
- `test('handleCallTool rejects set_internal_transfer when not in write mode', ...)` (line 390)
- `test('handleCallTool rejects set_transaction_goal when not in write mode', ...)` (line 401)

**F. Replace the schema lookup assertions in `createWriteToolSchemas` test** (around lines 513-524). Delete the `setCat` and `setNote` assertion blocks:

```typescript
    const setCat = schemas.find((s) => s.name === 'set_transaction_category');
    expect(setCat).toBeDefined();
    expect(setCat!.annotations?.readOnlyHint).toBe(false);
    expect(setCat!.inputSchema.required).toContain('transaction_id');
    expect(setCat!.inputSchema.required).toContain('category_id');

    const setNote = schemas.find((s) => s.name === 'set_transaction_note');
    expect(setNote).toBeDefined();
    expect(setNote!.annotations?.readOnlyHint).toBe(false);
    expect(setNote!.annotations?.idempotentHint).toBe(true);
    expect(setNote!.inputSchema.required).toContain('transaction_id');
    expect(setNote!.inputSchema.required).toContain('note');
```

(The equivalent `update_transaction` assertions were already added in Task 3 Step 5 in the same test body.)

- [ ] **Step 7: Delete old setter E2E tests from `tests/e2e/server.test.ts`**

Delete these tests (find by line number, then delete from `test(` through matching `});`):
- Line 697: `test('set_transaction_category updates category', ...)`
- Line 753: another `handleCallTool('set_transaction_category', ...)` test
- Line 778: another `handleCallTool('set_transaction_category', ...)` test
- Line 1123: `test('set_transaction_note sets a note', ...)`
- Line 1135: `test('set_transaction_tags assigns tags to a transaction', ...)`
- Line 1169: `test('set_transaction_excluded excludes a transaction', ...)`
- Line 1181: `test('set_transaction_name renames a transaction', ...)`
- Line 1194: `test('set_internal_transfer marks as internal transfer', ...)`
- Line 1206: `test('set_transaction_goal links a transaction to a goal', ...)`
- Line 1218: `test('set_transaction_goal unlinks a goal with null', ...)`
- Line 1432: `test('set_transaction_note with nonexistent transaction returns error', ...)`
- Line 1441: `test('set_transaction_tags with nonexistent transaction returns error', ...)`
- Line 1450: `test('set_transaction_category with nonexistent transaction returns error', ...)`
- Line 1528: `test('set_transaction_name with empty name returns error', ...)`
- Line 1537: `test('set_transaction_goal with nonexistent goal returns error', ...)`

**Also update the error-handling test at line 748** — `'write tool on read-only server returns isError with --write hint'` — which uses `set_transaction_category` as its example. Change the dispatched tool name:

```typescript
  test('write tool on read-only server returns isError with --write hint', async () => {
    const db = createMockDb();
    const server = new CopilotMoneyServer(FAKE_DB_DIR);
    server._injectForTesting(db, new CopilotMoneyTools(db));

    const result = await server.handleCallTool('update_transaction', {
      transaction_id: 'txn1',
      category_id: 'food_dining',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('--write');
  });
```

After deleting, **run grep to make sure nothing slipped through**:

```bash
bun test tests/e2e/server.test.ts 2>&1 | head -20
```

And:

```
Grep pattern: set_transaction|setTransaction|setInternalTransfer|set_internal
Path: tests/e2e/server.test.ts
Expected: 0 matches (or only matches in a comment you left behind)
```

The three core E2E cases for `update_transaction` (multi-field + goal unlink + empty patch) were added in Task 3, so existing coverage is preserved.

- [ ] **Step 8: Delete old setter tests from `tests/integration/tools.test.ts`**

Find the describe block containing the 7 setter integration tests (lines 974-1051). These appear to be wrapped in a larger describe; delete just the 7 individual test cases:

- Line 974: `test('setTransactionCategory updates category', ...)`
- Line 986: `test('setTransactionNote sets note', ...)`
- Line 997: `test('setTransactionTags sets tag_ids', ...)`
- Line 1019: `test('setTransactionExcluded excludes transaction', ...)`
- Line 1029: `test('setTransactionName renames transaction', ...)`
- Line 1040: `test('setInternalTransfer marks transfer', ...)`
- Line 1050: `test('setTransactionGoal links transaction to goal', ...)`

Add one equivalent integration test for `update_transaction` in the same describe block:

```typescript
    test('updateTransaction multi-field call writes once', async () => {
      const result = await writeTools.updateTransaction({
        transaction_id: TEST_TXN_ID,
        category_id: TEST_CATEGORY_ID,
        note: 'integration test',
      });
      expect(result.success).toBe(true);
      expect(result.updated.sort()).toEqual(['category_id', 'user_note']);
    });
```

Use whatever fixture names the existing tests used.

- [ ] **Step 9: Run the full test suite**

Run: `bun test`

Expected: all tests pass. Old setter tests are gone; old setter source still works; new tests still pass.

If any test fails because of a leftover reference to a removed test, find and remove it.

- [ ] **Step 10: Grep to confirm no stale test references**

```
Grep pattern: setTransactionCategory|setTransactionNote|setTransactionTags|setTransactionExcluded|setTransactionName|setInternalTransfer|setTransactionGoal
Path: tests/
Expected: 0 matches
```

```
Grep pattern: set_transaction_|set_internal_transfer
Path: tests/
Expected: 0 matches
```

If either returns matches, find and remove them.

- [ ] **Step 11: Commit**

```bash
git add tests/
git commit -m "$(cat <<'EOF'
test: remove old setter test suites after update_transaction migration

Deletes describe blocks and individual tests across 8 test files
that exercised the 7 soon-to-be-removed setter methods. Coverage
for the same behavior lives in tests/tools/update-transaction.test.ts
and the update_transaction entries added to the other suites.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete old setter source code

**Files:**
- Modify: `src/tools/tools.ts` — delete 7 methods + `writeTransactionFields` helper + 7 schema entries
- Modify: `src/server.ts` — delete 7 dispatch cases + 7 `WRITE_TOOLS` entries

All old setter tests are gone, so the setters can be deleted without breaking tests.

- [ ] **Step 1: Delete the 7 setter method implementations from `src/tools/tools.ts`**

Delete these entire method definitions (doc comment + `async` signature + body + closing `}`):

- `setTransactionCategory` (currently around line 2397)
- `setTransactionNote` (around 2441)
- `setTransactionTags` (around 2466)
- `setTransactionExcluded` (around 2557)
- `setTransactionName` (around 2575)
- `setInternalTransfer` (around 2601)
- `setTransactionGoal` (around 2620)

Use Read to load each method's range first, then Edit to delete. Do **NOT** delete `resolveTransaction`, `reviewTransactions`, or the new `updateTransaction` you just added.

- [ ] **Step 2: Delete the `writeTransactionFields` private helper**

Also in `src/tools/tools.ts`, delete the `writeTransactionFields` method (currently around line 2377). After Step 1 it has zero callers.

- [ ] **Step 3: Verify no remaining callers of `writeTransactionFields`**

```
Grep pattern: writeTransactionFields
Path: src/
Expected: 0 matches
```

If there are any matches, the step 1 deletions missed something — go back and fix.

- [ ] **Step 4: Delete the 7 old schema entries from `createWriteToolSchemas()`**

In `src/tools/tools.ts`, find `createWriteToolSchemas()` (around line 4807). Delete these entries from the returned array:
- `set_transaction_category` (~line 4810)
- `set_transaction_note` (~line 4835)
- `set_transaction_tags` (~line 4860)
- `set_transaction_excluded` (~line 4911)
- `set_transaction_name`
- `set_internal_transfer`
- `set_transaction_goal` (~line 4986)

Keep:
- `update_transaction` (added in Task 2)
- `review_transactions` (~line 4885)
- All other entity CRUD schemas (tags, categories, budgets, goals, recurring)

- [ ] **Step 5: Delete the 7 dispatch cases from `src/server.ts`**

In `src/server.ts`, find the `handleCallTool` switch (cases around line 252). Delete these `case` blocks:

```typescript
        case 'set_transaction_category':
          result = await this.tools.setTransactionCategory(...);
          break;
        case 'set_transaction_note':
          result = await this.tools.setTransactionNote(...);
          break;
        case 'set_transaction_tags':
          result = await this.tools.setTransactionTags(...);
          break;
        case 'set_transaction_excluded':
          result = await this.tools.setTransactionExcluded(...);
          break;
        case 'set_transaction_name':
          result = await this.tools.setTransactionName(...);
          break;
        case 'set_internal_transfer':
          result = await this.tools.setInternalTransfer(...);
          break;
        case 'set_transaction_goal':
          result = await this.tools.setTransactionGoal(...);
          break;
```

Keep:
- `case 'update_transaction':` (added in Task 2)
- `case 'review_transactions':`
- All other cases

- [ ] **Step 6: Delete the 7 entries from `WRITE_TOOLS` in `src/server.ts`**

Find the `WRITE_TOOLS` set (around line 96). Delete:

```typescript
    'set_transaction_category',
    'set_transaction_note',
    'set_transaction_tags',
    'set_transaction_excluded',
    'set_transaction_name',
    'set_internal_transfer',
    'set_transaction_goal',
```

Keep `'update_transaction'` (added in Task 2), `'review_transactions'`, and all other write tools.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`

Expected: no errors. TypeScript will catch any stale references.

- [ ] **Step 8: Run the full test suite**

Run: `bun test --bail`

Expected: all tests pass.

- [ ] **Step 9: Grep for any remaining source references**

```
Grep pattern: setTransactionCategory|setTransactionNote|setTransactionTags|setTransactionExcluded|setTransactionName|setInternalTransfer|setTransactionGoal|writeTransactionFields|set_transaction_|set_internal_transfer
Path: src/
Expected: 0 matches
```

If there are matches, fix them before committing.

- [ ] **Step 10: Run lint and format**

Run: `bun run lint && bun run format:check`

Expected: lint passes (existing warnings are pre-existing, not introduced by this change). Format check passes. If format fails, run `bun run format`.

- [ ] **Step 11: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
refactor: remove 7 transaction setter tools and writeTransactionFields

Deletes setTransactionCategory, setTransactionNote, setTransactionTags,
setTransactionExcluded, setTransactionName, setInternalTransfer, and
setTransactionGoal along with their schema entries and dispatch cases.
Also removes the private writeTransactionFields helper which now has
zero callers. All functionality lives in the new update_transaction
tool.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Regenerate manifest, bump version, update CHANGELOG

**Files:**
- Modify: `manifest.json` (regenerated)
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Regenerate `manifest.json` via the sync script**

Run: `bun run sync-manifest`

Expected: the script updates `manifest.json`'s `tools` array to drop the 7 old entries and include `update_transaction`. The array should now have 35 entries.

- [ ] **Step 2: Verify the tool count in `manifest.json`**

Read `manifest.json` and count the entries in the `tools` array. Expected: 35.

Also update the `description` field (around line 5) from "41 tools" to "35 tools":

```json
  "description": "Query and manage your personal finances with AI using local Copilot Money data. 35 tools for transactions, investments, budgets, goals, and more.",
```

And update the `version` field:

```json
  "version": "1.6.0",
```

- [ ] **Step 3: Update `package.json`**

Change the version and description:

```json
  "name": "copilot-money-mcp",
  "version": "1.6.0",
  "description": "MCP server for Copilot Money - query and manage personal finances with AI using local data (35 tools)",
```

- [ ] **Step 4: Update `package-lock.json`**

Change both the top-level `version` (line 3) and `packages[""].version` (line 9) from `1.5.0` to `1.6.0`:

```json
  "name": "copilot-money-mcp",
  "version": "1.6.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "copilot-money-mcp",
      "version": "1.6.0",
```

- [ ] **Step 5: Add the `[1.6.0]` entry to `CHANGELOG.md`**

Insert this block right under `## [Unreleased]` (which currently contains the total balance fix — leave that unreleased entry in place):

```markdown
## [1.6.0] - 2026-04-10

### Changed
- **Consolidated 7 transaction setter tools into one `update_transaction` tool.**
  The new tool accepts a partial patch with any combination of: `category_id`,
  `note`, `tag_ids`, `excluded`, `name`, `internal_transfer`, `goal_id`. Multi-field
  updates are atomic (single Firestore call). Omitted fields are preserved — sending
  `{id, tag_ids: [...]}` cannot accidentally erase the note. `goal_id: null` unlinks
  the goal. Net tool count: 41 → 35.

### Removed
- `set_transaction_category`, `set_transaction_note`, `set_transaction_tags`,
  `set_transaction_excluded`, `set_transaction_name`, `set_internal_transfer`,
  `set_transaction_goal`. Use `update_transaction` instead. Not marked as breaking
  because the write tools have never been published.
- Private helper `writeTransactionFields` (zero remaining callers after the setters
  were removed).
```

- [ ] **Step 6: Run the full check**

Run: `bun run check`

Expected: typecheck + lint + format + all tests pass.

- [ ] **Step 7: Commit**

```bash
git add manifest.json package.json package-lock.json CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: bump version to 1.6.0 and regenerate manifest

Net tool count 41 → 35 after consolidating transaction setters.
Updates manifest description, package.json description and version,
package-lock.json version, and adds a [1.6.0] CHANGELOG entry.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the tool count on line 19**

Change:

```markdown
**41 tools** across spending, investments, budgets, goals, and more:
```

To:

```markdown
**35 tools** across spending, investments, budgets, goals, and more:
```

- [ ] **Step 2: Update the write tools example on line 149**

Change:

```markdown
Uses write tools like `set_transaction_category`, `set_transaction_tags`, `create_budget`, `update_recurring`, and more. Requires `--write` flag.
```

To:

```markdown
Uses write tools like `update_transaction`, `create_budget`, `update_recurring`, and more. Requires `--write` flag.
```

- [ ] **Step 3: Update the tools table row on line 179**

Change:

```markdown
| **Transactions** | `set_transaction_category`, `set_transaction_name`, `set_transaction_note`, `set_transaction_tags`, `set_transaction_excluded`, `set_transaction_goal`, `set_internal_transfer`, `review_transactions` |
```

To:

```markdown
| **Transactions** | `update_transaction` (multi-field patch), `review_transactions` |
```

- [ ] **Step 4: Grep to confirm no remaining README references**

```
Grep pattern: set_transaction_|set_internal_transfer|41 tools
Path: README.md
Expected: 0 matches
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: update README for update_transaction consolidation

Updates the tool count (41 → 35) and replaces the list of individual
setter tools with update_transaction in the write-tools section and
the transactions row of the tools table.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final verification

No commits in this task — it's a verification pass to confirm the refactor is clean end-to-end.

- [ ] **Step 1: Run the full project check**

Run: `bun run check`

Expected: typecheck + lint + format + all tests pass (1629 baseline minus deleted setter tests plus new `update_transaction` tests).

- [ ] **Step 2: Confirm manifest has exactly 35 tools**

```bash
bun run sync-manifest
```

Expected output: the script reports 35 tools, or at minimum doesn't complain about drift. Read `manifest.json` and verify `tools` array length is 35.

- [ ] **Step 3: Grep for any stale references across the whole repo**

```
Grep pattern: setTransactionCategory|setTransactionNote|setTransactionTags|setTransactionExcluded|setTransactionName|setInternalTransfer|setTransactionGoal|writeTransactionFields
Expected: 0 matches anywhere (except in the spec, plan, and CHANGELOG files — those intentionally reference the removed tool names as history)
```

```
Grep pattern: set_transaction_|set_internal_transfer
Expected: 0 matches anywhere except docs/superpowers/specs/, docs/superpowers/plans/, and CHANGELOG.md
```

If there are unexpected hits, fix them and create a follow-up commit.

- [ ] **Step 4: Verify version consistency**

Read these three files and confirm they all show `1.6.0`:
- `package.json` line 3
- `manifest.json` line 6
- `package-lock.json` lines 3 and 9

- [ ] **Step 5: Verify "35 tools" consistency**

Grep for the old count to make sure nothing was missed:

```
Grep pattern: 41 tools
Expected: 0 matches (or only in CHANGELOG historical entries)
```

- [ ] **Step 6: Review the commit log**

```bash
git log --oneline main..HEAD
```

Expected: 7 commits (plus the earlier design spec commit) corresponding to the 7 tasks that produced commits (Tasks 1-7):
1. `docs: add design spec for consolidating transaction setters` (from brainstorming)
2. `test: add failing tests for update_transaction`
3. `feat: add update_transaction consolidated write tool`
4. `test: add update_transaction coverage to dispatch, server, and e2e suites`
5. `test: remove old setter test suites after update_transaction migration`
6. `refactor: remove 7 transaction setter tools and writeTransactionFields`
7. `chore: bump version to 1.6.0 and regenerate manifest`
8. `docs: update README for update_transaction consolidation`

Each commit should be independently reviewable.

---

## Rollback plan

If Task 5 or later reveals a design flaw, the branch can be reset to the commit from Task 4 (tests-only changes) with `git reset --hard <sha>` — the old setters are still fully functional up through Task 4's commit. Anything after Task 5 is a source-level removal and would require re-adding the deleted code.

## Success criteria (from spec)

- [x] `update_transaction` exists and handles all 7 fields the removed tools handled.
- [x] Multi-field calls issue exactly one `updateDocument` call (one Firestore round trip).
- [x] Omitted fields are preserved across writes. `note: ""` clears the user note. `goal_id: null` unlinks the goal (Firestore gets `""`, cache gets `undefined`).
- [x] All validation from the removed tools is preserved (per-field, not global).
- [x] `writeTransactionFields` is deleted (zero remaining callers).
- [x] `bun run check` passes.
- [x] `bun run sync-manifest` reports 35 tools, no drift.
- [x] No references to the 7 removed tool names remain in source, tests, or docs (excluding historical spec/plan/changelog).
- [x] Tool count in `manifest.json` description, `package.json` description, and `README.md` all say 35.
