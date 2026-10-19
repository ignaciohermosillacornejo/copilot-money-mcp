/**
 * Database abstraction layer for Copilot Money data.
 *
 * Provides filtered access to transactions and accounts with
 * proper error handling.
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  decodeAccounts,
  decodeTransactions,
  decodeRecurring,
  decodeBudgets,
  decodeGoals,
  decodeGoalHistory,
  decodeInvestmentPrices,
  periodInRange,
  decodeItems,
  decodeCategories,
  decodeAllCollectionsIsolated,
  AllCollectionsResult,
} from './decoder.js';
import type { DecodeStatsByCollection } from './schema-warn.js';
import {
  Account,
  Transaction,
  Category,
  Recurring,
  Budget,
  Goal,
  GoalHistory,
  InvestmentPrice,
  Item,
  getTransactionDisplayName,
} from '../models/index.js';
import type {
  Security,
  HoldingsHistory,
  Tag,
  InvestmentSplit,
  PriceType,
} from '../models/index.js';
import type { BalanceHistory } from '../models/balance-history.js';
import { preferredAccountName } from '../models/account.js';
import { getCategoryName } from '../utils/categories.js';
import { retryInterrupted, isRetryableErrno } from './fs-retry.js';

/**
 * Outcome of looking for the Copilot Money database.
 *
 * `path` set: found. `path` unset and no `lookupError`: every candidate was
 * looked at and none holds a database — genuinely absent. `path` unset WITH a
 * `lookupError`: at least one candidate could not be read, so absence was never
 * established (#774). The two used to collapse into one `undefined`, and a
 * transient `EINTR` reached the user as "please ensure Copilot Money is
 * installed and has synced data".
 */
export interface DatabaseDiscovery {
  path: string | undefined;
  lookupError?: Error;
}

/** Errnos that mean "not there" rather than "could not look". */
const ABSENT_ERRNOS = new Set(['ENOENT', 'ENOTDIR']);

function isAbsence(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && ABSENT_ERRNOS.has(code);
}

/**
 * Find the Copilot Money database under `home` by searching known locations.
 *
 * `home` is a parameter rather than `homedir()` so tests can point it at a
 * synthetic tree; production reaches it only through `findCopilotDatabase()`.
 * Directory reads go through `retryInterrupted`, so an `EINTR` that clears is
 * invisible; one that does not is returned as `lookupError` instead of being
 * swallowed into "absent".
 */
export function discoverCopilotDatabase(home: string): DatabaseDiscovery {
  let lookupError: Error | undefined;
  const noteFailure = (err: unknown): void => {
    if (isAbsence(err)) return;
    lookupError ??= err instanceof Error ? err : new Error(String(err));
  };

  // Known possible locations for Copilot Money database (macOS)
  const possiblePaths = [
    // Current known location
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/firestore/__FIRAPP_DEFAULT',
      'copilot-production-22904/main'
    ),
    // Alternative Firestore paths
    join(
      home,
      'Library/Containers/com.copilot.production/Data/Library',
      'Application Support/Copilot/FirestoreDB/data'
    ),
    // Potential future locations
    join(home, 'Library/Application Support/Copilot/FirestoreDB/data'),
    join(home, 'Library/Containers/com.copilot.production/Data/Documents/FirestoreDB'),
  ];

  // Also try to dynamically find paths matching patterns
  const containerBase = join(
    home,
    'Library/Containers/com.copilot.production/Data/Library/Application Support'
  );
  // No `existsSync` anywhere in discovery, on purpose: it returns `false` on ANY
  // error, so an interrupted existence check would read as "absent" before the
  // retried read below ever ran. The retried `readdirSync` is the existence
  // check — a missing directory throws `ENOENT`, which `noteFailure` files as
  // absence, and every other error is kept.
  try {
    // Look for firestore directories
    const firestorePath = join(containerBase, 'firestore/__FIRAPP_DEFAULT');
    const entries = retryInterrupted(() => fs.readdirSync(firestorePath, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('copilot-')) {
        // Highest priority. Whether `main` exists is settled by the loop below.
        possiblePaths.unshift(join(firestorePath, entry.name, 'main'));
      }
    }
  } catch (err) {
    // Dynamic discovery is best effort — the static list below still runs —
    // but a failure to read is remembered, not forgotten.
    noteFailure(err);
  }

  // Check each path for validity (contains .ldb files or is a valid LevelDB directory)
  for (const path of possiblePaths) {
    try {
      const files = retryInterrupted(() => fs.readdirSync(path));
      // Check for .ldb files or LevelDB manifest files
      if (files.some((file) => file.endsWith('.ldb') || file.startsWith('MANIFEST-'))) {
        return { path };
      }
    } catch (err) {
      // Continue to next path, remembering that this one was not ruled out.
      noteFailure(err);
    }
  }

  return { path: undefined, lookupError };
}

/**
 * Find the Copilot Money database in the current user's home directory.
 * The constructor's no-path branch is the only caller. The home it searched is
 * returned too, so a retryable failure can be re-looked at in the same place.
 */
function findCopilotDatabase(): DatabaseDiscovery & { home: string } {
  const home = homedir();
  return { ...discoverCopilotDatabase(home), home };
}

/**
 * The error to report when there is no usable database.
 *
 * Without a `lookupError` absence was established, and the install/sync advice
 * is right. With one it was not: telling a user who is installed and synced to
 * go install and sync is the misdiagnosis #774 is about, so that case names the
 * failure instead.
 *
 * The errno code and syscall are named, never `lookupError.message` — an fs
 * message carries the absolute path, home directory and username included, and
 * this text is returned to the MCP client, not just logged. Only a retryable
 * errno is called transient: what is left after `ENOENT`/`ENOTDIR` are filtered
 * out is most likely `EACCES`/`EPERM` (a sandbox or privacy denial), which is
 * persistent, and the remedy for it is different.
 */
export function missingDatabaseError(lookupError: Error | undefined): Error {
  if (!lookupError) {
    return new Error(
      'Database not found. Please ensure Copilot Money is installed and has synced data.'
    );
  }
  const errno = lookupError as NodeJS.ErrnoException;
  // No errno code means a non-fs throw, wrapped by `noteFailure`. Its message is
  // the only signal there is, so it is kept, with anything path-shaped removed.
  const what = errno.code
    ? `${errno.code}${errno.syscall ? ` from ${errno.syscall}` : ''}`
    : scrubPaths(lookupError.message) || lookupError.name;
  const prefix = `Could not read the Copilot Money database directory (${what}).`;
  if (isRetryableErrno(lookupError)) {
    return new Error(
      `${prefix} The read was interrupted after retrying, which is transient and not a ` +
        'missing install — retry the request.'
    );
  }
  // Generic about WHICH directory: this is also what an explicit `--db-path`
  // that cannot be read produces, so it must not assume the default container.
  return new Error(
    `${prefix} Copilot Money may well be installed: check that the process running this ` +
      'server is allowed to read that directory — the Copilot Money container, or the ' +
      'custom database path if one was given.'
  );
}

/**
 * Replace absolute and home-relative paths with a placeholder. A quoted path
 * is replaced whole, quotes included, so a space inside it (`Application
 * Support`) cannot leave a fragment of the path behind; an unquoted one ends at
 * whitespace, which is the best a pattern without quotes to go on can do.
 */
