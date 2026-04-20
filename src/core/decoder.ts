/**
 * LevelDB/Protobuf decoder for Copilot Money Firestore data.
 *
 * This module provides type-safe decoding of Firestore documents stored in LevelDB,
 * using proper protocol buffer parsing instead of brittle pattern matching.
 */

import { type ZodType } from 'zod';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { iterateDocuments } from './leveldb-reader.js';
import { type FirestoreValue, toPlainObject } from './protobuf-parser.js';
import { validateOrWarn } from './schema-warn.js';

// Re-export for potential use by other modules
export { toPlainObject } from './protobuf-parser.js';
import { Transaction, TransactionSchema } from '../models/transaction.js';
import { Account, AccountSchema, getAccountDisplayName } from '../models/account.js';
import { Recurring, RecurringSchema } from '../models/recurring.js';
import { Budget, BudgetSchema } from '../models/budget.js';
import { Goal, GoalSchema } from '../models/goal.js';
import { GoalHistory, GoalHistorySchema, DailySnapshot } from '../models/goal-history.js';
import { InvestmentPrice, InvestmentPriceSchema } from '../models/investment-price.js';
import { InvestmentSplit, InvestmentSplitSchema } from '../models/investment-split.js';
import { Item, ItemSchema } from '../models/item.js';
import { Category, CategorySchema } from '../models/category.js';
import {
  InvestmentPerformance,
  InvestmentPerformanceSchema,
  TwrHolding,
  TwrHoldingSchema,
} from '../models/investment-performance.js';
import { PlaidAccount, PlaidAccountSchema } from '../models/plaid-account.js';
import { BalanceHistory, BalanceHistorySchema } from '../models/balance-history.js';
import {
  HoldingsHistoryMeta,
  HoldingsHistoryMetaSchema,
  HoldingsHistory,
  HoldingsHistorySchema,
} from '../models/holdings-history.js';
import {
  Change,
  ChangeSchema,
  TransactionChange,
  TransactionChangeSchema,
  AccountChange,
  AccountChangeSchema,
} from '../models/change.js';
import { Security, SecuritySchema } from '../models/security.js';
import { UserProfile, UserProfileSchema } from '../models/user-profile.js';
import { Tag, TagSchema } from '../models/tag.js';
import {
  AmazonIntegration,
  AmazonIntegrationSchema,
  AmazonOrder,
  AmazonOrderSchema,
} from '../models/amazon.js';
import {
  Subscription,
  SubscriptionSchema,
  Invite,
  InviteSchema,
  UserItems,
  UserItemsSchema,
  FeatureTracking,
  FeatureTrackingSchema,
  Support,
  SupportSchema,
} from '../models/app-metadata.js';

/**
 * Extract a primitive value from a FirestoreValue.
 * Useful for debugging and converting Firestore values to plain JS values.
 */
export function extractValue(value: FirestoreValue | undefined): unknown {
  if (!value) return undefined;

  switch (value.type) {
    case 'string':
    case 'integer':
    case 'double':
    case 'boolean':
    case 'reference':
      return value.value;
    case 'null':
      return null;
    case 'timestamp':
      return new Date(value.value.seconds * 1000).toISOString().split('T')[0];
    case 'geopoint':
      return { lat: value.value.latitude, lon: value.value.longitude };
    case 'map':
      return toPlainObject(value.value);
    case 'array':
      return value.value.map((v) => extractValue(v));
    case 'bytes':
      return value.value;
    default:
      return undefined;
  }
}

/**
 * Extract a string field from parsed Firestore fields.
 */
function getString(fields: Map<string, FirestoreValue>, key: string): string | undefined {
  const value = fields.get(key);
  if (value?.type === 'string') {
    return value.value;
  }
  if (value?.type === 'reference') {
    return value.value;
  }
  return undefined;
}

/**
 * Extract a number field from parsed Firestore fields.
 */
function getNumber(fields: Map<string, FirestoreValue>, key: string): number | undefined {
  const value = fields.get(key);
  if (value?.type === 'double' || value?.type === 'integer') {
    return value.value;
  }
  return undefined;
}

/**
 * Extract a boolean field from parsed Firestore fields.
 */
function getBoolean(fields: Map<string, FirestoreValue>, key: string): boolean | undefined {
  const value = fields.get(key);
  if (value?.type === 'boolean') {
    return value.value;
  }
  return undefined;
}

/**
 * Extract a date string from a timestamp field.
 */
function getDateString(fields: Map<string, FirestoreValue>, key: string): string | undefined {
  const value = fields.get(key);
  if (value?.type === 'string') {
    // Already a date string
    return value.value;
  }
  if (value?.type === 'timestamp') {
    // Convert timestamp to YYYY-MM-DD
    const date = new Date(value.value.seconds * 1000);
    return date.toISOString().split('T')[0];
  }
  return undefined;
}

/**
 * Extract a map/object field.
 */
function getMap(
  fields: Map<string, FirestoreValue>,
  key: string
): Map<string, FirestoreValue> | undefined {
  const value = fields.get(key);
  if (value?.type === 'map') {
    return value.value;
  }
  return undefined;
}

/**
 * Extract an array of strings from a Firestore array field.
 */
function getStringArray(fields: Map<string, FirestoreValue>, key: string): string[] | undefined {
  const value = fields.get(key);
  if (value?.type === 'array') {
    const strings: string[] = [];
    for (const item of value.value) {
      if (item.type === 'string') {
        strings.push(item.value);
      }
    }
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
}

/**
 * Calculate the next payment date from a last payment date and frequency.
 */
function calculateNextDate(lastDate: string, frequency: string | undefined): string | undefined {
  if (!lastDate || !frequency) return undefined;

  const date = new Date(lastDate);
  if (isNaN(date.getTime())) return undefined;

  switch (frequency.toLowerCase()) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'biweekly':
      date.setDate(date.getDate() + 14);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'bimonthly':
      date.setMonth(date.getMonth() + 2);
      break;
    case 'quarterly':
      date.setMonth(date.getMonth() + 3);
      break;
    case 'quadmonthly':
      date.setMonth(date.getMonth() + 4);
      break;
    case 'semiannually':
      date.setMonth(date.getMonth() + 6);
      break;
    case 'yearly':
    case 'annually':
      date.setFullYear(date.getFullYear() + 1);
      break;
    default:
      // Unknown frequency, assume monthly
      date.setMonth(date.getMonth() + 1);
  }

  return date.toISOString().split('T')[0];
}

/**
 * Deduplicate transactions by transaction_id.
 * LevelDB may store the same Firestore document multiple times;
 * this collapses true duplicates without dropping distinct transactions
 * that happen to share the same merchant/amount/date.
 */
function deduplicateTransactions(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  const unique: Transaction[] = [];

  for (const txn of transactions) {
    if (!seen.has(txn.transaction_id)) {
      seen.add(txn.transaction_id);
      unique.push(txn);
    }
  }

  return unique;
}

/**
 * Reconcile pending and posted versions of the same transaction.
 * When a charge posts, two versions can coexist in LevelDB:
 * - A pending version (pending=true)
 * - A posted version (pending=false/undefined) with pending_transaction_id
 *   pointing to the pending transaction's ID
 *
 * This function drops the pending version when a matching posted version exists,
 * preventing double-counting in aggregations like category totals.
 */
function reconcilePendingTransactions(transactions: Transaction[]): Transaction[] {
  // Collect transaction IDs that have been superseded by a posted version
  const supersededPendingIds = new Set<string>();
  for (const txn of transactions) {
    if (!txn.pending && txn.pending_transaction_id) {
      supersededPendingIds.add(txn.pending_transaction_id);
    }
  }

  // Filter out superseded pending transactions
  return transactions.filter(
    (txn) => !(txn.pending && supersededPendingIds.has(txn.transaction_id))
  );
}

/**
 * Decode all transactions from LevelDB database.
 */
export async function decodeTransactions(dbPath: string): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'transactions' })) {
    const txn = processTransaction(doc.fields, doc.documentId);
    if (txn) transactions.push(txn);
  }

  // Deduplicate by transaction_id (Firestore document ID)
  // This correctly collapses only true LevelDB-level duplicates (same document stored more than once)
  // without dropping distinct transactions that happen to share display_name/amount/date
  const deduped = deduplicateTransactions(transactions);

  // Reconcile pending/posted pairs
  const reconciled = reconcilePendingTransactions(deduped);

  // Sort by date descending
  reconciled.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
  return reconciled;
}

/**
 * Decode account information from LevelDB database.
 */
export async function decodeAccounts(dbPath: string): Promise<Account[]> {
  const accounts: Account[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'accounts' })) {
    const acc = processAccount(doc.fields, doc.documentId);
    if (acc) accounts.push(acc);
  }

  // Deduplicate by (name, mask)
  const seen = new Set<string>();
  const unique: Account[] = [];

  for (const acc of accounts) {
    const displayName = getAccountDisplayName(acc);
    const key = `${displayName}|${acc.mask ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(acc);
    }
  }

  return unique;
}

/**
 * Decode recurring transactions from LevelDB database.
 */
export async function decodeRecurring(dbPath: string): Promise<Recurring[]> {
  const recurring: Recurring[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'recurring' })) {
    const rec = processRecurring(doc.fields, doc.documentId);
    if (rec) recurring.push(rec);
  }

  // Deduplicate by recurring_id
  const seen = new Set<string>();
  const unique: Recurring[] = [];

  for (const rec of recurring) {
    if (!seen.has(rec.recurring_id)) {
      seen.add(rec.recurring_id);
      unique.push(rec);
    }
  }

  return unique;
}

/**
 * Decode budgets from LevelDB database.
 */
export async function decodeBudgets(dbPath: string): Promise<Budget[]> {
  const budgets: Budget[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'budgets' })) {
    const budget = processBudget(doc.fields, doc.documentId);
    if (budget) budgets.push(budget);
  }

  // Deduplicate by budget_id
  const seen = new Set<string>();
  const unique: Budget[] = [];

  for (const budget of budgets) {
    if (!seen.has(budget.budget_id)) {
      seen.add(budget.budget_id);
      unique.push(budget);
    }
  }

  return unique;
}

/**
 * Decode financial goals from LevelDB database.
 */
export async function decodeGoals(dbPath: string): Promise<Goal[]> {
  const goals: Goal[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'financial_goals' })) {
    const goal = processGoal(doc.fields, doc.documentId);
    if (goal) goals.push(goal);
  }

  // Deduplicate by goal_id
  const seen = new Set<string>();
  const unique: Goal[] = [];

  for (const goal of goals) {
    if (!seen.has(goal.goal_id)) {
      seen.add(goal.goal_id);
      unique.push(goal);
    }
  }

  return unique;
}

/**
 * Decode financial goal history from LevelDB database.
 */
export async function decodeGoalHistory(dbPath: string, goalId?: string): Promise<GoalHistory[]> {
  const histories: GoalHistory[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'financial_goal_history' })) {
    // Filter by goalId if specified (before processing)
    if (goalId) {
      const extractedGoalId = doc.collection.split('/')[1] ?? getString(doc.fields, 'goal_id');
      if (extractedGoalId !== goalId) continue;
    }

    const history = processGoalHistory(doc.fields, doc.documentId, doc.collection);
    if (history) histories.push(history);
  }

  // Deduplicate by goal_id + month
  const seen = new Set<string>();
  const unique: GoalHistory[] = [];

  for (const history of histories) {
    const key = `${history.goal_id}:${history.month}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(history);
    }
  }

  // Sort by goal_id and then by month (newest first)
  unique.sort((a, b) => {
    if (a.goal_id !== b.goal_id) {
      return a.goal_id.localeCompare(b.goal_id);
    }
    return b.month.localeCompare(a.month);
  });

  return unique;
}

