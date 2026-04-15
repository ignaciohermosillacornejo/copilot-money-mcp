import { describe, test, expect, afterEach, mock } from 'bun:test';
import { GraphQLClient, GraphQLError } from '../../../src/core/graphql/client.js';
import type { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(responseBody: unknown, status = 200, throwErr?: Error) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    if (throwErr) return Promise.reject(throwErr);
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

function createMockAuth(idToken = 'test-jwt'): FirebaseAuth {
  return { getIdToken: mock(() => Promise.resolve(idToken)) } as unknown as FirebaseAuth;
}

describe('GraphQLClient', () => {
  afterEach(() => restoreFetch());

  test('POSTs to the Copilot GraphQL endpoint with correct headers', async () => {
    mockFetch({ data: { ok: true } });
    const client = new GraphQLClient(createMockAuth());
    await client.mutate('TestOp', 'mutation TestOp { ok }', {});
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://app.copilot.money/api/graphql');
    expect(fetchCalls[0].options.method).toBe('POST');
    const headers = fetchCalls[0].options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-jwt');
    expect(headers['Content-Type']).toBe('application/json');
    // No extra headers.
    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'Content-Type']);
  });

  test('sends single-op body as JSON object (not array)', async () => {
    mockFetch({ data: { ok: true } });
    const client = new GraphQLClient(createMockAuth());
    await client.mutate('TestOp', 'mutation TestOp { ok }', { id: 'x' });
    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(Array.isArray(body)).toBe(false);
    expect(body).toEqual({
      operationName: 'TestOp',
      query: 'mutation TestOp { ok }',
      variables: { id: 'x' },
    });
  });

  test('returns the data field on successful response', async () => {
    mockFetch({ data: { editTransaction: { transaction: { id: 't1' } } } });
    const client = new GraphQLClient(createMockAuth());
    const out = await client.mutate<unknown, { editTransaction: { transaction: { id: string } } }>(
      'TestOp',
      'mutation TestOp { editTransaction { transaction { id } } }',
      {}
    );
    expect(out.editTransaction.transaction.id).toBe('t1');
  });

  test('classifies HTTP 401 as AUTH_FAILED', async () => {
    mockFetch({ errors: [{ message: 'unauthorized' }] }, 401);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      expect((e as GraphQLError).code).toBe('AUTH_FAILED');
      expect((e as GraphQLError).httpStatus).toBe(401);
    }
  });

  test('classifies HTTP 500 as SCHEMA_ERROR', async () => {
    mockFetch('Internal server error', 500);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
    }
  });

  test('classifies other non-2xx as UNKNOWN', async () => {
    mockFetch({}, 418);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('UNKNOWN');
      expect((e as GraphQLError).httpStatus).toBe(418);
    }
  });

  test('classifies 2xx+errors[] as USER_ACTION_REQUIRED', async () => {
    mockFetch({
      errors: [{ message: 'Budgeting is disabled for this account.' }],
    });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('USER_ACTION_REQUIRED');
      expect((e as GraphQLError).message).toBe('Budgeting is disabled for this account.');
    }
  });

  test('classifies thrown fetch as NETWORK', async () => {
    mockFetch({}, 200, new Error('ECONNRESET'));
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('NETWORK');
      expect((e as GraphQLError).message).toContain('ECONNRESET');
    }
  });

  test('carries operationName on thrown error', async () => {
    mockFetch({ errors: [{ message: 'boom' }] });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('EditTransaction', 'mutation EditTransaction { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).operationName).toBe('EditTransaction');
    }
  });

  test('classifies malformed JSON on 2xx as UNKNOWN', async () => {
    // Provide a broken body: 200 OK with body that is not valid JSON.
    fetchCalls = [];
    const originalFetch2 = globalThis.fetch;
    globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} });
      return Promise.resolve(
        new Response('not-json-garbage', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;

    try {
      const client = new GraphQLClient(createMockAuth());
      try {
        await client.mutate('TestOp', 'mutation TestOp { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        expect((e as GraphQLError).code).toBe('UNKNOWN');
        expect((e as GraphQLError).httpStatus).toBe(200);
        expect((e as GraphQLError).message).toContain('Invalid JSON');
      }
    } finally {
      globalThis.fetch = originalFetch2;
    }
  });

  test('logs to stderr when throwing on classified errors', async () => {
    mockFetch({ errors: [{ message: 'unauthorized' }] }, 401);
    const originalError = console.error;
    const logs: string[] = [];
    console.error = ((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    }) as typeof console.error;
    try {
      const client = new GraphQLClient(createMockAuth());
      try {
        await client.mutate('EditTransaction', 'mutation EditTransaction { ok }', {});
      } catch {
        /* expected */
      }
      expect(
        logs.some(
          (l) =>
            l.includes('[graphql]') &&
            l.includes('EditTransaction') &&
            l.includes('AUTH_FAILED') &&
            l.includes('401')
        )
      ).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
