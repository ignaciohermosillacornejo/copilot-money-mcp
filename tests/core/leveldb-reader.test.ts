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
  _getTempDbCache,
  auditDocumentTable,
  isDocumentTableKey,
  isDocumentPathParity,
} from '../../src/core/leveldb-reader.js';
import { encodeFirestoreDocument } from '../../src/core/protobuf-parser.js';
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
      const item1 = Buffer.from('item1', 'utf8');
      const collectionParent = Buffer.from('collection_parent', 'utf8');
      const doc1 = Buffer.from('doc1', 'utf8');
      const end = Buffer.from([0x00, 0x01, 0x80]);

      // Key: items -> item1 -> collection_parent -> doc1. Four segments, so the
      // path passes the parity check (#807) and only the skip list rejects it.
      const keyBuffer = Buffer.concat([
        marker,
        remoteDoc,
        sep,
        items,
        sep,
        item1,
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

    describe('document path parity', () => {
      // A Firestore document path has an even number of segments; an odd count
      // is a collection path. Real caches hold two tables whose names contain
      // `remote_document`: the document table itself, and the sibling
      // `remote_document_read_time` index, whose keys carry a COLLECTION path as
      // string segments followed by a numeric read time and a non-string
      // document id. The parser keeps only the string segments, so a sibling
      // key used to come back as a "document" whose id is the collection name.

      /** Encode an ordered-code string component: label byte, bytes, 0x00 0x01. */
      function stringComponent(label: number, value: string): Buffer {
        return Buffer.concat([
          Buffer.from([label]),
          Buffer.from(value, 'utf8'),
          Buffer.from([0x00, 0x01]),
        ]);
      }

      /** A `remote_document` table key with the given path segments. */
      function documentTableKey(segments: string[]): Buffer {
        return Buffer.concat([
          stringComponent(0x85, 'remote_document'),
          ...segments.map((s) => stringComponent(0xbe, s)),
          Buffer.from([0x80]),
        ]);
      }

      /**
       * A `remote_document_read_time` key shaped like the real ones: table
       * name, collection path segments, a numeric read-time component, and a
       * document id under a non-string label, then the terminator.
       */
      function readTimeTableKey(collectionSegments: string[]): Buffer {
        return Buffer.concat([
          stringComponent(0x85, 'remote_document_read_time'),
          ...collectionSegments.map((s) => stringComponent(0xbe, s)),
          Buffer.from([0x90, 0x81, 0x02, 0x83, 0x04]),
          Buffer.from([0x98]),
          Buffer.from('k3Jd9QpX2mZ7wL', 'utf8'),
          Buffer.from([0x80]),
        ]);
      }

      const ITEM = 'Xq7pLm2NvR8sKd4TbW1a';
      const ACCOUNT = 'Ze3yHg6JcU9oFi5Vn0Qr';
      const HASH = 'a3f9c2e17b8d4065';

      // Every key the reader can meet, odd and even, from both tables.
      const KEYS: Array<{ label: string; key: Buffer }> = [
        { label: 'doc table, 2 segments', key: documentTableKey(['users', ITEM]) },
        {
          label: 'doc table, 4 segments',
          key: documentTableKey(['items', ITEM, 'accounts', ACCOUNT]),
        },
        {
          label: 'doc table, 6 segments',
          key: documentTableKey(['items', ITEM, 'accounts', ACCOUNT, 'transactions', 'tx1']),
        },
        {
          label: 'doc table, 3 segments (collection path)',
          key: documentTableKey(['items', ITEM, 'accounts']),
        },
        {
          label: 'doc table, 5 segments (collection path)',
          key: documentTableKey(['items', ITEM, 'accounts', ACCOUNT, 'balance_history']),
        },
        { label: 'read_time, 1 segment', key: readTimeTableKey(['users']) },
        { label: 'read_time, 3 segments', key: readTimeTableKey(['users', ITEM, 'categories']) },
        {
          label: 'read_time, 5 segments',
          key: readTimeTableKey(['items', ITEM, 'accounts', ACCOUNT, 'transactions']),
        },
        {
          label: 'read_time, 7 segments',
          key: readTimeTableKey([
            'items',
            ITEM,
            'accounts',
            ACCOUNT,
            'holdings_history',
            HASH,
            'history',
          ]),
        },
      ];

      test('every parsed key has an even segment count', () => {
        const odd = KEYS.flatMap(({ label, key }) => {
          const parsed = parseDocumentKey(key);
          if (!parsed) return [];
          return isDocumentPathParity(parsed.collection) ? [] : [label];
        });
        expect(odd).toEqual([]);
      });

      test('even document-table keys still parse', () => {
        expect(parseDocumentKey(documentTableKey(['users', ITEM]))).toEqual({
          collection: 'users',
          documentId: ITEM,
        });
        expect(
          parseDocumentKey(
            documentTableKey(['items', ITEM, 'accounts', ACCOUNT, 'transactions', 'tx1'])
          )
        ).toEqual({
          collection: `items/${ITEM}/accounts/${ACCOUNT}/transactions`,
          documentId: 'tx1',
        });
      });

      test('sibling remote_document_read_time keys are never documents', () => {
        // Even when the string segments happen to be even in number, a key from
        // another table is not a document.
        expect(parseDocumentKey(readTimeTableKey(['users', ITEM]))).toBeNull();
        expect(parseDocumentKey(readTimeTableKey(['items', ITEM, 'accounts']))).toBeNull();
      });

      test('iterateDocuments emits no odd-segment or sibling-table document', async () => {
        const dbPath = path.join(FIXTURES_DIR, 'parity-db');
        const { ClassicLevel } = await import('classic-level');
        const db = new ClassicLevel<Buffer, Buffer>(dbPath, {
          keyEncoding: 'buffer',
          valueEncoding: 'buffer',
          createIfMissing: true,
        });
        await db.open();
        // A NON-empty value on every key: a misparsed key with real fields is
        // exactly the case processor fields.size guards cannot neutralise.
        const value = encodeFirestoreDocument({ name: 'Synthetic', amount: 100 });
        for (const { key } of KEYS) await db.put(key, value);
        await db.close();

        const emitted: string[] = [];
        for await (const doc of iterateDocuments(dbPath)) {
          emitted.push(`${doc.collection}/${doc.documentId}`);
        }
        const odd = emitted.filter((p) => !isDocumentPathParity(p.slice(0, p.lastIndexOf('/'))));
        expect(odd).toEqual([]);
        expect(emitted.sort()).toEqual(
          [
            `users/${ITEM}`,
            `items/${ITEM}/accounts/${ACCOUNT}`,
            `items/${ITEM}/accounts/${ACCOUNT}/transactions/tx1`,
          ].sort()
        );
      });

      test('auditDocumentTable counts only document-table keys, and the rejected ones with data', async () => {
        const dbPath = path.join(FIXTURES_DIR, 'parity-audit-db');
        const { ClassicLevel } = await import('classic-level');
        const db = new ClassicLevel<Buffer, Buffer>(dbPath, {
          keyEncoding: 'buffer',
          valueEncoding: 'buffer',
          createIfMissing: true,
        });
        await db.open();
        const value = encodeFirestoreDocument({ name: 'Synthetic', amount: 100 });
        for (const { key } of KEYS) await db.put(key, value);
        // A rejected document-table key with an EMPTY value is not data loss.
        await db.put(documentTableKey(['items', ITEM, 'holdings_history']), Buffer.alloc(0));
        await db.close();

        // 5 document-table keys in KEYS plus the empty one; the 4 read_time
        // keys are outside the table's range. Rejected with data: the 3- and
        // 5-segment document-table keys.
        expect(await auditDocumentTable(dbPath)).toEqual({ tableKeys: 6, rejectedNonEmpty: 2 });
      });

      test('a non-ASCII segment is kept, so it does not flip parity and drop the document', () => {
        // 0xC4 0x80 is 'Ā': its second byte is the 0x80 the parser used to stop at.
        expect(parseDocumentKey(documentTableKey(['users', ITEM, 'tags', 'Āb€']))).toEqual({
          collection: `users/${ITEM}/tags`,
          documentId: 'Āb€',
        });
      });

      test('an unreadable segment rejects the key rather than shortening the path', () => {
        // Two complete segments plus a truncated one: skipping the truncated
        // one would leave an EVEN count and hand back the different document
        // users/u1.
        const truncated = Buffer.concat([
          stringComponent(0x85, 'remote_document'),
          stringComponent(0xbe, 'users'),
          stringComponent(0xbe, 'u1'),
          Buffer.from([0xbe]),
          Buffer.from('tags', 'utf8'),
        ]);
        expect(parseDocumentKey(truncated)).toBeNull();
        // Same with a control character in the third segment.
        const control = Buffer.concat([
          stringComponent(0x85, 'remote_document'),
          stringComponent(0xbe, 'users'),
          stringComponent(0xbe, 'u1'),
          stringComponent(0xbe, 'ta\x07gs'),
          Buffer.from([0x80]),
        ]);
        expect(parseDocumentKey(control)).toBeNull();
      });

      test('a table name followed by 0x00 and a byte other than 0x01 is not the table', () => {
        // 0x00 0xFF is ordered-code's escape for a literal NUL inside a string,
        // so the name continues past `remote_document`.
        const key = Buffer.concat([
          Buffer.from([0x85]),
          Buffer.from('remote_document', 'utf8'),
          Buffer.from([0x00, 0xff]),
          Buffer.from('x', 'utf8'),
          Buffer.from([0x00, 0x01]),
          stringComponent(0xbe, 'users'),
          stringComponent(0xbe, ITEM),
          Buffer.from([0x80]),
        ]);
        expect(parseDocumentKey(key)).toBeNull();
      });

      test('an unterminated trailing segment is not a segment', () => {
        // A truncated key: the last string has no 0x00 0x01 terminator.
        const truncated = Buffer.concat([
          stringComponent(0x85, 'remote_document'),
          stringComponent(0xbe, 'users'),
          stringComponent(0xbe, 'u1'),
          stringComponent(0xbe, 'tags'),
          Buffer.from([0xbe]),
          Buffer.from('tag1', 'utf8'),
          Buffer.from([0x80]),
        ]);
        expect(parseDocumentKey(truncated)).toBeNull();
      });

      test('the string-path format rejects a sibling table too', () => {
        const sibling =
          'remote_document_read_time/projects/p/databases/(default)/documents/users/u1';
        // The string overload, not just the Buffer one.
        expect(parseDocumentKey(sibling)).toBeNull();
        expect(
          parseDocumentKey(
            Buffer.from(
              'remote_document_read_time/projects/p/databases/(default)/documents/users/u1',
              'utf8'
            )
          )
        ).toBeNull();
        expect(
          parseDocumentKey(
            Buffer.from('remote_document/projects/p/databases/(default)/documents/users/u1', 'utf8')
          )
        ).toEqual({ collection: 'users', documentId: 'u1' });
      });

      test('isDocumentTableKey tells the document table from its sibling', () => {
        expect(isDocumentTableKey(documentTableKey(['users', ITEM]).toString('utf8'))).toBe(true);
        expect(isDocumentTableKey(readTimeTableKey(['users']).toString('utf8'))).toBe(false);
        expect(
          isDocumentTableKey('remote_document/projects/p/databases/(default)/documents/users/u1')
        ).toBe(true);
        expect(isDocumentTableKey('target_document')).toBe(false);
      });
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

      // Iterate to create a temp copy (populates the cache)
      const docs = [];
      for await (const doc of iterateDocuments(dbPath)) {
        docs.push(doc);
      }
      expect(_getTempDbCache().size).toBeGreaterThan(0);

      // Clean up all temp databases
      cleanupAllTempDatabases();

      // Verify the cache is actually emptied
      expect(_getTempDbCache().size).toBe(0);
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

    test('invalidates cache when source database changes', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'cache-invalidate-db');
      await createTestDatabase(dbPath, [
        { collection: 'transactions', id: 'txn-1', fields: { amount: 1.11 } },
      ]);

      // First iteration populates the temp cache.
      let count1 = 0;
      for await (const _doc of iterateDocuments(dbPath)) count1++;
      expect(count1).toBe(1);

      // Mutate the source: delete the only document.
      const reader = new LevelDBReader(dbPath);
      await reader.open();
      await reader.deleteDocument('transactions', 'txn-1');
      await reader.close();

      // Guard against rare filesystems with 1-second mtime granularity:
      // ensure the source's post-mutation mtime is strictly greater than
      // the fingerprint snapshotted by the first iteration. APFS/ext4
      // give sub-millisecond resolution, but a few ms here costs nothing.
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second iteration must reflect the deletion, not return the stale snapshot.
      let count2 = 0;
      for await (const _doc of iterateDocuments(dbPath)) count2++;
      expect(count2).toBe(0);
    });
  });

  describe('compaction TOCTOU resilience', () => {
    // Simulate a LevelDB compaction deleting an .ldb between readdir and the
    // per-file stat/copyFile call by stubbing readdirSync to inject a phantom
    // filename that doesn't exist on disk. Real readdir/stat/copyFile are used
    // for everything else, so the genuine race is reproduced exactly: the
    // listing contains a name, the per-file syscall hits ENOENT.

    function injectPhantom(targetDir: string, phantom: string): () => void {
      const original = fs.readdirSync;
      (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = ((
        p: fs.PathLike,
        opts?: Parameters<typeof fs.readdirSync>[1]
      ) => {
        const real = (original as (p: fs.PathLike, opts?: unknown) => unknown)(p, opts);
        if (typeof p === 'string' && path.resolve(p) === path.resolve(targetDir)) {
          return [...(real as string[]), phantom];
        }
        return real;
      }) as typeof fs.readdirSync;
      return () => {
        (fs as { readdirSync: typeof fs.readdirSync }).readdirSync = original;
      };
    }

    test('copy loop skips files that vanish between readdir and copyFile', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'copy-toctou-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      // First call exercises the copy loop. Phantom must be ignored.
      const restore = injectPhantom(dbPath, 'vanished-9999.ldb');
      try {
        const docs = [];
        for await (const doc of iterateDocuments(dbPath)) docs.push(doc);
        expect(docs.length).toBe(1);
      } finally {
        restore();
      }
    });

    test('sourceFingerprint skips files that vanish between readdir and stat', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'fingerprint-toctou-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      // Prime the temp cache so the next call goes through the fingerprint
      // (cache-hit) path rather than the copy loop.
      for await (const _doc of iterateDocuments(dbPath)) {
        // drain
      }

      const restore = injectPhantom(dbPath, 'vanished-9999.ldb');
      try {
        const docs = [];
        for await (const doc of iterateDocuments(dbPath)) docs.push(doc);
        expect(docs.length).toBe(1);
      } finally {
        restore();
      }
    });

    test('sourceFingerprint propagates non-ENOENT stat errors', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'fingerprint-eacces-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      // Prime cache so the next call goes through sourceFingerprint.
      for await (const _doc of iterateDocuments(dbPath)) {
        // drain
      }

      const originalStat = fs.statSync;
      (fs as { statSync: typeof fs.statSync }).statSync = ((
        p: fs.PathLike,
        opts?: Parameters<typeof fs.statSync>[1]
      ) => {
        // Throw on any per-file stat inside the source DB directory; allow
        // the directory-itself stat through so we hit the per-file branch.
        if (typeof p === 'string' && p.startsWith(dbPath + path.sep)) {
          const err: NodeJS.ErrnoException = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return (originalStat as (p: fs.PathLike, opts?: unknown) => fs.Stats)(p, opts);
      }) as typeof fs.statSync;

      try {
        const gen = iterateDocuments(dbPath);
        await expect(gen.next()).rejects.toThrow('permission denied');
      } finally {
        (fs as { statSync: typeof fs.statSync }).statSync = originalStat;
      }
    });

    test('copy loop propagates non-ENOENT copy errors', async () => {
      const dbPath = path.join(FIXTURES_DIR, 'copy-eacces-db');
      await createTestDatabase(dbPath, [{ collection: 'test', id: 'doc1', fields: { x: 1 } }]);

      const originalCopy = fs.copyFileSync;
      (fs as { copyFileSync: typeof fs.copyFileSync }).copyFileSync = ((
        src: fs.PathLike,
        dest: fs.PathLike,
        mode?: number
      ) => {
        // Throw on any copy out of the source DB directory.
        if (typeof src === 'string' && src.startsWith(dbPath + path.sep)) {
          const err: NodeJS.ErrnoException = new Error('permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return (originalCopy as (s: fs.PathLike, d: fs.PathLike, m?: number) => void)(
          src,
          dest,
          mode
        );
      }) as typeof fs.copyFileSync;

      try {
        const gen = iterateDocuments(dbPath);
        await expect(gen.next()).rejects.toThrow('permission denied');
      } finally {
        (fs as { copyFileSync: typeof fs.copyFileSync }).copyFileSync = originalCopy;
      }
    });
  });
});
