/**
 * Persistent per-uid record of split parents this server has learned about
 * (#842).
 *
 * delete_transaction refuses a split parent because deleting one makes
 * Copilot credit its amount back to the account a second time (#822). Once
 * all of a parent's children are deleted the parent comes back from the API
 * as an ordinary row with no split marker (ledger:
 * Transaction.parentId:childlessParentReappears), so after a restart nothing
 * on the server side can say it was ever split. This file is what still says
 * so: every parent split_transaction split, and the parent of every child
 * delete_transaction deleted.
 *
 * Same conventions as the routing-id index (TransactionMetaStore, #511) and
 * stored beside it: append-only JSONL keyed by the AUTHENTICATED SESSION's
 * Firebase uid, so a record written under one login is never consulted under
 * another. A split parent stays one for good — there is no unsplit — so
 * entries are never retired and the file needs no rewrite.
 *
 * Failure philosophy: persistence must never fail the caller. A missing,
 * unreadable or torn file degrades to the in-memory record with one warning.
 *
 * Privacy: opaque ids only — no amounts, names, dates, or merchants.
 * Opt-out: COPILOT_DISABLE_PERSISTENT_INDEX=1 (the same switch as the
 * routing-id index).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface SplitParentStoreOptions {
  baseDir: string;
  uidProvider: () => string | null;
}

export class SplitParentStore {
  private readonly baseDir: string;
  private readonly uidProvider: () => string | null;
  /** Ids on disk per uid, read once per uid and kept current by record(). */
  private readonly loaded = new Map<string, Set<string>>();
  private warnedLoad = false;
  private warnedAppend = false;

  constructor(opts: SplitParentStoreOptions) {
    this.baseDir = opts.baseDir;
    this.uidProvider = opts.uidProvider;
  }

  private disabled(): boolean {
    return process.env.COPILOT_DISABLE_PERSISTENT_INDEX === '1';
  }

  private fileFor(uid: string): string {
    // Firebase uids are alphanumeric; this guards a future non-Firebase uid source.
    const safe = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.baseDir, `split-parents.${safe}.jsonl`);
  }

  /** Never-throw wrapper around uidProvider: returns null on any exception. */
  private safeUid(): string | null {
    try {
      return this.uidProvider();
    } catch {
      return null;
    }
  }

  /** The persisted ids for `uid`, read from disk on first use. */
  private idsFor(uid: string): Set<string> {
    let ids = this.loaded.get(uid);
    if (ids) return ids;
    ids = new Set();
    // Latch before reading: a transient load error should not retry — warn
    // once and degrade to the in-memory record for the session.
    this.loaded.set(uid, ids);
    const file = this.fileFor(uid);
    try {
      if (!existsSync(file)) return ids;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { i?: unknown };
          if (typeof rec.i === 'string' && rec.i.length > 0) ids.add(rec.i);
        } catch {
          // torn/corrupt line (crash mid-append) — skip; the rest still counts.
        }
      }
    } catch (e) {
      if (!this.warnedLoad) {
        this.warnedLoad = true;
        console.warn(
          `[copilot-money-mcp] persistent split-parent record unreadable (${(e as Error).message}) — continuing in-memory. File: ${file}`
        );
      }
    }
    return ids;
  }

  /** True when the current login's persisted record names `id`. */
  has(id: string): boolean {
    if (this.disabled()) return false;
    const uid = this.safeUid();
    if (!uid) return false;
    return this.idsFor(uid).has(id);
  }

  /**
   * Persist `id` for the current login, synchronously: the caller records a
   * parent before it sends the delete of its child, so the record must be on
   * disk by then. No-op without a uid (the in-memory record still holds it).
   */
  record(id: string): void {
    if (this.disabled()) return;
    const uid = this.safeUid();
    if (!uid) return;
    const ids = this.idsFor(uid);
    if (ids.has(id)) return;
    try {
      mkdirSync(this.baseDir, { recursive: true });
      appendFileSync(this.fileFor(uid), `${JSON.stringify({ i: id })}\n`);
      ids.add(id);
    } catch (e) {
      if (!this.warnedAppend) {
        this.warnedAppend = true;
        console.warn(
          `[copilot-money-mcp] persistent split-parent record append failed (${(e as Error).message}) — continuing in-memory.`
        );
      }
    }
  }
}
