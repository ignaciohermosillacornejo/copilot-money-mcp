/**
 * Terse-by-default investment prices (#605, v3).
 *
 * The nested `prices` series is ~98% of this tool's response. Dropping it is
 * only safe because real documents carry their numbers ONLY in that map
 * (#622) — there is no scalar price field — so the terse row derives
 * `latest_price`/`latest_at` instead. A default row that dropped the series
 * without deriving anything would be smaller and useless.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { createCombinedDb } from '../helpers/test-db.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-prices-fields-'));
const DB_PATH = path.join(FIXTURES_DIR, 'db');

const SEC = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f70819a2b3c4d5e6f7081';

// Epoch-millis keys, deliberately NOT in ascending insertion order: the
// "latest" point must come from the key values, not from map ordering.
const SERIES = {
  '1706918400000': 101.5, // 2024-02-03
  '1706745600000': 99.25, // 2024-02-01
  '1707004800000': 104.75, // 2024-02-04  <- latest
  '1706832000000': 100.0, // 2024-02-02
};

let db: CopilotDatabase;
let tools: CopilotMoneyTools;

beforeAll(async () => {
  await createCombinedDb(DB_PATH, {
    investmentPrices: [
      { security_id: SEC, price_type: 'daily', period: '2024-02', prices: SERIES },
    ],
  });
  db = new CopilotDatabase(DB_PATH);
  tools = new CopilotMoneyTools(db);
});

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

describe('get_investment_prices terse default (#605)', () => {
  test('omits the price series by default', async () => {
    const result = await tools.getInvestmentPrices({});

    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]).not.toHaveProperty('prices');
  });

  test('still answers "what is this worth" — derives the latest point', async () => {
    const result = await tools.getInvestmentPrices({});

    const row = result.prices[0]!;
    expect(row.latest_price).toBe(104.75);
    // Taken from the largest epoch key, not the last inserted one.
    expect(row.latest_at).toBe('2024-02-04T00:00:00.000Z');
  });

  test('keeps the identity fields a caller needs to join', async () => {
    const result = await tools.getInvestmentPrices({});

    const row = result.prices[0]!;
    expect(row.security_id).toBe(SEC);
    expect(row.price_type).toBe('daily');
    expect(row.month).toBe('2024-02');
  });

  test('fields: ["default", "prices"] restores the series alongside the terse row', async () => {
    const result = await tools.getInvestmentPrices({ fields: ['default', 'prices'] });

    const row = result.prices[0]!;
    expect(row.prices).toEqual(SERIES);
    expect(row.latest_price).toBe(104.75);
  });

  test('fields: ["all"] returns full rows', async () => {
    const result = await tools.getInvestmentPrices({ fields: ['all'] });

    expect(result.prices[0]!.prices).toEqual(SERIES);
  });

  test('an explicit narrow selection wins over the default preset', async () => {
    const result = await tools.getInvestmentPrices({ fields: ['ticker_symbol', 'latest_price'] });

    expect(Object.keys(result.prices[0]!).sort()).toEqual(['latest_price']);
    // ticker_symbol is a valid name that is simply unset on this row, so it
    // must NOT be reported as unknown.
    expect(result._field_warning).toBeUndefined();
  });

  test('reports a typo without failing the call', async () => {
    const result = await tools.getInvestmentPrices({ fields: ['default', 'latest_pryce'] });

    expect(result._field_warning).toContain('latest_pryce');
    expect(result.prices[0]!.latest_price).toBe(104.75);
  });

  test('the derived names are recognised as valid fields', async () => {
    // Regression guard: if latest_price/latest_at were missing from the known
    // set, asking for them would warn even though they are exactly what the
    // default preset returns.
    const result = await tools.getInvestmentPrices({ fields: ['latest_price', 'latest_at'] });

    expect(result._field_warning).toBeUndefined();
  });

  test('the terse default is dramatically smaller than full rows', async () => {
    const terse = await tools.getInvestmentPrices({});
    const full = await tools.getInvestmentPrices({ fields: ['all'] });

    const terseSize = JSON.stringify(terse).length;
    const fullSize = JSON.stringify(full).length;

    // Pins the point of the change: a fixture with a mere 4-point series
    // already halves. Real months carry ~20 points.
    expect(terseSize).toBeLessThan(fullSize);
    expect(terseSize / fullSize).toBeLessThan(0.8);
  });

  test('a row whose series is absent still returns, without derived fields', async () => {
    // Defensive: getLatestPricePoint returns undefined rather than throwing,
    // so a malformed/empty document degrades to identity-only instead of
    // dropping the row.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-empty-'));
    const emptyPath = path.join(emptyDir, 'db');
    await createCombinedDb(emptyPath, {
      investmentPrices: [{ security_id: SEC, price_type: 'daily', period: '2024-03' }],
    });
    const emptyTools = new CopilotMoneyTools(new CopilotDatabase(emptyPath));

    const result = await emptyTools.getInvestmentPrices({});

    expect(result.prices).toHaveLength(1);
    expect(result.prices[0]!.latest_price).toBeUndefined();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