/**
 * Decode investment prices from LevelDB database.
 */
export async function decodeInvestmentPrices(
  dbPath: string,
  options: {
    tickerSymbol?: string;
    startDate?: string;
    endDate?: string;
    priceType?: 'daily' | 'hf';
  } = {}
): Promise<InvestmentPrice[]> {
  const { tickerSymbol, startDate, endDate, priceType } = options;
  const prices: InvestmentPrice[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'investment_prices' })) {
    // Pre-filter by ticker
    if (tickerSymbol) {
      const ticker = getString(doc.fields, 'ticker_symbol');
      if (ticker !== tickerSymbol) continue;
    }

    // Pre-filter by price type
    if (priceType === 'daily' && !doc.key.includes('/daily/')) continue;
    if (priceType === 'hf' && !doc.key.includes('/hf/')) continue;

    // Pre-filter by date range
    if (startDate || endDate) {
      const date = getString(doc.fields, 'date');
      const month = getString(doc.fields, 'month');
      const recordDate = date ?? month;
      if (recordDate) {
        if (startDate && recordDate < startDate) continue;
        if (endDate && recordDate > endDate) continue;
      }
    }

    const price = processInvestmentPrice(doc.fields, doc.documentId, doc.key);
    if (price) prices.push(price);
  }

  // Deduplicate by investment_id + date/month
  const seen = new Set<string>();
  const unique: InvestmentPrice[] = [];

  for (const price of prices) {
    const key = `${price.investment_id}-${price.date || price.month || 'unknown'}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(price);
    }
  }

  // Sort by investment_id, then by date/month (newest first)
  unique.sort((a, b) => {
    if (a.investment_id !== b.investment_id) {
      return a.investment_id.localeCompare(b.investment_id);
    }
    const dateA = a.date || a.month || '';
    const dateB = b.date || b.month || '';
    return dateB.localeCompare(dateA);
  });

  return unique;
}

/**
 * Decode investment splits from LevelDB database.
 */
export async function decodeInvestmentSplits(
  dbPath: string,
  options: {
    tickerSymbol?: string;
    startDate?: string;
    endDate?: string;
  } = {}
): Promise<InvestmentSplit[]> {
  const { tickerSymbol, startDate, endDate } = options;
  const splits: InvestmentSplit[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'investment_splits' })) {
    // Pre-filter by ticker
    if (tickerSymbol) {
      const ticker = getString(doc.fields, 'ticker_symbol');
      if (ticker !== tickerSymbol) continue;
    }

    // Pre-filter by date range
    if (startDate || endDate) {
      const splitDate = getString(doc.fields, 'split_date');
      if (splitDate) {
        if (startDate && splitDate < startDate) continue;
        if (endDate && splitDate > endDate) continue;
      }
    }

    const split = processInvestmentSplit(doc.fields, doc.documentId);
    if (split) splits.push(split);
  }

  // Deduplicate by split_id
  const seen = new Set<string>();
  const unique: InvestmentSplit[] = [];

  for (const split of splits) {
    if (!seen.has(split.split_id)) {
      seen.add(split.split_id);
      unique.push(split);
    }
  }

  // Sort by ticker_symbol, then by split_date (newest first)
  unique.sort((a, b) => {
    const tickerA = a.ticker_symbol || '';
    const tickerB = b.ticker_symbol || '';
    if (tickerA !== tickerB) {
      return tickerA.localeCompare(tickerB);
    }
    const dateA = a.split_date || '';
    const dateB = b.split_date || '';
    return dateB.localeCompare(dateA);
  });

  return unique;
}

/**
 * Decode Plaid items (institution connections) from LevelDB database.
 */
export async function decodeItems(
  dbPath: string,
  options: {
    connectionStatus?: string;
    institutionId?: string;
    needsUpdate?: boolean;
  } = {}
): Promise<Item[]> {
  const { connectionStatus, institutionId, needsUpdate } = options;
  const items: Item[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'items' })) {
    const item = processItem(doc.fields, doc.documentId);
    if (!item) continue;

    // Apply filters after processing
    if (connectionStatus && item.connection_status !== connectionStatus) continue;
    if (institutionId && item.institution_id !== institutionId) continue;
    if (needsUpdate !== undefined && item.needs_update !== needsUpdate) continue;

    items.push(item);
  }

  // Deduplicate by item_id
  const seen = new Set<string>();
  const unique: Item[] = [];

  for (const item of items) {
    if (!seen.has(item.item_id)) {
      seen.add(item.item_id);
      unique.push(item);
    }
  }

  // Sort by institution_name, then by item_id
  unique.sort((a, b) => {
    const nameA = a.institution_name || '';
    const nameB = b.institution_name || '';
    if (nameA !== nameB) {
      return nameA.localeCompare(nameB);
    }
    return a.item_id.localeCompare(b.item_id);
  });

  return unique;
}

/**
 * Decode user-defined categories from LevelDB database.
 */
export async function decodeCategories(dbPath: string): Promise<Category[]> {
  const categories: Category[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'categories' })) {
    const category = processCategory(doc.fields, doc.documentId);
    if (category) categories.push(category);
  }

  // Deduplicate by category_id
  const seen = new Set<string>();
  const unique: Category[] = [];

  for (const category of categories) {
    if (!seen.has(category.category_id)) {
      seen.add(category.category_id);
      unique.push(category);
    }
  }

  // Sort by order, then by name
  unique.sort((a, b) => {
    const orderA = a.order ?? 999;
    const orderB = b.order ?? 999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    const nameA = a.name || '';
    const nameB = b.name || '';
    return nameA.localeCompare(nameB);
  });

  return unique;
}

/**
 * User account customization data.
 */
export interface UserAccountCustomization {
  account_id: string;
  name?: string;
  user_id?: string;
  hidden?: boolean;
  order?: number;
}

/**
 * Decode user-defined account customizations from LevelDB database.
 */
export async function decodeUserAccounts(dbPath: string): Promise<UserAccountCustomization[]> {
  const userAccounts: UserAccountCustomization[] = [];

  // User accounts are in subcollection: users/{user_id}/accounts
  for await (const doc of iterateDocuments(dbPath)) {
    // Check if this is a user account document
    if (!doc.collection.includes('users/') || !doc.collection.endsWith('/accounts')) {
      continue;
    }

    const userAccount = processUserAccount(doc.fields, doc.documentId, doc.collection);
    if (userAccount) userAccounts.push(userAccount);
  }

  // Deduplicate by account_id
  const seen = new Set<string>();
  const unique: UserAccountCustomization[] = [];

  for (const userAccount of userAccounts) {
    if (!seen.has(userAccount.account_id)) {
      seen.add(userAccount.account_id);
      unique.push(userAccount);
    }
  }

  return unique;
}

/**
 * Result of batch decoding all collections.
 */
export interface AllCollectionsResult {
  transactions: Transaction[];
  accounts: Account[];
  recurring: Recurring[];
  budgets: Budget[];
  goals: Goal[];
  goalHistory: GoalHistory[];
  investmentPrices: InvestmentPrice[];
  investmentSplits: InvestmentSplit[];
  items: Item[];
  categories: Category[];
  userAccounts: UserAccountCustomization[];
  investmentPerformance: InvestmentPerformance[];
  twrHoldings: TwrHolding[];
  plaidAccounts: PlaidAccount[];
  balanceHistory: BalanceHistory[];
  holdingsHistoryMeta: HoldingsHistoryMeta[];
  holdingsHistory: HoldingsHistory[];
  changes: Change[];
  transactionChanges: TransactionChange[];
  accountChanges: AccountChange[];
  securities: Security[];
  userProfiles: UserProfile[];
  tags: Tag[];
  amazonIntegrations: AmazonIntegration[];
  amazonOrders: AmazonOrder[];
  subscriptions: Subscription[];
  invites: Invite[];
  userItems: UserItems[];
  featureTracking: FeatureTracking[];
  supportDocs: Support[];
}

/**
 * Internal helper to process a transaction document.
 */
function processTransaction(
  fields: Map<string, FirestoreValue>,
  docId: string
): Transaction | null {
  const transactionId = getString(fields, 'transaction_id') ?? docId;
  const amount = getNumber(fields, 'amount');
  const date = getDateString(fields, 'date') ?? getDateString(fields, 'original_date');

  if (amount === undefined || !date || amount === 0) {
    return null;
  }

  const txnData: Record<string, unknown> = {
    transaction_id: transactionId,
    amount,
    date,
  };

  const stringFields = [
    'name',
    'original_name',
    'original_clean_name',
    'name_override',
    'account_id',
    'item_id',
    'user_id',
    'category_id',
    'plaid_category_id',
    'category_id_source',
    'account_type',
    'original_date',
    'pending_transaction_id',
    'iso_currency_code',
    'transaction_type',
    'plaid_transaction_type',
    'payment_method',
    'payment_processor',
    'city',
    'region',
    'address',
    'postal_code',
    'country',
    'reference_number',
    'ppd_id',
    'by_order_of',
    'from_investment',
    'user_note',
    '_origin',
    'intelligence_chosen_category_id',
    'recurring_id',
    'plaid_pending_transaction_id',
    'posted_transaction_id',
    'original_transaction_id',
    'old_category_id',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) txnData[field] = value;
  }

  // from_investment can be stored as boolean in DB; capture it either way
  if (txnData.from_investment === undefined) {
    const fromInvestmentBool = getBoolean(fields, 'from_investment');
    if (fromInvestmentBool !== undefined) txnData.from_investment = fromInvestmentBool;
  }

  const booleanFields = [
    'pending',
    'excluded',
    'user_reviewed',
    'plaid_deleted',
    'is_amazon',
    'account_dashboard_active',
    'is_manual',
    'recurring',
    'skip_balance_adjust',
    'user_deleted',
    'intelligence_powered',
  ];

  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) txnData[field] = value;
  }

  const numericFields = ['original_amount', 'lat', 'lon', 'pending_amount'];

  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) txnData[field] = value;
  }

  // Date/timestamp fields
  const createdTimestamp = getDateString(fields, 'created_timestamp');
  if (createdTimestamp) txnData.created_timestamp = createdTimestamp;

  // String array fields
  const stringArrayFields = [
    'plaid_category_strings',
    'intelligence_suggested_category_ids',
    'tag_ids',
  ];

  for (const field of stringArrayFields) {
    const value = getStringArray(fields, field);
    if (value) txnData[field] = value;
  }

  // Map fields (converted to plain objects)
  const mapFields = ['internal_tx_match', 'venmo_extra_data'];

  for (const field of mapFields) {
    const mapValue = getMap(fields, field);
    if (mapValue) txnData[field] = toPlainObject(mapValue);
  }

  const copilotType = getString(fields, 'type');
  if (copilotType === 'internal_transfer') {
    txnData.internal_transfer = true;
  }

  return validateOrWarn(TransactionSchema, txnData, {
    collection: 'transactions',
    docId,
  });
}

/**
 * Internal helper to process an account document.
 */
function processAccount(fields: Map<string, FirestoreValue>, docId: string): Account | null {
  const accountId = getString(fields, 'account_id') ?? getString(fields, 'id') ?? docId;
  const balance =
    getNumber(fields, 'current_balance') ?? getNumber(fields, 'original_current_balance');

  if (balance === undefined) {
    return null;
  }

  const accData: Record<string, unknown> = {
    account_id: accountId,
    current_balance: Math.round(balance * 100) / 100,
  };

  const stringFields = [
    'name',
    'official_name',
    'mask',
    'institution_name',
    'item_id',
    'iso_currency_code',
    'institution_id',
    'color',
    'custom_color',
    'logo',
    'logo_content_type',
    '_origin',
    'nickname',
    'group_id',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) accData[field] = value;
  }

  // id field — store separately from account_id
  const idField = getString(fields, 'id');
  if (idField) accData.id = idField;

  const accountType =
    getString(fields, 'type') ??
    getString(fields, 'account_type') ??
    getString(fields, 'original_type');
  if (accountType) accData.account_type = accountType;

  const subtype = getString(fields, 'subtype') ?? getString(fields, 'original_subtype');
  if (subtype) accData.subtype = subtype;

  // Always store original_* fields separately even when used as fallback
  const originalType = getString(fields, 'original_type');
  if (originalType) accData.original_type = originalType;

  const originalSubtype = getString(fields, 'original_subtype');
  if (originalSubtype) accData.original_subtype = originalSubtype;

  const originalCurrentBalance = getNumber(fields, 'original_current_balance');
  if (originalCurrentBalance !== undefined) {
    accData.original_current_balance = Math.round(originalCurrentBalance * 100) / 100;
  }

  const availableBalance = getNumber(fields, 'available_balance');
  if (availableBalance !== undefined) {
    accData.available_balance = Math.round(availableBalance * 100) / 100;
  }

  // Check for null limit (credit cards) vs numeric limit
  const limitField = fields.get('limit');
  if (limitField) {
    if (limitField.type === 'null') {
      accData.limit = null;
    } else {
      const limitVal = getNumber(fields, 'limit');
      if (limitVal !== undefined) accData.limit = limitVal;
    }
  }

  // Boolean flags
  const booleanFields = [
    'user_deleted',
    'historical_update',
    'dashboard_active',
    'savings_active',
    'provider_deleted',
    'live_balance_backend_disabled',
    'live_balance_user_disabled',
    'holdings_initialized',
    'investments_performance_enabled',
    'is_manual',
    'user_hidden',
    'group_leader',
  ];

  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) accData[field] = value;
  }

  // verification_status — can be string or null
  const verificationField = fields.get('verification_status');
  if (verificationField) {
    if (verificationField.type === 'null') {
      accData.verification_status = null;
    } else {
      const vs = getString(fields, 'verification_status');
      if (vs) accData.verification_status = vs;
    }
  }

  // Timestamp fields
  const latestBalanceUpdate = getDateString(fields, 'latest_balance_update');
  if (latestBalanceUpdate) accData.latest_balance_update = latestBalanceUpdate;

  // Holdings array (investment accounts)
  const holdingsField = fields.get('holdings');
  if (holdingsField && holdingsField.type === 'array') {
    const holdings: Record<string, unknown>[] = [];
    for (const item of holdingsField.value) {
      if (item.type === 'map') {
        holdings.push(toPlainObject(item.value));
      }
    }
    if (holdings.length > 0) {
      accData.holdings = holdings;
    }
  }

  // Complex map fields
  const metadataMap = getMap(fields, 'metadata');
  if (metadataMap) accData.metadata = toPlainObject(metadataMap);

  const mergedMap = getMap(fields, 'merged');
  if (mergedMap) accData.merged = toPlainObject(mergedMap);

  if (!accData.name && !accData.official_name) {
    return null;
  }

  return validateOrWarn(AccountSchema, accData, {
    collection: 'accounts',
    docId,
  });
}

/**
 * Internal helper to process a recurring document.
 */
function processRecurring(fields: Map<string, FirestoreValue>, docId: string): Recurring | null {
  // Use 'id' field as the recurring_id (Copilot stores it as 'id')
  const recurringId = getString(fields, 'recurring_id') ?? getString(fields, 'id') ?? docId;

  const recData: Record<string, unknown> = {
    recurring_id: recurringId,
  };

  // String fields - map Copilot field names to our schema
  const stringFields = [
    'name',
    'merchant_name',
    'frequency',
    'category_id',
    'account_id',
    'iso_currency_code',
    'emoji',
    'match_string',
    'plaid_category_id',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) recData[field] = value;
  }

  // Handle state field (Copilot uses 'state' not 'is_active')
  const state = getString(fields, 'state');
  if (state === 'active' || state === 'paused' || state === 'archived') {
    recData.state = state;
    // Derive is_active from state for backwards compatibility
    recData.is_active = state === 'active';
  } else {
    // Fall back to is_active boolean if present
    const isActive = getBoolean(fields, 'is_active');
    if (isActive !== undefined) recData.is_active = isActive;
  }

  // Number fields
  const amount = getNumber(fields, 'amount');
  if (amount !== undefined) recData.amount = amount;

  const minAmount = getNumber(fields, 'min_amount');
  if (minAmount !== undefined) recData.min_amount = minAmount;

  const maxAmount = getNumber(fields, 'max_amount');
  if (maxAmount !== undefined) recData.max_amount = maxAmount;

  const daysFilter = getNumber(fields, 'days_filter');
  if (daysFilter !== undefined) recData.days_filter = daysFilter;

  // Date fields - Copilot uses 'latest_date' not 'last_date'
  const latestDate = getString(fields, 'latest_date');
  if (latestDate) {
    recData.last_date = latestDate;

    // Calculate next_date from latest_date + frequency
    const frequency = getString(fields, 'frequency');
    const nextDate = calculateNextDate(latestDate, frequency);
    if (nextDate) {
      recData.next_date = nextDate;
    }
  }

  // Also check for explicit next_date and last_date fields
  const explicitNextDate = getString(fields, 'next_date');
  if (explicitNextDate) recData.next_date = explicitNextDate;

  const explicitLastDate = getString(fields, 'last_date');
  if (explicitLastDate) recData.last_date = explicitLastDate;

  // Transaction IDs array
  const transactionIds = getStringArray(fields, 'transaction_ids');
  if (transactionIds) recData.transaction_ids = transactionIds;

  // Additional array fields
  const excludedTransactionIds = getStringArray(fields, 'excluded_transaction_ids');
  if (excludedTransactionIds) recData.excluded_transaction_ids = excludedTransactionIds;

  const includedTransactionIds = getStringArray(fields, 'included_transaction_ids');
  if (includedTransactionIds) recData.included_transaction_ids = includedTransactionIds;

  // Additional boolean fields
  const skipFilterUpdate = getBoolean(fields, 'skip_filter_update');
  if (skipFilterUpdate !== undefined) recData.skip_filter_update = skipFilterUpdate;

  // Additional string fields
  const identificationMethod = getString(fields, 'identification_method');
  if (identificationMethod) recData.identification_method = identificationMethod;

  const origin = getString(fields, '_origin');
  if (origin) recData._origin = origin;

  // Store latest_date alongside last_date — Firestore uses latest_date as the canonical
  // field name, but our schema exposes last_date for readability. Both kept for consumers.
  if (latestDate) recData.latest_date = latestDate;

  return validateOrWarn(RecurringSchema, recData, {
    collection: 'recurring',
    docId,
  });
}

/**
 * Internal helper to process a budget document.
 */
function processBudget(fields: Map<string, FirestoreValue>, docId: string): Budget | null {
  // Firestore represents deleted docs as empty-field entries. Drop them
  // rather than surfacing ghost `{budget_id}` rows (issue #278).
  if (fields.size === 0) return null;

  const budgetId = getString(fields, 'budget_id') ?? docId;

  const budgetData: Record<string, unknown> = {
    budget_id: budgetId,
  };

  const stringFields = [
    'name',
    'period',
    'category_id',
    'start_date',
    'end_date',
    'iso_currency_code',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) budgetData[field] = value;
  }

  const amount = getNumber(fields, 'amount');
  if (amount !== undefined) budgetData.amount = amount;

  const isActive = getBoolean(fields, 'is_active');
  if (isActive !== undefined) budgetData.is_active = isActive;

  // Monthly budget overrides map (e.g. "2024-02": 150)
  const amountsMap = getMap(fields, 'amounts');
  if (amountsMap) {
    const amounts: Record<string, number> = {};
    for (const [key, value] of amountsMap) {
      if (value.type === 'double' || value.type === 'integer') {
        amounts[key] = value.value;
      }
    }
    if (Object.keys(amounts).length > 0) {
      budgetData.amounts = amounts;
    }
  }

  // ID field
  const id = getString(fields, 'id');
  if (id) budgetData.id = id;

  return validateOrWarn(BudgetSchema, budgetData, {
    collection: 'budgets',
    docId,
  });
}

/**
 * Internal helper to process a goal document.
 */
function processGoal(fields: Map<string, FirestoreValue>, docId: string): Goal | null {
  const goalId = getString(fields, 'goal_id') ?? docId;

  const goalData: Record<string, unknown> = {
    goal_id: goalId,
  };

  const stringFields = [
    'name',
    'recommendation_id',
    'created_date',
    'user_id',
    'associated_category_id',
    'status',
    'type',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) goalData[field] = value;
  }

  // emoji: may be a direct string or a MAP {emoji: "🎯"}
  const emojiStr = getString(fields, 'emoji');
  if (emojiStr) {
    goalData.emoji = emojiStr;
  } else {
    const emojiMap = getMap(fields, 'emoji');
    if (emojiMap) {
      const inner = getString(emojiMap, 'emoji');
      if (inner) goalData.emoji = inner;
    }
  }

  const boolFields = ['created_with_allocations', 'is_met_early', 'party_mode_activated'];
  for (const field of boolFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) goalData[field] = value;
  }

  // associated_accounts is a MAP (possibly empty {}), not an array
  const associatedAccountsMap = getMap(fields, 'associated_accounts');
  if (associatedAccountsMap) {
    goalData.associated_accounts = toPlainObject(associatedAccountsMap);
  }

  const savingsMap = getMap(fields, 'savings');
  if (savingsMap) {
    const savings: Record<string, unknown> = {};

    const savingsStringFields = ['type', 'status', 'tracking_type', 'start_date'];
    for (const field of savingsStringFields) {
      const value = getString(savingsMap, field);
      if (value) savings[field] = value;
    }

    const targetAmount = getNumber(savingsMap, 'target_amount');
    if (targetAmount !== undefined) savings.target_amount = targetAmount;

    const monthlyContribution = getNumber(savingsMap, 'tracking_type_monthly_contribution');
    if (monthlyContribution !== undefined) {
      savings.tracking_type_monthly_contribution = monthlyContribution;
    }

    const savingsBoolFields = ['modified_start_date', 'inflates_budget', 'is_ongoing'];
    for (const field of savingsBoolFields) {
      const value = getBoolean(savingsMap, field);
      if (value !== undefined) savings[field] = value;
    }

    if (Object.keys(savings).length > 0) {
      goalData.savings = savings;
    }
  }

  return validateOrWarn(GoalSchema, goalData, {
    collection: 'goals',
    docId,
  });
}

/**
 * Internal helper to process a goal history document.
 */
function processGoalHistory(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): GoalHistory | null {
  const month = docId;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return null;
  }

  // Collection path: users/{user_id}/financial_goals/{goal_id}/financial_goal_history
  const extractedGoalId = collection.split('/')[3] ?? getString(fields, 'goal_id');

  const historyData: Record<string, unknown> = {
    month,
    goal_id: extractedGoalId ?? 'unknown',
  };

  const stringFields = ['user_id', 'last_updated', 'created_date'];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) historyData[field] = value;
  }

  // Try direct current_amount field first (may not exist)
  const currentAmount = getNumber(fields, 'current_amount');
  if (currentAmount !== undefined) historyData.current_amount = currentAmount;

  const targetAmount = getNumber(fields, 'target_amount');
  if (targetAmount !== undefined) historyData.target_amount = targetAmount;

  // Extract total_contribution if available
  const totalContribution = getNumber(fields, 'total_contribution');
  if (totalContribution !== undefined) {
    historyData.total_contribution = totalContribution;
  }

  // Parse daily_data - Copilot stores "balance" not "amount" in each daily entry
  const dailyDataMap = getMap(fields, 'daily_data');
  if (dailyDataMap) {
    const dailyData: Record<string, DailySnapshot> = {};
    let latestDate = '';
    let latestBalance: number | undefined;

    for (const [date, value] of dailyDataMap) {
      if (date.startsWith(month) && value.type === 'map') {
        // Try "balance" first (actual Copilot format), then "amount" (fallback)
        const balance = getNumber(value.value, 'balance') ?? getNumber(value.value, 'amount');
        if (balance !== undefined) {
          dailyData[date] = { amount: balance, date };
          // Track the latest date to get current_amount
          if (date > latestDate) {
            latestDate = date;
            latestBalance = balance;
          }
        }
      }
    }
    if (Object.keys(dailyData).length > 0) {
      historyData.daily_data = dailyData;
    }

    // If current_amount wasn't set directly, use the latest balance from daily_data
    if (currentAmount === undefined && latestBalance !== undefined) {
      historyData.current_amount = latestBalance;
    }
  }

  return validateOrWarn(GoalHistorySchema, historyData, {
    collection: 'goal_history',
    docId,
  });
}

/**
 * Internal helper to process an investment price document.
 */
function processInvestmentPrice(
  fields: Map<string, FirestoreValue>,
  docId: string,
  key: string
): InvestmentPrice | null {
  const investmentId = getString(fields, 'investment_id') ?? docId;
  const ticker = getString(fields, 'ticker_symbol');
  const isDailyData = key.includes('/daily/');
  const date = getString(fields, 'date');
  const month = getString(fields, 'month');

  const priceData: Record<string, unknown> = {
    investment_id: investmentId,
    price_type: isDailyData ? 'daily' : 'hf',
  };

  if (ticker) priceData.ticker_symbol = ticker;
  if (date) priceData.date = date;
  if (month) priceData.month = month;

  const priceFields = ['price', 'close_price', 'current_price', 'institution_price'];
  for (const field of priceFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) priceData[field] = value;
  }

  const ohlcvFields = ['high', 'low', 'open', 'volume'];
  for (const field of ohlcvFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) priceData[field] = value;
  }

  const metaFields = ['currency', 'source', 'close_price_as_of'];
  for (const field of metaFields) {
    const value = getString(fields, field);
    if (value) priceData[field] = value;
  }

  return validateOrWarn(InvestmentPriceSchema, priceData, {
    collection: 'investment_prices',
    docId,
  });
}

/**
 * Internal helper to process an investment split document.
 */
function processInvestmentSplit(
  fields: Map<string, FirestoreValue>,
  docId: string
): InvestmentSplit | null {
  const splitId = getString(fields, 'split_id') ?? docId;

  const splitData: Record<string, unknown> = {
    split_id: splitId,
  };

  const stringFields = [
    'ticker_symbol',
    'investment_id',
    'split_date',
    'split_ratio',
    'announcement_date',
    'record_date',
    'ex_date',
    'description',
    'source',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) splitData[field] = value;
  }

  const numericFields = ['from_factor', 'to_factor', 'multiplier'];
  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) splitData[field] = value;
  }

  // Collect date-keyed adjustment factors (e.g., "2022-03-11": 0.5)
  const knownFields = new Set(['split_id', ...stringFields, ...numericFields]);
  const dateKeyRegex = /^\d{4}-\d{2}-\d{2}$/;
  const adjustments: Record<string, number> = {};
  for (const [key, value] of fields.entries()) {
    if (knownFields.has(key)) continue;
    if (dateKeyRegex.test(key) && (value.type === 'double' || value.type === 'integer')) {
      adjustments[key] = value.value;
    }
  }
  if (Object.keys(adjustments).length > 0) {
    splitData.adjustments = adjustments;
  }

  return validateOrWarn(InvestmentSplitSchema, splitData, {
    collection: 'investment_splits',
    docId,
  });
}

/**
 * Internal helper to process an item document.
 */
function processItem(fields: Map<string, FirestoreValue>, docId: string): Item | null {
  const itemId = getString(fields, 'item_id') ?? docId;

  const itemData: Record<string, unknown> = {
    item_id: itemId,
  };

  const stringFields = [
    'user_id',
    'institution_id',
    'institution_name',
    'connection_status',
    'last_successful_update',
    'last_failed_update',
    'consent_expiration_time',
    'error_code',
    'error_message',
    'error_type',
    'created_at',
    'updated_at',
    'webhook',
    'status_transactions_last_successful_update',
    'status_transactions_last_failed_update',
    'status_investments_last_successful_update',
    'status_investments_last_failed_update',
    'latest_fetch',
    'latest_investments_fetch',
    '_origin',
    'provider',
    'country_code',
    'plaid_user_id',
    'update_type',
    'disconnect_attempted_error',
    'id',
    'status_last_webhook_code_sent',
    'status_last_webhook_sent_at',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) itemData[field] = value;
  }

  // Timestamp fields
  const timestampFields = [
    'creation_timestamp',
    'disconnect_attempted',
    'latest_investments_refresh',
  ];
  for (const field of timestampFields) {
    const value = getDateString(fields, field);
    if (value) itemData[field] = value;
  }

  // Boolean fields
  const boolFields = [
    'needs_update',
    'login_required',
    'disconnected',
    'historical_update',
    'is_manual',
    'new_accounts_available',
    'user_disconnected',
    'login_required_dismissed',
    'new_accounts_available_dismissed',
  ];
  for (const field of boolFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) itemData[field] = value;
  }

  // Array fields
  const products = getStringArray(fields, 'products');
  if (products) itemData.products = products;

  // Map fields
  const fetchDataMap = getMap(fields, 'fetch_data');
  if (fetchDataMap) itemData.fetch_data = toPlainObject(fetchDataMap);

  return validateOrWarn(ItemSchema, itemData, {
    collection: 'items',
    docId,
  });
}

/**
 * Internal helper to process a category document.
 */
function processCategory(fields: Map<string, FirestoreValue>, docId: string): Category | null {
  const categoryId = getString(fields, 'category_id') ?? docId;
  const name = getString(fields, 'name');

  if (!name) return null;

  const categoryData: Record<string, unknown> = {
    category_id: categoryId,
    name,
  };

  const stringFields = ['emoji', 'color', 'bg_color', 'parent_category_id', 'user_id'];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) categoryData[field] = value;
  }

  const order = getNumber(fields, 'order');
  if (order !== undefined) categoryData.order = order;

  const booleanFields = ['excluded', 'is_other', 'auto_budget_lock', 'auto_delete_lock'];
  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) categoryData[field] = value;
  }

  // Array fields
  const arrayFields = [
    'plaid_category_ids',
    'partial_name_rules',
    'children_category_ids',
    'children_categories',
  ];
  for (const field of arrayFields) {
    const value = getStringArray(fields, field);
    if (value) categoryData[field] = value;
  }

  // Additional string fields
  const additionalStringFields = ['budget_id', '_origin', 'id'];
  for (const field of additionalStringFields) {
    const value = getString(fields, field);
    if (value) categoryData[field] = value;
  }

  return validateOrWarn(CategorySchema, categoryData, {
    collection: 'categories',
    docId,
  });
}

/**
 * Internal helper to process a user account document.
 */
function processUserAccount(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): UserAccountCustomization | null {
  const accountId = getString(fields, 'account_id') ?? docId;
  const name = getString(fields, 'name');

  if (!name) return null;

  const userAccountData: UserAccountCustomization = {
    account_id: accountId,
    name,
  };

  const userIdMatch = collection.match(/users\/([^/]+)\/accounts/);
  if (userIdMatch) {
    userAccountData.user_id = userIdMatch[1];
  }

  const hidden = getBoolean(fields, 'hidden');
  if (hidden !== undefined) userAccountData.hidden = hidden;

  const order = getNumber(fields, 'order');
  if (order !== undefined) userAccountData.order = order;

  return userAccountData;
}

/**
 * Internal helper to process an investment performance document.
 */
function processInvestmentPerformance(
  fields: Map<string, FirestoreValue>,
  docId: string
): InvestmentPerformance | null {
  const data: Record<string, unknown> = {
    performance_id: docId,
  };

  // String fields — check both snake_case and camelCase variants
  const securityId = getString(fields, 'security_id') ?? getString(fields, 'securityId');
  if (securityId) data.security_id = securityId;

  const type = getString(fields, 'type');
  if (type) data.type = type;

  const userId = getString(fields, 'user_id') ?? getString(fields, 'userId');
  if (userId) data.user_id = userId;

  const lastUpdate = getString(fields, 'last_update') ?? getString(fields, 'lastUpdate');
  if (lastUpdate) data.last_update = lastUpdate;

  // Number fields
  const position = getNumber(fields, 'position');
  if (position !== undefined) data.position = position;

  // String array fields
  const access = getStringArray(fields, 'access');
  if (access) data.access = access;

  return validateOrWarn(InvestmentPerformanceSchema, data, {
    collection: 'investment_performance',
    docId,
  });
}

/**
 * Internal helper to process a TWR holding document.
 */
function processTwrHolding(
  fields: Map<string, FirestoreValue>,
  docId: string,
  key: string
): TwrHolding | null {
  // Extract security hash from the key path: investment_performance/{hash}/twr_holding
  let securityHash = 'unknown';
  const segments = key.split('/');
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === 'investment_performance' && i + 1 < segments.length) {
      securityHash = segments[i + 1]!;
      break;
    }
  }

  const data: Record<string, unknown> = {
    twr_id: `${securityHash}:${docId}`,
  };

  const securityId = getString(fields, 'security_id') ?? getString(fields, 'securityId');
  if (securityId) data.security_id = securityId;

  // The document ID is the month (YYYY-MM format)
  if (/^\d{4}-\d{2}$/.test(docId)) {
    data.month = docId;
  }

  // Extract history map: epoch-ms keys → { value: number }
  const historyMap = getMap(fields, 'history');
  if (historyMap) {
    const history: Record<string, { value: number }> = {};
    for (const [epochKey, val] of historyMap) {
      if (val.type === 'map') {
        const valueField = val.value.get('value');
        if (valueField && (valueField.type === 'double' || valueField.type === 'integer')) {
          history[epochKey] = { value: valueField.value };
        }
      }
    }
    if (Object.keys(history).length > 0) data.history = history;
  }

  return validateOrWarn(TwrHoldingSchema, data, {
    collection: 'twr_holdings',
    docId,
  });
}

/**
 * Internal helper to process a plaid account document (items/{id}/accounts/{id}).
 */
function processPlaidAccount(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): PlaidAccount | null {
  const data: Record<string, unknown> = {
    plaid_account_id: docId,
  };

  // Extract item_id from collection path: items/{item_id}/accounts/{doc_id}
  const parts = collection.split('/');
  const itemsIdx = parts.indexOf('items');
  if (itemsIdx >= 0 && itemsIdx + 1 < parts.length) {
    data.item_id = parts[itemsIdx + 1];
  }

  const stringFields = [
    'account_id',
    'name',
    'official_name',
    'mask',
    'account_type',
    'subtype',
    'iso_currency_code',
    'institution_id',
    'institution_name',
    'original_subtype',
    'original_type',
    'color',
    'logo',
    'logo_content_type',
    'nickname',
    '_origin',
    'id',
    'user_id',
    'custom_color',
    'group_id',
    'item_id',
  ];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const numberFields = ['current_balance', 'available_balance', 'original_current_balance'];
  for (const field of numberFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Handle limit with null check
  const limitVal = getNumber(fields, 'limit');
  if (limitVal !== undefined) {
    data.limit = limitVal;
  } else {
    const limitField = fields.get('limit');
    if (limitField && limitField.type === 'null') {
      data.limit = null;
    }
  }

  const booleanFields = [
    'historical_update',
    'investments_performance_enabled',
    'holdings_initialized',
    'provider_deleted',
    'savings_active',
    'dashboard_active',
    'live_balance_backend_disabled',
    'live_balance_user_disabled',
    'user_hidden',
    'user_deleted',
    'is_manual',
    'group_leader',
  ];
  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Timestamp fields
  const latestBalanceUpdate = getDateString(fields, 'latest_balance_update');
  if (latestBalanceUpdate) data.latest_balance_update = latestBalanceUpdate;

  // Verification status (string or null)
  const vs = getString(fields, 'verification_status');
  if (vs !== undefined) {
    data.verification_status = vs;
  } else {
    const vsField = fields.get('verification_status');
    if (vsField && vsField.type === 'null') {
      data.verification_status = null;
    }
  }

  // Map fields
  const mapFieldNames = ['metadata', 'merged'];
  for (const field of mapFieldNames) {
    const mapValue = getMap(fields, field);
    if (mapValue) data[field] = toPlainObject(mapValue);
  }

  // Extract holdings array
  const holdingsField = fields.get('holdings');
  if (holdingsField && holdingsField.type === 'array') {
    const holdings: Record<string, unknown>[] = [];
    for (const item of holdingsField.value) {
      if (item.type === 'map') {
        holdings.push(toPlainObject(item.value));
      }
    }
    if (holdings.length > 0) {
      data.holdings = holdings;
    }
  }

  return validateOrWarn(PlaidAccountSchema, data, {
    collection: 'plaid_accounts',
    docId,
  });
}

/**
 * Internal helper to process a tag document.
 * Path: users/{user_id}/tags/{tag_id}
 */
function processTag(fields: Map<string, FirestoreValue>, docId: string): Tag | null {
  const data: Record<string, unknown> = {
    tag_id: docId,
  };

  const stringFields = ['name', 'color_name', 'hex_color'];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value !== undefined) data[field] = value;
  }

  return validateOrWarn(TagSchema, data, {
    collection: 'tags',
    docId,
  });
}

/**
 * Internal helper to process a balance history document.
 * Path: items/{item_id}/accounts/{account_id}/balance_history/{date}
 */
function processBalanceHistory(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): BalanceHistory | null {
  const data: Record<string, unknown> = {};

  // Extract item_id and account_id from path: items/{item_id}/accounts/{account_id}/balance_history
  // Extract item_id and account_id from path — return null if path can't be parsed
  const parts = collection.split('/');
  const itemsIdx = parts.indexOf('items');
  const accountsIdx = parts.indexOf('accounts');
  if (
    itemsIdx < 0 ||
    itemsIdx + 1 >= parts.length ||
    accountsIdx < 0 ||
    accountsIdx + 1 >= parts.length
  ) {
    return null;
  }
  const itemId = parts[itemsIdx + 1]!;
  const accountId = parts[accountsIdx + 1]!;
  data.item_id = itemId;
  data.account_id = accountId;

  // Validate date format from doc ID
  if (!/^\d{4}-\d{2}-\d{2}$/.test(docId)) return null;

  data.balance_id = `${itemId}:${accountId}:${docId}`;
  data.date = docId;

  const numericFields = ['current_balance', 'available_balance', 'limit'];
  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Handle null limit (credit cards may have explicit null)
  const limitField = fields.get('limit');
  if (limitField && limitField.type === 'null') {
    data.limit = null;
  }

  const origin = getString(fields, '_origin');
  if (origin !== undefined) data._origin = origin;

  return validateOrWarn(BalanceHistorySchema, data, {
    collection: 'balance_history',
    docId,
  });
}

/**
 * Internal helper to process a holdings_history metadata document.
 * Path: items/{item_id}/accounts/{account_id}/holdings_history/{hash}
 */
function processHoldingsHistoryMeta(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): HoldingsHistoryMeta | null {
  const data: Record<string, unknown> = {};

  data.holdings_history_id = docId;
  data.security_id = docId;

  // Extract item_id and account_id from path
  const parts = collection.split('/');
  const itemsIdx = parts.indexOf('items');
  if (itemsIdx >= 0 && itemsIdx + 1 < parts.length) {
    data.item_id = parts[itemsIdx + 1] ?? 'unknown';
  }
  const accountsIdx = parts.indexOf('accounts');
  if (accountsIdx >= 0 && accountsIdx + 1 < parts.length) {
    data.account_id = parts[accountsIdx + 1] ?? 'unknown';
  }

  // Extract any other fields generically
  for (const [key, val] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(val);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(HoldingsHistoryMetaSchema, data, {
    collection: 'holdings_history_meta',
    docId,
  });
}

/**
 * Internal helper to process a holdings_history history document.
 * Path: items/{item_id}/accounts/{account_id}/holdings_history/{hash}/history/{month}
 */
function processHoldingsHistory(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): HoldingsHistory | null {
  const data: Record<string, unknown> = {};

  // Extract security_id from path (the holdings_history/{hash} part)
  const parts = collection.split('/');
  const hhIdx = parts.indexOf('holdings_history');
  let securityHash = 'unknown';
  if (hhIdx >= 0 && hhIdx + 1 < parts.length) {
    securityHash = parts[hhIdx + 1] ?? 'unknown';
    data.security_id = securityHash;
  }

  data.history_id = `${securityHash}:${docId}`;
  data.month = docId;

  // Extract item_id and account_id from path
  const itemsIdx = parts.indexOf('items');
  if (itemsIdx >= 0 && itemsIdx + 1 < parts.length) {
    data.item_id = parts[itemsIdx + 1] ?? 'unknown';
  }
  const accountsIdx = parts.indexOf('accounts');
  if (accountsIdx >= 0 && accountsIdx + 1 < parts.length) {
    data.account_id = parts[accountsIdx + 1] ?? 'unknown';
  }

  // Extract history map: epoch-ms keyed { price, quantity } entries
  const historyMap = getMap(fields, 'history');
  if (historyMap) {
    const history: Record<string, { price?: number; quantity?: number }> = {};
    for (const [epochKey, val] of historyMap) {
      if (val.type === 'map') {
        const entry: { price?: number; quantity?: number } = {};
        const priceField = val.value.get('price');
        if (priceField && (priceField.type === 'double' || priceField.type === 'integer')) {
          entry.price = priceField.value;
        }
        const qtyField = val.value.get('quantity');
        if (qtyField && (qtyField.type === 'double' || qtyField.type === 'integer')) {
          entry.quantity = qtyField.value;
        }
        history[epochKey] = entry;
      }
    }
    if (Object.keys(history).length > 0) data.history = history;
  }

  // Extract any other fields generically (skip 'history' already handled)
  for (const [key, val] of fields) {
    if (key !== 'history' && !(key in data)) {
      const extracted = extractValue(val);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(HoldingsHistorySchema, data, {
    collection: 'holdings_history',
    docId,
  });
}

/**
 * Internal helper to process a top-level change document.
 */
function processChange(fields: Map<string, FirestoreValue>, docId: string): Change | null {
  const data: Record<string, unknown> = { change_id: docId };
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }
  return validateOrWarn(ChangeSchema, data, {
    collection: 'changes',
    docId,
  });
}

/**
 * Shared helper to process a change sub-document (changes/{id}/t or changes/{id}/a).
 * Extracts parent_change_id from path and all fields from the document.
 */
function processSubChange<T>(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string,
  schema: ZodType<T>
): T | null {
  const data: Record<string, unknown> = { change_id: docId };
  const parts = collection.split('/');
  const changesIdx = parts.indexOf('changes');
  if (changesIdx >= 0 && changesIdx + 1 < parts.length) {
    data.parent_change_id = parts[changesIdx + 1];
  }
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }
  // Dedupe-friendly stable names for the two known sub-change types. If
  // Copilot ever adds a new suffix, we fall through to 'change_sub' and
  // embed the raw collection path in docId so the warn is still diagnosable.
  if (collection.endsWith('/t')) {
    return validateOrWarn(schema, data, { collection: 'transaction_changes', docId });
  }
  if (collection.endsWith('/a')) {
    return validateOrWarn(schema, data, { collection: 'account_changes', docId });
  }
  return validateOrWarn(schema, data, {
    collection: 'change_sub',
    docId: `${docId} (unknown collection: ${collection})`,
  });
}

/**
 * Internal helper to process a security document.
 */
function processSecurity(fields: Map<string, FirestoreValue>, docId: string): Security | null {
  // security_id: try field first, fall back to docId
  const securityId = getString(fields, 'security_id') ?? docId;
  const data: Record<string, unknown> = { security_id: securityId };

  const stringFields = [
    'ticker_symbol',
    'name',
    'type',
    'provider_type',
    'close_price_as_of',
    'iso_currency_code',
    'isin',
    'cusip',
    'sedol',
    'institution_id',
    'institution_security_id',
    'market_identifier_code',
    'last_update',
    'next_update',
    'source',
    'unofficial_currency_code',
    'cik',
    'proxy_security_id',
    '_origin',
    'update_datetime',
  ];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const numericFields = ['close_price', 'current_price', 'update_frequency'];
  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const booleanFields = ['is_cash_equivalent', 'comparison', 'trades_24_7'];
  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // option_contract: may be null or a string
  const optionContractField = fields.get('option_contract');
  if (optionContractField) {
    if (optionContractField.type === 'null') {
      data.option_contract = null;
    } else if (optionContractField.type === 'string') {
      data.option_contract = optionContractField.value;
    }
  }

  // info map
  const infoMap = getMap(fields, 'info');
  if (infoMap) data.info = toPlainObject(infoMap);

  return validateOrWarn(SecuritySchema, data, {
    collection: 'securities',
    docId,
  });
}

/**
 * Internal helper to process a user profile document.
 */
function processUserProfile(
  fields: Map<string, FirestoreValue>,
  docId: string
): UserProfile | null {
  // Skip sentinel/parent-pointer docs that have no meaningful data
  if (fields.size === 0) return null;

  const data: Record<string, unknown> = { user_id: docId };

  const stringFields = [
    'public_id',
    'last_cold_open',
    'last_warm_open',
    'last_month_reviewed',
    'last_year_reviewed',
    'account_creation_timestamp',
    'onboarding_completed_timestamp',
    'onboarding_last_completed_step',
  ];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const numericFields = [
    'service_ends_on_ms',
    'items_disconnect_on_ms',
    'intelligence_categories_review_count',
  ];
  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) data[field] = value;
  }

  const booleanFields = [
    'budgeting_enabled',
    'authentication_required',
    'data_initialized',
    'onboarding_completed',
    'logged_out',
    'match_internal_txs_enabled',
    'rollovers_enabled',
    'investments_performance_initialized',
    'finance_goals_monthly_summary_mode_enabled',
  ];
  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Map fields
  const mapFields = [
    'accounts_config',
    'auto_terms_timestamps',
    'finance_goals_review_timestamps',
    'ml_report',
    'notifications',
    'terms_timestamps',
  ];
  for (const field of mapFields) {
    const mapValue = getMap(fields, field);
    if (mapValue) data[field] = toPlainObject(mapValue);
  }

  // Array fields
  const fcmTokens = getStringArray(fields, 'fcm_tokens');
  if (fcmTokens) data.fcm_tokens = fcmTokens;

  // Timestamp fields
  const latestSpendingTrigger = getDateString(fields, 'latest_spending_trigger');
  if (latestSpendingTrigger) data.latest_spending_trigger = latestSpendingTrigger;

  // Additional string fields
  const rolloversStarteDate = getString(fields, 'rollovers_starte_date');
  if (rolloversStarteDate !== undefined) data.rollovers_starte_date = rolloversStarteDate;

  const origin = getString(fields, '_origin');
  if (origin !== undefined) data._origin = origin;

  return validateOrWarn(UserProfileSchema, data, {
    collection: 'user_profile',
    docId,
  });
}

/**
 * Internal helper to process an Amazon integration document.
 */
function processAmazonIntegration(
  fields: Map<string, FirestoreValue>,
  docId: string
): AmazonIntegration | null {
  const data: Record<string, unknown> = { amazon_id: docId };

  // Extract any fields generically
  for (const [key, value] of fields.entries()) {
    const extracted = extractValue(value);
    if (extracted !== undefined) data[key] = extracted;
  }

  return validateOrWarn(AmazonIntegrationSchema, data, {
    collection: 'amazon_integrations',
    docId,
  });
}

/**
 * Internal helper to process an Amazon order document.
 */
function processAmazonOrder(
  fields: Map<string, FirestoreValue>,
  docId: string,
  collection: string
): AmazonOrder | null {
  const data: Record<string, unknown> = { order_id: docId };

  // Extract amazon_user_id from collection path: amazon/{user_id}/orders
  const parts = collection.split('/');
  const amazonIdx = parts.indexOf('amazon');
  if (amazonIdx >= 0 && amazonIdx + 1 < parts.length) {
    data.amazon_user_id = parts[amazonIdx + 1];
  }

  // String fields
  for (const field of ['date', 'account_id', 'match_state']) {
    const value = getString(fields, field) ?? getDateString(fields, field);
    if (value !== undefined) data[field] = value;
  }

  // Items array
  const itemsValue = fields.get('items');
  if (itemsValue?.type === 'array') {
    data.items = itemsValue.value.map((v) => extractValue(v));
  }

  // Details map
  const detailsMap = getMap(fields, 'details');
  if (detailsMap) {
    data.details = toPlainObject(detailsMap);
  }

  // Payment map
  const paymentMap = getMap(fields, 'payment');
  if (paymentMap) {
    data.payment = toPlainObject(paymentMap);
  }

  // Transactions string array
  const transactions = getStringArray(fields, 'transactions');
  if (transactions) data.transactions = transactions;

  return validateOrWarn(AmazonOrderSchema, data, {
    collection: 'amazon_orders',
    docId,
  });
}

/**
 * Internal helper to process a subscription document.
 */
function processSubscription(
  fields: Map<string, FirestoreValue>,
  docId: string
): Subscription | null {
  const data: Record<string, unknown> = {
    subscription_id: getString(fields, 'subscription_id') ?? docId,
  };

  for (const key of [
    'product_id',
    'provider',
    'environment',
    'user_id',
    'expires_date_ms',
    'created_timestamp',
    'original_transaction_id',
  ]) {
    const v = getString(fields, key);
    if (v !== undefined) data[key] = v;
  }

  const price = getNumber(fields, 'price');
  if (price !== undefined) data.price = price;

  for (const key of ['will_auto_renew', 'is_eligible_for_initial_offer']) {
    const v = getBoolean(fields, key);
    if (v !== undefined) data[key] = v;
  }

  // Pass through any remaining fields
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(SubscriptionSchema, data, {
    collection: 'subscriptions',
    docId,
  });
}

/**
 * Internal helper to process an invite document.
 */
function processInvite(fields: Map<string, FirestoreValue>, docId: string): Invite | null {
  const data: Record<string, unknown> = {
    invite_id: getString(fields, 'invite_id') ?? docId,
  };

  for (const key of ['code', 'inviter_id', 'product_id']) {
    const v = getString(fields, key);
    if (v !== undefined) data[key] = v;
  }

  for (const key of ['is_available', 'is_unlimited', 'assigned', 'offer_reviewed']) {
    const v = getBoolean(fields, key);
    if (v !== undefined) data[key] = v;
  }

  // Pass through any remaining fields
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(InviteSchema, data, {
    collection: 'invites',
    docId,
  });
}

/**
 * Internal helper to process a user_items document.
 */
function processUserItems(fields: Map<string, FirestoreValue>, docId: string): UserItems | null {
  const data: Record<string, unknown> = {
    user_items_id: getString(fields, 'user_items_id') ?? docId,
  };

  // Pass through all fields
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(UserItemsSchema, data, {
    collection: 'user_items',
    docId,
  });
}

/**
 * Internal helper to process a feature_tracking document.
 */
function processFeatureTracking(
  fields: Map<string, FirestoreValue>,
  docId: string
): FeatureTracking | null {
  const data: Record<string, unknown> = {
    feature_tracking_id: getString(fields, 'feature_tracking_id') ?? docId,
  };

  // Pass through all fields
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(FeatureTrackingSchema, data, {
    collection: 'feature_tracking',
    docId,
  });
}

/**
 * Internal helper to process a support document.
 */
function processSupport(fields: Map<string, FirestoreValue>, docId: string): Support | null {
  const data: Record<string, unknown> = {
    support_id: getString(fields, 'support_id') ?? docId,
  };

  // Pass through all fields
  for (const [key, value] of fields) {
    if (!(key in data)) {
      const extracted = extractValue(value);
      if (extracted !== undefined) data[key] = extracted;
    }
  }

  return validateOrWarn(SupportSchema, data, {
    collection: 'support',
    docId,
  });
}

/**
 * Helper to check if a collection path matches a target collection name.
 * Handles both simple names ("transactions") and full paths ("users/{user_id}/transactions").
 */
export function collectionMatches(collection: string, target: string): boolean {
  return collection === target || collection.endsWith(`/${target}`);
}

/**
 * Batch decode all collections from LevelDB database in a single pass.
 *
 * This is significantly faster than calling individual decode functions
 * because it only iterates through the database once instead of once per collection.
 *
 * @param dbPath - Path to the LevelDB database
 * @returns All collections decoded and deduplicated
 */
export async function decodeAllCollections(dbPath: string): Promise<AllCollectionsResult> {
  const rawTransactions: Transaction[] = [];
  const rawAccounts: Account[] = [];
  const rawRecurring: Recurring[] = [];
  const rawBudgets: Budget[] = [];
  const rawGoals: Goal[] = [];
  const rawGoalHistory: GoalHistory[] = [];
  const rawInvestmentPrices: InvestmentPrice[] = [];
  const rawInvestmentSplits: InvestmentSplit[] = [];
  const rawItems: Item[] = [];
  const rawCategories: Category[] = [];
  const rawUserAccounts: UserAccountCustomization[] = [];
  const rawInvestmentPerformance: InvestmentPerformance[] = [];
  const rawTwrHoldings: TwrHolding[] = [];
  const rawPlaidAccounts: PlaidAccount[] = [];
  const rawBalanceHistory: BalanceHistory[] = [];
  const rawHoldingsHistoryMeta: HoldingsHistoryMeta[] = [];
  const rawHoldingsHistory: HoldingsHistory[] = [];
  const rawChanges: Change[] = [];
  const rawTransactionChanges: TransactionChange[] = [];
  const rawAccountChanges: AccountChange[] = [];
  const rawSecurities: Security[] = [];
  const rawUserProfiles: UserProfile[] = [];
  const rawTags: Tag[] = [];
  const rawAmazonIntegrations: AmazonIntegration[] = [];
  const rawAmazonOrders: AmazonOrder[] = [];
  const rawSubscriptions: Subscription[] = [];
  const rawInvites: Invite[] = [];
  const rawUserItems: UserItems[] = [];
  const rawFeatureTracking: FeatureTracking[] = [];
  const rawSupportDocs: Support[] = [];

  // Single pass through the database
  for await (const doc of iterateDocuments(dbPath)) {
    const { fields, documentId, collection, key } = doc;

    // Route document to appropriate processor based on collection
    // Note: User accounts (users/{user_id}/accounts) must be checked before regular accounts
    if (collection.includes('users/') && collection.endsWith('/accounts')) {
      const userAccount = processUserAccount(fields, documentId, collection);
      if (userAccount) rawUserAccounts.push(userAccount);
    } else if (collection.includes('/holdings_history/') && collection.endsWith('/history')) {
      const hh = processHoldingsHistory(fields, documentId, collection);
      if (hh) rawHoldingsHistory.push(hh);
    } else if (collection.includes('/holdings_history') && !collection.endsWith('/history')) {
      const hhm = processHoldingsHistoryMeta(fields, documentId, collection);
      if (hhm) rawHoldingsHistoryMeta.push(hhm);
    } else if (collection.endsWith('/balance_history')) {
      const bh = processBalanceHistory(fields, documentId, collection);
      if (bh) rawBalanceHistory.push(bh);
    } else if (
      // Plaid account docs: items/{id}/accounts/{account_id}
      // Exclude known subcollections — update this list when adding new ones:
      //   /balance_history, /transactions, /holdings_history
      collection.includes('items/') &&
      collection.includes('/accounts/') &&
      !collection.endsWith('/accounts') &&
      !collection.endsWith('/balance_history') &&
      !collection.endsWith('/transactions') &&
      !collection.includes('/holdings_history')
    ) {
      const plaidAccount = processPlaidAccount(fields, documentId, collection);
      if (plaidAccount) rawPlaidAccounts.push(plaidAccount);
    } else if (collectionMatches(collection, 'transactions')) {
      const txn = processTransaction(fields, documentId);
      if (txn) rawTransactions.push(txn);
    } else if (collectionMatches(collection, 'accounts')) {
      const acc = processAccount(fields, documentId);
      if (acc) rawAccounts.push(acc);
    } else if (collectionMatches(collection, 'recurring')) {
      const rec = processRecurring(fields, documentId);
      if (rec) rawRecurring.push(rec);
    } else if (collectionMatches(collection, 'budgets')) {
      const budget = processBudget(fields, documentId);
      if (budget) rawBudgets.push(budget);
    } else if (collectionMatches(collection, 'financial_goals')) {
      const goal = processGoal(fields, documentId);
      if (goal) rawGoals.push(goal);
    } else if (collection.endsWith('/financial_goal_history')) {
      const history = processGoalHistory(fields, documentId, collection);
      if (history) rawGoalHistory.push(history);
    } else if (
      collectionMatches(collection, 'investment_prices') ||
      collection.includes('investment_prices/')
    ) {
      const price = processInvestmentPrice(fields, documentId, key);
      if (price) rawInvestmentPrices.push(price);
    } else if (collection.endsWith('/twr_holding')) {
      const twr = processTwrHolding(fields, documentId, key);
      if (twr) rawTwrHoldings.push(twr);
    } else if (
      collectionMatches(collection, 'investment_performance') ||
      collection.includes('investment_performance/')
    ) {
      const perf = processInvestmentPerformance(fields, documentId);
      if (perf) rawInvestmentPerformance.push(perf);
    } else if (collectionMatches(collection, 'investment_splits')) {
      const split = processInvestmentSplit(fields, documentId);
      if (split) rawInvestmentSplits.push(split);
    } else if (collectionMatches(collection, 'items') || /^items\/[^/]+$/.test(collection)) {
      // Match both top-level items and items/{item_id} parent-pointer docs.
      // Parent-pointer docs (items/{item_id}) have empty fields and processItem returns null.
      const item = processItem(fields, documentId);
      if (item) rawItems.push(item);
    } else if (collectionMatches(collection, 'tags')) {
      const tag = processTag(fields, documentId);
      if (tag) rawTags.push(tag);
    } else if (collectionMatches(collection, 'categories')) {
      const category = processCategory(fields, documentId);
      if (category) rawCategories.push(category);
    } else if (collection.endsWith('/t') && collection.includes('changes/')) {
      const tc = processSubChange(fields, documentId, collection, TransactionChangeSchema);
      if (tc) rawTransactionChanges.push(tc);
    } else if (collection.endsWith('/a') && collection.includes('changes/')) {
      const ac = processSubChange(fields, documentId, collection, AccountChangeSchema);
      if (ac) rawAccountChanges.push(ac);
    } else if (collectionMatches(collection, 'changes')) {
      const change = processChange(fields, documentId);
      if (change) rawChanges.push(change);
    } else if (collectionMatches(collection, 'securities')) {
      const security = processSecurity(fields, documentId);
      if (security) rawSecurities.push(security);
    } else if (collectionMatches(collection, 'users') || /^users\/[^/]+$/.test(collection)) {
      // Match both top-level users and users/{user_id} parent-pointer sentinel docs.
      const profile = processUserProfile(fields, documentId);
      if (profile) rawUserProfiles.push(profile);
    } else if (collectionMatches(collection, 'orders') && collection.includes('amazon/')) {
      const order = processAmazonOrder(fields, documentId, collection);
      if (order) rawAmazonOrders.push(order);
    } else if (collection === 'amazon' || /^amazon\/[^/]+$/.test(collection)) {
      const ai = processAmazonIntegration(fields, documentId);
      if (ai) rawAmazonIntegrations.push(ai);
    } else if (collectionMatches(collection, 'subscriptions')) {
      const sub = processSubscription(fields, documentId);
      if (sub) rawSubscriptions.push(sub);
    } else if (collectionMatches(collection, 'invites')) {
      const inv = processInvite(fields, documentId);
      if (inv) rawInvites.push(inv);
    } else if (collectionMatches(collection, 'user_items')) {
      const ui = processUserItems(fields, documentId);
      if (ui) rawUserItems.push(ui);
    } else if (collectionMatches(collection, 'feature_tracking')) {
      const ft = processFeatureTracking(fields, documentId);
      if (ft) rawFeatureTracking.push(ft);
    } else if (collectionMatches(collection, 'support')) {
      const sup = processSupport(fields, documentId);
      if (sup) rawSupportDocs.push(sup);
    } else if (
      collection.includes('/financial_goals/') &&
      !collection.endsWith('/financial_goal_history')
    ) {
      // Sentinel/parent docs at users/{uid}/financial_goals/{goal_id} exist because
      // financial_goal_history is a subcollection underneath them. These documents are
      // typically empty (no fields) — their presence just anchors the subcollection path.
      // We match them here so they don't appear as "undecoded" in coverage reports.
    }
  }

  // Deduplicate and sort each collection

  // Transactions: dedupe by transaction_id, reconcile pending/posted pairs, sort by date desc
  const transactions = reconcilePendingTransactions(deduplicateTransactions(rawTransactions));
  transactions.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  // Accounts: dedupe by (name, mask)
  const accSeen = new Set<string>();
  const accounts: Account[] = [];
  for (const acc of rawAccounts) {
    const displayName = getAccountDisplayName(acc);
    const key = `${displayName}|${acc.mask ?? ''}`;
    if (!accSeen.has(key)) {
      accSeen.add(key);
      accounts.push(acc);
    }
  }

  // Recurring: dedupe by recurring_id
  const recSeen = new Set<string>();
  const recurring: Recurring[] = [];
  for (const rec of rawRecurring) {
    if (!recSeen.has(rec.recurring_id)) {
      recSeen.add(rec.recurring_id);
      recurring.push(rec);
    }
  }

  // Budgets: dedupe by budget_id
  const budgetSeen = new Set<string>();
  const budgets: Budget[] = [];
  for (const budget of rawBudgets) {
    if (!budgetSeen.has(budget.budget_id)) {
      budgetSeen.add(budget.budget_id);
      budgets.push(budget);
    }
  }

  // Goals: dedupe by goal_id
  const goalSeen = new Set<string>();
  const goals: Goal[] = [];
  for (const goal of rawGoals) {
    if (!goalSeen.has(goal.goal_id)) {
      goalSeen.add(goal.goal_id);
      goals.push(goal);
    }
  }

  // Goal history: dedupe by goal_id + month, sort by goal_id then month desc
  const histSeen = new Set<string>();
  const goalHistory: GoalHistory[] = [];
  for (const history of rawGoalHistory) {
    const key = `${history.goal_id}:${history.month}`;
    if (!histSeen.has(key)) {
      histSeen.add(key);
      goalHistory.push(history);
    }
  }
  goalHistory.sort((a, b) => {
    if (a.goal_id !== b.goal_id) {
      return a.goal_id.localeCompare(b.goal_id);
    }
    return b.month.localeCompare(a.month);
  });

  // Investment prices: dedupe by investment_id + date/month
  const priceSeen = new Set<string>();
  const investmentPrices: InvestmentPrice[] = [];
  for (const price of rawInvestmentPrices) {
    const key = `${price.investment_id}-${price.date || price.month || 'unknown'}`;
    if (!priceSeen.has(key)) {
      priceSeen.add(key);
      investmentPrices.push(price);
    }
  }
  investmentPrices.sort((a, b) => {
    if (a.investment_id !== b.investment_id) {
      return a.investment_id.localeCompare(b.investment_id);
    }
    const dateA = a.date || a.month || '';
    const dateB = b.date || b.month || '';
    return dateB.localeCompare(dateA);
  });

  // Investment splits: dedupe by split_id
  const splitSeen = new Set<string>();
  const investmentSplits: InvestmentSplit[] = [];
  for (const split of rawInvestmentSplits) {
    if (!splitSeen.has(split.split_id)) {
      splitSeen.add(split.split_id);
      investmentSplits.push(split);
    }
  }
  investmentSplits.sort((a, b) => {
    const tickerA = a.ticker_symbol || '';
    const tickerB = b.ticker_symbol || '';
    if (tickerA !== tickerB) {
      return tickerA.localeCompare(tickerB);
    }
    const dateA = a.split_date || '';
    const dateB = b.split_date || '';
    return dateB.localeCompare(dateA);
  });

  // Items: dedupe by item_id
  const itemSeen = new Set<string>();
  const items: Item[] = [];
  for (const item of rawItems) {
    if (!itemSeen.has(item.item_id)) {
      itemSeen.add(item.item_id);
      items.push(item);
    }
  }
  items.sort((a, b) => {
    const nameA = a.institution_name || '';
    const nameB = b.institution_name || '';
    if (nameA !== nameB) {
      return nameA.localeCompare(nameB);
    }
    return a.item_id.localeCompare(b.item_id);
  });

  // Categories: dedupe by category_id
  const catSeen = new Set<string>();
  const categories: Category[] = [];
  for (const category of rawCategories) {
    if (!catSeen.has(category.category_id)) {
      catSeen.add(category.category_id);
      categories.push(category);
    }
  }
  categories.sort((a, b) => {
    const orderA = a.order ?? 999;
    const orderB = b.order ?? 999;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    const nameA = a.name || '';
    const nameB = b.name || '';
    return nameA.localeCompare(nameB);
  });

  // User accounts: dedupe by account_id
  const userAccSeen = new Set<string>();
  const userAccounts: UserAccountCustomization[] = [];
  for (const userAccount of rawUserAccounts) {
    if (!userAccSeen.has(userAccount.account_id)) {
      userAccSeen.add(userAccount.account_id);
      userAccounts.push(userAccount);
    }
  }

  // Investment performance: dedupe by performance_id
  const perfSeen = new Set<string>();
  const investmentPerformance: InvestmentPerformance[] = [];
  for (const perf of rawInvestmentPerformance) {
    if (!perfSeen.has(perf.performance_id)) {
      perfSeen.add(perf.performance_id);
      investmentPerformance.push(perf);
    }
  }

  // TWR holdings: dedupe by twr_id
  const twrSeen = new Set<string>();
  const twrHoldings: TwrHolding[] = [];
  for (const twr of rawTwrHoldings) {
    if (!twrSeen.has(twr.twr_id)) {
      twrSeen.add(twr.twr_id);
      twrHoldings.push(twr);
    }
  }

  // Plaid accounts: dedupe by plaid_account_id
  const plaidAccSeen = new Set<string>();
  const plaidAccounts: PlaidAccount[] = [];
  for (const acc of rawPlaidAccounts) {
    if (!plaidAccSeen.has(acc.plaid_account_id)) {
      plaidAccSeen.add(acc.plaid_account_id);
      plaidAccounts.push(acc);
    }
  }

  // Balance history: dedupe by balance_id, sort by account then date desc
  const bhSeen = new Set<string>();
  const balanceHistory: BalanceHistory[] = [];
  for (const bh of rawBalanceHistory) {
    if (!bhSeen.has(bh.balance_id)) {
      bhSeen.add(bh.balance_id);
      balanceHistory.push(bh);
    }
  }
  balanceHistory.sort((a, b) => {
    const accA = a.account_id ?? '';
    const accB = b.account_id ?? '';
    if (accA !== accB) {
      return accA.localeCompare(accB);
    }
    const dateA = a.date ?? '';
    const dateB = b.date ?? '';
    return dateB.localeCompare(dateA);
  });

  // Holdings history meta: dedupe by holdings_history_id
  const hhMetaSeen = new Set<string>();
  const holdingsHistoryMeta: HoldingsHistoryMeta[] = [];
  for (const hhm of rawHoldingsHistoryMeta) {
    if (!hhMetaSeen.has(hhm.holdings_history_id)) {
      hhMetaSeen.add(hhm.holdings_history_id);
      holdingsHistoryMeta.push(hhm);
    }
  }

  // Holdings history: dedupe by history_id
  const hhSeen = new Set<string>();
  const holdingsHistory: HoldingsHistory[] = [];
  for (const hh of rawHoldingsHistory) {
    if (!hhSeen.has(hh.history_id)) {
      hhSeen.add(hh.history_id);
      holdingsHistory.push(hh);
    }
  }

  // Changes: dedupe by change_id
  const changeSeen = new Set<string>();
  const changes: Change[] = [];
  for (const c of rawChanges) {
    if (!changeSeen.has(c.change_id)) {
      changeSeen.add(c.change_id);
      changes.push(c);
    }
  }

  const tcSeen = new Set<string>();
  const transactionChanges: TransactionChange[] = [];
  for (const tc of rawTransactionChanges) {
    if (!tcSeen.has(tc.change_id)) {
      tcSeen.add(tc.change_id);
      transactionChanges.push(tc);
    }
  }

  const acSeen = new Set<string>();
  const accountChanges: AccountChange[] = [];
  for (const ac of rawAccountChanges) {
    if (!acSeen.has(ac.change_id)) {
      acSeen.add(ac.change_id);
      accountChanges.push(ac);
    }
  }

  // Securities: dedupe by security_id
  const secSeen = new Set<string>();
  const securities: Security[] = [];
  for (const sec of rawSecurities) {
    if (!secSeen.has(sec.security_id)) {
      secSeen.add(sec.security_id);
      securities.push(sec);
    }
  }

  // User profiles: dedupe by user_id
  const profileSeen = new Set<string>();
  const userProfiles: UserProfile[] = [];
  for (const profile of rawUserProfiles) {
    if (!profileSeen.has(profile.user_id)) {
      profileSeen.add(profile.user_id);
      userProfiles.push(profile);
    }
  }

  // Tags: dedupe by tag_id
  const tagSeen = new Set<string>();
  const tags: Tag[] = [];
  for (const tag of rawTags) {
    if (!tagSeen.has(tag.tag_id)) {
      tagSeen.add(tag.tag_id);
      tags.push(tag);
    }
  }

  // Amazon integrations: dedupe by amazon_id
  const amzIntSeen = new Set<string>();
  const amazonIntegrations: AmazonIntegration[] = [];
  for (const ai of rawAmazonIntegrations) {
    if (!amzIntSeen.has(ai.amazon_id)) {
      amzIntSeen.add(ai.amazon_id);
      amazonIntegrations.push(ai);
    }
  }

  // Amazon orders: dedupe by order_id, sort by date descending
  const amzOrdSeen = new Set<string>();
  const amazonOrders: AmazonOrder[] = [];
  for (const order of rawAmazonOrders) {
    if (!amzOrdSeen.has(order.order_id)) {
      amzOrdSeen.add(order.order_id);
      amazonOrders.push(order);
    }
  }
  amazonOrders.sort((a, b) => {
    const dateA = a.date ?? '';
    const dateB = b.date ?? '';
    return dateB.localeCompare(dateA);
  });

  // Subscriptions: dedupe by subscription_id
  const subSeen = new Set<string>();
  const subscriptions: Subscription[] = [];
  for (const sub of rawSubscriptions) {
    if (!subSeen.has(sub.subscription_id)) {
      subSeen.add(sub.subscription_id);
      subscriptions.push(sub);
    }
  }

  // Invites: dedupe by invite_id
  const invSeen = new Set<string>();
  const invites: Invite[] = [];
  for (const inv of rawInvites) {
    if (!invSeen.has(inv.invite_id)) {
      invSeen.add(inv.invite_id);
      invites.push(inv);
    }
  }

  // User items: dedupe by user_items_id
  const uiSeen = new Set<string>();
  const userItems: UserItems[] = [];
  for (const ui of rawUserItems) {
    if (!uiSeen.has(ui.user_items_id)) {
      uiSeen.add(ui.user_items_id);
      userItems.push(ui);
    }
  }

  // Feature tracking: dedupe by feature_tracking_id
  const ftSeen = new Set<string>();
  const featureTracking: FeatureTracking[] = [];
  for (const ft of rawFeatureTracking) {
    if (!ftSeen.has(ft.feature_tracking_id)) {
      ftSeen.add(ft.feature_tracking_id);
      featureTracking.push(ft);
    }
  }

  // Support docs: dedupe by support_id
  const supSeen = new Set<string>();
  const supportDocs: Support[] = [];
  for (const sup of rawSupportDocs) {
    if (!supSeen.has(sup.support_id)) {
      supSeen.add(sup.support_id);
      supportDocs.push(sup);
    }
  }

  return {
    transactions,
    accounts,
    recurring,
    budgets,
    goals,
    goalHistory,
    investmentPrices,
    investmentSplits,
    items,
    categories,
    userAccounts,
    investmentPerformance,
    twrHoldings,
    plaidAccounts,
    balanceHistory,
    holdingsHistoryMeta,
    holdingsHistory,
    changes,
    transactionChanges,
    accountChanges,
    securities,
    userProfiles,
    tags,
    amazonIntegrations,
    amazonOrders,
    subscriptions,
    invites,
    userItems,
    featureTracking,
    supportDocs,
  };
}

/**
 * Get the decode timeout in milliseconds from environment or default.
 * Can be set via DECODE_TIMEOUT_MS environment variable or --timeout CLI flag.
 */
export function getDecodeTimeoutMs(): number {
  const envValue = process.env.DECODE_TIMEOUT_MS;
  if (envValue !== undefined) {
    const ms = parseInt(envValue, 10);
    if (!isNaN(ms) && ms > 0) {
      return ms;
    }
  }
  return 90_000; // 90 seconds default
}

/**
 * Decode all collections in an isolated worker thread.
 *
 * This wraps `decodeAllCollections` in a worker thread to prevent memory leaks
 * from classic-level's native addon. The native LevelDB block cache allocates 256KB
 * ArrayBuffers that are held as weak GC roots but never collected because V8 doesn't
 * see enough heap pressure (the buffers are external memory). Each cache refresh
 * leaks ~7MB, accumulating ~88MB/hour.
 *
 * By running in a worker thread, when the worker terminates, its entire V8 isolate
 * is destroyed — including all native-allocated ArrayBuffers — guaranteeing cleanup.
 *
 * The results are sent back via structured clone (postMessage), creating independent
 * copies with no ties to the worker's native memory.
 *
 * @param dbPath - Path to the LevelDB database
 * @returns All collections decoded and deduplicated
 */
export function decodeAllCollectionsIsolated(
  dbPath: string,
  timeoutMs = getDecodeTimeoutMs()
): Promise<AllCollectionsResult> {
  return new Promise((resolve, reject) => {
    const selfUrl = import.meta.url;
    const workerExt = selfUrl.endsWith('.ts') ? '.ts' : '.js';
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(selfUrl)),
      'decode-worker' + workerExt
    );

    const worker = new Worker(workerPath, {
      workerData: { dbPath },
    });

    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };

    const timer = setTimeout(() => {
      settle(() => {
        void worker.terminate();
        reject(new Error(`Decode worker timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    worker.on('message', (msg: { type: string; data?: AllCollectionsResult; message?: string }) => {
      if (msg.type === 'result' && msg.data) {
        settle(() => resolve(msg.data as AllCollectionsResult));
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(msg.message ?? 'Worker decoding failed')));
      }
    });

    worker.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    worker.on('exit', (code: number) => {
      settle(() =>
        reject(
          new Error(
            code === 0
              ? 'Decode worker exited without sending result'
              : `Decode worker exited with code ${code}`
          )
        )
      );
    });
  });
}
