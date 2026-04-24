/**
 * Live-read data layer backed by Copilot's GraphQL API.
 *
 * This class is the planned long-term replacement for CopilotDatabase
 * once every read tool has migrated off LevelDB. Phase 1 implements
 * only getTransactions(); later phases add methods for accounts,
 * categories, budgets, recurring, and tags.
 *
 * The class owns cross-cutting concerns shared by every method:
 *   - short-lived result memoization (default 5 min TTL)
 *   - one retry on NETWORK errors (other GraphQL codes surface)
 *   - optional verbose logging to stderr for latency measurement
 *
 * See docs/superpowers/specs/2026-04-23-graphql-live-reads-design.md.
 */

import { GraphQLError, type GraphQLClient } from './graphql/client.js';
import type { CopilotDatabase } from './database.js';

interface MemoEntry<T> {
  result: T;
  at: number;
}

export interface LiveDatabaseOptions {
  memoTtlMs?: number;
  verbose?: boolean;
}

const DEFAULT_MEMO_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 500;

export class LiveCopilotDatabase {
  private readonly memoTtlMs: number;
  private readonly verbose: boolean;
  private readonly memoStore: Map<string, MemoEntry<unknown>> = new Map();

  constructor(
    private readonly graphql: GraphQLClient,
    private readonly cache: CopilotDatabase,
    opts: LiveDatabaseOptions = {}
  ) {
    this.memoTtlMs = opts.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
    this.verbose = opts.verbose ?? false;
  }

  /**
   * Expose the underlying GraphQL client for functions that take it
   * as an argument (e.g. fetchTransactionsPage).
   */
  getClient(): GraphQLClient {
    return this.graphql;
  }

  /**
   * Expose the cache so tool implementations can use it for
   * account→item and tag-name→tag-id lookups until Phase 2 migrates
   * those reads onto the live layer too.
   */
  getCache(): CopilotDatabase {
    return this.cache;
  }

  async withRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof GraphQLError && err.code === 'NETWORK') {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        return await op();
      }
      throw err;
    }
  }

  async memoize<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.memoStore.get(key);
    if (existing && Date.now() - existing.at < this.memoTtlMs) {
      return existing.result as T;
    }
    const result = await loader();
    this.memoStore.set(key, { result, at: Date.now() });
    return result;
  }

  logReadCall(opName: string, pages: number, latencyMs: number, rows: number): void {
    if (!this.verbose) return;
    console.error(`[graphql-read] op=${opName} pages=${pages} latency=${latencyMs}ms rows=${rows}`);
  }
}
