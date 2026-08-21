/**
 * End-to-end regression for issue #659 — a non-finite price in the cache used
 * to take the whole document with it.
 *
 * Reported shape: a brokerage account with one holding priced `Infinity`
 * (quantity 0 upstream, so `value / quantity` overflowed before Copilot ever
 * wrote it) plus 18 months of `holdings_history` carrying the same value. Zod
 * v4 rejects non-finite numbers from `z.number()` — with the confusing message
 * "expected number, received number" — so `validateOrWarn` returned null and
 * the account disappeared from `get_accounts` entirely.
 *
 * These tests go through the real decoder rather than the schema in isolation,
 * because the interesting part is which DOCUMENTS survive, not which values do.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { decodeAllCollections } from '../../src/core/decoder.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { __resetWarnedKeys } from '../../src/core/schema-warn.js';
import { createDeepTestDb } from '../helpers/test-db.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/non-finite-tests');

const ITEM = 'itm_9qyEMnfMXknwvx9';
const GOOD_ACCOUNT = 'acc_a1b2c3d4e5f6a7b8';
const BAD_ACCOUNT = 'acc_b2c3d4e5f6a7b8c9';
const SECURITY_HASH = 'hh_c3d4e5f6a7b8c9d0';

/** A holding whose price overflowed to Infinity, alongside a healthy one. */
const ACCOUNT_WITH_NON_FINITE_HOLDING = {
  collection: `items/${ITEM}/accounts`,
  id: BAD_ACCOUNT,
  fields: {
    account_id: BAD_ACCOUNT,
    name: 'Synthetic Brokerage',
    account_type: 'investment',
    current_balance: 5000,
    holdings: [
      {
        security_id: 'sec_d4e5f6a7b8c9d0e1',
        institution_price: 25,
        institution_value: 250,
        quantity: 10,
      },
      {
        security_id: 'sec_e5f6a7b8c9d0e1f2',
        institution_price: Infinity,
        institution_value: 0,
        quantity: 0,
      },
    ],
  },
};

const CLEAN_ACCOUNT = {
  collection: `items/${ITEM}/accounts`,
  id: GOOD_ACCOUNT,
  fields: {
    account_id: GOOD_ACCOUNT,
    name: 'Synthetic Checking',
    account_type: 'depository',
    current_balance: 1000,
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

describe('non-finite values in the cache (#659)', () => {
  test('keeps the account, drops only the unusable price', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'accounts-db');
    await createDeepTestDb(dbPath, [CLEAN_ACCOUNT, ACCOUNT_WITH_NON_FINITE_HOLDING]);

    const result = await decodeAllCollections(dbPath);

    // The regression: this list used to contain only the clean account.
    expect(result.accounts.map((a) => a.account_id).sort()).toEqual(
      [GOOD_ACCOUNT, BAD_ACCOUNT].sort()
    );

    const repaired = result.accounts.find((a) => a.account_id === BAD_ACCOUNT);
    // Balance and the healthy holding survive intact...
    expect(repaired?.current_balance).toBe(5000);
    expect(repaired?.holdings?.[0]).toMatchObject({ institution_price: 25 });
    // ...and only the non-finite leaf is gone.
    expect(repaired?.holdings?.[1]).toMatchObject({ quantity: 0 });
    expect(repaired?.holdings?.[1]).not.toHaveProperty('institution_price');

    expect(result.decodeStats.accounts).toEqual({
      decoded: 2,
      dropped: 0,
      repaired: 1,
      unread_field_warnings: 0,
    });
  }, 30_000);

  test('keeps holdings_history months that carry a non-finite price', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'history-db');
    const historyCollection = `items/${ITEM}/accounts/${BAD_ACCOUNT}/holdings_history/${SECURITY_HASH}/history`;
    await createDeepTestDb(dbPath, [
      {
        collection: historyCollection,
        id: '2026-07',
        fields: { history: { '1785124800000': { price: 150.5, quantity: 10 } } },
      },
      {
        collection: historyCollection,
        id: '2026-08',
        fields: {
          history: {
            '1787025600000': { price: Infinity, quantity: 0 },
            '1787112000000': { price: 152, quantity: 10 },
          },
        },
      },
    ]);

    const result = await decodeAllCollections(dbPath);

    expect(result.holdingsHistory.map((h) => h.month).sort()).toEqual(['2026-07', '2026-08']);

    const august = result.holdingsHistory.find((h) => h.month === '2026-08');
    // The snapshot whose price overflowed keeps its quantity; the sibling
    // snapshot in the same month is untouched.
    expect(august?.history?.['1787025600000']).toEqual({ quantity: 0 });
    expect(august?.history?.['1787112000000']).toEqual({ price: 152, quantity: 10 });

    expect(result.decodeStats.holdings_history?.repaired).toBe(1);
    expect(result.decodeStats.holdings_history?.dropped).toBe(0);
  }, 30_000);

  test('get_cache_info reports the repair instead of staying silent', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'health-db');
    await createDeepTestDb(dbPath, [
      CLEAN_ACCOUNT,
      ACCOUNT_WITH_NON_FINITE_HOLDING,
      {
        collection: 'transactions',
        id: 'txn_f6a7b8c9d0e1f2a3',
        fields: {
          transaction_id: 'txn_f6a7b8c9d0e1f2a3',
          amount: 100,
          date: '2026-08-15',
          name: 'Synthetic Coffee',
        },
      },
    ]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const info = await tools.getCacheInfo();

    // Nothing is missing, so health is not 'degraded' — but the partial loss
    // is still stated rather than swallowed.
    expect(info.decode_health.status).toBe('ok');
    expect(info.decode_health.note).toContain('non-finite');
    expect(info.decode_health.note).toContain('1 document');
    expect(info.decode_health.collections?.accounts?.repaired).toBe(1);
    expect(info.decode_health.collections?.accounts?.dropped).toBe(0);
  }, 30_000);

  test('get_holdings skips the unpriced lot and still returns the rest', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'holdings-db');
    await createDeepTestDb(dbPath, [ACCOUNT_WITH_NON_FINITE_HOLDING]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const result = await tools.getHoldings({});

    // Without a price the lot cannot be valued, so it is omitted — but the
    // account's other holdings are no longer collateral damage.
    expect(result.holdings.map((h) => h.security_id)).toEqual(['sec_d4e5f6a7b8c9d0e1']);
  }, 30_000);
});
