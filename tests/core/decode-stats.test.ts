/**
 * Read-side drop visibility (issue #442).
 *
 * A Zod parse failure on a cached document silently drops it from results
 * with only a deduped stderr warning that MCP users never see. These tests
 * verify the drop counters flow from the decoder through CopilotDatabase to
 * the get_cache_info / get_connection_status tool surfaces.
 *
 * Uses a synthetic LevelDB with a deliberately malformed document: the
 * transaction's `date` is a string (so it survives the decoder's defensive
 * field extraction) but does not match the schema's YYYY-MM-DD regex, so it
 * fails Zod validation and is dropped.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { decodeAllCollections } from '../../src/core/decoder.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { __resetWarnedKeys } from '../../src/core/schema-warn.js';
import { createTestDb } from '../helpers/test-db.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/decode-stats-tests');

const VALID_TXN = {
  collection: 'transactions',
  id: 'txn_good',
  fields: {
    transaction_id: 'txn_good',
    amount: 100,
    date: '2024-01-15',
    name: 'Synthetic Coffee',
  },
};

// String date passes the decoder's truthiness check but fails the
// TransactionSchema YYYY-MM-DD regex → validateOrWarn returns null → dropped.
const MALFORMED_TXN = {
  collection: 'transactions',
  id: 'txn_bad',
  fields: {
    transaction_id: 'txn_bad',
    amount: 200,
    date: 'not-a-date',
    name: 'Synthetic Malformed',
  },
};

const ITEM_DOC = {
  collection: 'items',
  id: 'item_1',
  fields: {
    item_id: 'item_1',
    institution_name: 'Synthetic Bank',
  },
};

// Valid transaction carrying one extra field the processor neither consumes
// nor ignores. It passes Zod (so it is NOT dropped) but trips
// warnUnreadFields, giving unread_field_warnings > 0 with zero drops.
const UNREAD_FIELD_TXN = {
  collection: 'transactions',
  id: 'txn_unread',
  fields: {
    transaction_id: 'txn_unread',
    amount: 300,
    date: '2024-01-16',
    name: 'Synthetic Unread Field',
    copilot_future_field: 'value the decoder does not read yet',
  },
};

let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  __resetWarnedKeys();
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

describe('decodeAllCollections decodeStats', () => {
  test('counts a malformed document as dropped and omits it from results', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'malformed-db');
    await createTestDb(dbPath, [VALID_TXN, MALFORMED_TXN]);

    const result = await decodeAllCollections(dbPath);

    expect(result.transactions.map((t) => t.transaction_id)).toEqual(['txn_good']);
    expect(result.decodeStats.transactions).toEqual({
      decoded: 1,
      dropped: 1,
      unread_field_warnings: 0,
    });
  });

  test('reports zero drops for a clean database', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'clean-db');
    await createTestDb(dbPath, [VALID_TXN]);

    const result = await decodeAllCollections(dbPath);

    expect(result.decodeStats.transactions).toEqual({
      decoded: 1,
      dropped: 0,
      unread_field_warnings: 0,
    });
  });
});

describe('decode_health on the tool surface', () => {
  test('get_cache_info reports degraded health with per-collection counts when a document drops', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'tool-malformed-db');
    await createTestDb(dbPath, [VALID_TXN, MALFORMED_TXN, ITEM_DOC]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const info = await tools.getCacheInfo();

    expect(info.transaction_count).toBe(1);
    expect(info.decode_health.status).toBe('degraded');
    // The note explains what a drop means and what to do about it.
    expect(info.decode_health.note).toContain('1 document failed schema validation');
    expect(info.decode_health.note).toContain('missing from results');
    expect(info.decode_health.note).toContain('Copilot app update');
    expect(info.decode_health.note).toContain('issue');
    // Per-collection breakdown only includes flagged collections.
    expect(info.decode_health.collections).toEqual({
      transactions: { decoded: 1, dropped: 1, unread_field_warnings: 0 },
    });
  }, 30_000);

  test('get_connection_status carries the same decode_health summary', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'conn-malformed-db');
    await createTestDb(dbPath, [VALID_TXN, MALFORMED_TXN, ITEM_DOC]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const status = await tools.getConnectionStatus();

    expect(status.summary.total).toBe(1);
    expect(status.decode_health.status).toBe('degraded');
    expect(status.decode_health.collections?.transactions?.dropped).toBe(1);
  }, 30_000);

  test('zero-drop output stays terse: ok status, short note, no per-collection breakdown', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'tool-clean-db');
    await createTestDb(dbPath, [VALID_TXN, ITEM_DOC]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const info = await tools.getCacheInfo();

    expect(info.decode_health.status).toBe('ok');
    expect(info.decode_health.note).toContain('decoded cleanly');
    // Shape check: the terse case has no collections key at all.
    expect(Object.keys(info.decode_health).sort()).toEqual(['note', 'status']);

    const status = await tools.getConnectionStatus();
    expect(status.decode_health.status).toBe('ok');
    expect(status.decode_health.collections).toBeUndefined();
  }, 30_000);

  test('unread-only data reports ok status WITH a per-collection breakdown', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'tool-unread-db');
    await createTestDb(dbPath, [VALID_TXN, UNREAD_FIELD_TXN, ITEM_DOC]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const info = await tools.getCacheInfo();

    // Nothing dropped: both transactions survive.
    expect(info.transaction_count).toBe(2);
    // Status stays 'ok' because there are zero drops...
    expect(info.decode_health.status).toBe('ok');
    // ...but the note and collections field surface the unread field.
    expect(info.decode_health.note).toContain('not yet read by the decoder');
    expect(info.decode_health.note).toContain('No data was dropped');
    // Per-collection breakdown is present (unlike the terse zero-warning case)
    // and includes only the flagged collection with dropped === 0.
    expect(info.decode_health.collections).toEqual({
      transactions: { decoded: 2, dropped: 0, unread_field_warnings: 1 },
    });

    const status = await tools.getConnectionStatus();
    expect(status.decode_health.status).toBe('ok');
    expect(status.decode_health.collections?.transactions?.unread_field_warnings).toBe(1);
    expect(status.decode_health.collections?.transactions?.dropped).toBe(0);
  }, 30_000);

  test('injected (non-decoded) data reports unknown decode health', async () => {
    const db = new CopilotDatabase('/fake/path');
    db._injectDataForTesting({
      transactions: [
        {
          transaction_id: 'txn_mock',
          amount: 100,
          date: '2024-01-15',
        },
      ],
      items: [],
    });

    const tools = new CopilotMoneyTools(db);
    const info = await tools.getCacheInfo();

    expect(info.decode_health.status).toBe('unknown');
    expect(info.decode_health.collections).toBeUndefined();
  });

  test('clearCache resets decode health to unknown until the next decode', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'clear-cache-db');
    await createTestDb(dbPath, [VALID_TXN]);

    const db = new CopilotDatabase(dbPath);
    await db.getCacheInfo();
    expect(db.getDecodeHealth().status).toBe('ok');

    db.clearCache();
    expect(db.getDecodeHealth().status).toBe('unknown');
  }, 30_000);
});
