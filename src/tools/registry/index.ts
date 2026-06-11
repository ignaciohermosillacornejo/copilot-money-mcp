/**
 * Tool registry — one `ToolDefinition` per MCP tool.
 *
 * The server derives its tool list, dispatch, and write gating from this
 * registry; `scripts/sync-manifest.ts` derives manifest.json from the same
 * definitions. Migration from the legacy `tools.ts` factories +
 * `server.ts` switch is in progress, one domain at a time.
 */

import type { ToolDefinition } from './types.js';
import {
  getTransactionsTool,
  createTransactionTool,
  deleteTransactionTool,
  addTransactionToRecurringTool,
  splitTransactionTool,
  updateTransactionTool,
  reviewTransactionsTool,
} from './transactions.js';
import {
  getCategoriesTool,
  createCategoryTool,
  updateCategoryTool,
  deleteCategoryTool,
} from './categories.js';
import { createTagTool, deleteTagTool, updateTagTool } from './tags.js';
import {
  getRecurringTransactionsTool,
  setRecurringStateTool,
  deleteRecurringTool,
  createRecurringTool,
  updateRecurringTool,
} from './recurring.js';

export type { ToolDefinition, ToolContext, LiveToolContext } from './types.js';

/** Every migrated tool definition. */
export const ALL_TOOL_DEFS: readonly ToolDefinition[] = [
  getTransactionsTool,
  createTransactionTool,
  deleteTransactionTool,
  addTransactionToRecurringTool,
  splitTransactionTool,
  updateTransactionTool,
  reviewTransactionsTool,
  getCategoriesTool,
  createCategoryTool,
  updateCategoryTool,
  deleteCategoryTool,
  createTagTool,
  deleteTagTool,
  updateTagTool,
  getRecurringTransactionsTool,
  setRecurringStateTool,
  deleteRecurringTool,
  createRecurringTool,
  updateRecurringTool,
];

/** Name → definition lookup used by the server's dispatch. */
export const TOOL_REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map(
  ALL_TOOL_DEFS.map((def) => [def.name, def])
);

if (TOOL_REGISTRY.size !== ALL_TOOL_DEFS.length) {
  throw new Error('Tool registry contains duplicate tool names');
}
