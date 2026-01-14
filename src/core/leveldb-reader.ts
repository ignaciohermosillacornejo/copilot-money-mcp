/**
 * LevelDB reader for Copilot Money Firestore data.
 *
 * This module provides proper iteration over LevelDB databases using the
 * classic-level library, eliminating the need for raw binary file parsing.
 *
 * Firestore stores documents with keys like:
 * remote_document/projects/{project}/databases/(default)/documents/{collection}/{doc_id}
 */

import { ClassicLevel } from 'classic-level';
import fs from 'node:fs';
import {
  parseFirestoreDocument,
  toPlainObject,
  encodeFirestoreDocument,
  type FirestoreValue,
} from './protobuf-parser.js';

/**
 * A parsed document from the LevelDB database.
 */
export interface LevelDBDocument {
  /** The full LevelDB key */
  key: string;
  /** The Firestore collection name (e.g., "transactions", "accounts") */
  collection: string;
  /** The document ID within the collection */
  documentId: string;
  /** The raw protobuf bytes (for debugging) */
  rawValue: Buffer;
  /** Parsed Firestore fields */
  fields: Map<string, FirestoreValue>;
}

/**
 * Options for opening a LevelDB database.
 */
export interface OpenOptions {
  /** Open in read-only mode (default: true) */
  readOnly?: boolean;
  /** Create if missing (default: false) */
  createIfMissing?: boolean;
}

/**
 * Options for iterating documents.
 */
export interface IterateOptions {
  /** Only include documents from this collection */
  collection?: string;
  /** Only include documents matching this key prefix */
  keyPrefix?: string;
  /** Limit the number of documents returned */
  limit?: number;
}

/**
 * Regex to parse Firestore document keys.
 * Expected format: remote_document/.../documents/{collection}/{doc_id}
 */
const DOCUMENT_KEY_REGEX = /documents\/([^/]+)\/([^/]+)$/;

/**
 * Alternative key format for subcollections.
 * Expected format: .../documents/{parent_collection}/{parent_id}/{sub_collection}/{doc_id}
 */
const SUBCOLLECTION_KEY_REGEX = /documents\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * Parse a LevelDB key to extract collection and document ID.
 */
export function parseDocumentKey(key: string): { collection: string; documentId: string } | null {
  // Try subcollection pattern first (more specific)
  const subMatch = key.match(SUBCOLLECTION_KEY_REGEX);
  if (subMatch && subMatch[1] && subMatch[2] && subMatch[3] && subMatch[4]) {
    // For subcollections, return the full path as collection
    // e.g., "users/abc123/categories" with doc id "xyz789"
    return {
      collection: `${subMatch[1]}/${subMatch[2]}/${subMatch[3]}`,
      documentId: subMatch[4],
    };
  }

  // Try simple collection pattern
  const match = key.match(DOCUMENT_KEY_REGEX);
  if (match && match[1] && match[2]) {
    return {
      collection: match[1],
      documentId: match[2],
    };
  }

  return null;
}

/**
 * Open a LevelDB database and iterate through Firestore documents.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param options - Iteration options
 * @yields LevelDBDocument objects
 */
export async function* iterateDocuments(
  dbPath: string,
  options: IterateOptions = {}
): AsyncGenerator<LevelDBDocument> {
  const { collection: filterCollection, keyPrefix, limit } = options;

  // Validate path exists
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database path not found');
  }

  // Validate path is a directory
  const stats = fs.statSync(dbPath);
  if (!stats.isDirectory()) {
    throw new Error('Path is not a directory');
  }

  // Open database in read-only mode
  const db = new ClassicLevel<string, Buffer>(dbPath, {
    createIfMissing: false,
    keyEncoding: 'utf8',
    valueEncoding: 'buffer',
  });

  try {
    let count = 0;

    for await (const [key, value] of db.iterator()) {
      // Check limit
      if (limit !== undefined && count >= limit) {
        break;
      }

      // Check key prefix filter
      if (keyPrefix && !key.startsWith(keyPrefix)) {
        continue;
      }

      // Skip non-document keys
      if (!key.includes('documents/')) {
        continue;
      }

      // Parse the key
      const parsed = parseDocumentKey(key);
      if (!parsed) {
        continue;
      }

      // Check collection filter
      if (filterCollection) {
        // Match either exact collection or subcollection ending with the filter
        const isMatch =
          parsed.collection === filterCollection ||
          parsed.collection.endsWith(`/${filterCollection}`);
        if (!isMatch) {
          continue;
        }
      }

      // Parse the protobuf value
      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key,
          collection: parsed.collection,
          documentId: parsed.documentId,
          rawValue: value,
          fields,
        };

        count++;
      } catch {
        // Skip documents that fail to parse
        // This can happen if the protobuf is corrupted or uses an unknown format
        continue;
      }
    }
  } finally {
    await db.close();
  }
}

