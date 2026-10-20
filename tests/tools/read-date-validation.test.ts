/**
 * Read filters refuse an impossible calendar date the same way in both modes
 * (#825). Before, `2026-02-30` passed the cache tools' format check and matched
 * nothing, and the live tool sent it to the server unchecked.
 *
 * Class-level: every read tool (cache and live) is walked from the registry,
 * and every string argument whose description says it takes a `YYYY-MM-DD` or
 * `YYYY-MM` value is called through the server with an impossible value and an
 * empty one. A new read tool with a date filter that skips the shared check
 * fails here without anyone listing it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CopilotDatabase } from '../../src/core/database.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import { CopilotMoneyServer } from '../../src/server.js';
import { LiveTransactionsTools } from '../../src/tools/live/transactions.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { LIVE_TOOL_DEFS, READ_TOOL_DEFS } from '../../src/tools/registry/index.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

interface DateArg {
  tool: string;
  arg: string;
  /** 'day' for YYYY-MM-DD, 'month' for YYYY-MM. */
  shape: 'day' | 'month';
  array: boolean;
  mode: 'cache' | 'live';
}

/** Every date-shaped string argument a read tool takes, found from its schema. */
function dateArgs(defs: typeof READ_TOOL_DEFS, mode: 'cache' | 'live'): DateArg[] {
  const found: DateArg[] = [];
  for (const def of defs) {
    const props = (def.schema.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string; items?: { type?: string; description?: string } }
    >;
    for (const [arg, prop] of Object.entries(props)) {
      const array = prop.type === 'array' && prop.items?.type === 'string';
      if (prop.type !== 'string' && !array) continue;
      const text = `${prop.description ?? ''} ${prop.items?.description ?? ''}`;
      if (/YYYY-MM-DD/.test(text)) {
        found.push({ tool: def.schema.name, arg, shape: 'day', array, mode });
      } else if (/YYYY-MM\b/.test(text)) {
        found.push({ tool: def.schema.name, arg, shape: 'month', array, mode });
      }
    }
  }
  return found;
}

/** Arguments a tool needs before it reaches its date check. */
const REQUIRED: Record<string, Record<string, unknown>> = {
  get_balance_history: { granularity: 'daily' },
  get_goal_history: { goal_id: 'gA1bC2dE3fG4hI5jK6lM' },
  refresh_cache: { scope: 'transactions' },
};

// A directory the server accepts as a database location; the cache tools get
// an injected, empty, loaded database (the e2e tests' pattern).
const DB_DIR = mkdtempSync(join(tmpdir(), 'read-date-validation-'));
writeFileSync(join(DB_DIR, 'dummy.ldb'), '');
afterAll(() => rmSync(DB_DIR, { recursive: true, force: true }));

function server(mode: 'cache' | 'live'): {
  server: CopilotMoneyServer;
  requests: () => number;
} {
  const client = createMockGraphQLClient({});
  const s = new CopilotMoneyServer(
    DB_DIR,
    undefined,
    false,
    mode === 'live',
    mode === 'live' ? client : undefined
  );
  if (mode === 'cache') {
    const db = new CopilotDatabase(DB_DIR);
    (db as any)._transactions = [];
    db._markLoadedForTesting();
    s._injectForTesting(db, new CopilotMoneyTools(db));
  }
  return { server: s, requests: () => client._calls.length };
}

function text(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === 'text' ? first.text : '';
}

const IMPOSSIBLE = { day: '2026-02-30', month: '2026-13' } as const;
const REFUSAL = {
  day: (arg: string) => `Invalid ${arg}: 2026-02-30 is not a real calendar date`,
  // A month filter's own check, or refresh_cache's stricter format check
  // (its pattern already limits the month to 01-12); either names the value.
  month: () => '2026-13',
} as const;

const ARGS = [...dateArgs(READ_TOOL_DEFS, 'cache'), ...dateArgs(LIVE_TOOL_DEFS, 'live')];
const CASES = ARGS.map((d) => [`${d.tool}.${d.arg} (${d.mode})`, d] as const);

describe('every read-filter date is a real calendar date, in both modes (#825)', () => {
  test('the walk finds the date arguments it is meant to cover', () => {
    const names = ARGS.map((d) => `${d.tool}.${d.arg}`);
    for (const expected of [
      'get_transactions.start_date',
      'get_recurring_transactions.end_date',
      'get_goal_history.start_month',
      'get_transactions_live.start_date',
      'refresh_cache.months',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test.each(CASES)(
    '%s: an impossible value is refused with the shared message, nothing sent',
    async (_name, d) => {
      const { server: s, requests } = server(d.mode);
      const value = d.array ? [IMPOSSIBLE[d.shape]] : IMPOSSIBLE[d.shape];
      const result = await s.handleCallTool(d.tool, { ...REQUIRED[d.tool], [d.arg]: value });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(REFUSAL[d.shape](d.arg));
      expect(requests()).toBe(0);
    }
  );

  test.each(CASES)('%s: an empty value is refused, not skipped', async (_name, d) => {
    const { server: s } = server(d.mode);
    const result = await s.handleCallTool(d.tool, {
      ...REQUIRED[d.tool],
      [d.arg]: d.array ? [''] : '',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Invalid/);
  });

  test('get_transactions_live: a malformed date gets the cache tools’ format message', async () => {
    const client = {
      query: () => Promise.reject(new Error('no request expected')),
      mutate: () => Promise.reject(new Error('no request expected')),
    } as unknown as GraphQLClient;
    const tools = new LiveTransactionsTools(
      new LiveCopilotDatabase(client, new CopilotDatabase('/nonexistent'))
    );
    await expect(
      tools.getTransactions({ start_date: '2026-02-01', end_date: '2026-3-1' })
    ).rejects.toThrow('Invalid end_date format. Expected YYYY-MM-DD, got: 2026-3-1');
  });
});
