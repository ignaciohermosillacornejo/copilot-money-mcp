/**
 * Persistent per-uid transaction meta index (#511).
 *
 * The id → (accountId, itemId) mapping is immutable server-side (ledger:
 * Mutation.editTransaction:routing), so persistence is append-only JSONL —
 * never invalidated, no TTL. Identity scoping is load-bearing: the file is
 * keyed by the AUTHENTICATED SESSION's Firebase uid, so an index written
 * under one login can never be consulted under another (the desktop app's
 * cache and the browser session token may belong to different accounts).
 *
 * Failure philosophy: persistence must never fail the caller. Load errors,
 * torn lines, corrupt files, and append failures degrade to in-memory
 * behavior with a single warning.
 *
 * Privacy: opaque ids only — no amounts, names, dates, or merchants.
 * Opt-out: COPILOT_DISABLE_PERSISTENT_INDEX=1.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

type Meta = { accountId: string; itemId: string };

export interface TransactionMetaStoreOptions {
  baseDir: string;
  uidProvider: () => string | null;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export class TransactionMetaStore {
  private readonly baseDir: string;
  private readonly uidProvider: () => string | null;
  private readonly maxBytes: number;
  private loadedForUid: string | null = null;
  /** ids known to be on disk already (loaded or flushed this session). */
  private readonly persisted = new Set<string>();
  private pending = new Map<string, Meta>();
  private warnedLoad = false;
  private warnedAppend = false;

  constructor(opts: TransactionMetaStoreOptions) {
    this.baseDir = opts.baseDir;
    this.uidProvider = opts.uidProvider;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private disabled(): boolean {
    return process.env.COPILOT_DISABLE_PERSISTENT_INDEX === '1';
  }

  private fileFor(uid: string): string {
    return join(this.baseDir, `txn-meta-index.${uid}.jsonl`);
  }

  loadOnce(): Map<string, Meta> {
    const out = new Map<string, Meta>();
    if (this.disabled()) return out;
    const uid = this.uidProvider();
    if (!uid || this.loadedForUid === uid) return out;
    this.loadedForUid = uid;
    const file = this.fileFor(uid);
    try {
      if (!existsSync(file)) return out;
      const raw = readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { i?: unknown; a?: unknown; t?: unknown };
          if (
            typeof rec.i === 'string' && rec.i.length > 0 &&
            typeof rec.a === 'string' && rec.a.length > 0 &&
            typeof rec.t === 'string' && rec.t.length > 0
          ) {
            out.set(rec.i, { accountId: rec.a, itemId: rec.t });
          }
        } catch {
          // torn/corrupt line (crash mid-append) — skip; valid prefix wins.
        }
      }
      for (const id of out.keys()) this.persisted.add(id);
      // Size valve: duplicates across many sessions can bloat the file far
      // past its logical content; rewrite deduped once, atomically.
      if (statSync(file).size > this.maxBytes) {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, this.serialize(out));
        renameSync(tmp, file);
      }
    } catch (e) {
      if (!this.warnedLoad) {
        this.warnedLoad = true;
        console.warn(
          `[copilot-money-mcp] persistent meta index unreadable (${(e as Error).message}) — continuing in-memory. File: ${file}`
        );
      }
      return new Map();
    }
    return out;
  }

  buffer(id: string, meta: Meta): void {
    if (this.disabled()) return;
    if (this.persisted.has(id)) return;
    this.pending.set(id, meta);
  }

  flush(): void {
    if (this.disabled() || this.pending.size === 0) return;
    const uid = this.uidProvider();
    if (!uid) return; // keep buffering until authenticated
    const batch = this.pending;
    this.pending = new Map();
    try {
      mkdirSync(this.baseDir, { recursive: true });
      appendFileSync(this.fileFor(uid), this.serialize(batch));
      for (const id of batch.keys()) this.persisted.add(id);
    } catch (e) {
      if (!this.warnedAppend) {
        this.warnedAppend = true;
        console.warn(
          `[copilot-money-mcp] persistent meta index append failed (${(e as Error).message}) — continuing in-memory.`
        );
      }
      // Do not re-buffer: repeated failures would grow memory; the entries
      // stay served by the in-memory index for this session regardless.
    }
  }

  private serialize(entries: Map<string, Meta>): string {
    let s = '';
    for (const [i, m] of entries) {
      s += `${JSON.stringify({ i, a: m.accountId, t: m.itemId })}\n`;
    }
    return s;
  }
}
