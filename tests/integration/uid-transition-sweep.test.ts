/**
 * Class-level detector for #521: a mid-session re-auth landing on a DIFFERENT
 * uid must flush every live cache. Drives the REAL server wiring — real
 * FirebaseAuth + real GraphQLClient (global fetch mocked) injected into
 * CopilotMoneyServer with --live-reads — so a regression in the registration
 * itself (not just the pieces) fails this test.
 *
 * Discriminator: after the transition, get_accounts_live would be a
 * fresh-TTL cache HIT serving the previous login's rows; the sweep forces a
 * refetch under the new identity.
 */
import { test, expect, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotMoneyServer } from '../../src/server.js';
import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';
import { GraphQLClient } from '../../src/core/graphql/client.js';
import type { TokenCandidates } from '../../src/core/auth/browser-token.js';
import { createTestDb } from '../helpers/test-db.js';

const originalFetch = globalThis.fetch;
const originalDisable = process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
let tempDbDir: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDisable === undefined) delete process.env.COPILOT_DISABLE_PERSISTENT_INDEX;
  else process.env.COPILOT_DISABLE_PERSISTENT_INDEX = originalDisable;
  if (tempDbDir) {
    rmSync(tempDbDir, { recursive: true, force: true });
    tempDbDir = undefined;
  }
});

const account = (id: string, name: string) => ({
  id,
  itemId: 'item1',
  name,
  balance: 100,
  liveBalance: true,
  type: 'DEPOSITORY',
  subType: 'checking',
  mask: '0001',
  isUserHidden: false,
  isUserClosed: false,
  isManual: false,
  color: null,
  limit: null,
  institutionId: 'inst1',
  hasHistoricalUpdates: true,
  hasLiveBalance: true,
  latestBalanceUpdate: 1_745_539_200_000,
});

const emptyTransactionsPage = {
  transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
};

/**
 * Mock fetch: exchange #1 lands uid-A with expires_in 0, so every later
 * GraphQL call re-exchanges; exchange #2+ lands uid-B. Returns the exchange
 * count. Also disables the persistent stores, since the uid provider is real.
 */
