import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

// Mock token extractor
const mockExtractor = mock(() =>
  Promise.resolve({ token: 'AMf-fake-refresh-token', browser: 'Chrome' })
);

// Capture fetch calls
let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(response: object, status = 200) {
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe('FirebaseAuth', () => {
  let auth: FirebaseAuth;

  beforeEach(() => {
    mockExtractor.mockClear();
    fetchCalls = [];
    auth = new FirebaseAuth(mockExtractor);
  });

  test('exchanges refresh token for ID token', async () => {
    mockFetch({
      id_token: 'fake-id-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token = await auth.getIdToken();
    expect(token).toBe('fake-id-token');
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('securetoken.googleapis.com');
    restoreFetch();
  });

  test('caches token on subsequent calls', async () => {
    mockFetch({
      id_token: 'cached-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token1 = await auth.getIdToken();
    const token2 = await auth.getIdToken();
    expect(token1).toBe('cached-token');
    expect(token2).toBe('cached-token');
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    restoreFetch();
  });

  test('returns userId from token exchange', async () => {
    mockFetch({
      id_token: 'fake-id-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    await auth.getIdToken();
    expect(auth.getUserId()).toBe('user123');
    restoreFetch();
  });

  test('throws on failed token exchange', async () => {
    mockFetch({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);
    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed');
    restoreFetch();
  });

  test('refreshes expired token', async () => {
    mockFetch({
      id_token: 'first-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '0',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token1 = await auth.getIdToken();
    expect(token1).toBe('first-token');

    mockFetch({
      id_token: 'refreshed-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token2 = await auth.getIdToken();
    expect(token2).toBe('refreshed-token');
    expect(fetchCalls).toHaveLength(2);
    restoreFetch();
  });
});
