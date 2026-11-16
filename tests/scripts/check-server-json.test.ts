/**
 * Behavioural tests for scripts/check-server-json.ts — the `check:server-json`
 * gate in `bun run check`.
 *
 * The MCP registry publish step runs with `continue-on-error: true`, so a
 * server.json the registry rejects only shows up as a quiet failure inside the
 * release. This gate checks the description length and the shape of every
 * packageArguments entry before that, and that the named arguments describe
 * the CLI's own flags (CLI_FLAGS in src/cli-args.ts).
 *
 * The script is driven end-to-end against synthetic files via the
 * CHECK_SERVER_JSON_PATH override, matching tests/scripts/check-deps-pinned.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { validBrowserNames } from '../../src/core/auth/browser-selection.js';

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

/** The real argument list: every synthetic file starts from it, since the gate
 * requires each published CLI flag to be listed. */
const REAL_ARGS: Record<string, unknown>[] = (
  JSON.parse(readFileSync(REAL_SERVER_JSON, 'utf-8')) as {
    packages: [{ packageArguments: Record<string, unknown>[] }];
  }
).packages[0].packageArguments;
/** Index of the first argument a test appends after REAL_ARGS. */
const NEXT = REAL_ARGS.length;

/** A well-formed positional argument, which the CLI cross-check does not touch. */
const GOOD_ARG = {
  type: 'positional',
  valueHint: 'path',
  description: 'Does a thing.',
  isRequired: false,
};

