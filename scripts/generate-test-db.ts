/**
 * Script to generate a synthetic test database for E2E tests.
 *
 * Creates a valid .ldb file with fake transactions and accounts
 * that can be read by the decoder.
 */

import fs from 'node:fs';
import path from 'node:path';

// Synthetic test data
const SYNTHETIC_TRANSACTIONS = [
  {
    transaction_id: 'test_txn_001',
    name: 'Acme Coffee Shop',
    original_name: 'ACME COFFEE SHOP #123',
    amount: -4.5,
    date: '2025-01-15',
    category_id: 'food_dining',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
    city: 'Seattle',
    region: 'WA',
  },
  {
    transaction_id: 'test_txn_002',
    name: 'Grocery Mart',
    original_name: 'GROCERY MART SUPERSTORE',
    amount: -125.67,
    date: '2025-01-14',
    category_id: 'groceries',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
    city: 'Seattle',
    region: 'WA',
  },
  {
    transaction_id: 'test_txn_003',
    name: 'Electric Company',
    original_name: 'CITY ELECTRIC UTILITY',
    amount: -89.32,
    date: '2025-01-10',
    category_id: 'utilities',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_004',
    name: 'Gas Station',
    original_name: 'SHELL OIL 12345',
    amount: -45.0,
    date: '2025-01-12',
    category_id: 'transportation',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_005',
    name: 'Online Shopping',
    original_name: 'AMZN MKTP US*AB1CD2EF3',
    amount: -67.89,
    date: '2025-01-11',
    category_id: 'shopping',
    account_id: 'test_acc_credit',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_006',
    name: 'Payroll',
    original_name: 'EMPLOYER DIRECT DEP',
    amount: 3500.0,
    date: '2025-01-01',
    category_id: 'income',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_007',
    name: 'Streaming Service',
    original_name: 'NETFLIX.COM',
    amount: -15.99,
    date: '2025-01-05',
    category_id: 'entertainment',
    account_id: 'test_acc_credit',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_008',
    name: 'Restaurant',
    original_name: 'FANCY RESTAURANT',
    amount: -78.5,
    date: '2025-01-08',
    category_id: 'food_dining',
    account_id: 'test_acc_credit',
    iso_currency_code: 'USD',
    city: 'Seattle',
    region: 'WA',
  },
  {
    transaction_id: 'test_txn_009',
    name: 'ATM Withdrawal',
    original_name: 'ATM WITHDRAWAL',
    amount: -100.0,
    date: '2025-01-06',
    category_id: 'cash',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_010',
    name: 'Transfer to Savings',
    original_name: 'TRANSFER TO SAVINGS',
    amount: -500.0,
    date: '2025-01-02',
    category_id: 'transfer',
    account_id: 'test_acc_checking',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_011',
    name: 'Transfer from Checking',
    original_name: 'TRANSFER FROM CHECKING',
    amount: 500.0,
    date: '2025-01-02',
    category_id: 'transfer',
    account_id: 'test_acc_savings',
    iso_currency_code: 'USD',
  },
  {
    transaction_id: 'test_txn_012',
    name: 'Gym Membership',
    original_name: 'FITNESS CENTER MONTHLY',
    amount: -49.99,
    date: '2025-01-03',
    category_id: 'health',
    account_id: 'test_acc_credit',
    iso_currency_code: 'USD',
  },
];

const SYNTHETIC_ACCOUNTS = [
  {
    account_id: 'test_acc_checking',
    name: 'Test Checking',
    official_name: 'Premium Checking Account',
    current_balance: 2500.0,
    account_type: 'depository',
    subtype: 'checking',
    mask: '1234',
    institution_name: 'Test Bank',
  },
  {
    account_id: 'test_acc_savings',
    name: 'Test Savings',
    official_name: 'High Yield Savings',
    current_balance: 10000.0,
    account_type: 'depository',
    subtype: 'savings',
    mask: '5678',
    institution_name: 'Test Bank',
  },
  {
    account_id: 'test_acc_credit',
    name: 'Test Credit Card',
    official_name: 'Rewards Credit Card',
    current_balance: -450.37,
    account_type: 'credit',
    subtype: 'credit card',
    mask: '9012',
    institution_name: 'Test Credit Union',
  },
];

/**
 * Encode a string field in the format the decoder expects.
 * Format: fieldName + \x8a\x01 + length + value
 */
function encodeStringField(fieldName: string, value: string): Buffer {
  const fieldNameBuf = Buffer.from(`\x0a${String.fromCharCode(fieldName.length)}${fieldName}`);
  const valueBuf = Buffer.from(value, 'utf-8');
  const tag = Buffer.from([0x8a, 0x01, valueBuf.length]);
  return Buffer.concat([fieldNameBuf, tag, valueBuf]);
}

/**
 * Encode a double value in little-endian format with tag.
 * Format: \x19 + 8-byte double LE
 */
