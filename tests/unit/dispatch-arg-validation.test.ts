/**
 * #845 detector: every tool call is validated against the tool's own
 * inputSchema at dispatch, in both modes. The walk is driven by the registry
 * (ALL_TOOL_DEFS), so a tool added tomorrow is covered by being registered.
 *
 * The server here runs with --write and --live-reads and NO local cache, so
 * every tool gets past the mode gates; validation runs before the cache gate
 * and before any handler, which the untouched GraphQL mock proves.
 */

import { describe, test, expect, mock } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';
import { validateToolArgs } from '../../src/tools/input-validation.js';

const NO_CACHE_PATH = '/nonexistent/no-native-app-installed';

function server(): {
  server: CopilotMoneyServer;
  client: { query: ReturnType<typeof mock>; mutate: ReturnType<typeof mock> };
} {
  const client = {
    query: mock(() => Promise.reject(new Error('a handler ran'))),
    mutate: mock(() => Promise.reject(new Error('a handler ran'))),
  };
  return {
    server: new CopilotMoneyServer(
      NO_CACHE_PATH,
      undefined,
      true,
      true,
      client as unknown as GraphQLClient
    ),
    client,
  };
}

function text(result: { content: { text?: string }[] }): string {
  return result.content[0]?.text ?? '';
}

type Prop = { type?: string; enum?: readonly unknown[] };
const props = (def: (typeof ALL_TOOL_DEFS)[number]) =>
  def.schema.inputSchema.properties as Record<string, Prop>;

/** A value of the wrong JSON type for a property of `type`. */
function wrongTypeFor(type: string): unknown {
  return type === 'string' ? 42 : 'not-the-right-type';
}

describe('dispatch validates every tool call against its inputSchema (#845)', () => {
  test('guards the gate: the walk covers the whole registry', () => {
    expect(ALL_TOOL_DEFS.length).toBeGreaterThanOrEqual(50);
  });

  test('every tool rejects an argument it does not declare, before any handler runs', async () => {
    const { server: s, client } = server();
    for (const def of ALL_TOOL_DEFS) {
      const result = await s.handleCallTool(def.name, { __not_an_argument__: 1 });
      expect(result.isError, def.name).toBe(true);
      const message = text(result);
      expect(message, def.name).toContain(`Invalid arguments for ${def.name}`);
      expect(message, def.name).toContain("Unknown argument '__not_an_argument__'");
      const accepted = Object.keys(props(def));
      if (accepted.length > 0) {
        for (const name of accepted) expect(message, def.name).toContain(name);
      } else {
        expect(message, def.name).toContain('takes no arguments');
      }
    }
    expect(client.query).not.toHaveBeenCalled();
    expect(client.mutate).not.toHaveBeenCalled();
  });

  test('every typed argument rejects a value of the wrong type', async () => {
    const { server: s, client } = server();
    let checked = 0;
    for (const def of ALL_TOOL_DEFS) {
      for (const [name, prop] of Object.entries(props(def))) {
        if (!prop.type) continue;
        const result = await s.handleCallTool(def.name, { [name]: wrongTypeFor(prop.type) });
        expect(result.isError, `${def.name}.${name}`).toBe(true);
        expect(text(result), `${def.name}.${name}`).toContain(`Argument '${name}' must be`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.mutate).not.toHaveBeenCalled();
  });

  test('every enum argument rejects a value outside it, listing the allowed values', async () => {
    const { server: s, client } = server();
    let checked = 0;
    for (const def of ALL_TOOL_DEFS) {
      for (const [name, prop] of Object.entries(props(def))) {
        if (!prop.enum) continue;
        const result = await s.handleCallTool(def.name, { [name]: '__not_in_the_enum__' });
        expect(result.isError, `${def.name}.${name}`).toBe(true);
        const message = text(result);
        expect(message, `${def.name}.${name}`).toContain(`Argument '${name}' must be one of`);
        for (const allowed of prop.enum) expect(message).toContain(JSON.stringify(allowed));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('get_investment_balance_live time_frame "1W" is a clean client-side error', async () => {
    const { server: s, client } = server();
    const result = await s.handleCallTool('get_investment_balance_live', { time_frame: '1W' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Argument 'time_frame' must be one of");
    expect(text(result)).toContain('"ONE_WEEK"');
    expect(client.query).not.toHaveBeenCalled();
  });

  test('the arguments a handler rejects itself still reach it, for its better message', async () => {
    const { server: s } = server();
    const compact = await s.handleCallTool('get_transactions_live', { compact: true });
    expect(text(compact)).toContain('`compact` was removed in v3.0.0');
    const city = await s.handleCallTool('get_transactions_live', {
      city: 'Somewhere',
      period: 'this_month',
    });
    expect(text(city)).toContain("Parameter 'city' is not supported in live mode");
  });

  test('create_category parent_id and get_accounts_live include_logos keep their own messages', async () => {
    const { server: s } = server();
    const parent = await s.handleCallTool('create_category', {
      name: 'Synthetic',
      color_name: 'BLUE1',
      emoji: '🛒',
      parent_id: 'Pq3mW8nR2tV6xL9sK4dB',
    });
    expect(text(parent)).toContain('parent_id is not supported on create_category');
    const logos = await s.handleCallTool('get_accounts_live', { include_logos: true });
    expect(text(logos)).toContain('`include_logos` was removed in v3.0.0');
  });

  test('every problem in a call is reported at once', async () => {
    const { server: s, client } = server();
    const result = await s.handleCallTool('get_investment_balance_live', {
      time_frame: '1W',
      history_limit: 'ten',
      bogus: true,
    });
    const message = text(result);
    expect(message).toContain("Argument 'time_frame' must be one of");
    expect(message).toContain("Argument 'history_limit' must be an integer");
    expect(message).toContain("Unknown argument 'bogus'");
    expect(client.query).not.toHaveBeenCalled();
  });

  test('a well-formed call is not rejected', () => {
    for (const def of ALL_TOOL_DEFS) {
      expect(validateToolArgs(def, {}), def.name).toBeNull();
      expect(validateToolArgs(def, undefined), def.name).toBeNull();
    }
    const def = ALL_TOOL_DEFS.find((d) => d.name === 'get_transactions_live')!;
    expect(
      validateToolArgs(def, {
        period: 'this_month',
        limit: 10,
        min_amount: 1.5,
        transaction_type: 'refunds',
        fields: ['default', 'type'],
      })
    ).toBeNull();
  });
});

describe('validateToolArgs details', () => {
  const tool = {
    name: 'demo',
    schema: {
      inputSchema: {
        properties: {
          limit: { type: 'integer' },
          tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
      },
    },
  };

  test.each([
    [
      'a fractional integer',
      { limit: 1.5 },
      "Argument 'limit' must be an integer (a whole number)",
    ],
    ['null where a value is expected', { limit: null }, '; got null.'],
    ['an array item out of its enum', { tags: ['a', 'c'] }, "Argument 'tags[1]' must be one of"],
    [
      'an unknown key in a closed nested object',
      { edits: [{ id: 'x', extra: 1 }] },
      "Unknown key 'edits[0].extra'",
    ],
    ['a non-object argument bag', 'nope', 'expected an object of named arguments'],
  ] as const)('%s is rejected', (_label, args, message) => {
    expect(validateToolArgs(tool, args)).toContain(message);
  });
});
