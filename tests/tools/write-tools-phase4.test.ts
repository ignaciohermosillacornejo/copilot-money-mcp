/**
 * E2E tests for the remaining 8 write tools.
 *
 * Covers: setTransactionCategory, setTransactionNote, setTransactionTags,
 * reviewTransactions, createTag, deleteTag, createCategory.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { CopilotDatabase } from '../../src/core/database.js';

// ============================================
// Shared mock helpers
// ============================================

interface UpdateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
  mask: string[];
}

interface CreateCall {
  collection: string;
  docId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fields: any;
}

interface DeleteCall {
  collection: string;
  docId: string;
}

function makeMockFirestoreClient(opts?: {
  updateCalls?: UpdateCall[];
  createCalls?: CreateCall[];
  deleteCalls?: DeleteCall[];
}) {
  const updateCalls = opts?.updateCalls ?? [];
  const createCalls = opts?.createCalls ?? [];
  const deleteCalls = opts?.deleteCalls ?? [];

  return {
    requireUserId: async () => 'user123',
    getUserId: () => 'user123',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
      updateCalls.push({ collection, docId, fields, mask });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createDocument: async (collection: string, docId: string, fields: any) => {
      createCalls.push({ collection, docId, fields });
    },
    deleteDocument: async (collection: string, docId: string) => {
      deleteCalls.push({ collection, docId });
    },
  };
}

const SAMPLE_TXN = {
  transaction_id: 'txn1',
  amount: 50,
  date: '2024-01-15',
  name: 'Coffee Shop',
  category_id: 'food_and_drink',
  user_id: 'user123',
  item_id: 'item1',
  account_id: 'acct1',
  excluded: false,
  user_note: 'Morning coffee',
  tag_ids: ['business'],
  user_reviewed: false,
};

const SAMPLE_TXN_2 = {
  transaction_id: 'txn2',
  amount: 100,
  date: '2024-01-16',
  name: 'Uber',
  category_id: 'transportation',
  user_id: 'user123',
  item_id: 'item1',
  account_id: 'acct1',
  excluded: false,
  user_reviewed: false,
};

const SAMPLE_TXN_NO_PATH = {
  transaction_id: 'txn_no_path',
  amount: 25,
  date: '2024-01-17',
  name: 'Orphan',
  // Missing item_id and account_id
};

// ============================================
// setTransactionCategory
// ============================================

describe('setTransactionCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._userCategories = [
      { category_id: 'food_and_drink', name: 'Food & Drink', user_id: 'user123' },
      { category_id: 'shopping', name: 'Shopping', user_id: 'user123' },
    ];

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('changes category successfully', async () => {
    const result = await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.old_category_id).toBe('food_and_drink');
    expect(result.new_category_id).toBe('shopping');
  });

  test('returns category names in response', async () => {
    const result = await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping',
    });
    expect(result.new_category_name).toBe('Shopping');
  });

  test('calls Firestore with correct path and mask', async () => {
    await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping',
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('items/item1/accounts/acct1/transactions');
    expect(updateCalls[0].docId).toBe('txn1');
    expect(updateCalls[0].mask).toEqual(['category_id']);
  });

  test('throws on invalid category_id format', async () => {
    await expect(
      tools.setTransactionCategory({ transaction_id: 'txn1', category_id: 'bad/id' })
    ).rejects.toThrow('Invalid category_id format');
  });

  test('throws when category not found', async () => {
    await expect(
      tools.setTransactionCategory({ transaction_id: 'txn1', category_id: 'nonexistent' })
    ).rejects.toThrow('Category not found: nonexistent');
  });

  test('throws when transaction not found', async () => {
    await expect(
      tools.setTransactionCategory({ transaction_id: 'missing', category_id: 'shopping' })
    ).rejects.toThrow('Transaction not found: missing');
  });

  test('throws on invalid transaction_id format', async () => {
    await expect(
      tools.setTransactionCategory({ transaction_id: 'bad/id', category_id: 'shopping' })
    ).rejects.toThrow('Invalid transaction_id format');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.setTransactionCategory({ transaction_id: 'txn1', category_id: 'shopping' })
    ).rejects.toThrow('Write mode is not enabled');
  });
});

// ============================================
// setTransactionNote
// ============================================

describe('setTransactionNote', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('sets a note on a transaction', async () => {
    const result = await tools.setTransactionNote({
      transaction_id: 'txn1',
      note: 'Lunch meeting with client',
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.old_note).toBe('Morning coffee');
    expect(result.new_note).toBe('Lunch meeting with client');
  });

  test('clears a note with empty string', async () => {
    const result = await tools.setTransactionNote({
      transaction_id: 'txn1',
      note: '',
    });
    expect(result.success).toBe(true);
    expect(result.old_note).toBe('Morning coffee');
    expect(result.new_note).toBe('');
  });

  test('calls Firestore with user_note field', async () => {
    await tools.setTransactionNote({
      transaction_id: 'txn1',
      note: 'New note',
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask).toEqual(['user_note']);
    expect(updateCalls[0].collection).toBe('items/item1/accounts/acct1/transactions');
  });

  test('returns empty old_note when transaction has no prior note', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN, user_note: undefined }];
    const result = await tools.setTransactionNote({
      transaction_id: 'txn1',
      note: 'First note',
    });
    expect(result.old_note).toBe('');
  });

  test('throws when transaction not found', async () => {
    await expect(
      tools.setTransactionNote({ transaction_id: 'missing', note: 'test' })
    ).rejects.toThrow('Transaction not found: missing');
  });

  test('throws on invalid transaction_id format', async () => {
    await expect(
      tools.setTransactionNote({ transaction_id: 'bad/id', note: 'test' })
    ).rejects.toThrow('Invalid transaction_id format');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.setTransactionNote({ transaction_id: 'txn1', note: 'test' })
    ).rejects.toThrow('Write mode is not enabled');
  });
});

// ============================================
// setTransactionTags
// ============================================

describe('setTransactionTags', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('sets tags on a transaction', async () => {
    const result = await tools.setTransactionTags({
      transaction_id: 'txn1',
      tag_ids: ['vacation', 'personal'],
    });
    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.old_tag_ids).toEqual(['business']);
    expect(result.new_tag_ids).toEqual(['vacation', 'personal']);
  });

  test('clears all tags with empty array', async () => {
    const result = await tools.setTransactionTags({
      transaction_id: 'txn1',
      tag_ids: [],
    });
    expect(result.success).toBe(true);
    expect(result.old_tag_ids).toEqual(['business']);
    expect(result.new_tag_ids).toEqual([]);
  });

  test('calls Firestore with tag_ids field', async () => {
    await tools.setTransactionTags({
      transaction_id: 'txn1',
      tag_ids: ['vacation'],
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].mask).toEqual(['tag_ids']);
  });

  test('returns empty old_tag_ids when transaction has none', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN, tag_ids: undefined }];
    const result = await tools.setTransactionTags({
      transaction_id: 'txn1',
      tag_ids: ['new_tag'],
    });
    expect(result.old_tag_ids).toEqual([]);
  });

  test('throws on invalid tag_id format', async () => {
    await expect(
      tools.setTransactionTags({ transaction_id: 'txn1', tag_ids: ['good', 'bad/id'] })
    ).rejects.toThrow('Invalid tag_id format');
  });

  test('throws when transaction not found', async () => {
    await expect(
      tools.setTransactionTags({ transaction_id: 'missing', tag_ids: ['tag1'] })
    ).rejects.toThrow('Transaction not found: missing');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(
      readOnlyTools.setTransactionTags({ transaction_id: 'txn1', tag_ids: ['tag1'] })
    ).rejects.toThrow('Write mode is not enabled');
  });
});

// ============================================
// reviewTransactions
// ============================================

describe('reviewTransactions', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let updateCalls: UpdateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN }, { ...SAMPLE_TXN_2 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();

    updateCalls = [];
    const mockClient = makeMockFirestoreClient({ updateCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('marks a single transaction as reviewed', async () => {
    const result = await tools.reviewTransactions({
      transaction_ids: ['txn1'],
    });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
    expect(result.transaction_ids).toEqual(['txn1']);
  });

  test('marks multiple transactions as reviewed', async () => {
    const result = await tools.reviewTransactions({
      transaction_ids: ['txn1', 'txn2'],
    });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(2);
    expect(result.transaction_ids).toEqual(['txn1', 'txn2']);
  });

  test('defaults reviewed to true', async () => {
    await tools.reviewTransactions({ transaction_ids: ['txn1'] });
    expect(updateCalls).toHaveLength(1);
    // The fields should contain user_reviewed: true
    expect(updateCalls[0].mask).toEqual(['user_reviewed']);
  });

  test('can mark transactions as unreviewed', async () => {
    const result = await tools.reviewTransactions({
      transaction_ids: ['txn1'],
      reviewed: false,
    });
    expect(result.success).toBe(true);
    expect(result.reviewed_count).toBe(1);
  });

  test('calls Firestore for each transaction', async () => {
    await tools.reviewTransactions({
      transaction_ids: ['txn1', 'txn2'],
    });
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].collection).toBe('items/item1/accounts/acct1/transactions');
    expect(updateCalls[0].docId).toBe('txn1');
    expect(updateCalls[1].docId).toBe('txn2');
  });

  test('throws on empty transaction_ids array', async () => {
    await expect(tools.reviewTransactions({ transaction_ids: [] })).rejects.toThrow(
      'transaction_ids must be a non-empty array'
    );
  });

  test('throws when a transaction is not found', async () => {
    await expect(
      tools.reviewTransactions({ transaction_ids: ['txn1', 'missing'] })
    ).rejects.toThrow('Transaction not found: missing');
  });

  test('throws on invalid transaction_id format', async () => {
    await expect(tools.reviewTransactions({ transaction_ids: ['bad/id'] })).rejects.toThrow(
      'Invalid transaction_id format'
    );
  });

  test('throws when transaction is missing Firestore path fields', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ ...SAMPLE_TXN }, { ...SAMPLE_TXN_NO_PATH }];
    await expect(tools.reviewTransactions({ transaction_ids: ['txn_no_path'] })).rejects.toThrow(
      'missing item_id or account_id'
    );
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.reviewTransactions({ transaction_ids: ['txn1'] })).rejects.toThrow(
      'Write mode is not enabled'
    );
  });
});

// ============================================
// createTag
// ============================================

describe('createTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let createCalls: CreateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._tags = [{ tag_id: 'business', name: 'Business' }];

    createCalls = [];
    const mockClient = makeMockFirestoreClient({ createCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('creates a tag with name only', async () => {
    const result = await tools.createTag({ name: 'Vacation' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('vacation');
    expect(result.name).toBe('Vacation');
    expect(result.color_name).toBeUndefined();
    expect(result.hex_color).toBeUndefined();
  });

  test('creates a tag with color', async () => {
    const result = await tools.createTag({
      name: 'Personal',
      color_name: 'blue',
      hex_color: '#0000FF',
    });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('personal');
    expect(result.color_name).toBe('blue');
    expect(result.hex_color).toBe('#0000FF');
  });

  test('generates deterministic tag_id from name', async () => {
    const result = await tools.createTag({ name: 'Work Trip' });
    expect(result.tag_id).toBe('work_trip');
  });

  test('strips special characters from tag_id', async () => {
    const result = await tools.createTag({ name: 'café & bar' });
    expect(result.tag_id).toBe('caf__bar');
  });

  test('calls Firestore createDocument with correct path', async () => {
    await tools.createTag({ name: 'Vacation' });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].collection).toBe('users/user123/tags');
    expect(createCalls[0].docId).toBe('vacation');
  });

  test('includes color fields in Firestore document when provided', async () => {
    await tools.createTag({ name: 'Personal', color_name: 'red', hex_color: '#FF0000' });
    const fields = createCalls[0].fields;
    expect(fields.name).toEqual({ stringValue: 'Personal' });
    expect(fields.color_name).toEqual({ stringValue: 'red' });
    expect(fields.hex_color).toEqual({ stringValue: '#FF0000' });
  });

  test('omits color fields from Firestore document when not provided', async () => {
    await tools.createTag({ name: 'Vacation' });
    const fields = createCalls[0].fields;
    expect(fields.name).toEqual({ stringValue: 'Vacation' });
    expect(fields.color_name).toBeUndefined();
    expect(fields.hex_color).toBeUndefined();
  });

  test('clears cache after creating tag', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.createTag({ name: 'Vacation' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('trims whitespace from name', async () => {
    const result = await tools.createTag({ name: '  Vacation  ' });
    expect(result.name).toBe('Vacation');
  });

  test('throws on empty name', async () => {
    await expect(tools.createTag({ name: '' })).rejects.toThrow('Tag name must not be empty');
  });

  test('throws on whitespace-only name', async () => {
    await expect(tools.createTag({ name: '   ' })).rejects.toThrow('Tag name must not be empty');
  });

  test('throws on duplicate tag', async () => {
    await expect(tools.createTag({ name: 'Business' })).rejects.toThrow(
      'Tag "Business" already exists'
    );
  });

  test('throws on invalid hex_color format', async () => {
    await expect(tools.createTag({ name: 'Test', hex_color: 'red' })).rejects.toThrow(
      'Invalid color format'
    );
  });

  test('throws on short hex_color', async () => {
    await expect(tools.createTag({ name: 'Test', hex_color: '#FFF' })).rejects.toThrow(
      'Invalid color format'
    );
  });

  test('throws when name produces empty tag_id', async () => {
    await expect(tools.createTag({ name: '!!!' })).rejects.toThrow(
      'Cannot generate a valid tag_id'
    );
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.createTag({ name: 'Test' })).rejects.toThrow(
      'Write mode is not enabled'
    );
  });
});

// ============================================
// deleteTag
// ============================================

describe('deleteTag', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let deleteCalls: DeleteCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._tags = [
      { tag_id: 'vacation', name: 'Vacation' },
      { tag_id: 'business', name: 'Business' },
    ];

    deleteCalls = [];
    const mockClient = makeMockFirestoreClient({ deleteCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('deletes a tag successfully', async () => {
    const result = await tools.deleteTag({ tag_id: 'vacation' });
    expect(result.success).toBe(true);
    expect(result.tag_id).toBe('vacation');
    expect(result.deleted_name).toBe('Vacation');
  });

  test('calls Firestore deleteDocument with correct path', async () => {
    await tools.deleteTag({ tag_id: 'vacation' });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].collection).toBe('users/user123/tags');
    expect(deleteCalls[0].docId).toBe('vacation');
  });

  test('clears cache after deleting tag', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.deleteTag({ tag_id: 'vacation' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('throws when tag not found', async () => {
    await expect(tools.deleteTag({ tag_id: 'nonexistent' })).rejects.toThrow(
      'Tag not found: nonexistent'
    );
  });

  test('throws on invalid tag_id format', async () => {
    await expect(tools.deleteTag({ tag_id: 'bad/id' })).rejects.toThrow('Invalid tag_id format');
  });

  test('returns tag_id as deleted_name when tag has no name', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._tags = [{ tag_id: 'nameless' }];
    const result = await tools.deleteTag({ tag_id: 'nameless' });
    expect(result.deleted_name).toBe('nameless');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.deleteTag({ tag_id: 'vacation' })).rejects.toThrow(
      'Write mode is not enabled'
    );
  });
});

// ============================================
// createCategory
// ============================================

describe('createCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let createCalls: CreateCall[];

  beforeEach(() => {
    mockDb = new CopilotDatabase('/nonexistent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any).dbPath = '/fake';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._allCollectionsLoaded = true;
    (mockDb as any)._cacheLoadedAt = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._userCategories = [
      { category_id: 'food_and_drink', name: 'Food & Drink', user_id: 'user123' },
    ];

    createCalls = [];
    const mockClient = makeMockFirestoreClient({ createCalls });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = new CopilotMoneyTools(mockDb, mockClient as any);
  });

  test('creates a category with name only', async () => {
    const result = await tools.createCategory({ name: 'Hobbies' });
    expect(result.success).toBe(true);
    expect(result.category_id).toMatch(/^custom_/);
    expect(result.name).toBe('Hobbies');
    expect(result.excluded).toBe(false);
  });

  test('creates a category with all optional fields', async () => {
    const result = await tools.createCategory({
      name: 'Subscriptions',
      emoji: '📺',
      color: '#FF5500',
      parent_category_id: 'food_and_drink',
      excluded: true,
    });
    expect(result.success).toBe(true);
    expect(result.name).toBe('Subscriptions');
    expect(result.emoji).toBe('📺');
    expect(result.color).toBe('#FF5500');
    expect(result.parent_category_id).toBe('food_and_drink');
    expect(result.excluded).toBe(true);
  });

  test('calls Firestore createDocument with correct path', async () => {
    const result = await tools.createCategory({ name: 'Hobbies' });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].collection).toBe('users/user123/categories');
    expect(createCalls[0].docId).toBe(result.category_id);
  });

  test('includes optional fields in Firestore document', async () => {
    await tools.createCategory({
      name: 'Subscriptions',
      emoji: '📺',
      color: '#FF5500',
    });
    const fields = createCalls[0].fields;
    expect(fields.name).toEqual({ stringValue: 'Subscriptions' });
    expect(fields.emoji).toEqual({ stringValue: '📺' });
    expect(fields.color).toEqual({ stringValue: '#FF5500' });
  });

  test('omits optional fields from Firestore when not provided', async () => {
    await tools.createCategory({ name: 'Hobbies' });
    const fields = createCalls[0].fields;
    expect(fields.emoji).toBeUndefined();
    expect(fields.color).toBeUndefined();
    expect(fields.parent_category_id).toBeUndefined();
  });

  test('clears cache after creating category', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1', amount: 10, date: '2024-01-01' }];
    await tools.createCategory({ name: 'Hobbies' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).toBeNull();
  });

  test('trims whitespace from name', async () => {
    const result = await tools.createCategory({ name: '  Hobbies  ' });
    expect(result.name).toBe('Hobbies');
  });

  test('defaults excluded to false', async () => {
    const result = await tools.createCategory({ name: 'Hobbies' });
    expect(result.excluded).toBe(false);
  });

  test('throws on empty name', async () => {
    await expect(tools.createCategory({ name: '' })).rejects.toThrow(
      'Category name must not be empty'
    );
  });

  test('throws on whitespace-only name', async () => {
    await expect(tools.createCategory({ name: '   ' })).rejects.toThrow(
      'Category name must not be empty'
    );
  });

  test('throws on duplicate name (case-insensitive)', async () => {
    await expect(tools.createCategory({ name: 'food & drink' })).rejects.toThrow(
      'Category with name "food & drink" already exists'
    );
  });

  test('throws when parent category not found', async () => {
    await expect(
      tools.createCategory({ name: 'Hobbies', parent_category_id: 'nonexistent' })
    ).rejects.toThrow('Parent category not found: nonexistent');
  });

  test('throws on invalid parent_category_id format', async () => {
    await expect(
      tools.createCategory({ name: 'Hobbies', parent_category_id: 'bad/id' })
    ).rejects.toThrow('Invalid parent_category_id format');
  });

  test('throws on invalid color format', async () => {
    await expect(tools.createCategory({ name: 'Hobbies', color: 'red' })).rejects.toThrow(
      'Invalid color format'
    );
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);
    await expect(readOnlyTools.createCategory({ name: 'Hobbies' })).rejects.toThrow(
      'Write mode is not enabled'
    );
  });

  test('does not modify cache on Firestore error', async () => {
    const failingClient = {
      requireUserId: async () => 'user123',
      getUserId: () => 'user123',
      createDocument: async () => {
        throw new Error('Firestore create failed (500)');
      },
      updateDocument: async () => {},
      deleteDocument: async () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failTools = new CopilotMoneyTools(mockDb, failingClient as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockDb as any)._transactions = [{ transaction_id: 'txn1' }];

    await expect(failTools.createCategory({ name: 'Hobbies' })).rejects.toThrow(
      'Firestore create failed'
    );
    // Cache should NOT have been cleared since error happened before clearCache
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mockDb as any)._transactions).not.toBeNull();
  });
});
