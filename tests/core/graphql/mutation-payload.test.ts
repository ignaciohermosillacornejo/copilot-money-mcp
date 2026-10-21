/**
 * Class-level detector for #875: no mutation wrapper may throw a bare
 * TypeError when the server's answer carries `null` where its payload belongs.
 *
 * By the time a wrapper reads its payload the write has committed, and
 * response validation is warn-only, so a drifted null reaches the wrapper. A
 * TypeError there reads as a generic crash, says nothing about the write
 * having landed, and (for split_transaction) skips the bookkeeping the caller
 * does for a classified failure. Each wrapper must either resolve or reject
 * with a GraphQLError whose `writeApplied` is set (see committedPayload).
 *
 * The wrappers are DISCOVERED, not listed: every exported function in
 * src/core/graphql/*.ts whose source calls `.mutate(` is fed the drifted
 * responses below. A new wrapper is covered the day it is added; the only
 * per-wrapper knowledge here is the set of raw-scalar passthroughs.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GraphQLError, type GraphQLClient } from '../../../src/core/graphql/client.js';
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

/** Every property read returns `leaf()`; `then` is absent so `await` passes it through. */
function everyKey(leaf: () => unknown): Record<string, unknown> {
  return new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : leaf()) });
}

const DRIFTED_RESPONSES: Array<[string, () => unknown]> = [
  ['the root payload is null', () => everyKey(() => null)],
  [
    'the payload is an object whose every field is null',
    () => everyKey(() => everyKey(() => null)),
  ],
  ['data itself is empty', () => ({})],
];

function clientReturning(response: unknown): GraphQLClient {
  return { mutate: async () => response } as unknown as GraphQLClient;
}

describe('mutation wrappers classify an unusable payload after a committed write (#875)', () => {
  test('discovery finds the wrappers (guards against a vacuous walk)', () => {
    const names = WRAPPERS.map(([n]) => n);
    // A sample across modules: if discovery breaks, these go missing.
    for (const expected of [
      'transactions.ts:editTransaction',
      'transactions.ts:createTransaction',
      'transactions.ts:splitTransaction',
      'transactions.ts:addTransactionToRecurring',
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
    for (const [label, response] of DRIFTED_RESPONSES) {
      test(`${name}: ${label}`, async () => {
        let outcome: { value: unknown } | { error: unknown };
        try {
          outcome = { value: await wrapper(clientReturning(response()), ARGS) };
        } catch (error) {
          outcome = { error };
        }
        if ('error' in outcome) {
          const e = outcome.error;
          // Not a TypeError from dereferencing null: a classified "it landed".
          expect(e).toBeInstanceOf(GraphQLError);
          expect((e as GraphQLError).writeApplied).toBe(true);
          expect((e as GraphQLError).writeMayHaveApplied).toBe(true);
          return;
        }
        // Resolving is fine, but not with nothing: a caller would dereference it.
        if (!RAW_SCALAR_PASSTHROUGHS.has(name)) {
          expect(outcome.value).not.toBeNull();
          expect(outcome.value).not.toBeUndefined();
        }
      });
    }
  }

  test('the user-facing message says the write probably landed and to confirm before retrying', async () => {
    const edit = WRAPPERS.find(([n]) => n === 'transactions.ts:editTransaction')![1];
    const e = await edit(clientReturning({ editTransaction: { transaction: null } }), ARGS).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(e).toBeInstanceOf(GraphQLError);
    const msg = graphQLErrorToMcpError(e as GraphQLError);
    expect(msg).toContain('EditTransaction');
    expect(msg).toContain('returned no editTransaction.transaction (it was null)');
    expect(msg).toContain('PROBABLY landed');
    expect(msg).toContain('confirm before retrying');
    expect(msg).toContain('could duplicate');
  });
});
