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

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
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
  private pending = new Map<string, { meta: Meta; uid: string | null }>();
  private warnedLoad = false;
  private warnedAppend = false;
  private warnedSkip = false;

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

  /** Never-throw wrapper around uidProvider: returns null on any exception. */
  private safeUid(): string | null {
    try {
      return this.uidProvider();
    } catch {
      return null;
    }
  }

  /** The uid for which the disk index was last loaded (null = not yet loaded). */
  loadedUid(): string | null {
    return this.loadedForUid;
  }

  /** The current uid as seen by the provider right now (null = not authenticated). */
  currentUid(): string | null {
    return this.safeUid();
  }

  loadOnce(): Map<string, Meta> {
    const out = new Map<string, Meta>();
    if (this.disabled()) return out;
    const uid = this.safeUid();
    if (!uid || this.loadedForUid === uid) return out;
    // Latch before the try: a transient load error should not retry — warn once and degrade for the session.
    this.loadedForUid = uid;
    const file = this.fileFor(uid);
    try {
      if (!existsSync(file)) return out;
      const raw = readFileSync(file, 'utf8');
      let skipped = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { i?: unknown; a?: unknown; t?: unknown };
          if (
            typeof rec.i === 'string' &&
            rec.i.length > 0 &&
            typeof rec.a === 'string' &&
            rec.a.length > 0 &&
            typeof rec.t === 'string' &&
            rec.t.length > 0
          ) {
            out.set(rec.i, { accountId: rec.a, itemId: rec.t });
          } else {
            skipped += 1;
          }
        } catch {
          // torn/corrupt line (crash mid-append) — skip; valid prefix wins.
          skipped += 1;
        }
      }
      if (skipped > 0 && !this.warnedSkip) {
        this.warnedSkip = true;
        console.warn(
          `[copilot-money-mcp] persistent meta index: skipped ${skipped} unparseable line(s) — continuing with the valid remainder.`
        );
      }
      for (const id of out.keys()) this.persisted.add(id);
      // Size valve: duplicates across many sessions can bloat the file far
      // past its logical content; rewrite deduped once, atomically.
      if (statSync(file).size > this.maxBytes) {
        try {
          const tmp = `${file}.${process.pid}.tmp`;
          writeFileSync(tmp, this.serialize(out));
          renameSync(tmp, file);
        } catch (e) {
          if (!this.warnedLoad) {
            this.warnedLoad = true;
            console.warn(
              `[copilot-money-mcp] persistent meta index cap-valve failed (${(e as Error).message}) — file not compacted. File: ${file}`
            );
          }
        }
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
    // Stamp the uid at buffer time so a mid-session re-auth cannot redirect
    // this entry to a different user's file at flush.
    this.pending.set(id, { meta, uid: this.safeUid() });
  }

  flush(): void {
    if (this.disabled() || this.pending.size === 0) return;
    const flushUid = this.safeUid();

    // Group entries by effective uid: use the uid captured at buffer time when
    // available; null-stamped (pre-auth) entries adopt the current flush-time
    // uid. Entries still unresolvable (both stamps null) stay pending.
    const groups = new Map<string, Map<string, Meta>>();
    const stillPending = new Map<string, { meta: Meta; uid: string | null }>();
    for (const [id, entry] of this.pending) {
      const effectiveUid = entry.uid ?? flushUid;
      if (!effectiveUid) {
        stillPending.set(id, entry);
        continue;
      }
      let group = groups.get(effectiveUid);
      if (!group) {
        group = new Map();
        groups.set(effectiveUid, group);
      }
      group.set(id, entry.meta);
    }
    this.pending = stillPending;

    if (groups.size === 0) return;
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch (e) {
      if (!this.warnedAppend) {
        this.warnedAppend = true;
        console.warn(
          `[copilot-money-mcp] persistent meta index append failed (${(e as Error).message}) — continuing in-memory.`
        );
      }
      return;
    }

    for (const [uidKey, batch] of groups) {
      try {
        appendFileSync(this.fileFor(uidKey), this.serialize(batch));
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
  }

  private serialize(entries: Map<string, Meta>): string {
    let s = '';
    for (const [i, m] of entries) {
      s += `${JSON.stringify({ i, a: m.accountId, t: m.itemId })}\n`;
    }
    return s;
  }
}
