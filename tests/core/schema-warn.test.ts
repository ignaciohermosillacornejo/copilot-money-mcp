/**
 * Unit tests for validateOrWarn — the shared helper that replaces silent
 * `safeParse → return null` patterns in the decoder. On parse failure it
 * returns null (preserving caller contract) but emits a structured
 * `console.warn` to stderr so silent schema drops become auditable.
 *
 * Dedupe is per-process, keyed by (collection, first-issue path, issue code),
 * to prevent log flood when Copilot ships a new field shape affecting every
 * doc in a collection.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { z } from 'zod';
import { validateOrWarn, __resetWarnedKeys } from '../../src/core/schema-warn.js';

const Schema = z.object({
  id: z.string(),
  amount: z.number(),
});

describe('validateOrWarn', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    __resetWarnedKeys();
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('returns parsed data on success', () => {
    const result = validateOrWarn(
      Schema,
      { id: 'x', amount: 1 },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );

    expect(result).toEqual({ id: 'x', amount: 1 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('returns null and warns on failure', () => {
    const result = validateOrWarn(
      Schema,
      { id: 'x', amount: 'not-a-number' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('copilot-money-mcp');
    expect(message).toContain('schema drop');
    expect(message).toContain('collection=accounts');
    expect(message).toContain('docId=doc1');
    expect(message).toContain('path=amount');
  });

  test('dedupes identical failures (same collection + path + code)', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 'y', amount: 'also-bad' },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('different failure paths emit separate warns', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 42, amount: 1 },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('different collections emit separate warns for the same path', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'transactions',
        docId: 'doc2',
      }
    );

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  test('__resetWarnedKeys clears state between runs', () => {
    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc1',
      }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);

    __resetWarnedKeys();

    validateOrWarn(
      Schema,
      { id: 'x', amount: 'bad' },
      {
        collection: 'accounts',
        docId: 'doc2',
      }
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