function installTransitionFetch(): () => number {
  // The suite must never touch the real home directory: this test has a REAL
  // uid provider, so the persistent meta index must be disabled (#522).
  process.env.COPILOT_DISABLE_PERSISTENT_INDEX = '1';

  // Exchange #1 lands uid-A with expires_in 0 → every later GraphQL call
  // re-exchanges. Exchange #2+ lands uid-B (valid 1h).
  let exchanges = 0;
  globalThis.fetch = mock(async (url: string | URL | Request, options?: RequestInit) => {
    const u = String(url);
    if (u.includes('securetoken.googleapis.com')) {
      exchanges += 1;
      const body =
        exchanges === 1
          ? {
              id_token: 'tok-A',
              refresh_token: 'AMf-r',
              expires_in: '0',
              token_type: 'Bearer',
              user_id: 'user-A',
            }
          : {
              id_token: 'tok-B',
              refresh_token: 'AMf-r',
              expires_in: '3600',
              token_type: 'Bearer',
              user_id: 'user-B',
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // GraphQL endpoint: route on operationName from the POST body.
    const op = (JSON.parse(String(options?.body)) as { operationName: string }).operationName;
    const data =
      op === 'Accounts'
        ? { accounts: [account('acc-1', exchanges === 1 ? 'Account of A' : 'Account of B')] }
        : emptyTransactionsPage;
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => exchanges;
}

test('mid-session uid transition flushes all live caches (#521)', async () => {
  const exchangeCount = installTransitionFetch();

  // Provide a synthetic LevelDB so availability() passes on CI (no real DB).
  // The live tools never touch LevelDB; the DB only needs to satisfy the guard.
  tempDbDir = mkdtempSync(join(tmpdir(), 'copilot-sweep-'));
  await createTestDb(tempDbDir, []);

  const extractor = mock((): Promise<TokenCandidates> =>
    Promise.resolve({
      candidates: [{ token: 'AMf-r', browser: 'Chrome', scoped: true }],
      checked: ['Chrome'],
    })
  );
  const client = new GraphQLClient(new FirebaseAuth(extractor));
  const server = new CopilotMoneyServer(tempDbDir, undefined, false, true, client);

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.join(' '));
  try {
    // 1) Populate the accounts snapshot cache under uid-A.
    const first = await server.handleCallTool('get_accounts_live', {});
    expect(JSON.stringify(first)).toContain('Account of A');

    // 2) Any live-tier call re-exchanges (token expired) → uid-B →
    //    transition fires → all live caches flushed.
    await server.handleCallTool('get_transactions_live', { period: 'this_month' });
    expect(exchangeCount()).toBe(2);
    expect(warns.some((w) => w.includes('flushing all live caches'))).toBe(true);

    // 3) Without the sweep this is a fresh-TTL cache HIT serving uid-A's
    //    rows. With it, the flush forces a refetch under uid-B.
    const third = await server.handleCallTool('get_accounts_live', {});
    expect(JSON.stringify(third)).toContain('Account of B');
    expect(JSON.stringify(third)).not.toContain('Account of A');
  } finally {
    console.warn = origWarn;
  }
});

test('mid-session uid transition drops the in-memory split-parent record (#842)', async () => {
  // The persisted split record is uid-scoped; the in-memory half must follow
  // the same login, so the sweep clears it.
  const exchangeCount = installTransitionFetch();
  tempDbDir = mkdtempSync(join(tmpdir(), 'copilot-sweep-'));
  await createTestDb(tempDbDir, []);
  const extractor = mock((): Promise<TokenCandidates> =>
    Promise.resolve({
      candidates: [{ token: 'AMf-r', browser: 'Chrome', scoped: true }],
      checked: ['Chrome'],
    })
  );
  const client = new GraphQLClient(new FirebaseAuth(extractor));
  const server = new CopilotMoneyServer(tempDbDir, undefined, true, true, client);
  const tools = (server as any).tools;
  const PARENT_ID = 'Rt4yU9iO2pA7sD1fG6hK';

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await server.handleCallTool('get_accounts_live', {});
    tools.recordSplitParent(PARENT_ID);
    expect(tools.isRecordedSplitParent(PARENT_ID)).toBe(true);
    // And the local cache's accumulated evidence, which is per login too.
    const db = (server as any).db;
    db._injectDataForTesting({ splitParentIds: [PARENT_ID] });
    expect(db.peekSplitParentIds().has(PARENT_ID)).toBe(true);

    await server.handleCallTool('get_transactions_live', { period: 'this_month' });
    expect(exchangeCount()).toBe(2);
    expect(tools.isRecordedSplitParent(PARENT_ID)).toBe(false);
    expect(db.peekSplitParentIds().has(PARENT_ID)).toBe(false);
  } finally {
    console.warn = origWarn;
  }
});

test('after a uid transition the next delete re-reads the local cache, even while it is fresh (#842)', async () => {
  // forgetSplitParentIds empties the accumulated evidence; it must also make
  // the next split check decode again, or a delete would answer from an
  // empty set until the TTL. Here the transition is on an account whose
  // local cache still holds a soft-deleted child naming PARENT_ID.
  const exchangeCount = installTransitionFetch();
  const PARENT_ID = 'Rt4yU9iO2pA7sD1fG6hK';
  tempDbDir = mkdtempSync(join(tmpdir(), 'copilot-sweep-'));
  await createTestDb(tempDbDir, [
    {
      collection: 'transactions',
      id: 'Zx8cV3bN6mQ1wE4rT7yU',
      fields: {
        transaction_id: 'Zx8cV3bN6mQ1wE4rT7yU',
        account_id: 'Vq3nR8kT2pX6wL9mZ4yB',
        item_id: 'Hc7fJ1sD5gK8aQ3vN6tW',
        amount: 60,
        date: '2025-03-12',
        name: 'Hardware Store',
        parent_transaction_id: PARENT_ID,
        user_deleted: true,
      },
    },
  ]);
  const extractor = mock((): Promise<TokenCandidates> =>
    Promise.resolve({
      candidates: [{ token: 'AMf-r', browser: 'Chrome', scoped: true }],
      checked: ['Chrome'],
    })
  );
  const client = new GraphQLClient(new FirebaseAuth(extractor));
  const server = new CopilotMoneyServer(tempDbDir, undefined, true, true, client);
  const db = (server as any).db;

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await server.handleCallTool('get_accounts_live', {});
    expect((await db.getSplitParentIds()).has(PARENT_ID)).toBe(true);

    await server.handleCallTool('get_transactions_live', { period: 'this_month' });
    expect(exchangeCount()).toBe(2);
    expect(db.peekSplitParentIds().has(PARENT_ID)).toBe(false);

    const res = await server.handleCallTool('delete_transaction', {
      transaction_id: PARENT_ID,
      account_id: 'Vq3nR8kT2pX6wL9mZ4yB',
      item_id: 'Hc7fJ1sD5gK8aQ3vN6tW',
    });
    expect(JSON.stringify(res)).toMatch(/split parent/);
    expect(db.peekSplitParentIds().has(PARENT_ID)).toBe(true);
  } finally {
    console.warn = origWarn;
  }
});
