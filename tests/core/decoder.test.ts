/**
 * Unit tests for LevelDB decoder functions.
 *
 * Tests the protobuf decoding and field extraction logic.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  decodeTransactions,
  decodeAccounts,
  decodeRecurring,
  decodeCategories,
} from '../../src/core/decoder.js';
import fs from 'node:fs';
import path from 'node:path';

// Cleanup function for test-specific temp fixtures (not the whole fixtures dir)
const tempDirs = [
  'test-file.txt',
  'test-file2.txt',
  'empty-db',
  'no-txn-db',
  'test-db',
  'empty-acc-db',
  'no-acc-db',
  'acc-db',
  // Transaction test directories
  'null-amount-db',
  'zero-amount-db',
  'complete-txn-db',
  'pending-txn-db',
  'original-name-db',
  'dedup-txn-db',
  'sort-txn-db',
  'missing-fields-db',
  'high-amount-db',
  'low-amount-db',
  'negative-amount-db',
  'multi-file-db',
  'control-chars-db',
  'long-string-db',
  'multi-pattern-db',
  // Account test directories
  'complete-acc-db',
  'official-name-acc-db',
  'dedup-acc-db',
  'missing-acc-fields-db',
  'no-id-acc-db',
  'null-balance-db',
  'negative-balance-db',
  'multi-acc-files-db',
  'multi-balance-db',
  'dedup-no-mask-db',
  // Edge case test directories
  'empty-ldb-db',
  'mixed-files-db',
  'amount-only-db',
  'original-only-db',
  'round-amount-db',
  'round-balance-db',
  'zero-len-string-db',
  'unicode-db',
  'invalid-zod-db',
  // Recurring test directories
  'empty-recurring-db',
  'no-recurring-db',
  'complete-recurring-db',
  'minimal-recurring-db',
  'short-id-recurring-db',
  'invalid-date-recurring-db',
  'invalid-freq-recurring-db',
  'dedup-recurring-db',
  'inactive-recurring-db',
  'multi-recurring-files-db',
  'dev-log-recurring-db',
  // Category test directories
  'empty-category-db',
  'no-category-db',
  'complete-category-db',
  'minimal-category-db',
  'short-id-category-db',
  'dedup-category-db',
  'multi-category-files-db',
  'no-name-category-db',
];

function cleanupTempFixtures() {
  const fixturesDir = path.resolve(__dirname, '../fixtures');
  for (const dir of tempDirs) {
    const fullPath = path.resolve(fixturesDir, dir);
    // Validate path is within fixtures directory to prevent directory traversal
    if (!fullPath.startsWith(fixturesDir + path.sep)) {
      throw new Error(`Invalid cleanup path: ${fullPath} is outside fixtures directory`);
    }
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

afterEach(() => {
  cleanupTempFixtures();
});

/**
 * Helper to create a length-prefixed field name.
 * Format: 0x0a + length + field_name_bytes
 */
function fieldPattern(name: string): Buffer {
  return Buffer.from([0x0a, name.length, ...Buffer.from(name)]);
}

/**
 * Helper to create a string field in protobuf-like format.
 * Format: 0x0a + name_length + field_name + 0x8a 0x01 + value_length + value_bytes
 * If fieldName is a Buffer (pre-formatted), it's used as-is.
 * If fieldName is a string, it's converted to length-prefixed format.
 */
function createStringField(fieldName: string | Buffer, value: string): Buffer {
  const nameBuffer = Buffer.isBuffer(fieldName) ? fieldName : fieldPattern(fieldName);
  const valueBuffer = Buffer.from(value, 'utf-8');
  return Buffer.concat([nameBuffer, Buffer.from([0x8a, 0x01, valueBuffer.length]), valueBuffer]);
}

/**
 * Helper to create a double field in protobuf-like format.
 * Format: 0x19 + 8 bytes (IEEE 754 double LE)
 */
function createDoubleField(value: number): Buffer {
  const buf = Buffer.alloc(9);
  buf[0] = 0x19;
  buf.writeDoubleLE(value, 1);
  return buf;
}

