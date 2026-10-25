/**
 * Behavioural tests for scripts/check-server-json.ts — the `check:server-json`
 * gate in `bun run check`.
 *
 * The MCP registry publish step runs with `continue-on-error: true`, so a
 * server.json the registry rejects only shows up as a quiet failure inside the
 * release. This gate checks the description length and the shape of every
 * packageArguments entry before that.
 *
 * The script is driven end-to-end against synthetic files via the
 * CHECK_SERVER_JSON_PATH override, matching tests/scripts/check-deps-pinned.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-server-json.ts', import.meta.url));
const REAL_SERVER_JSON = fileURLToPath(new URL('../../server.json', import.meta.url));

type Result = { code: number; stderr: string; stdout: string };

async function runCheck(path: string): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], {
    env: { ...process.env, CHECK_SERVER_JSON_PATH: path },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

const GOOD_ARG = {
  type: 'named',
  name: '--flag',
  description: 'Does a thing.',
  isRequired: false,
};

/** Write a synthetic server.json with these packageArguments, run the gate, clean up. */
async function withArgs(packageArguments: unknown, description = 'A server.'): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'server-json-'));
  const path = join(dir, 'server.json');
  try {
    await writeFile(path, JSON.stringify({ description, packages: [{ packageArguments }] }));
    return await runCheck(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('check:server-json', () => {
  test('passes on the real server.json', async () => {
    const { code, stderr } = await runCheck(REAL_SERVER_JSON);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  test('passes a well-formed argument', async () => {
    expect((await withArgs([GOOD_ARG])).code).toBe(0);
  });

  test('fails a description over 100 characters', async () => {
    const { code, stderr } = await withArgs([GOOD_ARG], 'x'.repeat(101));
    expect(code).toBe(1);
    expect(stderr).toContain('description is 101 chars (max 100)');
  });

  const BAD: [string, Record<string, unknown>, string][] = [
    ['an unknown type', { ...GOOD_ARG, type: 'flag' }, '.type is "flag"'],
    [
      'a positional with no value or valueHint',
      { type: 'positional', description: 'A path.', isRequired: true },
      ' is positional but has neither a value nor a valueHint string',
    ],
    ['a name without --', { ...GOOD_ARG, name: 'flag' }, '.name is "flag"'],
    ['a missing name', { ...GOOD_ARG, name: undefined }, '.name is undefined'],
    ['an empty description', { ...GOOD_ARG, description: ' ' }, '.description is missing or empty'],
    ['a string isRequired', { ...GOOD_ARG, isRequired: 'false' }, '.isRequired is not a boolean'],
  ];
  for (const [label, arg, message] of BAD) {
    test(`fails ${label}`, async () => {
      const { code, stderr } = await withArgs([GOOD_ARG, arg]);
      expect(code).toBe(1);
      expect(stderr).toContain(`packages[0].packageArguments[1]${message}`);
    });
  }

  test('passes a positional argument with a valueHint', async () => {
    const positional = {
      type: 'positional',
      valueHint: 'path',
      description: 'A path.',
      isRequired: true,
    };
    expect((await withArgs([GOOD_ARG, positional])).code).toBe(0);
  });

  test('reports a null argument by index instead of crashing', async () => {
    const { code, stderr } = await withArgs([GOOD_ARG, null]);
    expect(code).toBe(1);
    expect(stderr).toContain('packages[0].packageArguments[1] is null, expected an object');
    expect(stderr).not.toContain('TypeError');
  });

  test('reports a null package by index instead of crashing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'server-json-'));
    const path = join(dir, 'server.json');
    try {
      await writeFile(path, JSON.stringify({ description: 'A server.', packages: [null] }));
      const { code, stderr } = await runCheck(path);
      expect(code).toBe(1);
      expect(stderr).toContain('packages[0] is null, expected an object');
      expect(stderr).not.toContain('TypeError');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('fails packageArguments that is not an array', async () => {
    const { code, stderr } = await withArgs({ name: '--flag' });
    expect(code).toBe(1);
    expect(stderr).toContain('packages[0].packageArguments is not an array');
  });
});
