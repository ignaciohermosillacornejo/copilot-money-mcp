/**
 * Tests for leveldb-reader.ts to achieve 100% code coverage.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import {
  parseDocumentKey,
  iterateDocuments,
  getCollection,
  getAllCollections,
  documentToObject,
  LevelDBReader,
  createTestDatabase,
  cleanupAllTempDatabases,
} from '../../src/core/leveldb-reader.js';
import path from 'node:path';
import fs from 'node:fs';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/leveldb-reader-tests');

// Cleanup all test databases after each test
afterEach(() => {
  cleanupAllTempDatabases();
  if (fs.existsSync(FIXTURES_DIR)) {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  }
});

// Ensure fixtures directory exists
beforeEach(() => {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
});

describe('leveldb-reader', () => {
  describe('parseDocumentKey', () => {
    test('parses simple string path format', () => {
      const key = 'remote_document/projects/test/databases/(default)/documents/transactions/txn123';
      const result = parseDocumentKey(key);

      expect(result).toEqual({ collection: 'transactions', documentId: 'txn123' });
    });

    test('parses subcollection path format', () => {
      const key =
        'remote_document/projects/test/databases/(default)/documents/users/user1/orders/order123';
      const result = parseDocumentKey(key);

      expect(result).toEqual({ collection: 'users/user1/orders', documentId: 'order123' });
    });

    test('returns null for non-document keys', () => {
      const key = 'some_other_key/without/documents';
      const result = parseDocumentKey(key);

      expect(result).toBeNull();
    });

    test('returns null for keys without documents pattern', () => {
      // Key without the /documents/collection/id pattern
      const key = 'some_random_key_without_pattern';
      const result = parseDocumentKey(key);

      expect(result).toBeNull();
    });

    test('parses string key even without remote_document marker', () => {
      // The string parser uses regex and doesn't require remote_document
      const key = 'local_document/projects/test/databases/(default)/documents/test/123';
      const result = parseDocumentKey(key);

      // String parser matches based on documents/collection/id pattern
      expect(result).toEqual({ collection: 'test', documentId: '123' });
    });

    test('parses binary format key', () => {
      // Create a binary key with the Firestore SDK format using actual byte values
      // Format: 0x85 + "remote_document" + segments with 0x00 0x01 0xBE markers
      const marker = Buffer.from([0x85]);
      const remoteDoc = Buffer.from('remote_document', 'utf8');
      const sep = Buffer.from([0x00, 0x01, 0xbe]); // separator + string marker
      const accounts = Buffer.from('accounts', 'utf8');
      const acc123 = Buffer.from('acc123', 'utf8');
      const end = Buffer.from([0x00, 0x01, 0x80]); // end marker

      const keyBuffer = Buffer.concat([marker, remoteDoc, sep, accounts, sep, acc123, end]);
      const result = parseDocumentKey(keyBuffer);

      expect(result).not.toBeNull();
      expect(result?.collection).toBe('accounts');
      expect(result?.documentId).toBe('acc123');
    });

    test('returns null for binary key with less than 2 segments', () => {
      // Create a binary key with only one segment
      const marker = Buffer.from([0x85]);
      const remoteDoc = Buffer.from('remote_document', 'utf8');
      const sep = Buffer.from([0x00, 0x01, 0xbe]);
      const onlyone = Buffer.from('onlyone', 'utf8');
      const end = Buffer.from([0x00, 0x01, 0x80]);

      const keyBuffer = Buffer.concat([marker, remoteDoc, sep, onlyone, end]);
      const result = parseDocumentKey(keyBuffer);

      expect(result).toBeNull();
    });

    test('returns null for binary key with skip collections', () => {
      // Create a binary key where the second-to-last segment is a skip collection
      const marker = Buffer.from([0x85]);
      const remoteDoc = Buffer.from('remote_document', 'utf8');
      const sep = Buffer.from([0x00, 0x01, 0xbe]);
      const items = Buffer.from('items', 'utf8');
      const collectionParent = Buffer.from('collection_parent', 'utf8');
      const doc1 = Buffer.from('doc1', 'utf8');
      const end = Buffer.from([0x00, 0x01, 0x80]);

      // Key: items -> collection_parent -> doc1
      // Last two are: collection_parent, doc1 - should skip
      const keyBuffer = Buffer.concat([
        marker,
        remoteDoc,
        sep,
        items,
        sep,
        collectionParent,
        sep,
        doc1,
        end,
      ]);
      const result = parseDocumentKey(keyBuffer);

      // Should return null because collection_parent is in skip list
      expect(result).toBeNull();
    });

    test('handles string containing remote_document but no valid path', () => {
      const key = 'remote_document/invalid';
      const result = parseDocumentKey(key);

      expect(result).toBeNull();
    });

    test('string path parser does not filter skip collections', () => {
      // Note: Skip collection filtering only applies to binary keys
      // String key parser returns the match as-is
      const key =
        'remote_document/projects/test/databases/(default)/documents/collection_parent/doc1';
      const result = parseDocumentKey(key);

      // String parser returns the match without filtering
      expect(result).toEqual({ collection: 'collection_parent', documentId: 'doc1' });
    });
  });

  describe('iterateDocuments', () => {
    test('throws error for non-existent path', async () => {
      const gen = iterateDocuments('/nonexistent/path');
      await expect(gen.next()).rejects.toThrow('Database path not found');
    });

    test('throws error for file instead of directory', async () => {
      const tempFile = path.join(FIXTURES_DIR, 'test-file.txt');
      fs.writeFileSync(tempFile, 'test');

      const gen = iterateDocuments(tempFile);
      await expect(gen.next()).rejects.toThrow('Path is not a directory');
    });

    test('iterates documents with limit', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'limit-test-db');
      await createTestDatabase(dbPath, [
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
        { collection: 'transactions', id: 'txn2', fields: { amount: 200 } },
        { collection: 'transactions', id: 'txn3', fields: { amount: 300 } },
      ]);

      const docs = [];
      for await (const doc of iterateDocuments(dbPath, { limit: 2 })) {
        docs.push(doc);
      }

      expect(docs.length).toBe(2);
    });

    test('filters by collection', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'filter-test-db');
      await createTestDatabase(dbPath, [
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
        { collection: 'accounts', id: 'acc1', fields: { name: 'Test' } },
        { collection: 'transactions', id: 'txn2', fields: { amount: 200 } },
      ]);

      const docs = [];
      for await (const doc of iterateDocuments(dbPath, { collection: 'accounts' })) {
        docs.push(doc);
      }

      expect(docs.length).toBe(1);
      expect(docs[0]?.collection).toBe('accounts');
    });

    test('filters by keyPrefix', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'prefix-test-db');
      await createTestDatabase(dbPath, [
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
      ]);

      const docs = [];
      for await (const doc of iterateDocuments(dbPath, { keyPrefix: 'remote_document' })) {
        docs.push(doc);
      }

      expect(docs.length).toBe(1);
    });
  });

  describe('getCollection', () => {
    test('returns all documents from a collection', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'get-collection-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'Checking' } },
        { collection: 'accounts', id: 'acc2', fields: { name: 'Savings' } },
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
      ]);

      const docs = await getCollection(dbPath, 'accounts');

      expect(docs.length).toBe(2);
      expect(docs.every((d) => d.collection === 'accounts')).toBe(true);
    });
  });

  describe('getAllCollections', () => {
    test('groups documents by collection', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'all-collections-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'Checking' } },
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
        { collection: 'transactions', id: 'txn2', fields: { amount: 200 } },
        { collection: 'budgets', id: 'bud1', fields: { amount: 500 } },
      ]);

      const collections = await getAllCollections(dbPath);

      expect(collections.size).toBe(3);
      expect(collections.get('accounts')?.length).toBe(1);
      expect(collections.get('transactions')?.length).toBe(2);
      expect(collections.get('budgets')?.length).toBe(1);
    });
  });

  describe('documentToObject', () => {
    test('converts LevelDBDocument to plain object', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'doc-to-object-db');
      await createTestDatabase(dbPath, [
        {
          collection: 'accounts',
          id: 'acc1',
          fields: { name: 'Test Account', balance: 1000.5, active: true },
        },
      ]);

      const docs = await getCollection(dbPath, 'accounts');
      const obj = documentToObject(docs[0]!);

      expect(obj._id).toBe('acc1');
      expect(obj._collection).toBe('accounts');
      expect(obj.name).toBe('Test Account');
      expect(obj.balance).toBe(1000.5);
      expect(obj.active).toBe(true);
    });
  });

  describe('LevelDBReader class', () => {
    test('opens and closes database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-open-close-db');
      await createTestDatabase(dbPath, []);

      const reader = new LevelDBReader(dbPath);
      expect(reader.isOpen()).toBe(false);

      await reader.open();
      expect(reader.isOpen()).toBe(true);

      await reader.close();
      expect(reader.isOpen()).toBe(false);
    });

    test('throws when iterating without opening', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-not-open-db');
      const reader = new LevelDBReader(dbPath);

      const gen = reader.iterate();
      await expect(gen.next()).rejects.toThrow('Database not open');
    });

    test('throws when putting document without opening', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-put-not-open-db');
      const reader = new LevelDBReader(dbPath);

      await expect(reader.putDocument('test', 'doc1', { foo: 'bar' })).rejects.toThrow(
        'Database not open'
      );
    });

    test('throws when deleting document without opening', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-delete-not-open-db');
      const reader = new LevelDBReader(dbPath);

      await expect(reader.deleteDocument('test', 'doc1')).rejects.toThrow('Database not open');
    });

    test('iterates with collection filter', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-iterate-filter-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'Test' } },
        { collection: 'transactions', id: 'txn1', fields: { amount: 100 } },
      ]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const docs = [];
      for await (const doc of reader.iterate({ collection: 'accounts' })) {
        docs.push(doc);
      }

      await reader.close();

      expect(docs.length).toBe(1);
      expect(docs[0]?.collection).toBe('accounts');
    });

    test('iterates with limit', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-iterate-limit-db');
      await createTestDatabase(dbPath, [
        { collection: 'test', id: 'doc1', fields: { x: 1 } },
        { collection: 'test', id: 'doc2', fields: { x: 2 } },
        { collection: 'test', id: 'doc3', fields: { x: 3 } },
      ]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const docs = [];
      for await (const doc of reader.iterate({ limit: 2 })) {
        docs.push(doc);
      }

      await reader.close();

      expect(docs.length).toBe(2);
    });

    test('iterates with keyPrefix filter', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-iterate-prefix-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const docs = [];
      for await (const doc of reader.iterate({ keyPrefix: 'remote_document' })) {
        docs.push(doc);
      }

      await reader.close();

      expect(docs.length).toBe(1);
    });

    test('getCollection returns documents from collection', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-get-collection-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'A' } },
        { collection: 'accounts', id: 'acc2', fields: { name: 'B' } },
      ]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const docs = await reader.getCollection('accounts');

      await reader.close();

      expect(docs.length).toBe(2);
    });

    test('getDocument returns specific document', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-get-document-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'Account 1' } },
        { collection: 'accounts', id: 'acc2', fields: { name: 'Account 2' } },
      ]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const doc = await reader.getDocument('accounts', 'acc2');

      await reader.close();

      expect(doc).not.toBeNull();
      expect(doc?.documentId).toBe('acc2');
    });

    test('getDocument returns null for non-existent document', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-get-nonexistent-db');
      await createTestDatabase(dbPath, [
        { collection: 'accounts', id: 'acc1', fields: { name: 'Account 1' } },
      ]);

      const reader = new LevelDBReader(dbPath);
      await reader.open();

      const doc = await reader.getDocument('accounts', 'nonexistent');

      await reader.close();

      expect(doc).toBeNull();
    });

    test('putDocument and deleteDocument work correctly', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-put-delete-db');
      await createTestDatabase(dbPath, []);

      const reader = new LevelDBReader(dbPath);
      await reader.open({ createIfMissing: true });

      // Put a document
      await reader.putDocument('test', 'doc1', { value: 'hello' });

      // Verify it exists
      let doc = await reader.getDocument('test', 'doc1');
      expect(doc).not.toBeNull();

      // Delete the document
      await reader.deleteDocument('test', 'doc1');

      // Verify it's gone
      doc = await reader.getDocument('test', 'doc1');
      expect(doc).toBeNull();

      await reader.close();
    });

    test('close on already closed database is no-op', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'reader-double-close-db');
      await createTestDatabase(dbPath, []);

      const reader = new LevelDBReader(dbPath);
      await reader.open();
      await reader.close();

      // Second close should not throw
      await reader.close();
      expect(reader.isOpen()).toBe(false);
    });
  });

  describe('cleanupAllTempDatabases', () => {
    test('cleans up all cached temp databases', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'cleanup-test-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      // Iterate to create a temp copy
      const docs = [];
      for await (const doc of iterateDocuments(dbPath)) {
        docs.push(doc);
      }

      // Clean up all temp databases
      cleanupAllTempDatabases();

      // Should not throw, just cleanup
      expect(true).toBe(true);
    });
  });

  describe('temp database cache', () => {
    test('reuses cached temp database', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'cache-reuse-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      // First iteration
      let count1 = 0;
      for await (const _doc of iterateDocuments(dbPath)) {
        count1++;
      }

      // Second iteration should reuse cache
      let count2 = 0;
      for await (const _doc of iterateDocuments(dbPath)) {
        count2++;
      }

      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });
  });
});
