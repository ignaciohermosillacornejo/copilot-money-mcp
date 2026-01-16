/**
 * LevelDB/Protobuf decoder for Copilot Money Firestore data.
 *
 * This module provides type-safe decoding of Firestore documents stored in LevelDB,
 * using proper protocol buffer parsing instead of brittle pattern matching.
 */

import { iterateDocuments } from './leveldb-reader.js';
import { type FirestoreValue, toPlainObject } from './protobuf-parser.js';

// Re-export for potential use by other modules
export { toPlainObject } from './protobuf-parser.js';
import {
  Transaction,
  TransactionSchema,
  getTransactionDisplayName,
} from '../models/transaction.js';
import { Account, AccountSchema, getAccountDisplayName } from '../models/account.js';
import { Recurring, RecurringSchema } from '../models/recurring.js';
import { Budget, BudgetSchema } from '../models/budget.js';
import { Goal, GoalSchema } from '../models/goal.js';
import { GoalHistory, GoalHistorySchema, DailySnapshot } from '../models/goal-history.js';
import { InvestmentPrice, InvestmentPriceSchema } from '../models/investment-price.js';
import { InvestmentSplit, InvestmentSplitSchema } from '../models/investment-split.js';
import { Item, ItemSchema } from '../models/item.js';
import { Category, CategorySchema } from '../models/category.js';

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
 * Decode all transactions from LevelDB database.
 */
