/**
 * Regression tests for issue #622 — investment_prices is a NESTED collection.
 *
 * Copilot stores prices as one subcollection per security:
 *
 *     investment_prices/{securityHash}/daily/{YYYY-MM}
 *     investment_prices/{securityHash}/hf/{YYYY-MM-DD}
 *
 * The security identity exists ONLY in the middle path segment. Real documents
 * carry no `investment_id` and no `ticker_symbol` field, and the per-period
 * prices live in a nested `prices` map keyed by epoch-millis.
 *
 * The fixtures these decoders were originally written against modelled a FLAT
 * `investment_prices` collection with `investment_id`/`ticker_symbol` present as
 * document fields — a shape Copilot does not produce — so every assertion passed
 * while every real read was wrong. These tests encode the real shape.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { decodeInvestmentPrices } from '../../src/core/decoder.js';
import { createTestDatabase } from '../../src/core/leveldb-reader.js';

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-prices-nested-'));

afterAll(() => {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
});

// Synthetic, opaque, Firestore-shaped security ids (real ones are SHA-256 hex).
const SEC_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f70819a2b3c4d5e6f7081';
const SEC_B = 'f0e1d2c3b4a59687756433221100ffeeddccbbaa99887766554433221100abcd';

/** Build a database in the real nested layout. */
async function createNestedPriceDb(
  dbPath: string,
  docs: Array<{
    securityId: string;
    subcollection: 'daily' | 'hf';
    docId: string;
    prices: Record<string, number>;
  }>
): Promise<void> {
  await createTestDatabase(
    dbPath,
    docs.map((d) => ({
      collection: `investment_prices/${d.securityId}/${d.subcollection}`,
      id: d.docId,
      // Real docs carry ONLY the nested prices map — no investment_id,
      // no ticker_symbol, no date/month scalar.
      fields: { prices: d.prices },
    }))
  );
}

describe('decodeInvestmentPrices — real nested layout (#622)', () => {
  test('finds documents at all (the collection filter must match the subcollection)', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'finds-docs');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    expect(prices.length).toBe(1);
  });

  test('recovers the security id from the collection path', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'security-id');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    expect(prices[0]?.security_id).toBe(SEC_A);
  });

  test('does NOT collapse two securities that share a period', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'no-collapse');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
      {
        securityId: SEC_B,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 200 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    // The old dedup key was `${investment_id}-${date||month||'unknown'}`, which
    // for real docs evaluated to "2025-06-unknown" for BOTH securities and
    // silently dropped one of them.
    expect(prices.length).toBe(2);
    expect(new Set(prices.map((p) => p.security_id))).toEqual(new Set([SEC_A, SEC_B]));
  });

  test('classifies /daily/ documents as daily, not hf', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'daily-type');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    // Previously derived from `key.includes('/daily/')` against the RAW binary
    // LevelDB key, where the literal never appears — so every row fell through
    // to 'hf'.
    expect(prices[0]?.price_type).toBe('daily');
  });

  test('classifies /hf/ documents as hf', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'hf-type');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'hf',
        docId: '2025-06-02',
        prices: { '1748836800000': 100 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    expect(prices[0]?.price_type).toBe('hf');
  });

  test('derives the period from the document id', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'period');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
      {
        securityId: SEC_B,
        subcollection: 'hf',
        docId: '2025-06-02',
        prices: { '1748836800000': 200 },
      },
    ]);

    const prices = await decodeInvestmentPrices(dbPath);

    const daily = prices.find((p) => p.price_type === 'daily');
    const hf = prices.find((p) => p.price_type === 'hf');
    expect(daily?.month).toBe('2025-06');
    expect(hf?.date).toBe('2025-06-02');
  });

  test('price_type filter selects the right subcollection', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'type-filter');
    await createNestedPriceDb(dbPath, [
      {
        securityId: SEC_A,
        subcollection: 'daily',
        docId: '2025-06',
        prices: { '1748836800000': 100 },
      },
      {
        securityId: SEC_A,
        subcollection: 'hf',
        docId: '2025-06-02',
        prices: { '1748836800000': 200 },
      },
    ]);

    const daily = await decodeInvestmentPrices(dbPath, { priceType: 'daily' });
    const hf = await decodeInvestmentPrices(dbPath, { priceType: 'hf' });

    expect(daily.length).toBe(1);
    expect(daily[0]?.price_type).toBe('daily');
    expect(hf.length).toBe(1);
    expect(hf[0]?.price_type).toBe('hf');
  });

  // Periods come in two granularities, and callers may bound with either.
  // Raw string comparison gets month-vs-day pairs wrong in BOTH directions, so
  // both bounds are compared at the coarser granularity.
  describe('period filtering across granularities', () => {
    async function rangeDb(dbPath: string) {
      await createNestedPriceDb(dbPath, [
        { securityId: SEC_A, subcollection: 'daily', docId: '2025-05', prices: { '1': 1 } },
        { securityId: SEC_A, subcollection: 'daily', docId: '2025-06', prices: { '1': 1 } },
        { securityId: SEC_A, subcollection: 'daily', docId: '2025-07', prices: { '1': 1 } },
        { securityId: SEC_B, subcollection: 'hf', docId: '2025-06-14', prices: { '1': 1 } },
        { securityId: SEC_B, subcollection: 'hf', docId: '2025-07-02', prices: { '1': 1 } },
      ]);
    }

    test('a day-granularity startDate still admits that month’s daily document', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'range-start');
      await rangeDb(dbPath);

      const prices = await decodeInvestmentPrices(dbPath, { startDate: '2025-06-01' });

      // '2025-06' < '2025-06-01' as raw strings, so the June daily document
      // would be wrongly dropped by a naive comparison.
      expect(prices.map((p) => p.month ?? p.date).sort()).toEqual([
        '2025-06',
        '2025-06-14',
        '2025-07',
        '2025-07-02',
      ]);
    });

    test('a month-granularity endDate still admits that month’s hf documents', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'range-end');
      await rangeDb(dbPath);

      const prices = await decodeInvestmentPrices(dbPath, { endDate: '2025-06' });

      // '2025-06-14' > '2025-06' as raw strings, so the mid-June hf document
      // would be wrongly dropped by a naive comparison.
      expect(prices.map((p) => p.month ?? p.date).sort()).toEqual([
        '2025-05',
        '2025-06',
        '2025-06-14',
      ]);
    });

    test('excludes periods genuinely outside the range', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'range-both');
      await rangeDb(dbPath);

      const prices = await decodeInvestmentPrices(dbPath, {
        startDate: '2025-06',
        endDate: '2025-06',
      });

      expect(prices.map((p) => p.month ?? p.date).sort()).toEqual(['2025-06', '2025-06-14']);
    });
  });

  test('keeps every document across many securities and periods', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'no-loss');
    const docs = [];
    for (const sec of [SEC_A, SEC_B]) {
      for (const month of ['2025-04', '2025-05', '2025-06']) {
        docs.push({
          securityId: sec,
          subcollection: 'daily' as const,
          docId: month,
          prices: { '1748836800000': 100 },
        });
      }
    }
    await createNestedPriceDb(dbPath, docs);

    const prices = await decodeInvestmentPrices(dbPath);

    // 2 securities x 3 months = 6 documents in, 6 rows out. The pre-fix decoder
    // returned 3 (one per month, securities collapsed).
    expect(prices.length).toBe(6);
  });
});
