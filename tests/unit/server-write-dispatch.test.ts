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
  set_transaction_category: {
    method: 'setTransactionCategory',
    args: { transaction_id: 'txn1', category_id: 'food' },
  },
  set_transaction_note: {
    method: 'setTransactionNote',
    args: { transaction_id: 'txn1', note: 'test note' },
  },
  set_transaction_tags: {
    method: 'setTransactionTags',
    args: { transaction_id: 'txn1', tag_ids: ['tag1'] },
  },
  review_transactions: {
    method: 'reviewTransactions',
    args: { transaction_ids: ['txn1'], reviewed: true },
  },
  set_transaction_excluded: {
    method: 'setTransactionExcluded',
    args: { transaction_id: 'txn1', excluded: true },
  },
  set_transaction_name: {
    method: 'setTransactionName',
    args: { transaction_id: 'txn1', name: 'New Name' },
  },
  set_internal_transfer: {
    method: 'setInternalTransfer',
    args: { transaction_id: 'txn1', internal_transfer: true },
  },
  set_transaction_goal: {
    method: 'setTransactionGoal',
    args: { transaction_id: 'txn1', goal_id: 'goal1' },
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
  create_budget: {
    method: 'createBudget',
    args: { category_id: 'food', amount: 500 },
  },
  update_budget: {
    method: 'updateBudget',
    args: { budget_id: 'budget1', amount: 600 },
  },
  delete_budget: {
    method: 'deleteBudget',
    args: { budget_id: 'budget1' },
  },
  set_recurring_state: {
    method: 'setRecurringState',
    args: { recurring_id: 'rec1', state: 'paused' },
  },
  delete_recurring: {
    method: 'deleteRecurring',
    args: { recurring_id: 'rec1' },
  },
  update_goal: {
    method: 'updateGoal',
    args: { goal_id: 'goal1', name: 'Updated Goal' },
  },
  delete_goal: {
    method: 'deleteGoal',
    args: { goal_id: 'goal1' },
  },
  update_tag: {
    method: 'updateTag',
    args: { tag_id: 'tag1', name: 'Updated Tag' },
  },
  create_recurring: {
    method: 'createRecurring',
    args: { name: 'New Recurring', amount: 100, frequency: 'monthly' },
  },
  create_goal: {
    method: 'createGoal',
    args: { name: 'New Goal', target_amount: 1000 },
  },
  update_recurring: {
    method: 'updateRecurring',
    args: { recurring_id: 'rec1', name: 'Updated Recurring' },
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
