import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';
import type { TokenResult } from '../../../src/core/auth/browser-token.js';

// Mock token extractor: yields a single valid candidate.
const mockExtractor = mock(() =>
  Promise.resolve({
    candidates: [{ token: 'AMf-fake-refresh-token', browser: 'Chrome' }] as TokenResult[],
    checked: ['Chrome'],
  })
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

/**
 * Queue distinct responses, one per fetch call (for multi-candidate exchange).
 * Each entry is `[body, status]`; the Nth fetch returns the Nth entry.
 */
function mockFetchSequence(responses: [object, number][]) {
  let i = 0;
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    const [body, status] = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
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

  afterEach(() => {
    restoreFetch();
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
  });

  test('throws on failed token exchange', async () => {
    mockFetch({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);
    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed');
  });

  test('PROJECT_NUMBER_MISMATCH on the only candidate yields the "no session" error', async () => {
    // The sole candidate is a foreign-project AMf- token (e.g. another site's
    // Firebase session in the browser-wide Local Storage). Its exchange is
    // correctly rejected with PROJECT_NUMBER_MISMATCH. The user is logged out
    // of Copilot — surface the actionable "no session" message, NOT a raw 400.
    mockExtractor.mockResolvedValueOnce({
      candidates: [{ token: 'AMf-foreign-project-token', browser: 'Chrome' }],
      checked: ['Chrome'],
    });
    mockFetch({ error: { message: 'PROJECT_NUMBER_MISMATCH' } }, 400);

    await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
    // A SECOND, independent getIdToken() call (the mockResolvedValueOnce is
    // spent, so this uses the default single-valid-candidate extractor against
    // the same PROJECT_NUMBER_MISMATCH fetch mock): assert the raw code never
    // leaks on any attempt, not just that a cached error was reused.
    await expect(auth.getIdToken()).rejects.not.toThrow('PROJECT_NUMBER_MISMATCH');
  });

  test('discards foreign candidates and succeeds on a valid one', async () => {
    // Two foreign tokens precede a real Copilot session token. The first two
    // exchanges reject with PROJECT_NUMBER_MISMATCH; the third succeeds.
    mockExtractor.mockResolvedValueOnce({
      candidates: [
        { token: 'AMf-foreign-one', browser: 'Chrome' },
        { token: 'AMf-foreign-two', browser: 'Chrome' },
        { token: 'AMf-real-copilot-token', browser: 'Arc' },
      ],
      checked: ['Chrome', 'Arc'],
    });
    mockFetchSequence([
      [{ error: { message: 'PROJECT_NUMBER_MISMATCH' } }, 400],
      [{ error: { message: 'PROJECT_NUMBER_MISMATCH' } }, 400],
      [
        {
          id_token: 'real-id-token',
          refresh_token: 'AMf-real-copilot-token',
          expires_in: '3600',
          token_type: 'Bearer',
          user_id: 'user123',
        },
        200,
      ],
    ]);

    const token = await auth.getIdToken();
    expect(token).toBe('real-id-token');
    expect(fetchCalls).toHaveLength(3);
  });

  test('no candidates at all yields the "no session" error', async () => {
    mockExtractor.mockResolvedValueOnce({ candidates: [], checked: ['Chrome', 'Safari'] });
    // No exchange should even be attempted.
    mockFetch({ id_token: 'should-not-be-used' }, 200);

    await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
    expect(fetchCalls).toHaveLength(0);
  });

  test('caps the exchange loop at MAX_EXCHANGE_CANDIDATES foreign tokens', async () => {
    // Pathological case: many foreign AMf- tokens in the Local Storage fallback.
    // The loop must bound its sequential exchanges (cap 10) rather than trying
    // all 25, then surface the "no session" error.
    mockExtractor.mockResolvedValueOnce({
      candidates: Array.from({ length: 25 }, (_, i) => ({
        token: `AMf-foreign-${i}`,
        browser: 'Chrome',
      })),
      checked: ['Chrome'],
    });
    mockFetch({ error: { message: 'PROJECT_NUMBER_MISMATCH' } }, 400);

    await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
    expect(fetchCalls).toHaveLength(10);
  });

  test('a non-mismatch exchange error on a candidate is surfaced raw (not "no session")', async () => {
    // INVALID_REFRESH_TOKEN is a genuine exchange failure for a Copilot-project
    // token (e.g. expired/revoked), not a foreign-project token. Don't swallow
    // it into the "logged out" message — the token WAS Copilot's.
    mockExtractor.mockResolvedValueOnce({
      candidates: [{ token: 'AMf-copilot-but-expired', browser: 'Chrome' }],
      checked: ['Chrome'],
    });
    mockFetch({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed');
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
  });

  describe('uid-transition listener (#521)', () => {
    const tokenBody = (uid: string, expiresIn: string) => ({
      id_token: `tok-${uid}`,
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: expiresIn,
      token_type: 'Bearer',
      user_id: uid,
    });

    test('fires on a non-null → different-non-null uid change', async () => {
      const transitions: [string, string][] = [];
      auth.setUidTransitionListener((prev, next) => transitions.push([prev, next]));
      // First exchange expires immediately so the second call re-exchanges.
      mockFetchSequence([
        [tokenBody('user-A', '0'), 200],
        [tokenBody('user-B', '3600'), 200],
      ]);

      await auth.getIdToken();
      expect(transitions).toEqual([]); // null → user-A is NOT a transition
      await auth.getIdToken();
      expect(transitions).toEqual([['user-A', 'user-B']]);
    });

    test('does not fire on a same-uid refresh', async () => {
      const transitions: [string, string][] = [];
      auth.setUidTransitionListener((prev, next) => transitions.push([prev, next]));
      mockFetchSequence([
        [tokenBody('user-A', '0'), 200],
        [tokenBody('user-A', '3600'), 200],
      ]);

      await auth.getIdToken();
      await auth.getIdToken();
      expect(fetchCalls).toHaveLength(2); // a refresh really happened
      expect(transitions).toEqual([]);
    });

    test('a throwing listener never breaks the exchange', async () => {
      auth.setUidTransitionListener(() => {
        throw new Error('subscriber bug');
      });
      mockFetchSequence([
        [tokenBody('user-A', '0'), 200],
        [tokenBody('user-B', '3600'), 200],
      ]);

      await auth.getIdToken();
      const token = await auth.getIdToken();
      expect(token).toBe('tok-user-B');
      expect(auth.getUserId()).toBe('user-B');
    });
  });
});
