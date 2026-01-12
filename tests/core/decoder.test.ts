/**
 * Unit tests for LevelDB decoder functions.
 *
 * Tests the protobuf decoding and field extraction logic.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { decodeTransactions, decodeAccounts } from '../../src/core/decoder.js';
import fs from 'node:fs';
import path from 'node:path';

// Cleanup function for test fixtures
function cleanupFixtures() {
  const fixturesDir = path.join(__dirname, '../fixtures');
  if (fs.existsSync(fixturesDir)) {
    fs.rmSync(fixturesDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  cleanupFixtures();
});

describe('Decoder Main Functions', () => {
  describe('decodeTransactions', () => {
    test('throws error for non-existent path', () => {
      expect(() => {
        decodeTransactions('/nonexistent/path/that/does/not/exist');
      }).toThrow('Database path not found');
    });

    test('throws error for file instead of directory', () => {
      const tempFile = path.join(__dirname, '../fixtures/test-file.txt');
      fs.mkdirSync(path.dirname(tempFile), { recursive: true });
      fs.writeFileSync(tempFile, 'test');

      expect(() => {
        decodeTransactions(tempFile);
      }).toThrow('Path is not a directory');
    });

    test('returns empty array for directory without .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/empty-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('skips files without transaction markers', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-txn-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file without transaction data
      const ldbFile = path.join(tempDir, 'test.ldb');
      fs.writeFileSync(ldbFile, Buffer.from('random data here'));

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('returns array for directory with .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/test-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file with minimal transaction markers
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        Buffer.from([0x0a, 0x06, 0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74]), // amount field
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('decodeAccounts', () => {
    test('throws error for non-existent path', () => {
      expect(() => {
        decodeAccounts('/nonexistent/path/that/does/not/exist');
      }).toThrow('Database path not found');
    });

    test('throws error for file instead of directory', () => {
      const tempFile = path.join(__dirname, '../fixtures/test-file2.txt');
      fs.mkdirSync(path.dirname(tempFile), { recursive: true });
      fs.writeFileSync(tempFile, 'test');

      expect(() => {
        decodeAccounts(tempFile);
      }).toThrow('Path is not a directory');
    });

    test('returns empty array for directory without .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/empty-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const result = decodeAccounts(tempDir);
      expect(result).toEqual([]);
    });

    test('skips files without account markers', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      fs.writeFileSync(ldbFile, Buffer.from('random data'));

      const result = decodeAccounts(tempDir);
      expect(result).toEqual([]);
    });

    test('returns array for directory with account markers', () => {
      const tempDir = path.join(__dirname, '../fixtures/acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      fs.writeFileSync(ldbFile, Buffer.from('/accounts/'));

      const result = decodeAccounts(tempDir);
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
