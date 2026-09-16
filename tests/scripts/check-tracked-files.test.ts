/**
 * Behavioural tests for scripts/check-tracked-files.ts — the `check:tracked-files`
 * gate in `bun run check`.
 *
 * Context: `.gitignore` ignores all of `scripts/*` behind a hand-maintained
 * allowlist, so a new script nobody allowlists is a silent `git add` no-op. On
 * #727 the script the PR existed to add was never committed; every local gate
 * read it off disk and passed, and CI was the first to notice (#729).
 *
 * The script is driven end-to-end against synthetic **git repositories** via the
 * CHECK_TRACKED_FILES_ROOT override — a real `git init`, a real `.gitignore`, a
 * real commit — because the property under test is a property of git, and a
 * mocked one would only test the mock.
 *
 * Both directions are asserted deliberately. The failing cases are the deletion
 * mutants: remove the gate and each goes green. The passing cases are the
 * cry-wolf controls — local scratch under `scripts/local/` and build output
 * under `dist/` are ignored *on purpose*, and a gate that flagged them would be
 * turned off within a week. They cannot detect the gate's deletion on their own;
 * they exist to pin the boundary the failing cases are measured against.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-tracked-files.ts', import.meta.url));

type Result = { code: number; stderr: string; stdout: string };

/**
 * An environment in which `git` can only see the repository `cwd` points at.
 *
 * Not a nicety. `bun run check` runs from the pre-push hook, and git exports
 * `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` into every hook it runs. An
 * earlier draft of this file inherited them, so `git init` in a temp directory
 * re-initialised **the real repository** instead — which set `core.bare = true`
 * in the shared config and left `user.email = test@example.com` behind, in a
 * config every worktree of the repo reads. Tests that shell out to git must
 * pin the repository explicitly or they are not sandboxed at all.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` point at /dev/null for the mirror
 * reason: the temp repos must not pick up the developer's real identity or
 * signing configuration, which would make commits here prompt for a key.
 */
function sandboxedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || value === undefined) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

