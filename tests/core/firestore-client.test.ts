import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { FirestoreClient } from '../../src/core/firestore-client.js';
import type { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';

let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(responseBody: object, status = 200) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function createMockAuth(idToken = 'test-id-token', userId = 'user123'): FirebaseAuth {
  return {
    getIdToken: mock(() => Promise.resolve(idToken)),
    getUserId: () => userId,
  } as unknown as FirebaseAuth;
}

describe('FirestoreClient', () => {
  let client: FirestoreClient;
  let mockAuth: FirebaseAuth;

  beforeEach(() => {
    mockAuth = createMockAuth();
    client = new FirestoreClient(mockAuth);
  });

  test('sends PATCH request with correct URL and updateMask', async () => {
    mockFetch({
      name: 'projects/copilot-production-22904/databases/(default)/documents/transactions/txn1',
      fields: {},
    });

    await client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, [
      'category_id',
    ]);

    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe(
      '/v1/projects/copilot-production-22904/databases/(default)/documents/transactions/txn1'
    );
    expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual(['category_id']);
    restoreFetch();
  });

  test('sends Authorization header with Bearer token', async () => {
    mockFetch({ name: 'doc', fields: {} });
    await client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, [
      'category_id',
    ]);
    const headers = fetchCalls[0].options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-id-token');
    restoreFetch();
  });

  test('sends correct JSON body with fields', async () => {
    mockFetch({ name: 'doc', fields: {} });
    await client.updateDocument(
      'transactions',
      'txn1',
      { category_id: { stringValue: 'new_cat' } },
      ['category_id']
    );
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body).toEqual({ fields: { category_id: { stringValue: 'new_cat' } } });
    restoreFetch();
  });

  test('supports multiple updateMask fields', async () => {
    mockFetch({ name: 'doc', fields: {} });
    await client.updateDocument(
      'transactions',
      'txn1',
      { category_id: { stringValue: 'food' }, user_reviewed: { booleanValue: true } },
      ['category_id', 'user_reviewed']
    );
    const url = new URL(fetchCalls[0].url);
    expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual([
      'category_id',
      'user_reviewed',
    ]);
    restoreFetch();
  });

  test('throws on non-OK response', async () => {
    mockFetch({ error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } }, 404);
    await expect(
      client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, [
        'category_id',
      ])
    ).rejects.toThrow('Firestore update failed');
    restoreFetch();
  });

  test('throws on permission denied', async () => {
    mockFetch(
      { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } },
      403
    );
    await expect(
      client.updateDocument('transactions', 'bad', { category_id: { stringValue: 'x' } }, [
        'category_id',
      ])
    ).rejects.toThrow('Firestore update failed');
    restoreFetch();
  });

  // --- getUserId / requireUserId ---

  test('getUserId delegates to auth', () => {
    expect(client.getUserId()).toBe('user123');
  });

  test('getUserId returns null when auth has no userId', () => {
    const noIdAuth = createMockAuth('token', undefined as unknown as string);
    // Simulate null userId — getUserId on our mock returns the passed value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (noIdAuth as any).getUserId = () => null;
    const c = new FirestoreClient(noIdAuth);
    expect(c.getUserId()).toBeNull();
  });

  test('requireUserId returns userId after token exchange', async () => {
    mockFetch({});
    const uid = await client.requireUserId();
    expect(uid).toBe('user123');
    restoreFetch();
  });

  test('requireUserId throws when userId is null after exchange', async () => {
    const badAuth = createMockAuth('token');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (badAuth as any).getUserId = () => null;
    const c = new FirestoreClient(badAuth);
    mockFetch({});
    await expect(c.requireUserId()).rejects.toThrow('Firebase user ID unavailable');
    restoreFetch();
  });

  // --- createDocument ---

  test('createDocument sends POST with documentId query param', async () => {
    mockFetch({ name: 'doc', fields: {} });
    await client.createDocument('users/u1/tags', 'my_tag', {
      name: { stringValue: 'My Tag' },
    });

    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toContain('/users/u1/tags');
    expect(url.searchParams.get('documentId')).toBe('my_tag');
    expect(fetchCalls[0].options.method).toBe('POST');

    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body).toEqual({ fields: { name: { stringValue: 'My Tag' } } });
    restoreFetch();
  });

  test('createDocument sends correct JSON body', async () => {
    mockFetch({ name: 'doc', fields: {} });
    await client.createDocument('users/uid/categories', 'cat_123', {
      name: { stringValue: 'Test' },
      excluded: { booleanValue: false },
    });

    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body).toEqual({
      fields: {
        name: { stringValue: 'Test' },
        excluded: { booleanValue: false },
      },
    });
    restoreFetch();
  });

  test('createDocument throws on non-OK response', async () => {
    mockFetch({ error: { code: 409, message: 'Already exists' } }, 409);
    await expect(
      client.createDocument('users/u1/tags', 'dup', { name: { stringValue: 'Dup' } })
    ).rejects.toThrow('Firestore create failed');
    restoreFetch();
  });

  // --- deleteDocument ---

  test('deleteDocument sends DELETE with correct path', async () => {
    mockFetch({});
    await client.deleteDocument('users/u1/tags', 'my_tag');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options.method).toBe('DELETE');
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toContain('/users/u1/tags/my_tag');
    restoreFetch();
  });

  test('deleteDocument sends Authorization header', async () => {
    mockFetch({});
    await client.deleteDocument('users/u1/tags', 'my_tag');
    const headers = fetchCalls[0].options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-id-token');
    restoreFetch();
  });

  test('deleteDocument throws on non-OK response', async () => {
    mockFetch({ error: { code: 404, message: 'Not found' } }, 404);
    await expect(client.deleteDocument('users/u1/tags', 'missing')).rejects.toThrow(
      'Firestore delete failed'
    );
    restoreFetch();
  });
});
