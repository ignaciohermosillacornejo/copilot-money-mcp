/**
 * Transaction tool definitions (cache-mode read + writes).
 */

import { defineTool, type ToolMethodArgs } from './types.js';
import { TRANSACTION_TYPE_FILTERS } from '../constants.js';
import { TRANSACTION_TYPES } from '../../core/graphql/transactions.js';

export const getTransactionsTool = defineTool({
  schema: {
    name: 'get_transactions',
    description:
      "Reads from the local LevelDB cache, which may lag behind Copilot's server if the macOS app hasn't synced recently. " +
      'For real-time data use --live-reads with `get_transactions_live`. ' +
      'Unified transaction retrieval tool. Supports multiple modes: ' +
      '(1) Filter-based: Use period, date range, category, merchant, amount filters. ' +
      '(2) Single lookup: Provide transaction_id to get one transaction. ' +
      '(3) Text search: Use query for free-text merchant search. ' +
      `(4) Special types: Use transaction_type for ${TRANSACTION_TYPE_FILTERS.join(', ')}. ` +
      '(5) Location-based: Use city or lat/lon with radius_km. ' +
      '(6) Tag filter: Use tag to find transactions with a specific tag. ' +
      'Returns human-readable category names and normalized merchant names.',
    inputSchema: {
      type: 'object',
      properties: {
        // Date filters
        period: {
          type: 'string',
          description:
            'Period shorthand: this_month, last_month, ' +
            'last_7_days, last_30_days, last_90_days, ytd, ' +
            'this_year, last_year',
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
        // Basic filters
        category: {
          type: 'string',
          description: 'Filter by category (case-insensitive substring)',
        },
        merchant: {
          type: 'string',
          description: 'Filter by merchant name (case-insensitive substring)',
        },
        account_id: {
          type: 'string',
          description: 'Filter by account ID',
        },
        min_amount: {
          type: 'number',
          description: 'Minimum transaction amount',
        },
        max_amount: {
          type: 'number',
          description: 'Maximum transaction amount',
        },
        // Pagination
        limit: {
          type: 'integer',
          description: 'Maximum number of results (default: 100)',
          default: 100,
        },
        offset: {
          type: 'integer',
          description: 'Number of results to skip for pagination (default: 0)',
          default: 0,
        },
        // Toggles
        exclude_transfers: {
          type: 'boolean',
          description:
            'Exclude transfers between accounts and credit card payments (default: true)',
          default: true,
        },
        exclude_deleted: {
          type: 'boolean',
          description: 'Exclude deleted transactions marked by Plaid (default: true)',
          default: true,
        },
        exclude_excluded: {
          type: 'boolean',
          description: 'Exclude user-excluded transactions (default: true)',
          default: true,
        },
        exclude_split_parents: {
          type: 'boolean',
          description:
            'Exclude split-transaction parents (docs with children_transaction_ids). ' +
            'The children already carry the real categorized amounts — returning the ' +
            'parent would double-count the spend. Default: true.',
          default: true,
        },
        pending: {
          type: 'boolean',
          description: 'Filter by pending status (true for pending only, false for settled only)',
        },
        region: {
          type: 'string',
          description: 'Filter by region/city (case-insensitive substring)',
        },
        country: {
          type: 'string',
          description: 'Filter by country code (e.g., US, CL)',
        },
        // NEW: Single transaction lookup
        transaction_id: {
          type: 'string',
          description: 'Get a single transaction by ID (ignores other filters)',
        },
        // NEW: Text search
        query: {
          type: 'string',
          description: 'Free-text search in merchant/transaction names',
        },
        // NEW: Special transaction types
        transaction_type: {
          type: 'string',
          enum: [...TRANSACTION_TYPE_FILTERS],
          description:
            'Filter by special type: foreign (international), refunds, credits (cashback/rewards), ' +
            'duplicates (potential duplicate transactions), hsa_eligible (medical expenses), tagged (has tags)',
        },
        // NEW: Tag filter
        tag: {
          type: 'string',
          description: 'Filter by tag name (e.g. "vacation")',
        },
        // NEW: Location filters
        city: {
          type: 'string',
          description: 'Filter by city name (partial match)',
        },
        lat: {
          type: 'number',
          description: 'Latitude for proximity search (use with lon and radius_km)',
        },
        lon: {
          type: 'number',
          description: 'Longitude for proximity search (use with lat and radius_km)',
        },
        radius_km: {
          type: 'number',
          description: 'Search radius in kilometers (default: 10)',
          default: 10,
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
    ctx.tools.getTransactions((args as ToolMethodArgs<'getTransactions'>) || {}),
});

export const createTransactionTool = defineTool({
  schema: {
    name: 'create_transaction',
    description:
      'Create a brand-new manual transaction on an existing account. Seven ' +
      'fields are required: account_id, item_id (from get_accounts), name, date ' +
      '(YYYY-MM-DD), amount (positive = expense, negative = income; Copilot sign ' +
      'convention), category_id (from get_categories), and type. type is one of ' +
      'REGULAR, INCOME, or INTERNAL_TRANSFER. Three optional metadata fields may ' +
      'also be supplied: tag_ids (from get_tags), note (free-text), and ' +
      'recurring_id (link to an existing recurring series, from ' +
      'get_recurring_transactions). Returns the newly-created transaction.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account_id: {
          type: 'string',
          description: 'Account ID to attach the transaction to (from get_accounts)',
        },
        item_id: {
          type: 'string',
          description:
            "Item ID the account belongs to (from get_accounts; Copilot's Firestore item_id, not the user's)",
        },
        name: {
          type: 'string',
          description: 'Transaction name / merchant label (non-empty)',
        },
        date: {
          type: 'string',
          description: 'Transaction date in YYYY-MM-DD format',
        },
        amount: {
          type: 'number',
          description:
            'Transaction amount. Positive = expense, negative = income (Copilot sign convention).',
        },
        category_id: {
          type: 'string',
          description: 'Category ID to assign (from get_categories)',
        },
        type: {
          type: 'string',
          enum: [...TRANSACTION_TYPES],
          description:
            'Transaction type. REGULAR for typical expenses, INCOME for inflows, INTERNAL_TRANSFER for between-account moves.',
        },
        tag_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional. Tag IDs to attach to the new transaction (from get_tags).',
        },
        note: {
          type: 'string',
          description: 'Optional. Free-text note to attach to the new transaction.',
        },
        recurring_id: {
          type: 'string',
          description:
            'Optional. Link this new transaction to an existing recurring series (from get_recurring_transactions).',
        },
      },
      required: ['account_id', 'item_id', 'name', 'date', 'amount', 'category_id', 'type'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.createTransaction(args as ToolMethodArgs<'createTransaction'>),
});

export const deleteTransactionTool = defineTool({
  schema: {
    name: 'delete_transaction',
    description:
      '**DESTRUCTIVE**: Permanently deletes a transaction from Copilot Money. ' +
      'There is no soft-delete and no undo. All three IDs (transaction_id, ' +
      'account_id, item_id) are required — no lookups — so a typo in one field ' +
      "returns 'Transaction not found' rather than silently deleting a different " +
      'transaction. For Plaid-connected transactions, the source account may re-add ' +
      'the row on its next sync, but any user-side metadata (category override, ' +
      'tags, notes, reviewed state, goal link, split children) will not be preserved.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: {
          type: 'string',
          description: 'Transaction ID to delete (from get_transactions results)',
        },
        account_id: {
          type: 'string',
          description: 'Account ID the transaction belongs to (from the transaction row)',
        },
        item_id: {
          type: 'string',
          description: "Item ID the account belongs to (Copilot's Firestore item_id)",
        },
      },
      required: ['transaction_id', 'account_id', 'item_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.deleteTransaction(args as ToolMethodArgs<'deleteTransaction'>),
});

export const addTransactionToRecurringTool = defineTool({
  schema: {
    name: 'add_transaction_to_recurring',
    description:
      'Manually link an existing transaction to an existing recurring series. Use this when ' +
      "Copilot's auto-detection missed a rent/subscription/etc. charge that should be grouped " +
      'with a recurring. All four IDs are required (transaction_id, account_id, item_id, ' +
      'recurring_id). The transaction must already exist — create_transaction followed by ' +
      'add_transaction_to_recurring is the manual flow. Returns the updated transaction with ' +
      'its recurring_id now populated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: {
          type: 'string',
          description: 'Transaction ID to attach (from get_transactions results)',
        },
        account_id: {
          type: 'string',
          description: 'Account ID the transaction belongs to (from the transaction row)',
        },
        item_id: {
          type: 'string',
          description: "Item ID the account belongs to (Copilot's Firestore item_id)",
        },
        recurring_id: {
          type: 'string',
          description: 'Recurring series ID to link to (from get_recurring_transactions results)',
        },
      },
      required: ['transaction_id', 'account_id', 'item_id', 'recurring_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) =>
    ctx.tools.addTransactionToRecurring(args as ToolMethodArgs<'addTransactionToRecurring'>),
});

export const splitTransactionTool = defineTool({
  schema: {
    name: 'split_transaction',
    description:
      'Split one parent transaction into multiple child transactions (e.g., split a single ' +
      "'Hotel + Car + Meals' charge into three category-specific children). All three parent " +
      'IDs are required (transaction_id, account_id, item_id) plus a `splits` array with at ' +
      'least 2 entries. Each split entry requires `amount` and `category_id`; `name` and ' +
      "`date` default to the parent's values if omitted. The sum of all children's `amount` " +
      "fields must equal the parent's `amount` (server-enforced; this tool also validates " +
      'client-side before dispatching). After success the parent transaction is hidden but ' +
      'not deleted (children reference it via parent_transaction_id) — there is no reversal ' +
      "mutation; to undo a split delete each child and edit the parent's category back. No " +
      'optional per-split fields exist — tags, notes, and reviewed state must be set via ' +
      'update_transaction on each child after split.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: {
          type: 'string',
          description: 'Parent transaction ID to split (from get_transactions results)',
        },
        account_id: {
          type: 'string',
          description: 'Account ID the parent transaction belongs to (from the transaction row)',
        },
        item_id: {
          type: 'string',
          description: "Item ID the account belongs to (Copilot's Firestore item_id)",
        },
        splits: {
          type: 'array',
          minItems: 2,
          description:
            'Children to create. Must have at least 2 entries; child amounts must sum to the parent amount.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: {
                type: 'string',
                description: "Child name. Defaults to the parent's name if omitted.",
              },
              date: {
                type: 'string',
                description: "YYYY-MM-DD; defaults to the parent's date if omitted.",
              },
              amount: {
                type: 'number',
                description:
                  'Child amount. Positive = expense, negative = income (Copilot sign convention). All child amounts must sum to the parent amount.',
              },
              category_id: {
                type: 'string',
                description: 'Category ID for the child (from get_categories results)',
              },
            },
            required: ['amount', 'category_id'],
          },
        },
      },
      required: ['transaction_id', 'account_id', 'item_id', 'splits'],
    },
    annotations: {
      readOnlyHint: false,
      // Destructive: the parent transaction is permanently hidden post-split
      // (categoryId blanked, children_transaction_ids populated) and there
      // is no reversal mutation. "Undo" requires per-child delete + parent
      // edit. Idempotent is also false — re-running creates duplicate
      // children on the parent. Both hints reflect the "no safe retry"
      // nature of the operation.
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.splitTransaction(args as ToolMethodArgs<'splitTransaction'>),
});

