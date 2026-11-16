/**
 * End-to-end regression for issue #902 — a `null` price on one holding used to
 * take the whole account with it.
 *
 * Reported shape: an MX-linked 401k whose account document carries a holding
 * with `institution_price: null`. Holdings are copied verbatim into the
 * account by the decoder, Zod rejected the null ("expected number, received
 * null"), `validateOrWarn` returned null, and the account vanished from
 * `get_accounts` — and its balance from `total_balance` / `total_assets`.
 *
 * Goes through the real decoder and tool layer, because the user-visible
 * failure was a missing account and an understated total, not a parse result.
 * The schema-by-schema class sweep is `tests/core/nested-field-sweep.test.ts`.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import { decodeAllCollections } from '../../src/core/decoder.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { __resetWarnedKeys } from '../../src/core/schema-warn.js';
import { createDeepTestDb } from '../helpers/test-db.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/nested-repair-tests');

const ITEM = 'itm_7Hq2LmZpXc4RvT1';
const CHECKING = 'acc_c4d5e6f7a8b9c0d1';
const RETIREMENT = 'acc_d5e6f7a8b9c0d1e2';

const RETIREMENT_ACCOUNT = {
  collection: `items/${ITEM}/accounts`,
  id: RETIREMENT,
  fields: {
    account_id: RETIREMENT,
    name: 'Synthetic 401k',
    account_type: 'investment',
    current_balance: 4000,
    holdings: [
      {
        security_id: 'sec_e6f7a8b9c0d1e2f3',
        institution_price: 20,
        institution_value: 2000,
        quantity: 100,
      },
      {
        // The reported shape: the provider sent no price for this fund.
        security_id: 'sec_f7a8b9c0d1e2f3a4',
        institution_price: null,
        institution_value: 2000,
        quantity: 50,
      },
    ],
  },
};

const CHECKING_ACCOUNT = {
  collection: `items/${ITEM}/accounts`,
  id: CHECKING,
  fields: {
    account_id: CHECKING,
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

describe('a null nested holding price in the cache (#902)', () => {
  test('keeps the account and drops only the null price', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'decode-db');
    await createDeepTestDb(dbPath, [CHECKING_ACCOUNT, RETIREMENT_ACCOUNT]);

    const result = await decodeAllCollections(dbPath);

    // The regression: this list used to contain only the checking account.
    expect(result.accounts.map((a) => a.account_id).sort()).toEqual([CHECKING, RETIREMENT].sort());
    const repaired = result.accounts.find((a) => a.account_id === RETIREMENT);
    expect(repaired?.current_balance).toBe(4000);
    expect(repaired?.holdings?.[0]).toMatchObject({ institution_price: 20 });
    expect(repaired?.holdings?.[1]).toMatchObject({ quantity: 50 });
    expect(repaired?.holdings?.[1]).not.toHaveProperty('institution_price');

    expect(result.decodeStats.accounts).toEqual({
      decoded: 2,
      dropped: 0,
      repaired: 1,
      unread_field_warnings: 0,
    });
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('invalid nested field'))).toBe(true);
    expect(messages.some((m) => m.includes('schema drop'))).toBe(false);
  }, 30_000);

  test('get_accounts lists the account and counts its balance', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'accounts-db');
    await createDeepTestDb(dbPath, [CHECKING_ACCOUNT, RETIREMENT_ACCOUNT]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const result = await tools.getAccounts({});

    expect(result.count).toBe(2);
    expect(result.total_assets).toBe(5000);
    expect(result.total_balance).toBe(5000);
  }, 30_000);

  test('get_cache_info reports the repair as partial loss, not degraded', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'health-db');
    await createDeepTestDb(dbPath, [CHECKING_ACCOUNT, RETIREMENT_ACCOUNT]);

    const tools = new CopilotMoneyTools(new CopilotDatabase(dbPath));
    const info = await tools.getCacheInfo();

    expect(info.decode_health.status).toBe('ok');
    expect(info.decode_health.note).toContain('1 document');
    expect(info.decode_health.note).toContain('invalid nested field');
    expect(info.decode_health.collections?.accounts?.repaired).toBe(1);
    expect(info.decode_health.collections?.accounts?.dropped).toBe(0);
  }, 30_000);
});
