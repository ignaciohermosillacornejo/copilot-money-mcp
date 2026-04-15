import { mock } from 'bun:test';
import type { GraphQLClient } from '../../src/core/graphql/client.js';

export interface RecordedCall {
  op: string;
  query: string;
  variables: unknown;
}

export type MockGraphQLClient = GraphQLClient & {
  _calls: RecordedCall[];
};

type ResponseEntry = unknown | ((variables: unknown) => unknown);

/**
 * Build a fake GraphQLClient for tests.
 *
 * `responsesByOp` maps operation name → canned response. Values may be:
 *  - a plain object that will be returned from `client.mutate(...)`,
 *  - a function `(variables) => response` for per-call dynamic responses,
 *  - an `Error` instance, in which case the mutate call rejects with it.
 *
 * All calls are recorded on `client._calls` for later assertion:
 *   expect(client._calls[0].op).toBe('EditTransaction')
 *   expect(client._calls[0].variables).toEqual({ ... })
 */
export function createMockGraphQLClient(
  responsesByOp: Record<string, ResponseEntry> = {}
): MockGraphQLClient {
  const calls: RecordedCall[] = [];
  const client = {
    mutate: mock((op: string, query: string, variables: unknown) => {
      calls.push({ op, query, variables });
      if (!(op in responsesByOp)) {
        return Promise.reject(new Error(`No mock response for operation: ${op}`));
      }
      const entry = responsesByOp[op];
      if (entry instanceof Error) return Promise.reject(entry);
      if (typeof entry === 'function') {
        try {
          const resolved = (entry as (v: unknown) => unknown)(variables);
          if (resolved instanceof Error) return Promise.reject(resolved);
          return Promise.resolve(resolved);
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
      return Promise.resolve(entry);
    }),
    _calls: calls,
  };
  return client as unknown as MockGraphQLClient;
}