function scrubPaths(text: string): string {
  return text
    .replace(/(['"])(?:~|\/)[^'"]*\1/g, '<path>')
    .replace(/(?:~|\/)[^\s'",)]*/g, '<path>')
    .trim();
}

/**
 * Default cache TTL in minutes.
 */
const DEFAULT_CACHE_TTL_MINUTES = 5;

/**
 * The shortest interval at which delete_transaction's split check may
 * attempt to re-decode the local cache for split-parent evidence (#842). The
 * check re-decodes when the cache is stale, but never more often than
 * splitEvidenceRereadMs() — the cache TTL itself, or this minimum when the
 * TTL is shorter. It matters only at COPILOT_CACHE_TTL_MINUTES=0 (always
 * stale), where a cleanup pass would otherwise pay a full decode — worst case
 * the decode timeout — on every delete. Not longer than the TTL on purpose: a
 * split made and un-split in the app is invisible to the local evidence until
 * the next re-read, which is #842's shape, so the evidence is kept as fresh as
 * the rest of the cache contract (#852 review round 3).
 */
export const MIN_SPLIT_EVIDENCE_REREAD_MS = 60_000;

/** See MIN_SPLIT_EVIDENCE_REREAD_MS. */
export function splitEvidenceRereadMs(): number {
  return Math.max(getCacheTTLMs(), MIN_SPLIT_EVIDENCE_REREAD_MS);
}

/**
 * Get cache TTL in milliseconds.
 * Can be configured via COPILOT_CACHE_TTL_MINUTES environment variable.
 * Defaults to 5 minutes. Set to 0 to disable caching (always reload).
 */
function getCacheTTLMs(): number {
  const envValue = process.env.COPILOT_CACHE_TTL_MINUTES;
  if (envValue !== undefined) {
    const minutes = parseInt(envValue, 10);
    if (!isNaN(minutes) && minutes >= 0) {
      return minutes * 60 * 1000;
    }
  }
  return DEFAULT_CACHE_TTL_MINUTES * 60 * 1000;
}

/**
 * Decode-health summary surfaced via get_cache_info / get_connection_status
 * (issue #442). Makes silent schema drops visible to MCP users who never see
 * the stderr warnings.
 *
 * - `status`: 'ok' (no drops), 'degraded' (>=1 document dropped on schema
 *   validation failure), or 'unknown' (no decode pass has run, e.g. cache was
 *   injected or never loaded).
 * - `note`: human-readable health line. Terse in the zero-drop case; when
 *   drops exist it explains what happened and what to do. Repaired documents
 *   (#659 — a non-finite numeric field removed so the rest of the document
 *   survives) are reported here too: they are partial data loss, not silent.
 * - `collections`: per-collection `{ decoded, dropped, repaired,
 *   unread_field_warnings }` counters, present only when at least one
 *   collection has drops, repairs, or unread-field warnings (so clean output
 *   stays terse).
 */
export interface DecodeHealth {
  status: 'ok' | 'degraded' | 'unknown';
  note: string;
  collections?: DecodeStatsByCollection;
}

/**
 * Abstraction layer for querying Copilot Money data.
 *
 * Wraps the decoder and provides filtering capabilities.
 * All data access methods are async due to LevelDB iteration.
 *
 * The cache has a 5-minute TTL - after this time, data is automatically
 * reloaded from disk on the next query. You can also manually refresh
 * using `clearCache()`.
 */
export class CopilotDatabase {
  private dbPath: string | undefined;
  private _transactions: Transaction[] | null = null;
  private _accounts: Account[] | null = null;
  private _recurring: Recurring[] | null = null;
  private _budgets: Budget[] | null = null;
  private _goals: Goal[] | null = null;
  private _goalHistory: GoalHistory[] | null = null;
  private _investmentPrices: InvestmentPrice[] | null = null;
  private _investmentSplits: InvestmentSplit[] | null = null;
  private _items: Item[] | null = null;
  private _userCategories: Category[] | null = null;
  private _categoryNameMap: Map<string, string> | null = null;
  private _accountNameMap: Map<string, string> | null = null;
  private _securities: Security[] | null = null;
  private _tags: Tag[] | null = null;
  private _holdingsHistory: HoldingsHistory[] | null = null;
  private _balanceHistory: BalanceHistory[] | null = null;
  /**
   * The union of AllCollectionsResult.splitParentIds over every decode this
   * process has run (#842). Monotone on purpose: an id a decode once named
   * stays named even if a later decode does not (the app purged the
   * soft-deleted children, or a partial read missed them), because a split
   * parent never stops being one. clearCache() leaves it alone; only a login
   * change clears it (forgetSplitParentIds).
   */
  private readonly _splitParentIds = new Set<string>();
  /**
   * When getSplitParentIds' last decode attempt resolved, successful or not;
   * null = never. Latches failures too, so a cache that keeps timing out
   * costs one attempt per splitEvidenceRereadMs(), not one per delete.
   * Scoped to the split-evidence path: reads that share loadAllCollections
   * are unaffected.
   */
  private _splitEvidenceAttemptAt: number | null = null;

  // Promises for in-flight loads to prevent duplicate loading
  private _loadingTransactions: Promise<Transaction[]> | null = null;
  private _loadingAccounts: Promise<Account[]> | null = null;
  private _loadingRecurring: Promise<Recurring[]> | null = null;
  private _loadingBudgets: Promise<Budget[]> | null = null;
  private _loadingGoals: Promise<Goal[]> | null = null;
  private _loadingGoalHistory: Promise<GoalHistory[]> | null = null;
  private _loadingInvestmentPrices: Promise<InvestmentPrice[]> | null = null;
  private _loadingItems: Promise<Item[]> | null = null;
  private _loadingUserCategories: Promise<Category[]> | null = null;

  // Batch loading state
  private _loadingAllCollections: Promise<AllCollectionsResult> | null = null;
  private _allCollectionsLoaded = false;

  // Per-collection decode health from the last full decode pass (issue #442).
  // Null until a real decode has run (e.g. injected/mocked data has no stats).
  private _decodeStats: DecodeStatsByCollection | null = null;

  // Cache TTL tracking
  private _cacheLoadedAt: number | null = null;

  // Optional decode timeout override
  private decodeTimeoutMs?: number;
  /** Set when no-path discovery could not read a candidate (see `DatabaseDiscovery`). */
  private discoveryError?: Error;
  /** The home no-path discovery searched; unset when a path was given. */
  private discoveryHome?: string;

  /**
   * Initialize database connection.
   *
   * @param dbPath - Path to LevelDB database directory.
   *                If undefined, auto-detects Copilot Money location.
   * @param decodeTimeoutMs - Optional timeout for decode operations in milliseconds.
   *                         If undefined, falls back to DECODE_TIMEOUT_MS env var or default.
   */
  constructor(dbPath?: string, decodeTimeoutMs?: number) {
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      // Auto-detect database location
      const discovery = findCopilotDatabase();
      this.dbPath = discovery.path;
      this.discoveryError = discovery.lookupError;
      this.discoveryHome = discovery.home;
    }
    this.decodeTimeoutMs = decodeTimeoutMs;
  }

  /**
   * Get the database path, throwing if not available.
   */
  private requireDbPath(): string {
    this.rediscoverIfTransient();
    if (!this.dbPath) {
      throw missingDatabaseError(this.discoveryError);
    }
    return this.dbPath;
  }

  /**
   * Whether the database exists and is readable, with the reason kept.
   *
   * `lookupError` is set when the answer is "could not look" rather than
   * "looked, absent" — from discovery when no path was given, or from reading
   * `dbPath` when one was. The server's dispatch gate reads it so the message
   * the user sees is `missingDatabaseError`'s, not a second copy of the install
   * advice (#774).
   *
   * This is the only availability check, deliberately. There used to be a
   * boolean `isAvailable()` beside it, which collapsed both answers into
   * `false`; its last two callers (the cache and account-name smokes) printed
   * "no cache" for a cache they could not read. It was removed rather than
   * gated, so the collapse is not an API anyone can reach for.
   */
  availability(): { available: boolean; lookupError?: Error } {
    this.rediscoverIfTransient();
    // Copied to a local: `this.dbPath` does not stay narrowed inside the closure.
    const dbPath = this.dbPath;
    if (!dbPath) return { available: false, lookupError: this.discoveryError };
    try {
      // No `existsSync` first: it reports any error as absence. A missing
      // directory throws ENOENT here, which is absence; anything else is kept.
      const files = retryInterrupted(() => fs.readdirSync(dbPath));
      return {
        available: files.some((file) => file.endsWith('.ldb') || file.startsWith('MANIFEST-')),
      };
    } catch (err) {
      if (isAbsence(err)) return { available: false };
      return { available: false, lookupError: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * Look again when no-path discovery failed with a retryable errno.
   *
   * Discovery runs once, in the constructor. Its error used to be stored and
   * served on every later call without a syscall, so the message's own advice —
   * the read was interrupted, retry the request — could never change the
   * answer; only restarting the server could. A retryable failure is by
   * definition one a later look may settle, so it gets that look. A persistent
   * one (`EACCES`/`EPERM`) is still served from memory: its message says to fix
   * permissions, and re-walking the container on every call would not help.
   */
  private rediscoverIfTransient(): void {
    if (this.dbPath || !this.discoveryHome || !isRetryableErrno(this.discoveryError)) return;
    const again = discoverCopilotDatabase(this.discoveryHome);
    this.dbPath = again.path;
    this.discoveryError = again.lookupError;
  }

  /**
   * Check if the in-memory cache has expired (older than TTL).
   *
   * @returns true if cache is stale or not loaded, false if still valid
   */
  private isCacheStale(): boolean {
    if (this._cacheLoadedAt === null) {
      return true; // Not loaded yet
    }
    const ttlMs = getCacheTTLMs();
    if (ttlMs === 0) {
      return true; // TTL of 0 means always reload
    }
    return Date.now() - this._cacheLoadedAt > ttlMs;
  }

  /**
   * Clear all cached data, forcing a fresh reload on next query.
   *
   * This is useful when:
   * - User has synced new data in Copilot Money app
   * - Cache TTL has expired (called automatically)
   * - Manual refresh is requested
   *
   * @returns Information about what was cleared
   */
  clearCache(): { cleared: boolean; message: string } {
    const wasLoaded = this._allCollectionsLoaded;
    const hadData = this._transactions !== null;

    // Clear all cached data
    this._transactions = null;
    this._accounts = null;
    this._recurring = null;
    this._budgets = null;
    this._goals = null;
    this._goalHistory = null;
    this._investmentPrices = null;
    this._investmentSplits = null;
    this._items = null;
    this._userCategories = null;
    this._categoryNameMap = null;
    this._accountNameMap = null;
    this._securities = null;
    this._holdingsHistory = null;
    this._tags = null;
    this._balanceHistory = null;
    // _splitParentIds survives on purpose: split evidence only accumulates.

    // Clear in-flight loading promises
    this._loadingTransactions = null;
    this._loadingAccounts = null;
    this._loadingRecurring = null;
    this._loadingBudgets = null;
    this._loadingGoals = null;
    this._loadingGoalHistory = null;
    this._loadingInvestmentPrices = null;
    this._loadingItems = null;
    this._loadingUserCategories = null;
    this._loadingAllCollections = null;

    // Reset batch loading state
    this._allCollectionsLoaded = false;
    this._cacheLoadedAt = null;
    this._decodeStats = null;

    if (wasLoaded || hadData) {
      return {
        cleared: true,
        message: 'Cache cleared successfully. Fresh data will be loaded on next query.',
      };
    }
    return {
      cleared: false,
      message: 'Cache was already empty.',
    };
  }

  /**
   * Inject mock data for testing. Replaces internal caches with provided data.
   * Fields not provided are left unchanged.
   * Automatically marks the cache as fully loaded.
   * @internal
   */
  _injectDataForTesting(data: {
    transactions?: Transaction[];
    accounts?: Account[];
    recurring?: Recurring[];
    budgets?: Budget[];
    goals?: Goal[];
    goalHistory?: GoalHistory[];
    investmentPrices?: InvestmentPrice[];
    investmentSplits?: InvestmentSplit[];
    items?: Item[];
    userCategories?: Category[];
    securities?: Security[];
    tags?: Tag[];
    holdingsHistory?: HoldingsHistory[];
    balanceHistory?: BalanceHistory[];
    categoryNameMap?: Map<string, string>;
    accountNameMap?: Map<string, string>;
    splitParentIds?: string[];
  }): void {
    if (data.transactions !== undefined) this._transactions = data.transactions;
    if (data.accounts !== undefined) this._accounts = data.accounts;
    if (data.recurring !== undefined) this._recurring = data.recurring;
    if (data.budgets !== undefined) this._budgets = data.budgets;
    if (data.goals !== undefined) this._goals = data.goals;
    if (data.goalHistory !== undefined) this._goalHistory = data.goalHistory;
    if (data.investmentPrices !== undefined) this._investmentPrices = data.investmentPrices;
    if (data.investmentSplits !== undefined) this._investmentSplits = data.investmentSplits;
    if (data.items !== undefined) this._items = data.items;
    if (data.userCategories !== undefined) this._userCategories = data.userCategories;
    if (data.securities !== undefined) this._securities = data.securities;
    if (data.tags !== undefined) this._tags = data.tags;
    if (data.holdingsHistory !== undefined) this._holdingsHistory = data.holdingsHistory;
    if (data.balanceHistory !== undefined) this._balanceHistory = data.balanceHistory;
    if (data.categoryNameMap !== undefined) this._categoryNameMap = data.categoryNameMap;
    if (data.accountNameMap !== undefined) this._accountNameMap = data.accountNameMap;
    // Unions, like every decode: injecting [] does not reset the accumulated
    // split-parent ids — only forgetSplitParentIds() does.
    for (const id of data.splitParentIds ?? []) this._splitParentIds.add(id);
    this._allCollectionsLoaded = true;
    this._cacheLoadedAt = Date.now();
  }

  /**
   * Mark hand-built fixture state as a fresh full load (#852 review), the way
   * every real load and _injectDataForTesting do. A fixture that sets
   * `_allCollectionsLoaded` without a load time counts as stale, and
   * delete_transaction's split check then clears it and tries the database
   * path — a failure that check swallows, so the test silently weakens.
   * @internal
   */
  _markLoadedForTesting(): void {
    this._allCollectionsLoaded = true;
    this._cacheLoadedAt = Date.now();
  }

  /**
   * Patch a specific transaction in the in-memory cache.
   *
   * Used after a successful Firestore write to keep the cache consistent
   * without reloading the entire database from LevelDB.
   *
   * @param transactionId - The transaction_id to update
   * @param fields - Partial transaction fields to merge
   * @returns true if the transaction was found and patched, false otherwise
   */
  patchCachedTransaction(
    transactionId: string,
    // The split fields are excluded by type: CopilotMoneyTools' split-evidence
    // index (#836) assumes no patch rewrites them in place.
    fields: Partial<Omit<Transaction, 'parent_transaction_id' | 'children_transaction_ids'>>
  ): boolean {
    if (!this._transactions) return false;
    const txn = this._transactions.find((t) => t.transaction_id === transactionId);
    if (!txn) return false;
    Object.assign(txn, fields);
    return true;
  }

  /**
   * Remove a transaction from the in-memory cache by id. Used after a
   * successful DeleteTransaction GraphQL write so subsequent get_transactions
   * reads reflect the delete without waiting for the next refresh_database.
   *
   * Returns true if the cache contained the id and it was removed, false if
   * the cache was not loaded or the id was absent. Mirrors the shape of
   * `patchCachedTagDelete` / `patchCachedCategoryDelete` / `patchCachedRecurringDelete`.
   */
  patchCachedTransactionDelete(transactionId: string): boolean {
    if (!this._transactions) return false;
    const before = this._transactions.length;
    this._transactions = this._transactions.filter((t) => t.transaction_id !== transactionId);
    return this._transactions.length < before;
  }

  /**
   * Patch the in-memory budget for a category after a successful set_budget
   * write. Mirrors what Copilot's app writes to LevelDB: the value lands in
   * `amounts[YYYY-MM]` keyed by the current month (or an explicit month when
   * `month` is provided). See issue #278 for the investigation — the top-level
   * `amount` field is a frozen legacy artifact the Copilot app stopped
   * writing to ~2 years ago, so the only way to observe a fresh budget write
   * is via the amounts map.
   *
   * If no budget exists yet for the category, a new entry is pushed so the
   * setBudget-then-getBudgets round trip still reflects the write.
   *
   * @returns true if the cache was populated and the patch applied, false if
   *   the cache had not been loaded yet (next load picks up real state).
   */
  patchCachedBudget(categoryId: string, amount: number, month?: string): boolean {
    if (!this._budgets) return false;
    const monthKey =
      month ??
      (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })();

    const existing = this._budgets.find((b) => b.category_id === categoryId);
    if (existing) {
      existing.amounts = { ...(existing.amounts ?? {}), [monthKey]: amount };
    } else {
      // Synthetic placeholder so set_budget → get_budgets reflects the write
      // before Copilot syncs the real entry. Use a UUID rather than a
      // deterministic prefix so the surface ID looks like a real Firestore id
      // instead of advertising "this is fake" to clients.
      this._budgets.push({
        budget_id: randomUUID(),
        category_id: categoryId,
        amounts: { [monthKey]: amount },
      });
    }
    return true;
  }

  /**
   * Insert or merge a tag in the in-memory cache. If a tag with the same
   * `tag_id` exists, incoming fields are merged on top (missing fields are
   * preserved). Otherwise the tag is appended.
   *
   * No-op if the cache has not been loaded yet.
   */
  patchCachedTagUpsert(tag: Tag): void {
    if (!this._tags) return;
    const idx = this._tags.findIndex((t) => t.tag_id === tag.tag_id);
    if (idx >= 0) {
      Object.assign(this._tags[idx]!, tag);
    } else {
      this._tags.push(tag);
    }
  }

  /**
   * Remove a tag from the in-memory cache by id. No-op (returns false) if
   * the cache isn't loaded or the tag isn't found.
   */
  patchCachedTagDelete(tagId: string): boolean {
    if (!this._tags) return false;
    const before = this._tags.length;
    this._tags = this._tags.filter((t) => t.tag_id !== tagId);
    return this._tags.length < before;
  }

  /**
   * Insert or merge a category in the in-memory cache. Invalidates the
   * derived `_categoryNameMap` so the next read rebuilds it. No-op if the
   * cache has not been loaded yet.
   */
  patchCachedCategoryUpsert(category: Category): void {
    if (!this._userCategories) return;
    const idx = this._userCategories.findIndex((c) => c.category_id === category.category_id);
    if (idx >= 0) {
      Object.assign(this._userCategories[idx]!, category);
    } else {
      this._userCategories.push(category);
    }
    this._categoryNameMap = null;
  }

  /**
   * Remove a category from the in-memory cache. Invalidates the derived
   * name map. Returns false if the cache isn't loaded or the id isn't found.
   */
  patchCachedCategoryDelete(categoryId: string): boolean {
    if (!this._userCategories) return false;
    const before = this._userCategories.length;
    this._userCategories = this._userCategories.filter((c) => c.category_id !== categoryId);
    if (this._userCategories.length < before) {
      this._categoryNameMap = null;
      return true;
    }
    return false;
  }

  /**
   * Insert or merge a recurring item. No-op if cache isn't loaded.
   */
  patchCachedRecurringUpsert(recurring: Recurring): void {
    if (!this._recurring) return;
    const idx = this._recurring.findIndex((r) => r.recurring_id === recurring.recurring_id);
    if (idx >= 0) {
      Object.assign(this._recurring[idx]!, recurring);
    } else {
      this._recurring.push(recurring);
    }
  }

  /**
   * Remove a recurring item by id. Returns false if cache isn't loaded or
   * the id isn't found.
   */
  patchCachedRecurringDelete(recurringId: string): boolean {
    if (!this._recurring) return false;
    const before = this._recurring.length;
    this._recurring = this._recurring.filter((r) => r.recurring_id !== recurringId);
    return this._recurring.length < before;
  }

  /**
   * Get the timestamp when cache was last loaded.
   *
   * @returns Unix timestamp in milliseconds, or null if not loaded
   */
  getCacheLoadedAt(): number | null {
    return this._cacheLoadedAt;
  }

  /**
   * The transactions already decoded into memory, or null when none are.
   * Never triggers a decode or the per-collection fallback read. Write paths
   * use it where a read must stay free: resolution never pays for a LevelDB
   * decode, and delete_transaction's split check (#842), which may already
   * have paid for one through getSplitParentIds, never pays for a second.
   */
  peekLoadedTransactions(): readonly Transaction[] | null {
    return this._transactions;
  }

  /**
   * Every id the local cache has named as a split parent this process,
   * soft-deleted split children included (#842) — the union over every
   * decode (see `_splitParentIds`), so it never shrinks.
   *
   * Runs the batch decode every read uses when the local cache is not loaded
   * or is past its TTL (5 minutes by default, COPILOT_CACHE_TTL_MINUTES; 0
   * means always stale) — but attempts it at most once per
   * splitEvidenceRereadMs() (the TTL, at least a minute), failed attempts
   * included. So in live mode a delete pays for at most one decode attempt
   * per TTL, and per minute at a TTL of 0. (Cache-only mode — test-only
   * today, since --write implies --live-reads — also reads rows through
   * getAllTransactions(), which can attempt a decode of its own.)
   * Re-reading at all matters in live mode, where nothing else reloads the
   * local cache: a split made and un-split in the app after the first decode
   * reaches the cache later (#852 review). Any decode, a read's included,
   * adds to the union.
   *
   * A decode that throws leaves the union as it was, but the caller sees the
   * throw; callers that must not be blocked by an unreadable cache catch it
   * and read peekSplitParentIds().
   */
  async getSplitParentIds(): Promise<ReadonlySet<string>> {
    if (this.splitEvidenceDue()) {
      // The latch is stamped when the attempt RESOLVES, not when it starts: a
      // concurrent delete arriving mid-decode must find the attempt still
      // due and join the in-flight decode (loadAllCollections shares it),
      // rather than answer at once from evidence the decode has not yet
      // added (#852 review round 4).
      // mutation-guard: the split-evidence latch waits for the decode
      try {
        await this.loadAllCollections();
      } finally {
        this._splitEvidenceAttemptAt = Date.now();
      }
    }
    return this._splitParentIds;
  }

  /** The accumulated split-parent ids, never triggering a decode (#842). */
  peekSplitParentIds(): ReadonlySet<string> {
    return this._splitParentIds;
  }

  /**
   * Forget the accumulated split-parent ids (#842). Only for a login change:
   * the evidence belongs to the previous account's local cache. Also marks
   * the loaded cache stale and lifts the attempt latch, so the next split
   * check re-decodes at once instead of answering from an empty set until the
   * TTL (#852 review round 3). If the transition was a token anomaly on the
   * same account, that re-decode simply restores the evidence.
   */
  forgetSplitParentIds(): void {
    this._splitParentIds.clear();
    this._splitEvidenceAttemptAt = null;
    // mutation-guard: a login change re-reads split evidence
    this._cacheLoadedAt = null;
  }

  /** Whether getSplitParentIds should attempt a decode; see splitEvidenceRereadMs. */
  private splitEvidenceDue(): boolean {
    const last = this._splitEvidenceAttemptAt;
    if (last !== null && Date.now() - last < splitEvidenceRereadMs()) return false;
    // mutation-guard: split-parent evidence honours the cache TTL
    return !this._allCollectionsLoaded || this.isCacheStale();
  }

  /**
   * Summarize per-collection decode health from the last full decode pass.
   *
   * Surfaces silent schema drops (issue #442): documents that failed Zod
   * validation are omitted from results with only a deduped stderr warning,
   * which MCP users never see. This summary makes the drop counts visible
   * via get_cache_info and get_connection_status.
   */
  getDecodeHealth(): DecodeHealth {
    const stats = this._decodeStats;
    if (stats === null) {
      return {
        status: 'unknown',
        note: 'Decode statistics unavailable — the local database has not been decoded in this session.',
      };
    }

    let totalDecoded = 0;
    let totalDropped = 0;
    let totalRepaired = 0;
    let totalUnread = 0;
    const flagged: DecodeStatsByCollection = {};
    for (const [collection, s] of Object.entries(stats)) {
      totalDecoded += s.decoded;
      totalDropped += s.dropped;
      totalRepaired += s.repaired;
      totalUnread += s.unread_field_warnings;
      if (s.dropped > 0 || s.repaired > 0 || s.unread_field_warnings > 0) {
        flagged[collection] = { ...s };
      }
    }

    if (totalDropped > 0) {
      const phrase =
        totalDropped === 1
          ? '1 document failed schema validation and is missing from results'
          : `${totalDropped} documents failed schema validation and are missing from results`;
      return {
        status: 'degraded',
        note:
          `${phrase} — likely a Copilot app update changed the data shape. ` +
          'File an issue at https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues ' +
          "and include the 'schema drop' warnings from the MCP server's stderr log.",
        collections: flagged,
      };
    }

    // Repairs are partial data loss — the document survived, one field did
    // not — so they are reported even though nothing was dropped (#659).
    if (totalRepaired > 0) {
      const docs = totalRepaired === 1 ? 'document' : 'documents';
      const unreadClause =
        totalUnread > 0
          ? ` ${totalUnread} raw ${totalUnread === 1 ? 'field is' : 'fields are'} also not yet read by the decoder.`
          : '';
      return {
        status: 'ok',
        note:
          `All ${totalDecoded} validated documents are present, but ${totalRepaired} ${docs} held a ` +
          'non-finite number (NaN or ±Infinity) the schema cannot represent — that field was dropped ' +
          `and the rest of the document kept. See 'non-finite field' warnings on stderr for the paths.${unreadClause}`,
        collections: flagged,
      };
    }

    if (totalUnread > 0) {
      const fields = totalUnread === 1 ? 'field' : 'fields';
      return {
        status: 'ok',
        note:
          `All ${totalDecoded} validated documents decoded cleanly, but ${totalUnread} raw ${fields} ` +
          'in the cache are not yet read by the decoder (see unread-field warnings on stderr). ' +
          'No data was dropped.',
        collections: flagged,
      };
    }

    return {
      status: 'ok',
      note: `All ${totalDecoded} validated documents decoded cleanly. No schema drops.`,
    };
  }

  /**
   * Load all collections in a single database pass for optimal performance.
   *
   * This is ~10x faster than loading each collection individually because
   * it only iterates through the database once instead of once per collection.
   *
   * Automatically clears stale cache (older than TTL) before loading.
   */
  private async loadAllCollections(): Promise<void> {
    // Check if cache is stale and clear if needed
    if (this._allCollectionsLoaded && this.isCacheStale()) {
      this.clearCache();
    }

    // Return if already loaded (and not stale)
    if (this._allCollectionsLoaded) {
      return;
    }

    // Return in-flight promise if loading
    if (this._loadingAllCollections !== null) {
      await this._loadingAllCollections;
      return;
    }

    // Start batch loading in an isolated worker thread to prevent memory leaks
    // from classic-level's native ArrayBuffer accumulation
    this._loadingAllCollections = decodeAllCollectionsIsolated(
      this.requireDbPath(),
      this.decodeTimeoutMs
    );
    try {
      const result = await this._loadingAllCollections;

      // Populate all caches
      this._transactions = result.transactions;
      this._accounts = result.accounts;
      this._recurring = result.recurring;
      this._budgets = result.budgets;
      this._goals = result.goals;
      this._goalHistory = result.goalHistory;
      this._investmentPrices = result.investmentPrices;
      this._investmentSplits = result.investmentSplits;
      this._items = result.items;
      this._userCategories = result.categories;
      this._securities = result.securities;
      this._holdingsHistory = result.holdingsHistory;
      this._tags = result.tags;
      this._balanceHistory = result.balanceHistory;
      // mutation-guard: local split evidence only accumulates
      for (const id of result.splitParentIds) this._splitParentIds.add(id);

      this._decodeStats = result.decodeStats;

      this._allCollectionsLoaded = true;
      this._cacheLoadedAt = Date.now();
    } finally {
      this._loadingAllCollections = null;
    }
  }

  /**
   * Load transactions with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadTransactions(): Promise<Transaction[]> {
    // Return cached data if available
    if (this._transactions !== null) {
      return this._transactions;
    }

    // Use batch loading for optimal performance
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._transactions ?? [];
    }

    // Fallback to individual loading (shouldn't normally happen)
    if (this._loadingTransactions !== null) {
      return this._loadingTransactions;
    }

    this._loadingTransactions = decodeTransactions(this.requireDbPath());
    try {
      this._transactions = await this._loadingTransactions;
      return this._transactions;
    } finally {
      this._loadingTransactions = null;
    }
  }

  /**
   * Load accounts with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadAccounts(): Promise<Account[]> {
    if (this._accounts !== null) {
      return this._accounts;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._accounts ?? [];
    }

    if (this._loadingAccounts !== null) {
      return this._loadingAccounts;
    }

    this._loadingAccounts = decodeAccounts(this.requireDbPath());
    try {
      this._accounts = await this._loadingAccounts;
      return this._accounts;
    } finally {
      this._loadingAccounts = null;
    }
  }

  /**
   * Load recurring with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadRecurring(): Promise<Recurring[]> {
    if (this._recurring !== null) {
      return this._recurring;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._recurring ?? [];
    }

    if (this._loadingRecurring !== null) {
      return this._loadingRecurring;
    }

    this._loadingRecurring = decodeRecurring(this.requireDbPath());
    try {
      this._recurring = await this._loadingRecurring;
      return this._recurring;
    } finally {
      this._loadingRecurring = null;
    }
  }

  /**
   * Load budgets with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadBudgets(): Promise<Budget[]> {
    if (this._budgets !== null) {
      return this._budgets;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._budgets ?? [];
    }

    if (this._loadingBudgets !== null) {
      return this._loadingBudgets;
    }

    this._loadingBudgets = decodeBudgets(this.requireDbPath());
    try {
      this._budgets = await this._loadingBudgets;
      return this._budgets;
    } finally {
      this._loadingBudgets = null;
    }
  }

  /**
   * Load goals with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadGoals(): Promise<Goal[]> {
    if (this._goals !== null) {
      return this._goals;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._goals ?? [];
    }

    if (this._loadingGoals !== null) {
      return this._loadingGoals;
    }

    this._loadingGoals = decodeGoals(this.requireDbPath());
    try {
      this._goals = await this._loadingGoals;
      return this._goals;
    } finally {
      this._loadingGoals = null;
    }
  }

  /**
   * Load goal history with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadGoalHistory(): Promise<GoalHistory[]> {
    if (this._goalHistory !== null) {
      return this._goalHistory;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._goalHistory ?? [];
    }

    if (this._loadingGoalHistory !== null) {
      return this._loadingGoalHistory;
    }

    this._loadingGoalHistory = decodeGoalHistory(this.requireDbPath());
    try {
      this._goalHistory = await this._loadingGoalHistory;
      return this._goalHistory;
    } finally {
      this._loadingGoalHistory = null;
    }
  }

  /**
   * Load investment prices with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadInvestmentPrices(): Promise<InvestmentPrice[]> {
    if (this._investmentPrices !== null) {
      return this._investmentPrices;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._investmentPrices ?? [];
    }

    if (this._loadingInvestmentPrices !== null) {
      return this._loadingInvestmentPrices;
    }

    this._loadingInvestmentPrices = decodeInvestmentPrices(this.requireDbPath(), {});
    try {
      this._investmentPrices = await this._loadingInvestmentPrices;
      return this._investmentPrices;
    } finally {
      this._loadingInvestmentPrices = null;
    }
  }

  /**
   * Load items with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadItems(): Promise<Item[]> {
    if (this._items !== null) {
      return this._items;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._items ?? [];
    }

    if (this._loadingItems !== null) {
      return this._loadingItems;
    }

    this._loadingItems = decodeItems(this.requireDbPath());
    try {
      this._items = await this._loadingItems;
      return this._items;
    } finally {
      this._loadingItems = null;
    }
  }

  /**
   * Load user categories with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadUserCategories(): Promise<Category[]> {
    if (this._userCategories !== null) {
      return this._userCategories;
    }

    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._userCategories ?? [];
    }

    if (this._loadingUserCategories !== null) {
      return this._loadingUserCategories;
    }

    this._loadingUserCategories = decodeCategories(this.requireDbPath());
    try {
      this._userCategories = await this._loadingUserCategories;
      return this._userCategories;
    } finally {
      this._loadingUserCategories = null;
    }
  }

  /**
   * Load securities with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadSecurities(): Promise<Security[]> {
    if (this._securities !== null) {
      return this._securities;
    }
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._securities ?? [];
    }
    return this._securities ?? [];
  }

  /**
   * Load investment splits with caching.
   * Uses batch loading for optimal performance on first access.
   *
   * Cache shape: one InvestmentSplit per security (keyed by `security_id`)
   * with a sparse `adjustments` map of YYYY-MM-DD → multiplier. Securities
   * that have never split are omitted at decode time (placeholder docs are
   * skipped) — so the returned array only contains entries with ≥1 split.
   */
  private async loadInvestmentSplits(): Promise<InvestmentSplit[]> {
    if (this._investmentSplits !== null) {
      return this._investmentSplits;
    }
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._investmentSplits ?? [];
    }
    return this._investmentSplits ?? [];
  }

  /**
   * Load holdings history with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadHoldingsHistory(): Promise<HoldingsHistory[]> {
    if (this._holdingsHistory !== null) {
      return this._holdingsHistory;
    }
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._holdingsHistory ?? [];
    }
    return this._holdingsHistory ?? [];
  }

  /**
   * Load balance history with caching.
   * Uses batch loading for optimal performance on first access.
   */
  private async loadBalanceHistory(): Promise<BalanceHistory[]> {
    if (this._balanceHistory !== null) {
      return this._balanceHistory;
    }
    if (!this._allCollectionsLoaded) {
      await this.loadAllCollections();
      return this._balanceHistory ?? [];
    }
    return this._balanceHistory ?? [];
  }

  /**
   * Get transactions with optional filters.
   *
   * @param options - Filter options
   * @param options.startDate - Filter by date >= this (YYYY-MM-DD)
   * @param options.endDate - Filter by date <= this (YYYY-MM-DD)
   * @param options.categoryIds - Keep only rows whose category_id is in this set (exact
   *   match). Callers resolve a user-facing `category` value into this set with
   *   resolveCategoryFilter (src/tools/category-filter.ts), which adds a parent's
   *   descendants; this layer does no matching of its own (#845).
   * @param options.merchant - Filter by merchant name (case-insensitive substring match)
   * @param options.accountId - Filter by account_id
   * @param options.minAmount - Filter by amount >= this
   * @param options.maxAmount - Filter by amount <= this
   * @param options.limit - Maximum number of transactions to return (default: 1000)
   * @returns List of filtered transactions, sorted by date descending
   */
  async getTransactions(
    options: {
      startDate?: string;
      endDate?: string;
      categoryIds?: ReadonlySet<string>;
      merchant?: string;
      accountId?: string;
      minAmount?: number;
      maxAmount?: number;
      limit?: number;
    } = {}
  ): Promise<Transaction[]> {
    const {
      startDate,
      endDate,
      categoryIds,
      merchant,
      accountId,
      minAmount,
      maxAmount,
      limit = 1000,
    } = options;

    const transactions = await this.loadTransactions();
    let result = [...transactions];

    // Apply date range filter
    if (startDate) {
      result = result.filter((txn) => txn.date >= startDate);
    }
    if (endDate) {
      result = result.filter((txn) => txn.date <= endDate);
    }

    // Apply category filter: exact ids only. This used to be a case-insensitive
    // substring of the id, a relic of Plaid-taxonomy ids; on opaque Firestore
    // ids it matched by accident or not at all (#845).
    if (categoryIds) {
      result = result.filter(
        (txn) => txn.category_id !== undefined && categoryIds.has(txn.category_id)
      );
    }

    // Apply merchant filter (case-insensitive, check display_name)
    if (merchant) {
      const merchantLower = merchant.toLowerCase();
      result = result.filter((txn) =>
        getTransactionDisplayName(txn).toLowerCase().includes(merchantLower)
      );
    }

    // Apply account ID filter
    if (accountId) {
      result = result.filter((txn) => txn.account_id === accountId);
    }

    // Apply amount range filter (using absolute value for intuitive filtering)
    // With standard accounting (negative = expense), users expect minAmount: 50
    // to find transactions with magnitude >= 50 (e.g., -50, -100, not -25)
    if (minAmount !== undefined) {
      result = result.filter((txn) => Math.abs(txn.amount) >= minAmount);
    }
    if (maxAmount !== undefined) {
      result = result.filter((txn) => Math.abs(txn.amount) <= maxAmount);
    }

    // Apply limit
    return result.slice(0, limit);
  }

  /**
   * Free-text search of transactions.
   *
   * Searches in merchant name (display_name).
   *
   * @param query - Search query (case-insensitive)
   * @param limit - Maximum results (default: 50)
   * @returns List of matching transactions
   */
  async searchTransactions(query: string, limit = 50): Promise<Transaction[]> {
    const transactions = await this.loadTransactions();

    const queryLower = query.toLowerCase();
    const result = transactions.filter((txn) =>
      getTransactionDisplayName(txn).toLowerCase().includes(queryLower)
    );

    return result.slice(0, limit);
  }

  /**
   * Get all accounts.
   *
   * @param accountType - Optional filter by account type
   *                     (checking, savings, credit, investment)
   *                     Also checks subtype field for better matching.
   * @returns List of accounts
   */
  async getAccounts(accountType?: string): Promise<Account[]> {
    const accounts = await this.loadAccounts();
    let result = [...accounts];

    // Apply account type filter if specified
    // Check both account_type and subtype fields for better matching
    if (accountType) {
      const accountTypeLower = accountType.toLowerCase();
      result = result.filter((acc) => {
        // Check account_type field
        if (acc.account_type && acc.account_type.toLowerCase().includes(accountTypeLower)) {
          return true;
        }
        // Check subtype field (e.g., "checking" when account_type is "depository")
        if (acc.subtype && acc.subtype.toLowerCase().includes(accountTypeLower)) {
          return true;
        }
        return false;
      });
    }

    return result;
  }

  /**
   * Get recurring transactions from Copilot's native subscription tracking.
   *
   * @param activeOnly - If true, only return active recurring transactions
   * @returns List of recurring transactions
   */
  async getRecurring(activeOnly = false): Promise<Recurring[]> {
    const recurring = await this.loadRecurring();
    let result = [...recurring];

    if (activeOnly) {
      // Filter for active subscriptions:
      // - is_active === true: explicitly marked as active
      // - is_active === undefined: status field not set in Firestore, treat as potentially active
      //   (better to show potentially active subscriptions than hide real ones)
      // - is_active === false: explicitly canceled, excluded
      result = result.filter((rec) => rec.is_active === true || rec.is_active === undefined);
    }

    return result;
  }

  /**
   * Get budgets from Copilot's native budget tracking.
   *
   * @param activeOnly - If true, only return active budgets
   * @returns List of budgets
   */
  async getBudgets(activeOnly = false): Promise<Budget[]> {
    const budgets = await this.loadBudgets();
    let result = [...budgets];

    if (activeOnly) {
      // Filter for active budgets:
      // - is_active === true: explicitly marked as active
      // - is_active === undefined: status field not set in Firestore, treat as potentially active
      //   (better to show potentially active budgets than hide real ones)
      // - is_active === false: explicitly disabled, excluded
      result = result.filter(
        (budget) => budget.is_active === true || budget.is_active === undefined
      );
    }

    return result;
  }

  /**
   * Get financial goals from the database.
   *
   * @param activeOnly - If true, only return active goals (default: false)
   * @returns Array of Goal objects
   */
  async getGoals(activeOnly = false): Promise<Goal[]> {
    const goals = await this.loadGoals();
    let result = [...goals];

    if (activeOnly) {
      // Filter for active goals (status === 'active')
      result = result.filter((goal) => goal.savings?.status === 'active');
    }

    return result;
  }

  /**
   * Get goal history (monthly snapshots) from the database.
   *
   * Goal history is stored in the subcollection:
   * /users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}
   *
   * Each document represents a monthly snapshot with:
   * - current_amount: Amount saved as of that month
   * - daily_data: Nested object with daily snapshots
   * - contributions: Array of deposits/withdrawals (if available)
   *
   * @param goalId - Optional goal ID to filter history for a specific goal
   * @param options - Filter options
   * @param options.startMonth - Filter by month >= this (YYYY-MM)
   * @param options.endMonth - Filter by month <= this (YYYY-MM)
   * @param options.limit - Maximum number of history entries to return
   * @returns Array of GoalHistory objects, sorted by goal_id and month (newest first)
   */
  async getGoalHistory(
    goalId?: string,
    options: {
      startMonth?: string;
      endMonth?: string;
      limit?: number;
    } = {}
  ): Promise<GoalHistory[]> {
    const { startMonth, endMonth, limit } = options;

    // Load goal history with caching
    const allHistory = await this.loadGoalHistory();
    let result = [...allHistory];

    // Apply goal ID filter
    if (goalId) {
      result = result.filter((h) => h.goal_id === goalId);
    }

    // Apply month range filters
    if (startMonth) {
      result = result.filter((h) => h.month >= startMonth);
    }
    if (endMonth) {
      result = result.filter((h) => h.month <= endMonth);
    }

    // Apply limit if specified
    if (limit && limit > 0) {
      result = result.slice(0, limit);
    }

    return result;
  }

  /**
   * Get user-defined categories from Firestore.
   *
   * These are custom categories created by the user in the Copilot Money app,
   * stored in /users/{user_id}/categories/{category_id}.
   *
   * @returns List of user-defined categories with full metadata
   */
  async getUserCategories(): Promise<Category[]> {
    const userCategories = await this.loadUserCategories();
    return [...userCategories];
  }

  async getTags(): Promise<Tag[]> {
    await this.loadAllCollections();
    return [...(this._tags ?? [])];
  }

  /**
   * Build a map of category ID to category name from user-defined categories.
   *
   * This map can be used for efficient category name lookups.
   * The map is cached after the first call.
   *
   * @returns Map from category_id to category name
   */
  async getCategoryNameMap(): Promise<Map<string, string>> {
    // Return cached map if available
    if (this._categoryNameMap !== null) {
      return this._categoryNameMap;
    }

    const userCategories = await this.loadUserCategories();
    const nameMap = new Map<string, string>();

    for (const category of userCategories) {
      if (category.name) {
        nameMap.set(category.category_id, category.name);
      }
    }

    this._categoryNameMap = nameMap;
    return nameMap;
  }

  /**
   * Build a map of account ID to the name a user would recognize.
   *
   * Sourced from the account documents themselves, preferring a user-set
   * `nickname` over the institution-supplied `name`.
   *
   * This previously read the `users/{uid}/accounts` customization collection
   * (whose reader was since deleted, #666), which Copilot no longer
   * populates — so the map came back EMPTY on every real cache and its one
   * consumer (`get_balance_history`'s `account_name`) silently returned
   * `undefined` for every row. Same root cause as the hidden
   * filter in #624: those customizations moved onto the account records.
   *
   * The map is cached after the first call.
   *
   * @returns Map from account_id to display name
   */
  async getAccountNameMap(): Promise<Map<string, string>> {
    // Return cached map if available
    if (this._accountNameMap !== null) {
      return this._accountNameMap;
    }

    const accounts = await this.loadAccounts();
    const nameMap = new Map<string, string>();

    for (const account of accounts) {
      // `preferredAccountName`, not `nickname ?? name` (#663). The old form
      // had the bug twice over: a CLEARED nickname is `''`, which `??` keeps,
      // and the truthiness guard below then dropped the account from the map
      // entirely — so get_balance_history reported `account_name: undefined`.
      // Not a wrong name; no name at all.
      const displayName = preferredAccountName(account);
      if (displayName) {
        nameMap.set(account.account_id, displayName);
      }
    }

    this._accountNameMap = nameMap;
    return nameMap;
  }

  /**
   * Get all unique categories from transactions.
   *
   * Combines user-defined categories from Firestore with categories
   * referenced in transactions. User-defined categories take precedence
   * for naming.
   *
   * @returns List of unique categories with human-readable names
   */
  async getCategories(): Promise<Category[]> {
    const [transactions, userCategories] = await Promise.all([
      this.loadTransactions(),
      this.loadUserCategories(),
    ]);

    // Build map of user-defined categories
    const userCategoryMap = new Map<string, Category>();
    for (const cat of userCategories) {
      userCategoryMap.set(cat.category_id, cat);
    }

    // Extract unique category IDs from transactions
    const categoryIdsFromTxns = new Set<string>();
    for (const txn of transactions) {
      if (txn.category_id) {
        categoryIdsFromTxns.add(txn.category_id);
      }
    }

    // Build result: prefer user-defined categories, fall back to static mapping
    const uniqueCategories: Category[] = [];
    const seenIds = new Set<string>();

    // First, add all user-defined categories
    for (const cat of userCategories) {
      uniqueCategories.push(cat);
      seenIds.add(cat.category_id);
    }

    // Then add any transaction categories not in user-defined list
    for (const categoryId of categoryIdsFromTxns) {
      if (!seenIds.has(categoryId)) {
        // Fall back to static mapping for standard Plaid categories
        const category: Category = {
          category_id: categoryId,
          name: getCategoryName(categoryId),
        };
        uniqueCategories.push(category);
        seenIds.add(categoryId);
      }
    }

    // Sort by name for easier browsing
    return uniqueCategories.sort((a, b) => {
      const nameA = a.name ?? a.category_id;
      const nameB = b.name ?? b.category_id;
      return nameA.localeCompare(nameB);
    });
  }

  /**
   * Get all transactions (unfiltered) - useful for internal aggregations.
   *
   * @returns All transactions
   */
  async getAllTransactions(): Promise<Transaction[]> {
    const transactions = await this.loadTransactions();
    return [...transactions];
  }

  /**
   * Get database path, or undefined if not found.
   *
   * Re-looks after a retryable discovery failure, like `availability()` and
   * `requireDbPath()`, so every reader of the path sees the same answer and
   * call-site ordering cannot matter. `smoke:cache` read this before
   * `availability()`, and without the re-look here it reported "no cache" for
   * a cache the very next line had found.
   */
  getDbPath(): string | undefined {
    this.rediscoverIfTransient();
    return this.dbPath;
  }

  /**
   * Get investment prices from the database.
   *
   * Investment prices are stored in:
   * /investment_prices/{hash}/daily/{month} - Historical monthly data
   * /investment_prices/{hash}/hf/{date} - High-frequency intraday data
   *
   * @param options - Filter options
   * @param options.tickerSymbol - Filter by ticker symbol (e.g., "AAPL", "BTC-USD")
   * @param options.startDate - Filter by date >= this (YYYY-MM or YYYY-MM-DD)
   * @param options.endDate - Filter by date <= this (YYYY-MM or YYYY-MM-DD)
   * @param options.priceType - Filter by price type ("daily" or "hf")
   * @returns Array of InvestmentPrice objects, sorted by investment_id and date (newest first)
   */
  async getInvestmentPrices(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
      priceType?: PriceType;
    } = {}
  ): Promise<InvestmentPrice[]> {
    const { tickerSymbol, startDate, endDate, priceType } = options;

    // Load investment prices with caching
    const allPrices = await this.loadInvestmentPrices();

    // Join the ticker on from `securities`. Price documents carry no
    // ticker_symbol of their own (#622) — the only identity they have is the
    // security_id recovered from their collection path — so without this join
    // every row is anonymous and the ticker filter below matches nothing.
    const securityMap = await this.getSecurityMap();
    let result = allPrices.map((p) => {
      if (p.ticker_symbol) return p;
      const ticker = securityMap.get(p.security_id)?.ticker_symbol;
      return ticker ? { ...p, ticker_symbol: ticker } : p;
    });

    // Apply ticker symbol filter (case-insensitive)
    if (tickerSymbol) {
      const lower = tickerSymbol.toLowerCase();
      result = result.filter((p) => p.ticker_symbol?.toLowerCase() === lower);
    }

    // Apply period filters. Uses the same predicate as the decoder so the two
    // cannot disagree about what a range means across granularities (#622).
    if (startDate || endDate) {
      result = result.filter((p) => {
        const d = p.date ?? p.month;
        return d !== undefined && periodInRange(d, startDate, endDate);
      });
    }

    // Apply price type filter
    if (priceType) {
      result = result.filter((p) => p.price_type === priceType);
    }

    return result;
  }

  /**
   * Get a map of securities keyed by security_id for fast lookups.
   *
   * @returns Map<security_id, Security>
   */
  async getSecurityMap(): Promise<Map<string, Security>> {
    const securities = await this.loadSecurities();
    const map = new Map<string, Security>();
    for (const s of securities) {
      map.set(s.security_id, s);
    }
    return map;
  }

  /**
   * Get investment splits (one entry per security that has had ≥1 split).
   *
   * Each entry has a sparse `adjustments` map of YYYY-MM-DD → multiplier.
   * Securities with no splits are omitted entirely at decode time.
   *
   * Filters operate at the document level:
   * - `tickerSymbol`: case-insensitive match via the securityMap join.
   * - `startDate` / `endDate`: a doc is included if ≥1 of its `adjustments`
   *   keys falls within the [startDate, endDate] window (inclusive). The
   *   per-(date, multiplier) row-level filter happens at the tool/projection
   *   layer — that's where each tuple is emitted as its own output row.
   *
   * @returns Array of InvestmentSplit objects
   */
  async getInvestmentSplits(
    options: {
      tickerSymbol?: string;
      startDate?: string;
      endDate?: string;
    } = {}
  ): Promise<InvestmentSplit[]> {
    const { tickerSymbol, startDate, endDate } = options;
    const allSplits = await this.loadInvestmentSplits();
    let result = [...allSplits];

    if (tickerSymbol) {
      const securityMap = await this.getSecurityMap();
      const lower = tickerSymbol.toLowerCase();
      const matchingIds = new Set<string>();
      for (const [id, sec] of securityMap) {
        if (sec.ticker_symbol?.toLowerCase() === lower) matchingIds.add(id);
      }
      result = result.filter((s) => matchingIds.has(s.security_id));
    }

    if (startDate || endDate) {
      result = result.filter((s) => {
        for (const date of Object.keys(s.adjustments)) {
          if (startDate && date < startDate) continue;
          if (endDate && date > endDate) continue;
          return true;
        }
        return false;
      });
    }

    return result;
  }

  /**
   * Get holdings history with optional filters.
   *
   * @param options - Filter options
   * @param options.securityId - Filter by security_id
   * @param options.accountId - Filter by account_id
   * @returns Array of HoldingsHistory objects
   */
  async getHoldingsHistory(
    options: {
      securityId?: string;
      accountId?: string;
    } = {}
  ): Promise<HoldingsHistory[]> {
    const { securityId, accountId } = options;
    const allHistory = await this.loadHoldingsHistory();
    let result = [...allHistory];
    if (securityId) {
      result = result.filter((h) => h.security_id === securityId);
    }
    if (accountId) {
      result = result.filter((h) => h.account_id === accountId);
    }
    return result;
  }

  /**
   * Get connected institutions (Plaid items) from the database.
   *
   * Items represent connections to financial institutions via Plaid.
   * Each item can have multiple accounts (e.g., checking + savings at same bank).
   *
   * @param options - Filter options
   * @param options.connectionStatus - Filter by connection status ("active", "error", etc.)
   * @param options.institutionId - Filter by Plaid institution ID
   * @param options.needsUpdate - Filter by needs_update flag
   * @returns Array of Item objects, sorted by institution name
   */
  async getItems(
    options: {
      connectionStatus?: string;
      institutionId?: string;
      needsUpdate?: boolean;
    } = {}
  ): Promise<Item[]> {
    const { connectionStatus, institutionId, needsUpdate } = options;

    // Load items with caching
    const allItems = await this.loadItems();
    let result = [...allItems];

    // Apply connection status filter
    if (connectionStatus) {
      result = result.filter((item) => item.connection_status === connectionStatus);
    }

    // Apply institution ID filter
    if (institutionId) {
      result = result.filter((item) => item.institution_id === institutionId);
    }

    // Apply needs update filter
    if (needsUpdate !== undefined) {
      result = result.filter((item) => item.needs_update === needsUpdate);
    }

    return result;
  }

  /**
   * Get cache information including date range and transaction count.
   * Useful for warning users when queries may be limited by cache size.
   *
   * @returns Cache metadata including date range and count
   */
  async getCacheInfo(): Promise<{
    oldest_transaction_date: string | null;
    newest_transaction_date: string | null;
    transaction_count: number;
    cache_note: string;
    decode_health: DecodeHealth;
  }> {
    const transactions = await this.loadTransactions();
    if (transactions.length === 0) {
      return {
        oldest_transaction_date: null,
        newest_transaction_date: null,
        transaction_count: 0,
        cache_note: 'No transactions in local cache. Open Copilot Money app to sync data.',
        decode_health: this.getDecodeHealth(),
      };
    }

    const dates = transactions.map((t) => t.date).sort();
    const oldestDate = dates[0] ?? null;
    const newestDate = dates[dates.length - 1] ?? null;

    return {
      oldest_transaction_date: oldestDate,
      newest_transaction_date: newestDate,
      transaction_count: transactions.length,
      cache_note:
        `Local cache contains ${transactions.length} transactions from ${oldestDate} to ${newestDate}. ` +
        'This is a subset of your full transaction history. ' +
        'Open Copilot Money app and browse transactions to sync more data.',
      decode_health: this.getDecodeHealth(),
    };
  }

  /**
   * Get balance history (daily account balance snapshots) with optional filters.
   *
   * @param options - Filter options
   * @param options.accountId - Filter by account_id
   * @param options.startDate - Filter by date >= this (YYYY-MM-DD)
   * @param options.endDate - Filter by date <= this (YYYY-MM-DD)
   * @returns Array of BalanceHistory objects
   */
  async getBalanceHistory(
    options: {
      accountId?: string;
      startDate?: string;
      endDate?: string;
    } = {}
  ): Promise<BalanceHistory[]> {
    const { accountId, startDate, endDate } = options;
    const all = await this.loadBalanceHistory();
    let result = [...all];

    if (accountId) {
      result = result.filter((h) => h.account_id === accountId);
    }
    if (startDate) {
      result = result.filter((h) => h.date >= startDate);
    }
    if (endDate) {
      result = result.filter((h) => h.date <= endDate);
    }

    result.sort((a, b) => {
      const acctCmp = a.account_id.localeCompare(b.account_id);
      if (acctCmp !== 0) return acctCmp;
      return b.date.localeCompare(a.date); // date desc
    });

    return result;
  }

  /**
   * Check if a date range query may be limited by cache availability.
   * Returns a warning message if the query extends before the oldest cached transaction.
   *
   * @param startDate - Query start date (YYYY-MM-DD)
   * @param endDate - Query end date (YYYY-MM-DD) - optional
   * @returns Warning message if cache may limit results, null otherwise
   */
  async checkCacheLimitation(startDate?: string, _endDate?: string): Promise<string | null> {
    if (!startDate) return null;

    const cacheInfo = await this.getCacheInfo();
    if (!cacheInfo.oldest_transaction_date) return null;

    // If query starts before oldest cached data, warn the user
    if (startDate < cacheInfo.oldest_transaction_date) {
      return (
        `Note: Your query starts at ${startDate}, but local cache only contains transactions from ` +
        `${cacheInfo.oldest_transaction_date} to ${cacheInfo.newest_transaction_date} (${cacheInfo.transaction_count} total). ` +
        'Earlier transactions may exist in Copilot Money but are not cached locally. ' +
        'Open the Copilot Money app and scroll through older transactions to cache more data.'
      );
    }

    return null;
  }
}
