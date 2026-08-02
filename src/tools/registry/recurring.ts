/**
 * Recurring-transaction tool definitions (cache-mode read + writes).
 */

import { defineTool, type ToolMethodArgs } from './types.js';
import { RECURRING_FREQUENCIES, RECURRING_STATE_VALUES } from '../../core/graphql/recurrings.js';

/** Shared cadence explanation for the `frequency` enum (create + update). */
const FREQUENCY_DESCRIPTION =
  'How often the recurring repeats. BIWEEKLY = every 2 weeks, BIMONTHLY = every 2 months, ' +
  'QUADMONTHLY = every 4 months, SEMIANNUALLY = every 6 months; the rest are literal.';

export const getRecurringTransactionsTool = defineTool({
  schema: {
    name: 'get_recurring_transactions',
    description:
      'Identify recurring/subscription charges. Combines two data sources: ' +
      '(1) Pattern analysis - finds transactions from same merchant with similar amounts, ' +
      'returns estimated frequency, confidence score, and next expected date. ' +
      "(2) Copilot's native subscription tracking - returns user-confirmed subscriptions " +
      'stored in the app. Both sources are included by default for comprehensive coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        min_occurrences: {
          type: 'integer',
          description: 'Minimum number of occurrences to qualify as recurring (default: 2)',
          default: 2,
        },
        period: {
          type: 'string',
          description:
            'Period to analyze (default: last_90_days). ' +
            'Options: this_month, last_month, last_7_days, last_30_days, ' +
            'last_90_days, ytd, this_year, last_year',
        },
        start_date: {
          type: 'string',
          description: 'Start date (YYYY-MM-DD)',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        end_date: {
          type: 'string',
          description: 'End date (YYYY-MM-DD)',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        },
        include_copilot_subscriptions: {
          type: 'boolean',
          description:
            "Include Copilot's native subscription tracking data (default: true). " +
            'Returns copilot_subscriptions array with user-confirmed subscriptions.',
          default: true,
        },
        name: {
          type: 'string',
          description:
            'Filter by name (case-insensitive partial match). When filtering, returns detailed ' +
            'view with additional fields like min_amount, max_amount, match_string, account info, ' +
            'and transaction history.',
        },
        recurring_id: {
          type: 'string',
          description:
            'Filter by exact recurring ID. When filtering, returns detailed view with additional ' +
            'fields like min_amount, max_amount, match_string, account info, and transaction history.',
        },
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  readOnly: true,
  swappedOutInLiveMode: true,
  handler: (ctx, args) =>
    ctx.tools.getRecurringTransactions((args as ToolMethodArgs<'getRecurringTransactions'>) || {}),
});

export const setRecurringStateTool = defineTool({
  schema: {
    name: 'set_recurring_state',
    description:
      'Change the state of a recurring item (subscription/charge). ' +
      'Set to ACTIVE, PAUSED, or ARCHIVED (uppercase, matching the GraphQL API). ' +
      'Requires recurring_id (from get_recurring_transactions). ' +
      'Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        recurring_id: {
          type: 'string',
          description: 'Recurring item ID to update (from get_recurring_transactions results)',
        },
        state: {
          type: 'string',
          enum: [...RECURRING_STATE_VALUES],
          description: 'New state for the recurring item (uppercase: ACTIVE, PAUSED, ARCHIVED)',
        },
      },
      required: ['recurring_id', 'state'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.setRecurringState(args as ToolMethodArgs<'setRecurringState'>),
});

export const deleteRecurringTool = defineTool({
  schema: {
    name: 'delete_recurring',
    description:
      'Delete a recurring item (subscription/charge). ' +
      'Requires recurring_id (from get_recurring_transactions). ' +
      'Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        recurring_id: {
          type: 'string',
          description: 'Recurring item ID to delete (from get_recurring_transactions results)',
        },
      },
      required: ['recurring_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.deleteRecurring(args as ToolMethodArgs<'deleteRecurring'>),
});

export const createRecurringTool = defineTool({
  schema: {
    name: 'create_recurring',
    description:
      'Create a new recurring/subscription item by seeding it from an existing transaction. ' +
      'The recurring inherits its merchant name, account, and initial amount from that transaction; ' +
      'you only supply the cadence (frequency). If the seed transaction cannot be resolved ' +
      'locally (outside the resolution window), pass account_id and item_id (from a live read) ' +
      'to create the recurring anyway. Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: {
          type: 'string',
          description:
            'ID of an existing transaction to seed the recurring from. The recurring inherits its merchant name, account, and initial amount from this transaction.',
        },
        account_id: {
          type: 'string',
          description:
            'Optional. Account ID the seed transaction belongs to (from a live read). Pass ' +
            'together with item_id to skip local resolution and seed from a transaction ' +
            'outside the resolution window.',
        },
        item_id: {
          type: 'string',
          description:
            "Optional. Item ID the account belongs to (Copilot's Firestore item_id, from a " +
            'live read). Pass together with account_id to skip local resolution and seed from ' +
            'a transaction outside the resolution window.',
        },
        frequency: {
          type: 'string',
          enum: [...RECURRING_FREQUENCIES],
          description: FREQUENCY_DESCRIPTION,
        },
      },
      required: ['transaction_id', 'frequency'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.createRecurring(args as ToolMethodArgs<'createRecurring'>),
});

export const updateRecurringTool = defineTool({
  schema: {
    name: 'update_recurring',
    description:
      'Update an existing recurring transaction. Pass recurring_id plus at least one of ' +
      'name, category_id, frequency, state, or rule. Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        recurring_id: {
          type: 'string',
          description: 'ID of the recurring to update.',
        },
        name: {
          type: 'string',
          description: 'New display name for the recurring series. Must not be empty.',
        },
        category_id: {
          type: 'string',
          description:
            'New category ID (from get_categories results). Becomes the default category for future matched transactions.',
        },
        frequency: {
          type: 'string',
          enum: [...RECURRING_FREQUENCIES],
          description: FREQUENCY_DESCRIPTION,
        },
        state: {
          type: 'string',
          enum: [...RECURRING_STATE_VALUES],
          description:
            'New state. If state is the only change, set_recurring_state is the more specific tool.',
        },
        rule: {
          type: 'object',
          description: 'Matching rule. Controls how Copilot auto-detects future payments.',
          properties: {
            name_contains: {
              type: 'string',
              description: 'Substring that must appear in the merchant/payee name.',
            },
            min_amount: {
              type: 'string',
              description: 'Minimum amount (as a decimal string) for a transaction to match.',
            },
            max_amount: {
              type: 'string',
              description: 'Maximum amount (as a decimal string) for a transaction to match.',
            },
            days: {
              type: 'array',
              items: { type: 'number' },
              description: 'Days of the month (1-31) when this recurring is expected.',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['recurring_id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.updateRecurring(args as ToolMethodArgs<'updateRecurring'>),
});