export const updateTransactionTool = defineTool({
  schema: {
    name: 'update_transaction',
    description:
      "Update a single transaction's name, category, note, tags, or type. Pass transaction_id " +
      'plus any combination of name, category_id, note, tag_ids, or type — only specified fields ' +
      'are changed. Pass note="" to clear the note. Pass tag_ids=[] to clear all tags. `type` sets ' +
      'the high-level classification (REGULAR, INCOME, or INTERNAL_TRANSFER) — use ' +
      'INTERNAL_TRANSFER to exclude internal/transfer mechanics from spending. Setting type to ' +
      "INCOME or INTERNAL_TRANSFER clears the transaction's category (Copilot does this " +
      'server-side), so category_id cannot be combined with those two types — pass the type alone, ' +
      'or use REGULAR to keep/set a category. At least one mutable field must be provided besides ' +
      'transaction_id. Other fields (excluded, internal_transfer, goal_id) are not writable ' +
      'through the GraphQL API and were removed from this tool when the backend was migrated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        transaction_id: {
          type: 'string',
          description: 'Transaction ID to update (from get_transactions results)',
        },
        name: {
          type: 'string',
          description: 'New display name for the transaction. Must not be empty.',
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
        type: {
          type: 'string',
          enum: ['REGULAR', 'INCOME', 'INTERNAL_TRANSFER'],
          description:
            'High-level classification. INTERNAL_TRANSFER excludes the transaction from spending. ' +
            'INCOME/INTERNAL_TRANSFER clear the category server-side — do not pass category_id with them.',
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
  readOnly: false,
  handler: (ctx, args) => ctx.tools.updateTransaction(args as ToolMethodArgs<'updateTransaction'>),
});

export const reviewTransactionsTool = defineTool({
  schema: {
    name: 'review_transactions',
    description:
      'Mark one or more transactions as reviewed (or unreviewed). ' +
      'Accepts an array of transaction_ids. Writes are issued via GraphQL in parallel with ' +
      'a cap of 5 in flight at a time. On the first GraphQL error, new writes stop, in-flight ' +
      'writes settle, and the error is thrown with a `reviewed_count` reflecting how many ' +
      'succeeded before the failure (partial success is possible).',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Transaction IDs to mark as reviewed',
        },
        reviewed: {
          type: 'boolean',
          description: 'Set to true to mark as reviewed, false to unmark. Defaults to true.',
        },
      },
      required: ['transaction_ids'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) =>
    ctx.tools.reviewTransactions(args as ToolMethodArgs<'reviewTransactions'>),
});
