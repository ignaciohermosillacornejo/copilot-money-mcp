import { describe, test, expect, afterEach, mock } from 'bun:test';
import {
  GraphQLClient,
  GraphQLError,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_TIMEOUT_MS,
} from '../../../src/core/graphql/client.js';
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

  test('classifies bare 400 (no recognizable body) as SCHEMA_ERROR with raw text', async () => {
    mockFetch('Schema/validation error body', 400);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
      expect((e as GraphQLError).httpStatus).toBe(400);
      expect((e as GraphQLError).message).toContain('Schema/validation error body');
    }
  });

  test.each([500, 502, 503])(
    'classifies HTTP %i as SERVER_ERROR (not SCHEMA_ERROR)',
    async (status) => {
      mockFetch('upstream blew up', status);
      const client = new GraphQLClient(createMockAuth());
      try {
        await client.mutate('TestOp', 'mutation TestOp { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as GraphQLError).code).toBe('SERVER_ERROR');
        expect((e as GraphQLError).httpStatus).toBe(status);
        expect((e as GraphQLError).message).toContain('upstream blew up');
      }
    }
  );

  test('400 with BAD_USER_INPUT (variable coercion, the #419 shape) is SCHEMA_ERROR', async () => {
    const body = {
      errors: [
        {
          message:
            'Variable "$input" got invalid value "YEARLY" at "input.frequency"; Value "YEARLY" does not exist in "RecurringFrequency" enum.',
          extensions: { code: 'BAD_USER_INPUT' },
        },
      ],
    };
    mockFetch(body, 400);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('CreateRecurring', 'mutation CreateRecurring { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
      // Raw server reason is surfaced, not swallowed.
      expect((e as GraphQLError).message).toContain(
        'Value "YEARLY" does not exist in "RecurringFrequency" enum.'
      );
    }
  });

  test('4xx with NOT_FOUND extension is USER_ACTION_REQUIRED (input/ownership)', async () => {
    const body = {
      errors: [
        {
          message: 'Recurring not found or not owned by user',
          extensions: { code: 'NOT_FOUND' },
        },
      ],
    };
    mockFetch(body, 404);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('EditRecurring', 'mutation EditRecurring { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('USER_ACTION_REQUIRED');
      expect((e as GraphQLError).message).toContain('Recurring not found');
    }
  });

  test('4xx with FORBIDDEN extension is USER_ACTION_REQUIRED (ownership)', async () => {
    const body = {
      errors: [
        {
          message: 'Not authorized to modify this transaction',
          extensions: { code: 'FORBIDDEN' },
        },
      ],
    };
    mockFetch(body, 403);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('EditTransaction', 'mutation EditTransaction { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('USER_ACTION_REQUIRED');
      expect((e as GraphQLError).message).toContain('Not authorized to modify this transaction');
    }
  });

  test('2xx + GRAPHQL_VALIDATION_FAILED errors[] is SCHEMA_ERROR (not USER_ACTION_REQUIRED)', async () => {
    mockFetch({
      errors: [
        {
          message: 'Cannot query field "bogus" on type "Mutation".',
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
      expect((e as GraphQLError).message).toContain('Cannot query field "bogus"');
    }
  });

  test('UNAUTHENTICATED extension is AUTH_FAILED regardless of HTTP status', async () => {
    const body = {
      errors: [{ message: 'Token expired', extensions: { code: 'UNAUTHENTICATED' } }],
    };
    mockFetch(body, 403);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('AUTH_FAILED');
    }
  });

  test('2xx + UNAUTHENTICATED errors[] is AUTH_FAILED', async () => {
    mockFetch({
      errors: [{ message: 'Token expired', extensions: { code: 'UNAUTHENTICATED' } }],
    });
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('AUTH_FAILED');
    }
  });

  test('truncates oversized raw server text in the error message', async () => {
    mockFetch('x'.repeat(5000), 502);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SERVER_ERROR');
      expect((e as GraphQLError).message).toContain('[truncated]');
      expect((e as GraphQLError).message.length).toBeLessThan(1000);
    }
  });

  test('400 with GRAPHQL_VALIDATION_FAILED body is SCHEMA_ERROR', async () => {
    const body = {
      errors: [
        {
          message: 'Fragment "CategoryFields" is never used.',
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    };
    mockFetch(body, 400);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).code).toBe('SCHEMA_ERROR');
      expect((e as GraphQLError).httpStatus).toBe(400);
      expect((e as GraphQLError).message).toContain('CategoryFields');
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

  test('failed responses carry requestReachedServer=true (an HTTP response arrived)', async () => {
    mockFetch('upstream blew up', 502);
    const client = new GraphQLClient(createMockAuth());
    try {
      await client.mutate('TestOp', 'mutation TestOp { ok }', {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as GraphQLError).requestReachedServer).toBe(true);
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

// ── Retry / backoff (issue #443) ─────────────────────────────────────────────

type FetchStep = { throwErr: Error } | { body: unknown; status?: number };

/** Mock fetch with a per-call script; the last step repeats if exhausted. */
function mockFetchSequence(steps: FetchStep[]) {
  fetchCalls = [];
  let i = 0;
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if ('throwErr' in step) return Promise.reject(step.throwErr);
    return Promise.resolve(
      new Response(JSON.stringify(step.body), {
        status: step.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

/** Client with zero backoff/jitter so retry tests run instantly. */
function fastClient(opts: ConstructorParameters<typeof GraphQLClient>[1] = {}) {
  return new GraphQLClient(createMockAuth(), { retryDelaysMs: [0, 0, 0], jitterMs: 0, ...opts });
}

/** Node-shaped fetch rejection: TypeError('fetch failed') with errno cause. */
function fetchRejection(code?: string, causeMessage = 'socket-level failure'): Error {
  const err = new Error('fetch failed') as Error & { cause?: unknown };
  if (code) {
    const cause = new Error(`${causeMessage} (${code})`) as Error & { code?: string };
    cause.code = code;
    err.cause = cause;
  }
  return err;
}

function silencingConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = (() => {}) as typeof console.error;
  return fn().finally(() => {
    console.error = original;
  });
}

describe('GraphQLClient — retry/backoff (#443)', () => {
  afterEach(() => restoreFetch());

  test('default backoff schedule is 3 retries at 250ms/1s/4s', () => {
    expect([...DEFAULT_RETRY_DELAYS_MS]).toEqual([250, 1000, 4000]);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  test('passes an AbortSignal (timeout) to fetch by default', async () => {
    mockFetch({ data: { ok: true } });
    await new GraphQLClient(createMockAuth()).query('Q', 'query Q { ok }', {});
    expect(fetchCalls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  test('timeoutMs: Infinity disables the abort signal', async () => {
    mockFetch({ data: { ok: true } });
    await new GraphQLClient(createMockAuth(), { timeoutMs: Infinity }).query(
      'Q',
      'query Q { ok }',
      {}
    );
    expect(fetchCalls[0].options.signal).toBeUndefined();
  });

  test('query recovers from a transient fetch rejection', async () => {
    mockFetchSequence([{ throwErr: fetchRejection() }, { body: { data: { ok: true } } }]);
    const out = await silencingConsoleError(() =>
      fastClient().query<unknown, { ok: boolean }>('Q', 'query Q { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('query recovers from a 5xx with no GraphQL error body', async () => {
    mockFetchSequence([{ body: 'bad gateway', status: 502 }, { body: { data: { ok: true } } }]);
    const out = await silencingConsoleError(() =>
      fastClient().query<unknown, { ok: boolean }>('Q', 'query Q { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('query does NOT retry a 5xx that carries a GraphQL errors[] body', async () => {
    mockFetchSequence([
      { body: { errors: [{ message: 'resolver exploded' }] }, status: 500 },
      { body: { data: { ok: true } } },
    ]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().query('Q', 'query Q { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as GraphQLError).code).toBe('SERVER_ERROR');
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('query does NOT retry GraphQL-level errors (2xx + errors[])', async () => {
    mockFetchSequence([
      { body: { errors: [{ message: 'Budgeting is disabled.' }] } },
      { body: { data: { ok: true } } },
    ]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().query('Q', 'query Q { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as GraphQLError).code).toBe('USER_ACTION_REQUIRED');
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('query gives up after exhausting retries; error carries attempts', async () => {
    mockFetchSequence([{ throwErr: fetchRejection() }]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().query('Q', 'query Q { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as GraphQLError).code).toBe('NETWORK');
        expect((e as GraphQLError).attempts).toBe(4);
      }
    });
    expect(fetchCalls).toHaveLength(4); // 1 initial + 3 retries
  });

  test('query retries a timed-out attempt and recovers', async () => {
    fetchCalls = [];
    let call = 0;
    globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} });
      call += 1;
      if (call === 1) {
        // Hang until the timeout signal aborts us.
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;

    const out = await silencingConsoleError(() =>
      fastClient({ timeoutMs: 20 }).query<unknown, { ok: boolean }>('Q', 'query Q { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('mutation retries a provably-unsent failure (ECONNREFUSED) and recovers', async () => {
    mockFetchSequence([
      { throwErr: fetchRejection('ECONNREFUSED') },
      { body: { data: { ok: true } } },
    ]);
    const out = await silencingConsoleError(() =>
      fastClient().mutate<unknown, { ok: boolean }>('M', 'mutation M { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('mutation retries a DNS failure (ENOTFOUND) and recovers', async () => {
    mockFetchSequence([
      { throwErr: fetchRejection('ENOTFOUND', 'getaddrinfo failure') },
      { body: { data: { ok: true } } },
    ]);
    const out = await silencingConsoleError(() =>
      fastClient().mutate<unknown, { ok: boolean }>('M', 'mutation M { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('mutation retries Bun-style ConnectionRefused (top-level code, no cause)', async () => {
    const bunErr = new Error('Unable to connect.') as Error & { code?: string };
    bunErr.code = 'ConnectionRefused';
    mockFetchSequence([{ throwErr: bunErr }, { body: { data: { ok: true } } }]);
    const out = await silencingConsoleError(() =>
      fastClient().mutate<unknown, { ok: boolean }>('M', 'mutation M { ok }', {})
    );
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test('exhausted provably-unsent mutation keeps writeMayHaveApplied=false', async () => {
    mockFetchSequence([{ throwErr: fetchRejection('ECONNREFUSED') }]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().mutate('M', 'mutation M { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        const err = e as GraphQLError;
        expect(err.code).toBe('NETWORK');
        expect(err.requestReachedServer).toBe(false);
        expect(err.writeMayHaveApplied).toBe(false);
        expect(err.attempts).toBe(4);
      }
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test('mutation does NOT retry an ambiguous fetch rejection (ECONNRESET)', async () => {
    mockFetchSequence([
      { throwErr: new Error('read ECONNRESET') },
      { body: { data: { ok: true } } },
    ]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().mutate('M', 'mutation M { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        const err = e as GraphQLError;
        expect(err.code).toBe('NETWORK');
        expect(err.requestReachedServer).toBeUndefined();
        expect(err.writeMayHaveApplied).toBe(true);
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('mutation does NOT retry a timeout; flags writeMayHaveApplied', async () => {
    fetchCalls = [];
    globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
      fetchCalls.push({ url: String(url), options: options ?? {} });
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason));
      });
    }) as typeof fetch;

    await silencingConsoleError(async () => {
      try {
        await fastClient({ timeoutMs: 20 }).mutate('M', 'mutation M { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        const err = e as GraphQLError;
        expect(err.code).toBe('NETWORK');
        expect(err.message).toContain('timed out after 20ms');
        expect(err.writeMayHaveApplied).toBe(true);
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('mutation does NOT retry a 5xx; flags writeMayHaveApplied', async () => {
    mockFetchSequence([{ body: 'internal error', status: 500 }, { body: { data: { ok: true } } }]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().mutate('M', 'mutation M { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        const err = e as GraphQLError;
        expect(err.code).toBe('SERVER_ERROR');
        expect(err.writeMayHaveApplied).toBe(true);
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('server-rejected mutation (SCHEMA_ERROR) is definitive: no retry, no ambiguity flag', async () => {
    mockFetchSequence([
      {
        body: { errors: [{ message: 'bad enum', extensions: { code: 'BAD_USER_INPUT' } }] },
        status: 400,
      },
    ]);
    await silencingConsoleError(async () => {
      try {
        await fastClient().mutate('M', 'mutation M { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        const err = e as GraphQLError;
        expect(err.code).toBe('SCHEMA_ERROR');
        expect(err.writeMayHaveApplied).toBe(false);
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test('retryDelaysMs: [] disables retries entirely', async () => {
    mockFetchSequence([{ throwErr: fetchRejection() }]);
    await silencingConsoleError(async () => {
      try {
        await fastClient({ retryDelaysMs: [] }).query('Q', 'query Q { ok }', {});
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as GraphQLError).code).toBe('NETWORK');
        expect((e as GraphQLError).attempts).toBe(1);
      }
    });
    expect(fetchCalls).toHaveLength(1);
  });
});
