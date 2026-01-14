/**
 * Test database helper for creating proper LevelDB fixtures.
 *
 * Provides functions to create real LevelDB databases with test data
 * that can be properly read by the decoder.
 */

import { LevelDBReader, createTestDatabase } from '../../src/core/leveldb-reader.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Test data types that match our model schemas.
 */
export interface TestTransaction {
  transaction_id: string;
  account_id?: string;
  amount?: number;
  date?: string;
  name?: string;
  original_name?: string;
  merchant?: string;
  category_id?: string;
  city?: string;
  region?: string;
  country?: string;
  pending?: boolean;
  is_transfer?: boolean;
  note?: string;
  tags?: string[];
}

export interface TestAccount {
  account_id: string;
  name?: string;
  official_name?: string;
  mask?: string;
  account_type?: string;
  subtype?: string;
  institution_name?: string;
  institution_id?: string;
  current_balance?: number;
  available_balance?: number;
  iso_currency_code?: string;
  item_id?: string;
}

export interface TestRecurring {
  recurring_id: string;
  name?: string;
  amount?: number;
  frequency?: string;
  next_date?: string;
  last_date?: string;
  account_id?: string;
  category_id?: string;
  is_active?: boolean;
  merchant?: string;
}

export interface TestBudget {
  budget_id: string;
  category_id?: string;
  amount?: number;
  month?: string;
  is_active?: boolean;
  name?: string;
  spent?: number;
}

export interface TestGoal {
  goal_id: string;
  name?: string;
  target_amount?: number;
  current_amount?: number;
  target_date?: string;
  goal_type?: string;
  is_active?: boolean;
  account_id?: string;
}

export interface TestGoalHistory {
  goal_history_id: string;
  goal_id?: string;
  month?: string;
  daily_snapshots?: Array<{
    date?: string;
    amount?: number;
  }>;
}

export interface TestInvestmentPrice {
  investment_id: string;
  ticker_symbol?: string;
  price?: number;
  close_price?: number;
  current_price?: number;
  institution_price?: number;
  date?: string;
  month?: string;
  currency?: string;
  high?: number;
  low?: number;
  open?: number;
  volume?: number;
  price_type?: string;
}

export interface TestInvestmentSplit {
  split_id: string;
  ticker_symbol?: string;
  split_date?: string;
  split_ratio?: string;
  from_factor?: number;
  to_factor?: number;
  announcement_date?: string;
  record_date?: string;
  ex_date?: string;
  description?: string;
}

export interface TestItem {
  item_id: string;
  institution_name?: string;
  institution_id?: string;
  connection_status?: string;
  needs_update?: boolean;
  error_code?: string;
  error_message?: string;
  last_successful_update?: string;
  consent_expiration_time?: string;
}

export interface TestCategory {
  category_id: string;
  name?: string;
  user_id?: string;
  icon?: string;
  color?: string;
  parent_id?: string;
}

/**
 * Create a test database with the given documents.
 * The database is created in the specified directory.
 */
export async function createTestDb(
  dbPath: string,
  documents: Array<{
    collection: string;
    id: string;
    fields: Record<string, unknown>;
  }>
): Promise<void> {
  // Remove existing directory if it exists
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }

  // Create the database
  await createTestDatabase(dbPath, documents);
}

/**
 * Create a test database with transactions.
 */