/**
 * Get all documents from a collection.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @param collection - Collection name to filter by
 * @returns Array of parsed documents
 */
export async function getCollection(
  dbPath: string,
  collection: string
): Promise<LevelDBDocument[]> {
  const documents: LevelDBDocument[] = [];

  for await (const doc of iterateDocuments(dbPath, { collection })) {
    documents.push(doc);
  }

  return documents;
}

/**
 * Get all documents and group them by collection.
 *
 * @param dbPath - Path to the LevelDB database directory
 * @returns Map of collection names to document arrays
 */
export async function getAllCollections(dbPath: string): Promise<Map<string, LevelDBDocument[]>> {
  const collections = new Map<string, LevelDBDocument[]>();

  for await (const doc of iterateDocuments(dbPath)) {
    const existing = collections.get(doc.collection) ?? [];
    existing.push(doc);
    collections.set(doc.collection, existing);
  }

  return collections;
}

/**
 * Convert a LevelDBDocument to a plain JavaScript object.
 */
export function documentToObject(doc: LevelDBDocument): Record<string, unknown> {
  return {
    _id: doc.documentId,
    _collection: doc.collection,
    ...toPlainObject(doc.fields),
  };
}

/**
 * A wrapper class for working with LevelDB databases.
 */
export class LevelDBReader {
  private db: ClassicLevel<string, Buffer> | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /**
   * Open the database.
   */
  async open(options: OpenOptions = {}): Promise<void> {
    const { createIfMissing = false } = options;
    // Note: readOnly option is accepted but classic-level doesn't support it directly
    // Read-only behavior is achieved by not performing writes

    this.db = new ClassicLevel<string, Buffer>(this.dbPath, {
      createIfMissing,
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
    });
    // Wait for database to be ready
    await this.db.open();
  }

  /**
   * Close the database.
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if the database is open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Iterate through all documents.
   */
  async *iterate(options: IterateOptions = {}): AsyncGenerator<LevelDBDocument> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    const { collection: filterCollection, keyPrefix, limit } = options;
    let count = 0;

    for await (const [key, value] of this.db.iterator()) {
      if (limit !== undefined && count >= limit) {
        break;
      }

      if (keyPrefix && !key.startsWith(keyPrefix)) {
        continue;
      }

      if (!key.includes('documents/')) {
        continue;
      }

      const parsed = parseDocumentKey(key);
      if (!parsed) {
        continue;
      }

      if (filterCollection) {
        const isMatch =
          parsed.collection === filterCollection ||
          parsed.collection.endsWith(`/${filterCollection}`);
        if (!isMatch) {
          continue;
        }
      }

      try {
        const fields = parseFirestoreDocument(value);

        yield {
          key,
          collection: parsed.collection,
          documentId: parsed.documentId,
          rawValue: value,
          fields,
        };

        count++;
      } catch {
        continue;
      }
    }
  }

  /**
   * Get all documents from a collection.
   */
  async getCollection(collection: string): Promise<LevelDBDocument[]> {
    const documents: LevelDBDocument[] = [];

    for await (const doc of this.iterate({ collection })) {
      documents.push(doc);
    }

    return documents;
  }

  /**
   * Get a specific document by collection and ID.
   */
  async getDocument(collection: string, documentId: string): Promise<LevelDBDocument | null> {
    for await (const doc of this.iterate({ collection })) {
      if (doc.documentId === documentId) {
        return doc;
      }
    }
    return null;
  }

  /**
   * Put a document into the database (for testing purposes).
   */
  async putDocument(
    collection: string,
    documentId: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    // Create the key
    const key = `remote_document/projects/copilot-production-22904/databases/(default)/documents/${collection}/${documentId}`;

    // Encode the document
    const value = encodeFirestoreDocument(fields);

    await this.db.put(key, value);
  }

  /**
   * Delete a document from the database (for testing purposes).
   */
  async deleteDocument(collection: string, documentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not open. Call open() first.');
    }

    const key = `remote_document/projects/copilot-production-22904/databases/(default)/documents/${collection}/${documentId}`;
    await this.db.del(key);
  }
}

/**
 * Create a new LevelDB database for testing.
 */
export async function createTestDatabase(
  dbPath: string,
  documents: Array<{ collection: string; id: string; fields: Record<string, unknown> }>
): Promise<void> {
  const reader = new LevelDBReader(dbPath);
  await reader.open({ readOnly: false, createIfMissing: true });

  try {
    for (const doc of documents) {
      await reader.putDocument(doc.collection, doc.id, doc.fields);
    }
  } finally {
    await reader.close();
  }
}
