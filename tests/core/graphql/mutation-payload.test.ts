/**
 * Class-level detector for #875 / #887: no mutation wrapper may throw a bare
 * TypeError, or hand its caller an id-less row, when the server's answer
 * carries `null` (or nothing) where its payload belongs.
 *
 * A mutation answered with no `errors` has probably committed (ledger:
 * Mutation.*:null-payload-means-applied, unverified), and response
 * validation is warn-only, so a drifted null reaches the wrapper. A
 * TypeError there reads as a generic crash, says nothing about the write, and
 * (for split_transaction) skips the bookkeeping the caller does for a
 * classified failure. An id-less row resolved to the caller would key a cache
 * patch on `null`. Each wrapper must either resolve — with a string `id` on
 * any row it returns — or reject with a GraphQLError whose `writeApplied` is
 * set (see committedPayload / committedRow).
 *
 * Two transports, because the drift sits at two levels:
 *  - `fetch`: a real GraphQLClient over a mocked `fetch`, so `requestOnce`'s
 *    own checks run — a null or empty `data` is caught there or in the wrapper;
 *  - `mutate`: a stub client whose `mutate` resolves a Proxy, to reach shapes
 *    JSON cannot carry (every field of a present payload null).
 *
 * The wrappers are DISCOVERED, not listed: every exported function in
 * src/core/graphql/*.ts whose source calls `.mutate(` is fed every drifted
 * response below. A new wrapper is covered the day it is added; the only
 * per-wrapper knowledge here is the set of raw-scalar passthroughs.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GraphQLClient, GraphQLError } from '../../../src/core/graphql/client.js';
import type { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';
import { graphQLErrorToMcpError } from '../../../src/tools/errors.js';

const GRAPHQL_DIR = join(import.meta.dir, '..', '..', '..', 'src', 'core', 'graphql');

type Wrapper = (client: GraphQLClient, args: unknown) => Promise<unknown>;

async function discoverWrappers(): Promise<Array<[string, Wrapper]>> {
  const found: Array<[string, Wrapper]> = [];
  for (const file of readdirSync(GRAPHQL_DIR).sort()) {
    if (!file.endsWith('.ts')) continue;
    const mod = (await import(join(GRAPHQL_DIR, file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      if (!/\.mutate\s*(<[^(]*>)?\s*\(/.test(String(value))) continue;
      // The client's own method is not a wrapper.
      if (/^[A-Z]/.test(name)) continue;
      found.push([`${file}:${name}`, value as Wrapper]);
    }
  }
  return found;
}

const WRAPPERS = await discoverWrappers();

/** How many wrappers discovery found when this was written; it may only grow. */
const KNOWN_WRAPPER_COUNT = 17;

/**
 * Wrappers documented to return a raw server scalar unchanged (so callers can
 * observe drift), where a null comes back as a value rather than a payload
 * to read into.
 */
const RAW_SCALAR_PASSTHROUGHS = new Set(['transactions.ts:deleteTransaction']);

/**
 * One args object that satisfies every wrapper's pre-send checks: ids, a
 * non-empty `ids` list for the bulk edit, an input that names a field so the
 * edit wrappers read it back, and a valid budget amount.
 */
const ARGS = {
  id: 'aB3xK9pQ2mN7vR4tY8wZ',
  accountId: 'kQ7vN2xR9pL4mW8tY3zB',
  itemId: 'hT5cJ8wF2nD6sG1qV4xM',
  categoryId: 'gR4tH7jK2lM9nP3qS6vW',
  amount: '100',
  ids: [
    {
      id: 'aB3xK9pQ2mN7vR4tY8wZ',
      accountId: 'kQ7vN2xR9pL4mW8tY3zB',
      itemId: 'hT5cJ8wF2nD6sG1qV4xM',
    },
  ],
  input: { name: 'n' },
};

/**
 * An object that claims every property (`has`) and returns `leaf()` for every
 * read (`get`). The `has` trap matters: without it `'id' in value` falls
 * through to the empty target and the in-loop id assertion below never runs
 * (#887 review). The one special case is `then`, absent from both traps so
 * `await` treats the object as a plain value rather than a thenable. Symbols
 * get `leaf()` too: no wrapper coerces or iterates its payload today, so a
 * future one that does will fail here on that coercion, not on a null
 * dereference.
 */
function everyKey(leaf: () => unknown): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_t, k) => (k === 'then' ? undefined : leaf()),
      has: (_t, k) => k !== 'then',
    }
  );
}

type Drift =
  | { label: string; transport: 'fetch'; body: () => unknown }
  | { label: string; transport: 'mutate'; data: () => unknown };

const DRIFTED_RESPONSES: Drift[] = [
  // The server's literal JSON body, through the real client.
  { label: 'data is null', transport: 'fetch', body: () => ({ data: null }) },
  { label: 'data is empty', transport: 'fetch', body: () => ({ data: {} }) },
  // `data` as the wrapper sees it, past the client.
  { label: 'the root payload is null', transport: 'mutate', data: () => everyKey(() => null) },
  {
    label: 'every field of the payload is null (ids included)',
    transport: 'mutate',
    data: () => everyKey(() => everyKey(() => null)),
  },
];