function encodeDoubleField(fieldName: string, value: number): Buffer {
  const fieldNameBuf = Buffer.from(`\x0a${String.fromCharCode(fieldName.length)}${fieldName}`);
  const doubleBuf = Buffer.alloc(9);
  doubleBuf[0] = 0x19; // Double tag
  doubleBuf.writeDoubleLE(value, 1);
  return Buffer.concat([fieldNameBuf, doubleBuf]);
}

/**
 * Encode a boolean field.
 * Format: fieldName + \x08 + value
 */
function encodeBooleanField(fieldName: string, value: boolean): Buffer {
  const fieldNameBuf = Buffer.from(`\x0a${String.fromCharCode(fieldName.length)}${fieldName}`);
  const valueBuf = Buffer.from([0x08, value ? 1 : 0]);
  return Buffer.concat([fieldNameBuf, valueBuf]);
}

/**
 * Encode a transaction record.
 * The decoder uses a 3000-byte window (1500 before + 1500 after the amount field),
 * so we need adequate padding between records to isolate them.
 */
function encodeTransaction(txn: (typeof SYNTHETIC_TRANSACTIONS)[0]): Buffer {
  const parts: Buffer[] = [];

  // Start with padding to separate from previous record
  parts.push(Buffer.alloc(1600, 0));

  // Required fields - put amount first as the decoder anchors on it
  parts.push(encodeDoubleField('amount', txn.amount));
  parts.push(encodeStringField('transaction_id', txn.transaction_id));
  parts.push(encodeStringField('original_date', txn.date));

  // Name fields
  if (txn.name) {
    parts.push(encodeStringField('name', txn.name));
  }
  if (txn.original_name) {
    parts.push(encodeStringField('original_name', txn.original_name));
  }

  // Optional fields
  if (txn.category_id) {
    parts.push(encodeStringField('category_id', txn.category_id));
  }
  if (txn.account_id) {
    parts.push(encodeStringField('account_id', txn.account_id));
  }
  if (txn.iso_currency_code) {
    parts.push(encodeStringField('iso_currency_code', txn.iso_currency_code));
  }
  if (txn.city) {
    parts.push(encodeStringField('city', txn.city));
  }
  if (txn.region) {
    parts.push(encodeStringField('region', txn.region));
  }

  // Add pending field (false by default)
  parts.push(encodeBooleanField('pending', false));

  // Add trailing padding
  parts.push(Buffer.alloc(1600, 0));

  return Buffer.concat(parts);
}

/**
 * Encode an account record.
 * The decoder uses a 2000-byte window (1000 before + 1000 after the balance field),
 * so we need adequate padding between records.
 */
function encodeAccount(acc: (typeof SYNTHETIC_ACCOUNTS)[0]): Buffer {
  const parts: Buffer[] = [];

  // Start with padding to separate from previous record
  parts.push(Buffer.alloc(1100, 0));

  // Account marker (required for decoder to process the file)
  parts.push(Buffer.from('/accounts/'));

  // Put current_balance first as the decoder anchors on it
  parts.push(encodeDoubleField('current_balance', acc.current_balance));
  parts.push(encodeStringField('account_id', acc.account_id));

  // Name fields
  if (acc.name) {
    parts.push(encodeStringField('name', acc.name));
  }
  if (acc.official_name) {
    parts.push(encodeStringField('official_name', acc.official_name));
  }

  // Optional fields
  if (acc.account_type) {
    parts.push(encodeStringField('type', acc.account_type));
  }
  if (acc.subtype) {
    parts.push(encodeStringField('subtype', acc.subtype));
  }
  if (acc.mask) {
    parts.push(encodeStringField('mask', acc.mask));
  }
  if (acc.institution_name) {
    parts.push(encodeStringField('institution_name', acc.institution_name));
  }

  // Add trailing padding
  parts.push(Buffer.alloc(1100, 0));

  return Buffer.concat(parts);
}

/**
 * Generate the test database.
 */
function generateTestDatabase(outputDir: string): void {
  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Generate transactions file
  const txnParts: Buffer[] = [];
  for (const txn of SYNTHETIC_TRANSACTIONS) {
    txnParts.push(encodeTransaction(txn));
  }
  const txnData = Buffer.concat(txnParts);
  fs.writeFileSync(path.join(outputDir, 'transactions.ldb'), txnData);

  // Generate accounts file
  const accParts: Buffer[] = [];
  for (const acc of SYNTHETIC_ACCOUNTS) {
    accParts.push(encodeAccount(acc));
  }
  const accData = Buffer.concat(accParts);
  fs.writeFileSync(path.join(outputDir, 'accounts.ldb'), accData);

  console.log(`Generated test database in ${outputDir}`);
  console.log(`  - ${SYNTHETIC_TRANSACTIONS.length} transactions`);
  console.log(`  - ${SYNTHETIC_ACCOUNTS.length} accounts`);
}

// Run if executed directly
const outputDir = process.argv[2] || path.join(__dirname, '../tests/fixtures/synthetic-db');
generateTestDatabase(outputDir);