async function runCheck(root?: string, extraEnv: Record<string, string> = {}): Promise<Result> {
  const env = sandboxedEnv(extraEnv);
  delete env.CHECK_TRACKED_FILES_ROOT;
  if (root !== undefined) env.CHECK_TRACKED_FILES_ROOT = root;
  const proc = Bun.spawn(['bun', 'run', SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    env: sandboxedEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed with ${code}: ${await new Response(proc.stderr).text()}`
    );
  }
}

async function write(root: string, rel: string, body: string): Promise<void> {
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), body);
}

/**
 * The shape the real repo has: everything under `scripts/` ignored, individual
 * files re-admitted by name, plus a declared home for local scratch and a build
 * output directory.
 */
const GITIGNORE = ['dist/', 'scripts/local/', 'scripts/*', '!scripts/kept.ts', ''].join('\n');

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'synthetic',
    scripts: {
      'check:kept': 'bun run scripts/kept.ts',
      build: 'bun build src/entry.ts --outdir dist && chmod +x dist/entry.js',
    },
  },
  null,
  2
);

/**
 * Build a committed synthetic repo, let the caller perturb it, then run the gate.
 *
 * `git add -A` is used rather than `add -f` on purpose: the silent skip it
 * performs on an ignored path is the defect under test, so the fixture must be
 * built the same way a contributor builds a commit.
 */
async function withRepo(
  perturb: (root: string) => Promise<void>,
  assertions: (result: Result) => void,
  extraEnv: Record<string, string> = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'check-tracked-files-'));
  try {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.email', 'test@example.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'commit.gpgsign', 'false']);

    await write(root, '.gitignore', GITIGNORE);
    await write(root, 'package.json', PACKAGE_JSON);
    await write(root, 'scripts/kept.ts', "console.log('kept');\n");
    await write(root, 'src/entry.ts', "export const entry = 'entry';\n");
    await write(root, 'tests/example.test.ts', "export const example = 'example';\n");

    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'initial']);

    await perturb(root);
    assertions(await runCheck(root, extraEnv));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('check:tracked-files', () => {
  test('passes against this repo as checked in', async () => {
    const { code, stdout, stderr } = await runCheck();
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('tooling files are tracked and un-ignored');
  });

  test('passes on a healthy synthetic repo', async () => {
    await withRepo(
      async () => {},
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('tooling files are tracked and un-ignored');
      }
    );
  });

  // The #727 instance, reproduced: a new script, referenced from package.json,
  // that the allowlist does not cover. `git add -A` skips it without a word.
  test('fails on a package.json-referenced script the allowlist does not cover', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/newcomer.ts', "console.log('new');\n");
        await write(
          root,
          'package.json',
          PACKAGE_JSON.replace(
            '"check:kept"',
            '"check:newcomer": "bun run scripts/newcomer.ts",\n    "check:kept"'
          )
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('Tracked-files check failed');
        expect(stderr).toContain('scripts/newcomer.ts');
        expect(stderr).toContain('NOT TRACKED');
      }
    );
  });

  // Reference by import rather than by package.json — the same hole reached a
  // different way, and the one the first draft of the specifier regex missed
  // because a bare side-effect `import './x.js'` carries no `from`.
  test('fails on a script reached only by a side-effect import from a tracked test', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/imported.ts', 'export const imported = 1;\n');
        await write(root, 'tests/example.test.ts', "import '../scripts/imported.js';\n");
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/imported.ts');
        expect(stderr).toContain('NOT TRACKED');
      }
    );
  });

  // Spawned, not imported — how scripts/check-skills.py reaches
  // scripts/dump-tool-names.ts in the real repo.
  test('fails on a script named only as a string literal in a tracked script', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/spawned.ts', "console.log('spawned');\n");
        await write(
          root,
          'scripts/kept.ts',
          "const child = 'scripts/spawned.ts';\nexport { child };\n"
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/spawned.ts');
      }
    );
  });

  // A tracked file that a rule also matches still works — until a rename or a
  // `git rm --cached` re-adds it, at which point it leaves silently. The real
  // repo had seven such scripts plus one test file when this gate first ran.
  test('fails on a tracked file that .gitignore matches, and names the rule', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/landmine.ts', "console.log('landmine');\n");
        await git(root, ['add', '-f', 'scripts/landmine.ts']);
        await git(root, ['commit', '-qm', 'force-add an ignored script']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/landmine.ts');
        expect(stderr).toContain('tracked, but matched by .gitignore');
        expect(stderr).toContain('scripts/*');
      }
    );
  });

  // Renaming a script without updating the package.json entry that runs it
  // fails today only when something runs it. #729 asked for this too.
  test('fails when a package.json script names a path that does not exist', async () => {
    await withRepo(
      async (root) => {
        await write(
          root,
          'package.json',
          PACKAGE_JSON.replace('scripts/kept.ts', 'scripts/renamed-away.ts')
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/renamed-away.ts');
        expect(stderr).toContain('does not exist');
      }
    );
  });

  // `bun run check` runs from the pre-push hook, and git exports GIT_DIR into
  // every hook. A gate that inherited it would answer about whichever
  // repository the hook belongs to rather than the one it was pointed at —
  // and would report a bogus failure the moment the two differ.
  test('answers about the repo it was pointed at, not an inherited GIT_DIR', async () => {
    await withRepo(
      async () => {},
      ({ code, stdout, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(stdout).toContain('tooling files are tracked and un-ignored');
      },
      { GIT_DIR: join(tmpdir(), 'check-tracked-files-not-a-git-dir') }
    );
  });

  // Cry-wolf control: scripts/local/ is the declared home for local scratch.
  test('does not flag untracked local scratch that nothing references', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/local/scratch.ts', "console.log('mine alone');\n");
        await git(root, ['add', '-A']);
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('tooling files are tracked and un-ignored');
      }
    );
  });

  // Cry-wolf control: the build names dist/entry.js after creating it, so a
  // clean checkout is right not to have it.
  test('does not flag build output a package.json script names', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'dist/entry.js', '// built\n');
        await git(root, ['add', '-A']);
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('tooling files are tracked and un-ignored');
      }
    );
  });

  // The scratch carve-out is for the string-literal sweep only: an actual
  // import of a scratch file is a real break and must still be reported.
  test('still flags a scratch file a tracked script genuinely imports', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/local/helper.ts', 'export const helper = 1;\n');
        await write(
          root,
          'scripts/kept.ts',
          "import { helper } from './local/helper.js';\nconsole.log(helper);\n"
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/local/helper.ts');
      }
    );
  });
});