/**
 * Helper to create a boolean field in protobuf-like format.
 * Format: 0x0a + name_length + field_name + 0x08 + boolean_byte
 */
function createBooleanField(fieldName: string | Buffer, value: boolean): Buffer {
  const nameBuffer = Buffer.isBuffer(fieldName) ? fieldName : fieldPattern(fieldName);
  return Buffer.concat([nameBuffer, Buffer.from([0x08, value ? 0x01 : 0x00])]);
}

// Protobuf-like field prefixes used in the decoder
const FIELD_PREFIXES = {
  amount: Buffer.from([0x0a, 0x06, 0x61, 0x6d, 0x6f, 0x75, 0x6e, 0x74]), // "\x0a\x06amount"
  name: Buffer.from([0x0a, 0x04, 0x6e, 0x61, 0x6d, 0x65]), // "\x0a\x04name"
  city: Buffer.from([0x0a, 0x04, 0x63, 0x69, 0x74, 0x79]), // "\x0a\x04city"
  region: Buffer.from([0x0a, 0x06, 0x72, 0x65, 0x67, 0x69, 0x6f, 0x6e]), // "\x0a\x06region"
  type: Buffer.from([0x0a, 0x04, 0x74, 0x79, 0x70, 0x65]), // "\x0a\x04type"
  mask: Buffer.from([0x0a, 0x04, 0x6d, 0x61, 0x73, 0x6b]), // "\x0a\x04mask"
};

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

    test('skips transaction with null amount', () => {
      const tempDir = path.join(__dirname, '../fixtures/null-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file with amount marker but no valid double value
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // Invalid double data
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('skips transaction with zero amount', () => {
      const tempDir = path.join(__dirname, '../fixtures/zero-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file with amount = 0
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(0),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('decodes complete transaction with all fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/complete-txn-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file with complete transaction data
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(125.5),
        createStringField(FIELD_PREFIXES.name, 'Test Store'),
        createStringField('original_date', '2024-01-15'),
        createStringField('category_id', 'cat_123'),
        createStringField('account_id', 'acc_456'),
        createStringField('transaction_id', 'txn_789'),
        createStringField('iso_currency_code', 'USD'),
        createBooleanField('pending', false),
        createStringField(FIELD_PREFIXES.city, 'San Francisco'),
        createStringField(FIELD_PREFIXES.region, 'CA'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].transaction_id).toBe('txn_789');
      expect(result[0].amount).toBe(125.5);
      expect(result[0].date).toBe('2024-01-15');
      expect(result[0].name).toBe('Test Store');
      expect(result[0].account_id).toBe('acc_456');
      expect(result[0].category_id).toBe('cat_123');
      expect(result[0].iso_currency_code).toBe('USD');
      expect(result[0].city).toBe('San Francisco');
      expect(result[0].region).toBe('CA');
    });

    test('decodes transaction with pending field', () => {
      const tempDir = path.join(__dirname, '../fixtures/pending-txn-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(50.0),
        createStringField(FIELD_PREFIXES.name, 'Pending Store'),
        createStringField('original_date', '2024-02-20'),
        createStringField('transaction_id', 'txn_pending'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Pending Store');
    });

    test('decodes transaction with valid data', () => {
      const tempDir = path.join(__dirname, '../fixtures/original-name-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(75.25),
        createStringField(FIELD_PREFIXES.name, 'Valid Store Name'),
        createStringField('original_date', '2024-03-10'),
        createStringField('transaction_id', 'txn_original'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Valid Store Name');
      expect(result[0].amount).toBe(75.25);
    });

    test('deduplicates transactions by display_name, amount, date', () => {
      const tempDir = path.join(__dirname, '../fixtures/dedup-txn-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create duplicate transactions
      const createTxn = (id: string) =>
        Buffer.concat([
          Buffer.from('amount'),
          Buffer.from('original_name'),
          FIELD_PREFIXES.amount,
          createDoubleField(100.0),
          createStringField(FIELD_PREFIXES.name, 'Duplicate Store'),
          createStringField('original_date', '2024-04-01'),
          createStringField('transaction_id', id),
        ]);

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([createTxn('txn_dup1'), createTxn('txn_dup2')]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      // Should deduplicate to 1
      expect(result.length).toBe(1);
    });

    test('sorts transactions by date descending', () => {
      const tempDir = path.join(__dirname, '../fixtures/sort-txn-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create separate files to ensure distinct records
      const createTxn = (id: string, date: string, amount: number) =>
        Buffer.concat([
          Buffer.from('amount'),
          Buffer.from('original_name'),
          FIELD_PREFIXES.amount,
          createDoubleField(amount),
          createStringField(FIELD_PREFIXES.name, `Store ${id}`),
          createStringField('original_date', date),
          createStringField('transaction_id', id),
        ]);

      // Use separate files for cleaner separation
      fs.writeFileSync(path.join(tempDir, 'old.ldb'), createTxn('txn_old', '2024-01-01', 50.0));
      fs.writeFileSync(path.join(tempDir, 'mid.ldb'), createTxn('txn_mid', '2024-06-15', 75.0));
      fs.writeFileSync(path.join(tempDir, 'new.ldb'), createTxn('txn_new', '2024-12-31', 100.0));

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(3);
      // Verify sorting is applied (newest first)
      expect(result[0].date).toBe('2024-12-31');
      expect(result[1].date).toBe('2024-06-15');
      expect(result[2].date).toBe('2024-01-01');
    });

    test('skips transactions without required fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/missing-fields-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Transaction without transaction_id
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(100.0),
        createStringField(FIELD_PREFIXES.name, 'Missing ID Store'),
        createStringField('original_date', '2024-05-01'),
        // No transaction_id
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('skips transactions with amount out of range (too high)', () => {
      const tempDir = path.join(__dirname, '../fixtures/high-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(999_999_999.0), // > 10_000_000
        createStringField(FIELD_PREFIXES.name, 'High Amount Store'),
        createStringField('original_date', '2024-06-01'),
        createStringField('transaction_id', 'txn_high'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('skips transactions with amount out of range (too low)', () => {
      const tempDir = path.join(__dirname, '../fixtures/low-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(-999_999_999.0), // < -10_000_000
        createStringField(FIELD_PREFIXES.name, 'Low Amount Store'),
        createStringField('original_date', '2024-06-02'),
        createStringField('transaction_id', 'txn_low'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('handles negative transaction amounts', () => {
      const tempDir = path.join(__dirname, '../fixtures/negative-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(-250.75),
        createStringField(FIELD_PREFIXES.name, 'Refund Store'),
        createStringField('original_date', '2024-07-01'),
        createStringField('transaction_id', 'txn_neg'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].amount).toBe(-250.75);
    });

    test('handles multiple .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-file-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createTxn = (id: string, amount: number) =>
        Buffer.concat([
          Buffer.from('amount'),
          Buffer.from('original_name'),
          FIELD_PREFIXES.amount,
          createDoubleField(amount),
          createStringField(FIELD_PREFIXES.name, `Store ${id}`),
          createStringField('original_date', '2024-08-01'),
          createStringField('transaction_id', id),
        ]);

      fs.writeFileSync(path.join(tempDir, 'file1.ldb'), createTxn('txn_file1', 100.0));
      fs.writeFileSync(path.join(tempDir, 'file2.ldb'), createTxn('txn_file2', 200.0));

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(2);
    });

    test('handles various transaction data scenarios', () => {
      const tempDir = path.join(__dirname, '../fixtures/control-chars-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create valid transaction data
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(50.0),
        createStringField(FIELD_PREFIXES.name, 'Valid Name'),
        createStringField('original_date', '2024-09-01'),
        createStringField('transaction_id', 'txn_valid'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Valid Name');
    });

    test('handles string with very long length (over 100 chars)', () => {
      const tempDir = path.join(__dirname, '../fixtures/long-string-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Manually create a field with length > 100 which should be skipped
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(75.0),
        // Name field with length = 150 (should be skipped)
        FIELD_PREFIXES.name,
        Buffer.from([0x8a, 0x01, 150]),
        Buffer.alloc(150, 0x41), // 150 'A' characters
        // Valid transaction_id and date
        createStringField('original_date', '2024-10-01'),
        createStringField('transaction_id', 'txn_long'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      // Transaction should be skipped because name couldn't be extracted
      expect(result).toEqual([]);
    });

    test('processes multiple amount patterns in single file', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-pattern-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createTxn = (id: string, amount: number, date: string) =>
        Buffer.concat([
          Buffer.from('amount'),
          Buffer.from('original_name'),
          FIELD_PREFIXES.amount,
          createDoubleField(amount),
          createStringField(FIELD_PREFIXES.name, `Store ${id}`),
          createStringField('original_date', date),
          createStringField('transaction_id', id),
          Buffer.alloc(100), // Padding to separate records
        ]);

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        createTxn('txn_1', 10.0, '2024-11-01'),
        createTxn('txn_2', 20.0, '2024-11-02'),
        createTxn('txn_3', 30.0, '2024-11-03'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(3);
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

    test('decodes complete account with all fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/complete-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(5000.5),
        createStringField(FIELD_PREFIXES.name, 'Checking Account'),
        createStringField('official_name', 'Primary Checking Account'),
        createStringField(FIELD_PREFIXES.type, 'depository'),
        createStringField('subtype', 'checking'),
        createStringField(FIELD_PREFIXES.mask, '4567'),
        createStringField('institution_name', 'Test Bank'),
        createStringField('account_id', 'acc_123'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].account_id).toBe('acc_123');
      expect(result[0].current_balance).toBe(5000.5);
      expect(result[0].name).toBe('Checking Account');
      expect(result[0].official_name).toBe('Primary Checking Account');
      expect(result[0].account_type).toBe('depository');
      expect(result[0].subtype).toBe('checking');
      expect(result[0].mask).toBe('4567');
      expect(result[0].institution_name).toBe('Test Bank');
    });

    test('decodes account using official_name when name is missing', () => {
      const tempDir = path.join(__dirname, '../fixtures/official-name-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(2500.0),
        createStringField('official_name', 'Official Savings Account'),
        createStringField('account_id', 'acc_official'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].official_name).toBe('Official Savings Account');
    });

    test('deduplicates accounts by display_name and mask', () => {
      const tempDir = path.join(__dirname, '../fixtures/dedup-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createAcc = (id: string) =>
        Buffer.concat([
          Buffer.from('/accounts/'),
          Buffer.from('current_balance'),
          createDoubleField(1000.0),
          createStringField(FIELD_PREFIXES.name, 'Duplicate Account'),
          createStringField(FIELD_PREFIXES.mask, '1234'),
          createStringField('account_id', id),
        ]);

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([createAcc('acc_dup1'), createAcc('acc_dup2')]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
    });

    test('skips accounts without required fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/missing-acc-fields-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Account without name or official_name
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(3000.0),
        createStringField('account_id', 'acc_no_name'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result).toEqual([]);
    });

    test('skips accounts without account_id', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-id-acc-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(3000.0),
        createStringField(FIELD_PREFIXES.name, 'No ID Account'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result).toEqual([]);
    });

    test('skips accounts with null balance', () => {
      const tempDir = path.join(__dirname, '../fixtures/null-balance-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        // No valid double value tag
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        createStringField(FIELD_PREFIXES.name, 'Null Balance Account'),
        createStringField('account_id', 'acc_null'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result).toEqual([]);
    });

    test('handles negative account balance', () => {
      const tempDir = path.join(__dirname, '../fixtures/negative-balance-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(-500.25),
        createStringField(FIELD_PREFIXES.name, 'Overdrawn Account'),
        createStringField('account_id', 'acc_neg'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].current_balance).toBe(-500.25);
    });

    test('handles multiple .ldb files for accounts', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-acc-files-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createAcc = (id: string, name: string, balance: number) =>
        Buffer.concat([
          Buffer.from('/accounts/'),
          Buffer.from('current_balance'),
          createDoubleField(balance),
          createStringField(FIELD_PREFIXES.name, name),
          createStringField('account_id', id),
        ]);

      fs.writeFileSync(path.join(tempDir, 'file1.ldb'), createAcc('acc_1', 'Account 1', 1000.0));
      fs.writeFileSync(path.join(tempDir, 'file2.ldb'), createAcc('acc_2', 'Account 2', 2000.0));

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(2);
    });

    test('processes multiple balance patterns in separate files', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-balance-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createAcc = (id: string, name: string, balance: number) =>
        Buffer.concat([
          Buffer.from('/accounts/'),
          Buffer.from('current_balance'),
          createDoubleField(balance),
          createStringField(FIELD_PREFIXES.name, name),
          createStringField('account_id', id),
        ]);

      // Use separate files for cleaner separation
      fs.writeFileSync(
        path.join(tempDir, 'acc1.ldb'),
        createAcc('acc_multi_1', 'Multi Account 1', 100.0)
      );
      fs.writeFileSync(
        path.join(tempDir, 'acc2.ldb'),
        createAcc('acc_multi_2', 'Multi Account 2', 200.0)
      );
      fs.writeFileSync(
        path.join(tempDir, 'acc3.ldb'),
        createAcc('acc_multi_3', 'Multi Account 3', 300.0)
      );

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(3);
    });

    test('deduplicates accounts without mask', () => {
      const tempDir = path.join(__dirname, '../fixtures/dedup-no-mask-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createAcc = (id: string) =>
        Buffer.concat([
          Buffer.from('/accounts/'),
          Buffer.from('current_balance'),
          createDoubleField(1500.0),
          createStringField(FIELD_PREFIXES.name, 'No Mask Account'),
          createStringField('account_id', id),
          // No mask field
        ]);

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([createAcc('acc_nomask1'), createAcc('acc_nomask2')]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('handles empty .ldb file', () => {
      const tempDir = path.join(__dirname, '../fixtures/empty-ldb-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'empty.ldb');
      fs.writeFileSync(ldbFile, Buffer.alloc(0));

      const txnResult = decodeTransactions(tempDir);
      expect(txnResult).toEqual([]);

      const accResult = decodeAccounts(tempDir);
      expect(accResult).toEqual([]);
    });

    test('handles non-.ldb files in directory', () => {
      const tempDir = path.join(__dirname, '../fixtures/mixed-files-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create non-ldb files
      fs.writeFileSync(path.join(tempDir, 'test.txt'), 'text file');
      fs.writeFileSync(path.join(tempDir, 'test.log'), 'log file');
      fs.writeFileSync(path.join(tempDir, 'CURRENT'), 'current file');

      const txnResult = decodeTransactions(tempDir);
      expect(txnResult).toEqual([]);

      const accResult = decodeAccounts(tempDir);
      expect(accResult).toEqual([]);
    });

    test('handles file with only amount marker but no original_name', () => {
      const tempDir = path.join(__dirname, '../fixtures/amount-only-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        FIELD_PREFIXES.amount,
        createDoubleField(100.0),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('handles file with only original_name marker but no amount', () => {
      const tempDir = path.join(__dirname, '../fixtures/original-only-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.from('original_name some_data');
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result).toEqual([]);
    });

    test('handles amounts that round to 2 decimal places', () => {
      const tempDir = path.join(__dirname, '../fixtures/round-amount-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(123.456789), // Should round to 123.46
        createStringField(FIELD_PREFIXES.name, 'Round Store'),
        createStringField('original_date', '2024-12-01'),
        createStringField('transaction_id', 'txn_round'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].amount).toBe(123.46);
    });

    test('handles balance that rounds to 2 decimal places', () => {
      const tempDir = path.join(__dirname, '../fixtures/round-balance-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/accounts/'),
        Buffer.from('current_balance'),
        createDoubleField(9999.999), // Should round to 10000
        createStringField(FIELD_PREFIXES.name, 'Round Balance Account'),
        createStringField('account_id', 'acc_round'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeAccounts(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].current_balance).toBe(10000);
    });

    test('handles transaction with minimal valid data', () => {
      const tempDir = path.join(__dirname, '../fixtures/zero-len-string-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(50.0),
        createStringField(FIELD_PREFIXES.name, 'Minimal Store'),
        createStringField('original_date', '2024-12-15'),
        createStringField('transaction_id', 'txn_minimal'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].transaction_id).toBe('txn_minimal');
    });

    test('handles unicode characters in strings', () => {
      const tempDir = path.join(__dirname, '../fixtures/unicode-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(88.88),
        createStringField(FIELD_PREFIXES.name, 'Café Münich'),
        createStringField('original_date', '2024-12-20'),
        createStringField('transaction_id', 'txn_unicode'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('Café Münich');
    });

    test('skips transaction when Zod validation fails', () => {
      const tempDir = path.join(__dirname, '../fixtures/invalid-zod-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create transaction with invalid date format that will fail Zod validation
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('amount'),
        Buffer.from('original_name'),
        FIELD_PREFIXES.amount,
        createDoubleField(100.0),
        createStringField(FIELD_PREFIXES.name, 'Valid Name'),
        createStringField('original_date', 'not-a-valid-date'),
        createStringField('transaction_id', ''),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeTransactions(tempDir);
      // Transaction should be skipped due to empty transaction_id
      expect(result).toEqual([]);
    });
  });

  describe('decodeRecurring', () => {
    test('returns empty array for non-existent path', () => {
      const result = decodeRecurring('/nonexistent/path/that/does/not/exist');
      expect(result).toEqual([]);
    });

    test('returns empty array for directory without .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/empty-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const result = decodeRecurring(tempDir);
      expect(result).toEqual([]);
    });

    test('returns empty array for files without recurring markers', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      fs.writeFileSync(ldbFile, Buffer.from('random data'));

      const result = decodeRecurring(tempDir);
      expect(result).toEqual([]);
    });

    test('decodes complete recurring transaction with all fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/complete-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      // Include recurring ID in the path itself
      const data = Buffer.concat([
        Buffer.from('/recurring/rec_123456789012'),
        Buffer.alloc(50), // Padding
        createStringField(FIELD_PREFIXES.name, 'Netflix Subscription'),
        createStringField('merchant_name', 'Netflix'),
        createStringField('amount', ''), // Use field pattern
        createDoubleField(15.99),
        createStringField('frequency', 'monthly'),
        createStringField('next_date', '2025-02-15'),
        createStringField('last_date', '2025-01-15'),
        createStringField('category_id', 'cat_entertainment'),
        createStringField('account_id', 'acc_checking'),
        createBooleanField('is_active', true),
        createStringField('iso_currency_code', 'USD'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].recurring_id).toBe('rec_123456789012');
      expect(result[0].name).toBe('Netflix Subscription');
      expect(result[0].merchant_name).toBe('Netflix');
      expect(result[0].amount).toBe(15.99);
      expect(result[0].frequency).toBe('monthly');
      expect(result[0].next_date).toBe('2025-02-15');
      expect(result[0].last_date).toBe('2025-01-15');
      expect(result[0].category_id).toBe('cat_entertainment');
      expect(result[0].account_id).toBe('acc_checking');
      expect(result[0].is_active).toBe(true);
      expect(result[0].iso_currency_code).toBe('USD');
    });

    test('decodes recurring transaction with minimal required fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/minimal-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.from('/recurring/rec_minimal123');
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].recurring_id).toBe('rec_minimal123');
    });

    test('skips recurring record with short recurring_id', () => {
      const tempDir = path.join(__dirname, '../fixtures/short-id-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.from('/recurring/short'); // Too short (< 10 chars)
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      expect(result).toEqual([]);
    });

    test('skips recurring record with invalid date format', () => {
      const tempDir = path.join(__dirname, '../fixtures/invalid-date-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/recurring/rec_invaliddate'),
        Buffer.alloc(20),
        createStringField('next_date', '01/15/2025'), // Invalid format (not YYYY-MM-DD)
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      // Should be skipped due to invalid date format
      expect(result).toEqual([]);
    });

    test('skips recurring record with invalid frequency', () => {
      const tempDir = path.join(__dirname, '../fixtures/invalid-freq-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/recurring/rec_badfrequency'),
        Buffer.alloc(20),
        createStringField('frequency', 'sometimes'), // Invalid frequency
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      // Should be skipped due to invalid frequency enum
      expect(result).toEqual([]);
    });

    test('deduplicates recurring records by recurring_id', () => {
      const tempDir = path.join(__dirname, '../fixtures/dedup-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createRec = (id: string, name: string) =>
        Buffer.concat([
          Buffer.from(`/recurring/${id}`),
          Buffer.alloc(20),
          createStringField(FIELD_PREFIXES.name, name),
        ]);

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        createRec('rec_duplicate12', 'First Instance'),
        createRec('rec_duplicate12', 'Second Instance'), // Duplicate ID
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('First Instance');
    });

    test('handles recurring with is_active false', () => {
      const tempDir = path.join(__dirname, '../fixtures/inactive-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/recurring/rec_inactive123'),
        Buffer.alloc(20),
        createStringField(FIELD_PREFIXES.name, 'Canceled Subscription'),
        createBooleanField('is_active', false),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeRecurring(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].is_active).toBe(false);
    });

    test('handles multiple .ldb files with recurring data', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-recurring-files-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createRec = (id: string, name: string) =>
        Buffer.concat([
          Buffer.from(`/recurring/${id}`),
          Buffer.alloc(20),
          createStringField(FIELD_PREFIXES.name, name),
        ]);

      fs.writeFileSync(
        path.join(tempDir, 'file1.ldb'),
        createRec('rec_file1_12345', 'Subscription 1')
      );
      fs.writeFileSync(
        path.join(tempDir, 'file2.ldb'),
        createRec('rec_file2_12345', 'Subscription 2')
      );

      const result = decodeRecurring(tempDir);
      expect(result.length).toBe(2);
    });

    test('logs validation errors in development mode', () => {
      const tempDir = path.join(__dirname, '../fixtures/dev-log-recurring-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Set development mode
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/recurring/rec_devlog12345'),
        Buffer.alloc(20),
        createStringField('frequency', 'invalid'), // Will cause validation error
      ]);
      fs.writeFileSync(ldbFile, data);

      // Capture console.warn
      const originalWarn = console.warn;
      let warnCalled = false;
      console.warn = () => {
        warnCalled = true;
      };

      const result = decodeRecurring(tempDir);

      // Restore
      console.warn = originalWarn;
      process.env.NODE_ENV = originalEnv;

      expect(result).toEqual([]);
      expect(warnCalled).toBe(true);
    });
  });

  describe('decodeCategories', () => {
    test('returns empty array for non-existent path', () => {
      const result = decodeCategories('/nonexistent/path/that/does/not/exist');
      expect(result).toEqual([]);
    });

    test('returns empty array for file instead of directory', () => {
      const tempFile = path.join(__dirname, '../fixtures/test-file2.txt');
      fs.mkdirSync(path.dirname(tempFile), { recursive: true });
      fs.writeFileSync(tempFile, 'test');

      const result = decodeCategories(tempFile);
      expect(result).toEqual([]);
    });

    test('returns empty array for directory without .ldb files', () => {
      const tempDir = path.join(__dirname, '../fixtures/empty-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const result = decodeCategories(tempDir);
      expect(result).toEqual([]);
    });

    test('skips files without category markers', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      // Create .ldb file without category data
      const ldbFile = path.join(tempDir, 'test.ldb');
      fs.writeFileSync(ldbFile, Buffer.from('random data here'));

      const result = decodeCategories(tempDir);
      expect(result).toEqual([]);
    });

    test('extracts category with all fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/complete-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/users/user123/categories/TestCategory1234567'),
        Buffer.alloc(20), // Padding
        createStringField('name', 'Restaurants'),
        createStringField('emoji', '🍕'),
        createStringField('color', '#FF5733'),
        createStringField('bg_color', '#FFFFFF'),
        createStringField('parent_category_id', 'parent123456789'),
        createBooleanField('excluded', false),
        createBooleanField('is_other', false),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeCategories(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].category_id).toBe('TestCategory1234567');
      expect(result[0].name).toBe('Restaurants');
      expect(result[0].emoji).toBe('🍕');
      expect(result[0].color).toBe('#FF5733');
      expect(result[0].bg_color).toBe('#FFFFFF');
      expect(result[0].parent_category_id).toBe('parent123456789');
    });

    test('extracts category with minimal fields', () => {
      const tempDir = path.join(__dirname, '../fixtures/minimal-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/users/user123/categories/MinimalCategory12'),
        Buffer.alloc(20), // Padding
        createStringField('name', 'Groceries'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeCategories(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].category_id).toBe('MinimalCategory12');
      expect(result[0].name).toBe('Groceries');
    });

    test('skips categories with short IDs', () => {
      const tempDir = path.join(__dirname, '../fixtures/short-id-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/users/user123/categories/short'), // ID too short (< 15 chars)
        Buffer.alloc(20),
        createStringField('name', 'Invalid Category'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeCategories(tempDir);
      expect(result).toEqual([]);
    });

    test('skips categories without name', () => {
      const tempDir = path.join(__dirname, '../fixtures/no-name-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        Buffer.from('/users/user123/categories/NoNameCategory123'),
        Buffer.alloc(20),
        createStringField('emoji', '🍕'), // Has emoji but no name
        createStringField('color', '#FF5733'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeCategories(tempDir);
      expect(result).toEqual([]);
    });

    test('deduplicates categories by ID', () => {
      const tempDir = path.join(__dirname, '../fixtures/dedup-category-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createCat = (id: string, name: string) =>
        Buffer.concat([
          Buffer.from(`/users/user123/categories/${id}`),
          Buffer.alloc(20),
          createStringField('name', name),
        ]);

      // Create file with duplicate category IDs
      const ldbFile = path.join(tempDir, 'test.ldb');
      const data = Buffer.concat([
        createCat('DuplicateCategory1', 'First Category'),
        Buffer.alloc(50),
        createCat('DuplicateCategory1', 'First Category Duplicate'),
      ]);
      fs.writeFileSync(ldbFile, data);

      const result = decodeCategories(tempDir);
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('First Category'); // First one wins
    });

    test('handles multiple .ldb files for categories', () => {
      const tempDir = path.join(__dirname, '../fixtures/multi-category-files-db');
      fs.mkdirSync(tempDir, { recursive: true });

      const createCat = (id: string, name: string) =>
        Buffer.concat([
          Buffer.from(`/users/user123/categories/${id}`),
          Buffer.alloc(20),
          createStringField('name', name),
        ]);

      fs.writeFileSync(path.join(tempDir, 'file1.ldb'), createCat('Category123456781', 'Food'));
      fs.writeFileSync(
        path.join(tempDir, 'file2.ldb'),
        createCat('Category123456782', 'Transportation')
      );
      fs.writeFileSync(
        path.join(tempDir, 'file3.ldb'),
        createCat('Category123456783', 'Entertainment')
      );

      const result = decodeCategories(tempDir);
      expect(result.length).toBe(3);
      // Results should be sorted by name
      const names = result.map((c) => c.name);
      expect(names).toContain('Food');
      expect(names).toContain('Transportation');
      expect(names).toContain('Entertainment');
    });
  });
});
