/**
 * Category tool definitions (cache-mode read + writes).
 */

import { defineTool, type ToolMethodArgs } from './types.js';
import { CATEGORY_VIEWS } from '../constants.js';
import { COLOR_NAMES } from '../../core/graphql/colors.js';

export const getCategoriesTool = defineTool({
  schema: {
    name: 'get_categories',
    description:
      'Unified category retrieval tool. Supports multiple views: ' +
      'list (default) - user categories with transaction counts/amounts for a time period; ' +
      'tree - user categories as hierarchical tree; ' +
      'search - search user categories by keyword. Use parent_id to get subcategories. ' +
      'For list view, use period (e.g., "this_month") or start_date/end_date to filter by date. ' +
      'Includes all categories, even those with $0 spent (matching UI behavior).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: [...CATEGORY_VIEWS],
          description:
            'View mode: list (categories with spend totals), tree (parent/child hierarchy), search (find by keyword)',
        },
        period: {
          type: 'string',
          description:
            "Time period for list view (e.g., 'this_month', 'last_month', 'last_30_days', 'this_year'). " +
            'Takes precedence over start_date/end_date if provided.',
        },
        start_date: {
          type: 'string',
          description: 'Start date for list view (YYYY-MM-DD format)',
        },
        end_date: {
          type: 'string',
          description: 'End date for list view (YYYY-MM-DD format)',
        },
        parent_id: {
          type: 'string',
          description: 'Get subcategories of this parent category ID',
        },
        query: {
          type: 'string',
          description: "Search query (required for 'search' view)",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  swappedOutInLiveMode: true,
  handler: (ctx, args) => ctx.tools.getCategories(args || {}),
});

export const createCategoryTool = defineTool({
  schema: {
    name: 'create_category',
    description:
      'Create a new custom category in Copilot Money. Provide name, color_name, ' +
      'and emoji (all required). Optionally set is_excluded. Returns the generated ' +
      'category_id. The new category can then be used with update_transaction. ' +
      "Note: parent/child category hierarchies are not writable through Copilot's " +
      'GraphQL API — create flat categories only. Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Display name for the new category (e.g., "Subscriptions")',
        },
        color_name: {
          type: 'string',
          enum: [...COLOR_NAMES],
          description: 'Named color from the Copilot palette (e.g., "RED1", "OLIVE1", "PURPLE2").',
        },
        emoji: {
          type: 'string',
          description: 'Emoji icon for the category (e.g., "🎬")',
        },
        is_excluded: {
          type: 'boolean',
          description: 'Exclude this category from spending totals (default: false)',
          default: false,
        },
      },
      required: ['name', 'color_name', 'emoji'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.createCategory(args as ToolMethodArgs<'createCategory'>),
});

export const updateCategoryTool = defineTool({
  schema: {
    name: 'update_category',
    description:
      'Update an existing user-defined category. Provide category_id (required) and any ' +
      'fields to change: name, emoji, color_name, or is_excluded. Only the specified ' +
      'fields are updated. Note: parent/child category hierarchies are not writable ' +
      "through Copilot's GraphQL API. Writes directly to Copilot Money via GraphQL.",
    inputSchema: {
      type: 'object',
      properties: {
        category_id: {
          type: 'string',
          description: 'Category ID to update (from get_categories results)',
        },
        name: {
          type: 'string',
          description: 'New display name for the category',
        },
        emoji: {
          type: 'string',
          description: 'New emoji icon for the category (e.g., "🎬")',
        },
        color_name: {
          type: 'string',
          enum: [...COLOR_NAMES],
          description:
            'New named color from the Copilot palette (e.g., "RED1", "OLIVE1", "PURPLE2").',
        },
        is_excluded: {
          type: 'boolean',
          description: 'Exclude this category from spending totals',
        },
      },
      required: ['category_id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.updateCategory(args as ToolMethodArgs<'updateCategory'>),
});

export const deleteCategoryTool = defineTool({
  schema: {
    name: 'delete_category',
    description:
      'Delete a user-defined category. The category_id can be obtained from get_categories. ' +
      'Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        category_id: {
          type: 'string',
          description: 'Category ID to delete',
        },
      },
      required: ['category_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.deleteCategory(args as ToolMethodArgs<'deleteCategory'>),
});