export async function decodeTransactions(dbPath: string): Promise<Transaction[]> {
  const transactions: Transaction[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'transactions' })) {
    const fields = doc.fields;

    // Extract required fields
    const transactionId = getString(fields, 'transaction_id') ?? doc.documentId;
    const amount = getNumber(fields, 'amount');
    const date = getDateString(fields, 'date') ?? getDateString(fields, 'original_date');

    if (amount === undefined || !date) {
      continue;
    }

    // Skip zero amounts
    if (amount === 0) {
      continue;
    }

    // Build transaction object
    const txnData: Record<string, unknown> = {
      transaction_id: transactionId,
      amount,
      date,
    };

    // String fields
    const stringFields = [
      'name',
      'original_name',
      'original_clean_name',
      'account_id',
      'item_id',
      'user_id',
      'category_id',
      'plaid_category_id',
      'category_id_source',
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
    ];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) txnData[field] = value;
    }

    // Boolean fields
    const booleanFields = [
      'pending',
      'excluded',
      'user_reviewed',
      'plaid_deleted',
      'is_amazon',
      'account_dashboard_active',
    ];

    for (const field of booleanFields) {
      const value = getBoolean(fields, field);
      if (value !== undefined) txnData[field] = value;
    }

    // Numeric fields
    const numericFields = ['original_amount', 'lat', 'lon'];

    for (const field of numericFields) {
      const value = getNumber(fields, field);
      if (value !== undefined) txnData[field] = value;
    }

    // Derive internal_transfer from type field
    const copilotType = getString(fields, 'type');
    if (copilotType === 'internal_transfer') {
      txnData.internal_transfer = true;
    }

    // Validate with Zod
    try {
      const txn = TransactionSchema.parse(txnData);
      transactions.push(txn);
    } catch {
      // Skip invalid transactions
    }
  }

  // Deduplicate by (display_name, amount, date)
  const seen = new Set<string>();
  const unique: Transaction[] = [];

  for (const txn of transactions) {
    const displayName = getTransactionDisplayName(txn);
    const key = `${displayName}|${txn.amount}|${txn.date}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(txn);
    }
  }

  // Sort by date descending
  unique.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  return unique;
}

/**
 * Decode account information from LevelDB database.
 */
export async function decodeAccounts(dbPath: string): Promise<Account[]> {
  const accounts: Account[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection: 'accounts' })) {
    const fields = doc.fields;

    // Extract required fields
    const accountId = getString(fields, 'account_id') ?? getString(fields, 'id') ?? doc.documentId;
    const balance =
      getNumber(fields, 'current_balance') ?? getNumber(fields, 'original_current_balance');

    if (balance === undefined) {
      continue;
    }

    // Build account object
    const accData: Record<string, unknown> = {
      account_id: accountId,
      current_balance: Math.round(balance * 100) / 100,
    };

    // String fields
    const stringFields = [
      'name',
      'official_name',
      'mask',
      'institution_name',
      'item_id',
      'iso_currency_code',
      'institution_id',
    ];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) accData[field] = value;
    }

    // Account type fields (may be stored as 'type' or 'original_type')
    const accountType =
      getString(fields, 'type') ??
      getString(fields, 'account_type') ??
      getString(fields, 'original_type');
    if (accountType) accData.account_type = accountType;

    const subtype = getString(fields, 'subtype') ?? getString(fields, 'original_subtype');
    if (subtype) accData.subtype = subtype;

    // Available balance
    const availableBalance = getNumber(fields, 'available_balance');
    if (availableBalance !== undefined) {
      accData.available_balance = Math.round(availableBalance * 100) / 100;
    }

    // Need at least a name
    if (!accData.name && !accData.official_name) {
      continue;
    }

    // Validate with Zod
    try {
      const account = AccountSchema.parse(accData);
      accounts.push(account);
    } catch {
      // Skip invalid accounts
    }
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
    const fields = doc.fields;

    const recurringId = getString(fields, 'recurring_id') ?? doc.documentId;

    // Build recurring object
    const recData: Record<string, unknown> = {
      recurring_id: recurringId,
    };

    // String fields
    const stringFields = [
      'name',
      'merchant_name',
      'frequency',
      'next_date',
      'last_date',
      'category_id',
      'account_id',
      'iso_currency_code',
    ];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) recData[field] = value;
    }

    // Amount
    const amount = getNumber(fields, 'amount');
    if (amount !== undefined) recData.amount = amount;

    // is_active
    const isActive = getBoolean(fields, 'is_active');
    if (isActive !== undefined) recData.is_active = isActive;

    // Validate with Zod
    try {
      const rec = RecurringSchema.parse(recData);
      recurring.push(rec);
    } catch {
      // Skip invalid records
    }
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
    const fields = doc.fields;

    const budgetId = getString(fields, 'budget_id') ?? doc.documentId;

    // Build budget object
    const budgetData: Record<string, unknown> = {
      budget_id: budgetId,
    };

    // String fields
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

    // Amount
    const amount = getNumber(fields, 'amount');
    if (amount !== undefined) budgetData.amount = amount;

    // is_active
    const isActive = getBoolean(fields, 'is_active');
    if (isActive !== undefined) budgetData.is_active = isActive;

    // Validate with Zod
    try {
      const budget = BudgetSchema.parse(budgetData);
      budgets.push(budget);
    } catch {
      // Skip invalid records
    }
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
    const fields = doc.fields;

    const goalId = getString(fields, 'goal_id') ?? doc.documentId;

    // Build goal object
    const goalData: Record<string, unknown> = {
      goal_id: goalId,
    };

    // Top-level string fields
    const stringFields = ['name', 'recommendation_id', 'emoji', 'created_date', 'user_id'];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) goalData[field] = value;
    }

    // created_with_allocations
    const createdWithAllocations = getBoolean(fields, 'created_with_allocations');
    if (createdWithAllocations !== undefined) {
      goalData.created_with_allocations = createdWithAllocations;
    }

    // Extract nested savings object
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

    // Validate with Zod
    try {
      const goal = GoalSchema.parse(goalData);
      goals.push(goal);
    } catch {
      // Skip invalid records
    }
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
    const fields = doc.fields;

    // Month is typically the document ID in YYYY-MM format
    const month = doc.documentId;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      continue;
    }

    // Extract goal_id from the collection path
    const extractedGoalId = doc.collection.split('/')[1] ?? getString(fields, 'goal_id');

    // Filter by goalId if specified
    if (goalId && extractedGoalId !== goalId) {
      continue;
    }

    // Build history object
    const historyData: Record<string, unknown> = {
      month,
      goal_id: extractedGoalId ?? 'unknown',
    };

    // String fields
    const stringFields = ['user_id', 'last_updated', 'created_date'];
    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) historyData[field] = value;
    }

    // Numeric fields
    const currentAmount = getNumber(fields, 'current_amount');
    if (currentAmount !== undefined) historyData.current_amount = currentAmount;

    const targetAmount = getNumber(fields, 'target_amount');
    if (targetAmount !== undefined) historyData.target_amount = targetAmount;

    // Daily data (nested map)
    const dailyDataMap = getMap(fields, 'daily_data');
    if (dailyDataMap) {
      const dailyData: Record<string, DailySnapshot> = {};
      for (const [date, value] of dailyDataMap) {
        if (date.startsWith(month) && value.type === 'map') {
          const amount = getNumber(value.value, 'amount');
          if (amount !== undefined) {
            dailyData[date] = { amount, date };
          }
        }
      }
      if (Object.keys(dailyData).length > 0) {
        historyData.daily_data = dailyData;
      }
    }

    // Validate with Zod
    try {
      const history = GoalHistorySchema.parse(historyData);
      histories.push(history);
    } catch {
      // Skip invalid records
    }
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
    const fields = doc.fields;

    const investmentId = getString(fields, 'investment_id') ?? doc.documentId;

    // Filter by ticker if specified
    const ticker = getString(fields, 'ticker_symbol');
    if (tickerSymbol && ticker !== tickerSymbol) {
      continue;
    }

    // Determine price type
    const isDailyData = doc.key.includes('/daily/');
    const isHfData = doc.key.includes('/hf/');

    if (priceType === 'daily' && !isDailyData) continue;
    if (priceType === 'hf' && !isHfData) continue;

    // Get date/month
    const date = getString(fields, 'date');
    const month = getString(fields, 'month');
    const recordDate = date ?? month;

    // Apply date filters
    if (recordDate) {
      if (startDate && recordDate < startDate) continue;
      if (endDate && recordDate > endDate) continue;
    }

    // Build price object
    const priceData: Record<string, unknown> = {
      investment_id: investmentId,
      price_type: isDailyData ? 'daily' : 'hf',
    };

    if (ticker) priceData.ticker_symbol = ticker;
    if (date) priceData.date = date;
    if (month) priceData.month = month;

    // Price fields
    const priceFields = ['price', 'close_price', 'current_price', 'institution_price'];
    for (const field of priceFields) {
      const value = getNumber(fields, field);
      if (value !== undefined) priceData[field] = value;
    }

    // OHLCV fields
    const ohlcvFields = ['high', 'low', 'open', 'volume'];
    for (const field of ohlcvFields) {
      const value = getNumber(fields, field);
      if (value !== undefined) priceData[field] = value;
    }

    // String metadata
    const metaFields = ['currency', 'source', 'close_price_as_of'];
    for (const field of metaFields) {
      const value = getString(fields, field);
      if (value) priceData[field] = value;
    }

    // Validate with Zod
    const validated = InvestmentPriceSchema.safeParse(priceData);
    if (validated.success) {
      prices.push(validated.data);
    }
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
    const fields = doc.fields;

    const splitId = getString(fields, 'split_id') ?? doc.documentId;

    // Filter by ticker if specified
    const ticker = getString(fields, 'ticker_symbol');
    if (tickerSymbol && ticker !== tickerSymbol) {
      continue;
    }

    // Get split date
    const splitDate = getString(fields, 'split_date');

    // Apply date filters
    if (splitDate) {
      if (startDate && splitDate < startDate) continue;
      if (endDate && splitDate > endDate) continue;
    }

    // Build split object
    const splitData: Record<string, unknown> = {
      split_id: splitId,
    };

    // String fields
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

    // Numeric fields
    const numericFields = ['from_factor', 'to_factor', 'multiplier'];
    for (const field of numericFields) {
      const value = getNumber(fields, field);
      if (value !== undefined) splitData[field] = value;
    }

    // Validate with Zod
    const validated = InvestmentSplitSchema.safeParse(splitData);
    if (validated.success) {
      splits.push(validated.data);
    }
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
    const fields = doc.fields;

    const itemId = getString(fields, 'item_id') ?? doc.documentId;

    // Build item object
    const itemData: Record<string, unknown> = {
      item_id: itemId,
    };

    // String fields
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
    ];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) itemData[field] = value;
    }

    // Boolean fields
    const needsUpdateValue = getBoolean(fields, 'needs_update');
    if (needsUpdateValue !== undefined) itemData.needs_update = needsUpdateValue;

    // Apply filters
    if (connectionStatus && itemData.connection_status !== connectionStatus) {
      continue;
    }
    if (institutionId && itemData.institution_id !== institutionId) {
      continue;
    }
    if (needsUpdate !== undefined && itemData.needs_update !== needsUpdate) {
      continue;
    }

    // Validate with Zod
    const validated = ItemSchema.safeParse(itemData);
    if (validated.success) {
      items.push(validated.data);
    }
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
    const fields = doc.fields;

    const categoryId = getString(fields, 'category_id') ?? doc.documentId;

    // Get name - skip if no name
    const name = getString(fields, 'name');
    if (!name) continue;

    // Build category object
    const categoryData: Record<string, unknown> = {
      category_id: categoryId,
      name,
    };

    // String fields
    const stringFields = ['emoji', 'color', 'bg_color', 'parent_category_id', 'user_id'];

    for (const field of stringFields) {
      const value = getString(fields, field);
      if (value) categoryData[field] = value;
    }

    // Numeric fields
    const order = getNumber(fields, 'order');
    if (order !== undefined) categoryData.order = order;

    // Boolean fields
    const booleanFields = ['excluded', 'is_other', 'auto_budget_lock', 'auto_delete_lock'];
    for (const field of booleanFields) {
      const value = getBoolean(fields, field);
      if (value !== undefined) categoryData[field] = value;
    }

    // Validate with Zod
    const validated = CategorySchema.safeParse(categoryData);
    if (validated.success) {
      categories.push(validated.data);
    }
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

    const fields = doc.fields;

    const accountId = getString(fields, 'account_id') ?? doc.documentId;

    // Get name - skip if no name
    const name = getString(fields, 'name');
    if (!name) continue;

    // Build user account object
    const userAccountData: UserAccountCustomization = {
      account_id: accountId,
      name,
    };

    // Extract user_id from collection path
    const userIdMatch = doc.collection.match(/users\/([^/]+)\/accounts/);
    if (userIdMatch) {
      userAccountData.user_id = userIdMatch[1];
    }

    // Boolean fields
    const hidden = getBoolean(fields, 'hidden');
    if (hidden !== undefined) userAccountData.hidden = hidden;

    // Numeric fields
    const order = getNumber(fields, 'order');
    if (order !== undefined) userAccountData.order = order;

    userAccounts.push(userAccountData);
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
    'account_id',
    'item_id',
    'user_id',
    'category_id',
    'plaid_category_id',
    'category_id_source',
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
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) txnData[field] = value;
  }

  const booleanFields = [
    'pending',
    'excluded',
    'user_reviewed',
    'plaid_deleted',
    'is_amazon',
    'account_dashboard_active',
  ];

  for (const field of booleanFields) {
    const value = getBoolean(fields, field);
    if (value !== undefined) txnData[field] = value;
  }

  const numericFields = ['original_amount', 'lat', 'lon'];

  for (const field of numericFields) {
    const value = getNumber(fields, field);
    if (value !== undefined) txnData[field] = value;
  }

  const copilotType = getString(fields, 'type');
  if (copilotType === 'internal_transfer') {
    txnData.internal_transfer = true;
  }

  try {
    return TransactionSchema.parse(txnData);
  } catch {
    return null;
  }
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
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) accData[field] = value;
  }

  const accountType =
    getString(fields, 'type') ??
    getString(fields, 'account_type') ??
    getString(fields, 'original_type');
  if (accountType) accData.account_type = accountType;

  const subtype = getString(fields, 'subtype') ?? getString(fields, 'original_subtype');
  if (subtype) accData.subtype = subtype;

  const availableBalance = getNumber(fields, 'available_balance');
  if (availableBalance !== undefined) {
    accData.available_balance = Math.round(availableBalance * 100) / 100;
  }

  if (!accData.name && !accData.official_name) {
    return null;
  }

  try {
    return AccountSchema.parse(accData);
  } catch {
    return null;
  }
}

/**
 * Internal helper to process a recurring document.
 */
function processRecurring(fields: Map<string, FirestoreValue>, docId: string): Recurring | null {
  const recurringId = getString(fields, 'recurring_id') ?? docId;

  const recData: Record<string, unknown> = {
    recurring_id: recurringId,
  };

  const stringFields = [
    'name',
    'merchant_name',
    'frequency',
    'next_date',
    'last_date',
    'category_id',
    'account_id',
    'iso_currency_code',
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) recData[field] = value;
  }

  const amount = getNumber(fields, 'amount');
  if (amount !== undefined) recData.amount = amount;

  const isActive = getBoolean(fields, 'is_active');
  if (isActive !== undefined) recData.is_active = isActive;

  try {
    return RecurringSchema.parse(recData);
  } catch {
    return null;
  }
}

/**
 * Internal helper to process a budget document.
 */
function processBudget(fields: Map<string, FirestoreValue>, docId: string): Budget | null {
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

  try {
    return BudgetSchema.parse(budgetData);
  } catch {
    return null;
  }
}

/**
 * Internal helper to process a goal document.
 */
function processGoal(fields: Map<string, FirestoreValue>, docId: string): Goal | null {
  const goalId = getString(fields, 'goal_id') ?? docId;

  const goalData: Record<string, unknown> = {
    goal_id: goalId,
  };

  const stringFields = ['name', 'recommendation_id', 'emoji', 'created_date', 'user_id'];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) goalData[field] = value;
  }

  const createdWithAllocations = getBoolean(fields, 'created_with_allocations');
  if (createdWithAllocations !== undefined) {
    goalData.created_with_allocations = createdWithAllocations;
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

  try {
    return GoalSchema.parse(goalData);
  } catch {
    return null;
  }
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

  const extractedGoalId = collection.split('/')[1] ?? getString(fields, 'goal_id');

  const historyData: Record<string, unknown> = {
    month,
    goal_id: extractedGoalId ?? 'unknown',
  };

  const stringFields = ['user_id', 'last_updated', 'created_date'];
  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) historyData[field] = value;
  }

  const currentAmount = getNumber(fields, 'current_amount');
  if (currentAmount !== undefined) historyData.current_amount = currentAmount;

  const targetAmount = getNumber(fields, 'target_amount');
  if (targetAmount !== undefined) historyData.target_amount = targetAmount;

  const dailyDataMap = getMap(fields, 'daily_data');
  if (dailyDataMap) {
    const dailyData: Record<string, DailySnapshot> = {};
    for (const [date, value] of dailyDataMap) {
      if (date.startsWith(month) && value.type === 'map') {
        const amount = getNumber(value.value, 'amount');
        if (amount !== undefined) {
          dailyData[date] = { amount, date };
        }
      }
    }
    if (Object.keys(dailyData).length > 0) {
      historyData.daily_data = dailyData;
    }
  }

  try {
    return GoalHistorySchema.parse(historyData);
  } catch {
    return null;
  }
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

  const validated = InvestmentPriceSchema.safeParse(priceData);
  return validated.success ? validated.data : null;
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

  const validated = InvestmentSplitSchema.safeParse(splitData);
  return validated.success ? validated.data : null;
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
  ];

  for (const field of stringFields) {
    const value = getString(fields, field);
    if (value) itemData[field] = value;
  }

  const needsUpdateValue = getBoolean(fields, 'needs_update');
  if (needsUpdateValue !== undefined) itemData.needs_update = needsUpdateValue;

  const validated = ItemSchema.safeParse(itemData);
  return validated.success ? validated.data : null;
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

  const validated = CategorySchema.safeParse(categoryData);
  return validated.success ? validated.data : null;
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

  // Single pass through the database
  for await (const doc of iterateDocuments(dbPath)) {
    const { fields, documentId, collection, key } = doc;

    // Route document to appropriate processor based on collection
    if (collection === 'transactions') {
      const txn = processTransaction(fields, documentId);
      if (txn) rawTransactions.push(txn);
    } else if (collection === 'accounts') {
      const acc = processAccount(fields, documentId);
      if (acc) rawAccounts.push(acc);
    } else if (collection === 'recurring') {
      const rec = processRecurring(fields, documentId);
      if (rec) rawRecurring.push(rec);
    } else if (collection === 'budgets') {
      const budget = processBudget(fields, documentId);
      if (budget) rawBudgets.push(budget);
    } else if (collection === 'financial_goals') {
      const goal = processGoal(fields, documentId);
      if (goal) rawGoals.push(goal);
    } else if (collection.endsWith('/financial_goal_history')) {
      const history = processGoalHistory(fields, documentId, collection);
      if (history) rawGoalHistory.push(history);
    } else if (collection === 'investment_prices' || collection.includes('investment_prices/')) {
      const price = processInvestmentPrice(fields, documentId, key);
      if (price) rawInvestmentPrices.push(price);
    } else if (collection === 'investment_splits') {
      const split = processInvestmentSplit(fields, documentId);
      if (split) rawInvestmentSplits.push(split);
    } else if (collection === 'items') {
      const item = processItem(fields, documentId);
      if (item) rawItems.push(item);
    } else if (collection === 'categories') {
      const category = processCategory(fields, documentId);
      if (category) rawCategories.push(category);
    } else if (collection.includes('users/') && collection.endsWith('/accounts')) {
      const userAccount = processUserAccount(fields, documentId, collection);
      if (userAccount) rawUserAccounts.push(userAccount);
    }
  }

  // Deduplicate and sort each collection

  // Transactions: dedupe by (display_name, amount, date), sort by date desc
  const txnSeen = new Set<string>();
  const transactions: Transaction[] = [];
  for (const txn of rawTransactions) {
    const displayName = getTransactionDisplayName(txn);
    const key = `${displayName}|${txn.amount}|${txn.date}`;
    if (!txnSeen.has(key)) {
      txnSeen.add(key);
      transactions.push(txn);
    }
  }
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
  };
}
