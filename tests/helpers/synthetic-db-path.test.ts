/**
 * Contract for `SYNTHETIC_DB_PATH`, the one path every test uses to keep a
 * `CopilotDatabase`/`CopilotMoneyServer` from discovering the real container.
 *
 * `tests/no-ambient-database-discovery.test.ts` recognises only LITERAL falsy
 * first arguments; an imported constant is outside its view. With the path
 * shared, one edit here (to `''`, say) would send every importer down the
 * discovery branch at once and leave that gate green. So the properties the
 * gate relies on are pinned at the source.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SYNTHETIC_DB_PATH } from './synthetic-db-path.js';

describe('SYNTHETIC_DB_PATH', () => {
  test('is a non-empty string, so the constructor takes the explicit-path branch', () => {
    expect(typeof SYNTHETIC_DB_PATH).toBe('string');
    expect(SYNTHETIC_DB_PATH.length).toBeGreaterThan(0);
  });

  test('is absolute and under /nonexistent, so a stray read finds absence, not data', () => {
    expect(isAbsolute(SYNTHETIC_DB_PATH)).toBe(true);
    expect(SYNTHETIC_DB_PATH.startsWith('/nonexistent/')).toBe(true);
    expect(existsSync(SYNTHETIC_DB_PATH)).toBe(false);
  });
});
