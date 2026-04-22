/**
 * Tests that every write tool case branch in handleCallTool() successfully
 * dispatches to the corresponding CopilotMoneyTools method when writeEnabled=true.
 *
 * The tool methods themselves are tested elsewhere; here we only verify routing.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';

/**
 * Map of write tool name -> { method to stub, minimal args for dispatch }.
 */
const WRITE_TOOL_SPECS: Record<string, { method: string; args: Record<string, unknown> }> = {
  create_transaction: {
    method: 'createTransaction',
    args: {
      account_id: 'acc1',
      item_id: 'item1',
      name: 'Coffee',
      date: '2026-04-21',
      amount: 5.25,
      category_id: 'cat1',
      type: 'REGULAR',
    },
  },
  delete_transaction: {
    method: 'deleteTransaction',
    args: { transaction_id: 'txn1', account_id: 'acc1', item_id: 'item1' },
  },
  add_transaction_to_recurring: {
    method: 'addTransactionToRecurring',
    args: {
      transaction_id: 'txn1',
      account_id: 'acc1',
      item_id: 'item1',
      recurring_id: 'rec1',
    },
  },
  split_transaction: {
    method: 'splitTransaction',
    args: {
      transaction_id: 'txn1',
      account_id: 'acc1',
      item_id: 'item1',
      splits: [
        { amount: 50, category_id: 'cat1' },
        { amount: 50, category_id: 'cat2' },
      ],
    },
  },
  update_transaction: {
    method: 'updateTransaction',
    args: { transaction_id: 'txn1', category_id: 'food' },
  },
  review_transactions: {
    method: 'reviewTransactions',
    args: { transaction_ids: ['txn1'], reviewed: true },
  },
  create_tag: {
    method: 'createTag',
    args: { name: 'Test Tag' },
  },
  delete_tag: {
    method: 'deleteTag',
    args: { tag_id: 'tag1' },
  },
  create_category: {
    method: 'createCategory',
    args: { name: 'Test Category' },
  },
  update_category: {
    method: 'updateCategory',
    args: { category_id: 'cat1', name: 'Updated' },
  },
  delete_category: {
    method: 'deleteCategory',
    args: { category_id: 'cat1' },
  },
  set_budget: {
    method: 'setBudget',
    args: { category_id: 'food', amount: '500.00' },
  },
  set_recurring_state: {
    method: 'setRecurringState',
    args: { recurring_id: 'rec1', state: 'PAUSED' },
  },
  delete_recurring: {
    method: 'deleteRecurring',
    args: { recurring_id: 'rec1' },
  },
  update_tag: {
    method: 'updateTag',
    args: { tag_id: 'tag1', name: 'Updated Tag' },
  },
  create_recurring: {
    method: 'createRecurring',
    args: { transaction_id: 'txn1', frequency: 'MONTHLY' },
  },
  update_recurring: {
    method: 'updateRecurring',
    args: { recurring_id: 'rec1', state: 'PAUSED' },
  },
};

describe('write tool dispatch (writeEnabled=true)', () => {
  let server: CopilotMoneyServer;
  let tools: CopilotMoneyTools;

  const STUB_RESULT = { dispatched: true };

  beforeAll(() => {
    server = new CopilotMoneyServer('/fake/path', undefined, true);

    const db = new CopilotDatabase('/fake/path');
    db.isAvailable = () => true;

    tools = new CopilotMoneyTools(db);

    // Stub every write method to return STUB_RESULT
    for (const spec of Object.values(WRITE_TOOL_SPECS)) {
      if (!(spec.method in (tools as object)))
        throw new Error(`Unknown method on tools: ${spec.method}`);
      (tools as unknown as Record<string, unknown>)[spec.method] = async () => STUB_RESULT;
    }

    server._injectForTesting(db, tools);
  });

  for (const [toolName, spec] of Object.entries(WRITE_TOOL_SPECS)) {
    test(`${toolName} routes to tools.${spec.method}()`, async () => {
      const result = await server.handleCallTool(toolName, spec.args);

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);

      const text = (result.content[0] as { type: string; text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed).toEqual(STUB_RESULT);
    });
  }
});