/** Write this value as server.json, run the gate, clean up. */
async function withServerJson(server: unknown): Promise<Result> {
  const dir = await mkdtemp(join(tmpdir(), 'server-json-'));
  const path = join(dir, 'server.json');
  try {
    await writeFile(path, JSON.stringify(server));
    return await runCheck(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A server.json with one package carrying these packageArguments. */
function withArgs(packageArguments: unknown, description = 'A server.'): Promise<Result> {
  return withServerJson({ description, packages: [{ packageArguments }] });
}

/** REAL_ARGS with the argument named `name` changed by `edit`. */
function withRealArgEdited(
  name: string,
  edit: (arg: Record<string, unknown>) => Record<string, unknown>
): Promise<Result> {
  return withArgs(REAL_ARGS.map((arg) => (arg.name === name ? edit({ ...arg }) : arg)));
}

describe('check:server-json', () => {
  test('passes on the real server.json', async () => {
    const { code, stderr } = await runCheck(REAL_SERVER_JSON);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  test('passes a well-formed argument', async () => {
    expect((await withArgs([...REAL_ARGS, GOOD_ARG])).code).toBe(0);
  });

  test('fails a description over 100 characters', async () => {
    const { code, stderr } = await withArgs(REAL_ARGS, 'x'.repeat(101));
    expect(code).toBe(1);
    expect(stderr).toContain('description is 101 chars (max 100)');
  });

  const NAMED = { type: 'named', name: '--x', description: 'Does a thing.', isRequired: false };
  const BAD: [string, Record<string, unknown>, string][] = [
    ['an unknown type', { ...GOOD_ARG, type: 'flag' }, '.type is "flag"'],
    ['a missing type', { ...GOOD_ARG, type: undefined }, '.type is undefined'],
    [
      'a positional with no value or valueHint',
      { type: 'positional', description: 'A path.', isRequired: true },
      ' is positional but has neither a value nor a valueHint string',
    ],
    ['a name without --', { ...NAMED, name: 'flag' }, '.name is "flag"'],
    ['a missing name', { ...NAMED, name: undefined }, '.name is undefined'],
    ['an empty description', { ...GOOD_ARG, description: ' ' }, '.description is missing or empty'],
    ['a string isRequired', { ...GOOD_ARG, isRequired: 'false' }, '.isRequired is not a boolean'],
  ];
  for (const [label, arg, message] of BAD) {
    test(`fails ${label}`, async () => {
      const { code, stderr } = await withArgs([...REAL_ARGS, arg]);
      expect(code).toBe(1);
      expect(stderr).toContain(`packages[0].packageArguments[${NEXT}]${message}`);
    });
  }

  test('reports a null argument by index instead of crashing', async () => {
    const { code, stderr } = await withArgs([...REAL_ARGS, null]);
    expect(code).toBe(1);
    expect(stderr).toContain(`packages[0].packageArguments[${NEXT}] is null, expected an object`);
    expect(stderr).not.toContain('TypeError');
  });

  test('reports a null package by index instead of crashing', async () => {
    const { code, stderr } = await withServerJson({ description: 'A server.', packages: [null] });
    expect(code).toBe(1);
    expect(stderr).toContain('packages[0] is null, expected an object');
    expect(stderr).not.toContain('TypeError');
  });

  test('reports a null server.json instead of crashing', async () => {
    const { code, stderr } = await withServerJson(null);
    expect(code).toBe(1);
    expect(stderr).toContain('server.json is null, expected an object');
    expect(stderr).not.toContain('TypeError');
  });

  test('reports an array argument by index', async () => {
    const { code, stderr } = await withArgs([...REAL_ARGS, []]);
    expect(code).toBe(1);
    expect(stderr).toContain(`packages[0].packageArguments[${NEXT}] is [], expected an object`);
  });

  test('fails packageArguments that is not an array', async () => {
    const { code, stderr } = await withArgs({ name: '--flag' });
    expect(code).toBe(1);
    expect(stderr).toContain('packages[0].packageArguments is not an array');
  });

  describe('named arguments describe the CLI flags', () => {
    test('--browser choices that drift from validBrowserNames() fail', async () => {
      const { code, stderr } = await withRealArgEdited('--browser', (arg) => ({
        ...arg,
        choices: validBrowserNames().slice(1),
      }));
      expect(code).toBe(1);
      expect(stderr).toContain('(--browser).choices is ');
      expect(stderr).toContain(JSON.stringify(validBrowserNames()));
    });

    test('--browser without choices fails', async () => {
      const { code, stderr } = await withRealArgEdited(
        '--browser',
        ({ choices: _, ...arg }) => arg
      );
      expect(code).toBe(1);
      expect(stderr).toContain('(--browser).choices is undefined');
    });

    test('choices on a flag that has none fail', async () => {
      const { code, stderr } = await withRealArgEdited('--browser-profile', (arg) => ({
        ...arg,
        choices: ['Default'],
      }));
      expect(code).toBe(1);
      expect(stderr).toContain('(--browser-profile).choices is ["Default"], expected undefined');
    });

    for (const name of ['--db-path', '--browser-data-dir']) {
      test(`${name} without format "filepath" fails`, async () => {
        const { code, stderr } = await withRealArgEdited(name, ({ format: _, ...arg }) => arg);
        expect(code).toBe(1);
        expect(stderr).toContain(`(${name}).format is undefined, expected "filepath"`);
      });
    }

    for (const name of ['--write', '--live-reads']) {
      test(`${name} without format "boolean" fails`, async () => {
        const { code, stderr } = await withRealArgEdited(name, ({ format: _, ...arg }) => arg);
        expect(code).toBe(1);
        expect(stderr).toContain(`(${name}).format is undefined, expected "boolean"`);
      });
    }

    test('a value-taking flag described as boolean fails', async () => {
      const { code, stderr } = await withRealArgEdited('--browser-profile', (arg) => ({
        ...arg,
        format: 'boolean',
      }));
      expect(code).toBe(1);
      expect(stderr).toContain('(--browser-profile).format is "boolean", expected "string"');
    });

    test('a named argument the CLI does not parse fails', async () => {
      const { code, stderr } = await withArgs([
        ...REAL_ARGS,
        { type: 'named', name: '--frobnicate', description: 'Nope.', isRequired: false },
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain(`[${NEXT}].name --frobnicate is not a flag the CLI parses`);
    });

    test('an unpublished CLI flag listed in server.json fails', async () => {
      const { code, stderr } = await withArgs([
        ...REAL_ARGS,
        { type: 'named', name: '--timeout', description: 'ms', isRequired: false },
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain(
        `[${NEXT}].name --timeout is listed but CLI_FLAGS marks it unpublished`
      );
    });

    test('a published CLI flag missing from server.json fails', async () => {
      const { code, stderr } = await withArgs(REAL_ARGS.filter((a) => a.name !== '--browser'));
      expect(code).toBe(1);
      expect(stderr).toContain(
        'packageArguments has no --browser, which CLI_FLAGS marks published'
      );
    });
  });
});