function stubClient(data: unknown): GraphQLClient {
  return { mutate: async () => data } as unknown as GraphQLClient;
}

const AUTH = {
  getIdToken: async () => 'test-token',
  getUserId: () => null,
} as unknown as FirebaseAuth;

/** Run `fn` with a real client whose every request is answered 200 with `body`. */
async function withFetchedBody<T>(body: unknown, fn: (c: GraphQLClient) => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  // The client logs classified errors and warn-mode schema drift; both are
  // expected for every case here.
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return await fn(new GraphQLClient(AUTH, { retryDelaysMs: [], timeoutMs: 0 }));
  } finally {
    globalThis.fetch = originalFetch;
    err.mockRestore();
    warn.mockRestore();
  }
}

async function run(
  wrapper: Wrapper,
  drift: Drift
): Promise<{ value: unknown } | { error: unknown }> {
  const call = (c: GraphQLClient) => wrapper(c, ARGS);
  try {
    const value =
      drift.transport === 'fetch'
        ? await withFetchedBody(drift.body(), call)
        : await call(stubClient(drift.data()));
    return { value };
  } catch (error) {
    return { error };
  }
}

describe('mutation wrappers classify an unusable payload after a committed write (#875, #887)', () => {
  test('discovery finds the wrappers (guards against a vacuous or shrunken walk)', () => {
    const names = WRAPPERS.map(([n]) => n);
    // A refactor that routes a wrapper's mutate through a helper would drop it
    // from discovery silently; the count catches that without blocking additions.
    expect(names.length).toBeGreaterThanOrEqual(KNOWN_WRAPPER_COUNT);
    for (const expected of [
      'transactions.ts:editTransaction',
      'transactions.ts:createTransaction',
      'transactions.ts:splitTransaction',
      'transactions.ts:addTransactionToRecurring',
      'transactions.ts:bulkEditTransactions',
      'categories.ts:editCategory',
      'tags.ts:createTag',
      'recurrings.ts:editRecurring',
      'accounts.ts:editAccount',
      'budgets.ts:setBudget',
    ]) {
      expect(names).toContain(expected);
    }
    for (const passthrough of RAW_SCALAR_PASSTHROUGHS) expect(names).toContain(passthrough);
  });

  for (const [name, wrapper] of WRAPPERS) {
    for (const drift of DRIFTED_RESPONSES) {
      test(`${name}: ${drift.label} (${drift.transport})`, async () => {
        const outcome = await run(wrapper, drift);
        if ('error' in outcome) {
          const e = outcome.error;
          // Not a TypeError from dereferencing null: a classified "probably landed".
          expect(e).toBeInstanceOf(GraphQLError);
          expect((e as GraphQLError).writeApplied).toBe(true);
          expect((e as GraphQLError).writeMayHaveApplied).toBe(true);
          return;
        }
        if (RAW_SCALAR_PASSTHROUGHS.has(name)) return;
        // Resolving is fine, but not with nothing: a caller would dereference it.
        const value = outcome.value;
        expect(value).not.toBeNull();
        expect(value).not.toBeUndefined();
        // ...and a row it returns is keyed on a real id, never on null: callers
        // patch caches and answer with it (#887 review).
        if (value !== null && typeof value === 'object' && 'id' in value) {
          expect(typeof (value as { id: unknown }).id).toBe('string');
          expect((value as { id: string }).id).not.toBe('');
        }
      });
    }
  }

  test('a create answered with a row but no id is classified, not resolved (#887)', async () => {
    const createTag = WRAPPERS.find(([n]) => n === 'tags.ts:createTag')![1];
    const e = await createTag(
      stubClient({ createTag: { id: '', name: 'n', colorName: 'RED1' } }),
      ARGS
    ).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).writeApplied).toBe(true);
    expect((e as GraphQLError).message).toContain('returned no createTag.id (it was empty)');
  });

  test('a mutation answered with data: null says it probably landed (#887)', async () => {
    const edit = WRAPPERS.find(([n]) => n === 'transactions.ts:editTransaction')![1];
    const e = await withFetchedBody({ data: null }, (c) => edit(c, ARGS)).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).writeApplied).toBe(true);
    expect(graphQLErrorToMcpError(e as GraphQLError)).toContain('returned no data (it was null)');
  });

  test('the user-facing message says the write probably landed and to confirm before retrying', async () => {
    const edit = WRAPPERS.find(([n]) => n === 'transactions.ts:editTransaction')![1];
    const e = await edit(stubClient({ editTransaction: { transaction: null } }), ARGS).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(e).toBeInstanceOf(GraphQLError);
    const msg = graphQLErrorToMcpError(e as GraphQLError);
    expect(msg).toContain('EditTransaction');
    expect(msg).toContain('returned no editTransaction.transaction (it was null)');
    expect(msg).toContain('PROBABLY landed');
    expect(msg).toContain('confirm before retrying');
    expect(msg).toContain('could duplicate the change');
  });
});