export async function createTransactionDb(
  dbPath: string,
  transactions: TestTransaction[]
): Promise<void> {
  const documents = transactions.map((t) => ({
    collection: 'transactions',
    id: t.transaction_id,
    fields: {
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount: t.amount,
      date: t.date,
      name: t.name,
      original_name: t.original_name,
      merchant: t.merchant,
      category_id: t.category_id,
      city: t.city,
      region: t.region,
      country: t.country,
      pending: t.pending,
      is_transfer: t.is_transfer,
      note: t.note,
      tags: t.tags,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with accounts.
 */
export async function createAccountDb(dbPath: string, accounts: TestAccount[]): Promise<void> {
  const documents = accounts.map((a) => ({
    collection: 'accounts',
    id: a.account_id,
    fields: {
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      account_type: a.account_type,
      subtype: a.subtype,
      institution_name: a.institution_name,
      institution_id: a.institution_id,
      current_balance: a.current_balance,
      available_balance: a.available_balance,
      iso_currency_code: a.iso_currency_code,
      item_id: a.item_id,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with recurring items.
 */
export async function createRecurringDb(dbPath: string, recurring: TestRecurring[]): Promise<void> {
  const documents = recurring.map((r) => ({
    collection: 'recurring',
    id: r.recurring_id,
    fields: {
      recurring_id: r.recurring_id,
      name: r.name,
      amount: r.amount,
      frequency: r.frequency,
      next_date: r.next_date,
      last_date: r.last_date,
      account_id: r.account_id,
      category_id: r.category_id,
      is_active: r.is_active,
      merchant: r.merchant,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with budgets.
 */
export async function createBudgetDb(dbPath: string, budgets: TestBudget[]): Promise<void> {
  const documents = budgets.map((b) => ({
    collection: 'budgets',
    id: b.budget_id,
    fields: {
      budget_id: b.budget_id,
      category_id: b.category_id,
      amount: b.amount,
      month: b.month,
      is_active: b.is_active,
      name: b.name,
      spent: b.spent,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with goals.
 */
export async function createGoalDb(dbPath: string, goals: TestGoal[]): Promise<void> {
  const documents = goals.map((g) => ({
    collection: 'financial_goals',
    id: g.goal_id,
    fields: {
      goal_id: g.goal_id,
      name: g.name,
      target_amount: g.target_amount,
      current_amount: g.current_amount,
      target_date: g.target_date,
      goal_type: g.goal_type,
      is_active: g.is_active,
      account_id: g.account_id,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with goal history.
 */
export async function createGoalHistoryDb(
  dbPath: string,
  history: TestGoalHistory[]
): Promise<void> {
  const documents = history.map((h) => ({
    collection: 'goalHistory',
    id: h.goal_history_id,
    fields: {
      goal_history_id: h.goal_history_id,
      goal_id: h.goal_id,
      month: h.month,
      daily_snapshots: h.daily_snapshots,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with investment prices.
 */
export async function createInvestmentPriceDb(
  dbPath: string,
  prices: TestInvestmentPrice[]
): Promise<void> {
  const documents = prices.map((p) => ({
    collection: 'investmentPrices',
    id: p.investment_id,
    fields: {
      investment_id: p.investment_id,
      ticker_symbol: p.ticker_symbol,
      price: p.price,
      close_price: p.close_price,
      current_price: p.current_price,
      institution_price: p.institution_price,
      date: p.date,
      month: p.month,
      currency: p.currency,
      high: p.high,
      low: p.low,
      open: p.open,
      volume: p.volume,
      price_type: p.price_type,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with investment splits.
 */
export async function createInvestmentSplitDb(
  dbPath: string,
  splits: TestInvestmentSplit[]
): Promise<void> {
  const documents = splits.map((s) => ({
    collection: 'investmentSplits',
    id: s.split_id,
    fields: {
      split_id: s.split_id,
      ticker_symbol: s.ticker_symbol,
      split_date: s.split_date,
      split_ratio: s.split_ratio,
      from_factor: s.from_factor,
      to_factor: s.to_factor,
      announcement_date: s.announcement_date,
      record_date: s.record_date,
      ex_date: s.ex_date,
      description: s.description,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with items.
 */
export async function createItemDb(dbPath: string, items: TestItem[]): Promise<void> {
  const documents = items.map((i) => ({
    collection: 'items',
    id: i.item_id,
    fields: {
      item_id: i.item_id,
      institution_name: i.institution_name,
      institution_id: i.institution_id,
      connection_status: i.connection_status,
      needs_update: i.needs_update,
      error_code: i.error_code,
      error_message: i.error_message,
      last_successful_update: i.last_successful_update,
      consent_expiration_time: i.consent_expiration_time,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create a test database with categories.
 */
export async function createCategoryDb(dbPath: string, categories: TestCategory[]): Promise<void> {
  const documents = categories.map((c) => ({
    collection: 'categories',
    id: c.category_id,
    fields: {
      category_id: c.category_id,
      name: c.name,
      user_id: c.user_id,
      icon: c.icon,
      color: c.color,
      parent_id: c.parent_id,
    },
  }));

  await createTestDb(dbPath, documents);
}

/**
 * Create an empty test database.
 */
export async function createEmptyDb(dbPath: string): Promise<void> {
  await createTestDb(dbPath, []);
}

/**
 * Create a combined test database with multiple collections.
 */
export async function createCombinedDb(
  dbPath: string,
  data: {
    transactions?: TestTransaction[];
    accounts?: TestAccount[];
    recurring?: TestRecurring[];
    budgets?: TestBudget[];
    goals?: TestGoal[];
    goalHistory?: TestGoalHistory[];
    investmentPrices?: TestInvestmentPrice[];
    investmentSplits?: TestInvestmentSplit[];
    items?: TestItem[];
    categories?: TestCategory[];
  }
): Promise<void> {
  const documents: Array<{ collection: string; id: string; fields: Record<string, unknown> }> = [];

  if (data.transactions) {
    for (const t of data.transactions) {
      documents.push({
        collection: 'transactions',
        id: t.transaction_id,
        fields: {
          transaction_id: t.transaction_id,
          account_id: t.account_id,
          amount: t.amount,
          date: t.date,
          name: t.name,
          original_name: t.original_name,
          merchant: t.merchant,
          category_id: t.category_id,
          city: t.city,
          region: t.region,
          country: t.country,
          pending: t.pending,
          is_transfer: t.is_transfer,
          note: t.note,
          tags: t.tags,
        },
      });
    }
  }

  if (data.accounts) {
    for (const a of data.accounts) {
      documents.push({
        collection: 'accounts',
        id: a.account_id,
        fields: {
          account_id: a.account_id,
          name: a.name,
          official_name: a.official_name,
          mask: a.mask,
          account_type: a.account_type,
          subtype: a.subtype,
          institution_name: a.institution_name,
          institution_id: a.institution_id,
          current_balance: a.current_balance,
          available_balance: a.available_balance,
          iso_currency_code: a.iso_currency_code,
          item_id: a.item_id,
        },
      });
    }
  }

  if (data.recurring) {
    for (const r of data.recurring) {
      documents.push({
        collection: 'recurring',
        id: r.recurring_id,
        fields: {
          recurring_id: r.recurring_id,
          name: r.name,
          amount: r.amount,
          frequency: r.frequency,
          next_date: r.next_date,
          last_date: r.last_date,
          account_id: r.account_id,
          category_id: r.category_id,
          is_active: r.is_active,
          merchant: r.merchant,
        },
      });
    }
  }

  if (data.budgets) {
    for (const b of data.budgets) {
      documents.push({
        collection: 'budgets',
        id: b.budget_id,
        fields: {
          budget_id: b.budget_id,
          category_id: b.category_id,
          amount: b.amount,
          month: b.month,
          is_active: b.is_active,
          name: b.name,
          spent: b.spent,
        },
      });
    }
  }

  if (data.goals) {
    for (const g of data.goals) {
      documents.push({
        collection: 'financial_goals',
        id: g.goal_id,
        fields: {
          goal_id: g.goal_id,
          name: g.name,
          target_amount: g.target_amount,
          current_amount: g.current_amount,
          target_date: g.target_date,
          goal_type: g.goal_type,
          is_active: g.is_active,
          account_id: g.account_id,
        },
      });
    }
  }

  if (data.goalHistory) {
    for (const h of data.goalHistory) {
      documents.push({
        collection: 'goalHistory',
        id: h.goal_history_id,
        fields: {
          goal_history_id: h.goal_history_id,
          goal_id: h.goal_id,
          month: h.month,
          daily_snapshots: h.daily_snapshots,
        },
      });
    }
  }

  if (data.investmentPrices) {
    for (const p of data.investmentPrices) {
      documents.push({
        collection: 'investmentPrices',
        id: p.investment_id,
        fields: {
          investment_id: p.investment_id,
          ticker_symbol: p.ticker_symbol,
          price: p.price,
          close_price: p.close_price,
          current_price: p.current_price,
          institution_price: p.institution_price,
          date: p.date,
          month: p.month,
          currency: p.currency,
          high: p.high,
          low: p.low,
          open: p.open,
          volume: p.volume,
          price_type: p.price_type,
        },
      });
    }
  }

  if (data.investmentSplits) {
    for (const s of data.investmentSplits) {
      documents.push({
        collection: 'investmentSplits',
        id: s.split_id,
        fields: {
          split_id: s.split_id,
          ticker_symbol: s.ticker_symbol,
          split_date: s.split_date,
          split_ratio: s.split_ratio,
          from_factor: s.from_factor,
          to_factor: s.to_factor,
          announcement_date: s.announcement_date,
          record_date: s.record_date,
          ex_date: s.ex_date,
          description: s.description,
        },
      });
    }
  }

  if (data.items) {
    for (const i of data.items) {
      documents.push({
        collection: 'items',
        id: i.item_id,
        fields: {
          item_id: i.item_id,
          institution_name: i.institution_name,
          institution_id: i.institution_id,
          connection_status: i.connection_status,
          needs_update: i.needs_update,
          error_code: i.error_code,
          error_message: i.error_message,
          last_successful_update: i.last_successful_update,
          consent_expiration_time: i.consent_expiration_time,
        },
      });
    }
  }

  if (data.categories) {
    for (const c of data.categories) {
      documents.push({
        collection: 'categories',
        id: c.category_id,
        fields: {
          category_id: c.category_id,
          name: c.name,
          user_id: c.user_id,
          icon: c.icon,
          color: c.color,
          parent_id: c.parent_id,
        },
      });
    }
  }

  await createTestDb(dbPath, documents);
}

/**
 * Clean up a test database directory.
 */
export function cleanupTestDb(dbPath: string): void {
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
}
