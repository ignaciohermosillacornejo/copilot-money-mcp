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
      // The gate derives its generated-directory list from this script rather
      // than from a list of its own, so the fixture needs one to model the real
      // repo. Without it the gate's anti-vacuity guard fires and every case
      // here fails on a message about `clean` instead of its own subject.
      // `out-stage` is deliberately a name no hand-written list would carry:
      // the derivation test below tracks a file under it, which only fails if
      // the gate really did read this script.
      clean: 'rm -rf dist coverage out-stage',
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

  // CI and the git hooks invoke scripts by name from YAML and shell, which
  // carry no import graph. `scripts/check-pr-sections.sh` is named only from
  // `.github/workflows/required-sections.yml`; before this root existed it
  // passed the gate incidentally, because it happened to be tracked already.
  test('fails on a script referenced only from a workflow file', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/ci-only.sh', "echo 'ci only'\n");
        await write(
          root,
          '.github/workflows/ci.yml',
          'jobs:\n  a:\n    steps:\n      - run: bash scripts/ci-only.sh\n'
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/ci-only.sh');
        expect(stderr).toContain('NOT TRACKED');
      }
    );
  });

  test('fails on a script referenced only from a git hook', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/hook-only.sh', "echo 'hook only'\n");
        await write(root, '.husky/pre-push', 'bash scripts/hook-only.sh\n');
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/hook-only.sh');
      }
    );
  });

  // The token class admits `..`, so a literal like the `new URL('../../scripts/x.ts')`
  // this very file uses can name a path above the checkout. It must resolve
  // relative to the file that wrote it, never be joined onto the repo root raw,
  // or the gate reports a path outside the repository as untracked.
  test('resolves a ../-prefixed literal against its own file, not the repo root', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'scripts/target.ts', 'export const target = 1;\n');
        // From tests/, '../scripts/target.ts' is the real file; joined onto the
        // repo root it would be '../scripts/target.ts' — outside the checkout.
        await write(
          root,
          'tests/example.test.ts',
          "const p = '../scripts/target.ts';\nexport { p };\n"
        );
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        // Named by its in-repo path, with no `../` escaping into the message.
        expect(stderr).toContain('scripts/target.ts');
        expect(stderr).not.toContain('../scripts/target.ts');
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
        expect(stderr).toContain('tracked, but matched by an ignore rule');
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

  // The rule that produced seven of this PR's eight sibling fixes was
  // `MANIFEST-*`, which over-matches only where `core.ignoreCase` is true —
  // default macOS APFS, not ubuntu-latest's ext4. Without setting it here the
  // whole case-fold class is unobservable on Linux, so CI could never see a
  // regression of it. The fixture sets it explicitly.
  test('detects a case-fold over-match, on any filesystem', async () => {
    await withRepo(
      async (root) => {
        await git(root, ['config', 'core.ignorecase', 'true']);
        await writeFile(join(root, '.gitignore'), `${GITIGNORE}MANIFEST-*\n`);
        await write(root, 'scripts/manifest-utils.ts', 'export const u = 1;\n');
        await git(root, ['add', '-f', 'scripts/manifest-utils.ts']);
        await git(root, ['add', '.gitignore']);
        await git(root, ['commit', '-qm', 'an over-broad rule and its victim']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/manifest-utils.ts');
        expect(stderr).toContain('MANIFEST-*');
      }
    );
  });

  // skills/ ships to users inside the .mcpb and is the only directory besides
  // scripts/ with a hand-written rule inside it. The repo-wide unanchored rules
  // (LOG, CURRENT, LOCK, *.log) match at any depth, so a skill reference file
  // can be ignore-matched exactly the way tests/unit/manifest-sync.test.ts was.
  test('flags a tracked file under a shipped directory that an unanchored rule matches', async () => {
    await withRepo(
      async (root) => {
        await writeFile(join(root, '.gitignore'), `${GITIGNORE}LOG\n`);
        await write(root, 'skills/demo/references/LOG', 'notes\n');
        await git(root, ['add', '-f', 'skills/demo/references/LOG']);
        await git(root, ['add', '.gitignore']);
        await git(root, ['commit', '-qm', 'a shipped file an unanchored rule matches']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('skills/demo/references/LOG');
        expect(stderr).toContain('tracked, but matched by an ignore rule');
      }
    );
  });

  // The header claims every repo-relative path a package.json script names, and
  // `typecheck` names two tsconfigs at the repo root. Requiring a directory
  // segment dropped both silently — and widening the token exposed an ordered
  // alternation that matched `js` inside `.json`, turning `tsconfig.tests.json`
  // into a dangling reference to `tsconfig.tests.js`.
  test('seeds a root-level path, and does not truncate its extension', async () => {
    await withRepo(
      async (root) => {
        await write(root, 'tsconfig.tests.json', '{}\n');
        await write(
          root,
          'package.json',
          PACKAGE_JSON.replace(
            '"check:kept"',
            '"typecheck": "tsc -p tsconfig.tests.json",\n    "check:kept"'
          )
        );
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-qm', 'a root-level tsconfig']);
        // Now make it vanish the way a rename would.
        await git(root, ['rm', '-q', '--cached', 'tsconfig.tests.json']);
        await rm(join(root, 'tsconfig.tests.json'));
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        // The whole extension, not `tsconfig.tests.js`. A lookahead rather than
        // `not.toContain('tsconfig.tests.js,')`: that trailing comma was doing
        // the work of telling the two apart, so any change to how the message
        // punctuates a path would have retired this detector in silence — the
        // exact class this gate exists for.
        expect(stderr).toContain('tsconfig.tests.json');
        expect(stderr).not.toMatch(/tsconfig\.tests\.js(?!on)/);
      }
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

  // -------------------------------------------------------------------------
  // The inverse direction (#766): nothing GENERATED may be tracked.
  // -------------------------------------------------------------------------

  test('flags a tracked file under a directory `clean` deletes', async () => {
    // The instance that motivated it: a `git add -A` after a local coverage run
    // committed `coverage/`, and every gate stayed green because all of them
    // asked "is what we need present?" and none asked "is anything here that
    // should not be?".
    await withRepo(
      async (root) => {
        await write(root, 'coverage/lcov.info', 'TN:\nSF:src/entry.ts\nend_of_record\n');
        // A plain `add`, not `add -f`: the fixture has no `coverage/` ignore
        // rule, mirroring the real repo's state, and an ordinary add is how
        // the file actually got committed. `-f` would keep this test passing
        // if the fixture ever gained such a rule — at which point it would be
        // exercising a state the real bug did not have. `withRepo`'s docblock
        // makes the same argument about `add -A`.
        await git(root, ['add', 'coverage/lcov.info']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('coverage/lcov.info');
        expect(stderr).toContain('`bun run clean` deletes');
        // The remedy has to be the one that STAYS fixed: deleting the file
        // without an ignore rule leaves the next `git add -A` free to re-add it.
        expect(stderr).toContain('git rm -r --cached');
      }
    );
  });

  test('a generated directory that is empty of tracked files passes', async () => {
    // Guards the gate from the other side: the check is about the INDEX, not
    // about the directory existing on disk. A contributor who has just run the
    // tests must not fail a check they cannot act on.
    await withRepo(
      async (root) => {
        await write(root, 'coverage/lcov.info', 'TN:\n');
        // Deliberately NOT added — present on disk, absent from the index.
      },
      ({ code, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  test('the generated list is derived from `clean`, not hardcoded', async () => {
    // `out-stage` is the point: it appears in the fixture's `clean` script and
    // nowhere in this repo, so no hand-written list in the gate could contain
    // it. If the derivation stopped working, this file would simply not be
    // guarded and the case would go green.
    await withRepo(
      async (root) => {
        await write(root, 'out-stage/bundle.js', "console.log('staged');\n");
        await git(root, ['add', 'out-stage/bundle.js']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('out-stage/bundle.js');
      }
    );
  });

  test('an ignored generated directory is caught too', async () => {
    // `dist/` IS in the fixture's ignore file, so this one needs `-f` — the
    // contrast with the coverage case above, where the missing ignore rule is
    // what let an ordinary `add` sweep the file in.
    await withRepo(
      async (root) => {
        await write(root, 'dist/entry.js', "console.log('built');\n");
        await git(root, ['add', '-f', 'dist/entry.js']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('dist/entry.js');
      }
    );
  });

  test('a `clean` this script cannot parse fails loudly, per spelling', async () => {
    // The half the empty-parse guard misses: these produce a NON-empty list
    // whose entries match no path `git ls-files` emits, so the gate would
    // report a directory count over a scan that guards nothing — the same
    // "finds nothing, looks like a pass" shape one layer in.
    // NB `./dist` is absent: a leading `./` is normalised, not rejected, and
    // the next test pins that. Listing it here too would be two tests asserting
    // opposite things about one spelling.
    for (const clean of [
      'rm -rf "dist" coverage',
      'rm -rf dist/*',
      'rm -rf dist && rm -rf coverage',
      // Brace expansion carries no operator, quote or glob character, so the
      // first draft's metacharacter denylist passed it as ONE directory named
      // `{dist,coverage,.bun-build}` — a non-empty parse guarding nothing.
      // It is also the most natural way to write this exact script.
      'rm -rf {dist,coverage,.bun-build}',
      'rm -rf dist[0-9] coverage',
      'rm -rf ~/dist coverage',
      // Plain paths, every one of them — and none names anything
      // `git ls-files` can print, so each would report a directory count over
      // a scan matching nothing. Being free of shell syntax was only half of
      // "readable"; the other half is "inside this repo".
      'rm -rf ../dist coverage',
      'rm -rf /tmp/build coverage',
      'rm -rf .',
    ]) {
      await withRepo(
        async (root) => {
          const pkg = JSON.parse(PACKAGE_JSON) as { scripts: Record<string, string> };
          pkg.scripts.clean = clean;
          await write(root, 'package.json', JSON.stringify(pkg, null, 2));
          await git(root, ['add', '-A']);
        },
        ({ code, stderr }) => {
          expect(code, `\`${clean}\` must not pass silently`).toBe(1);
          expect(stderr, `\`${clean}\` must name the parse as the problem`).toContain(
            'cannot read as a directory'
          );
        }
      );
    }
  });

  test('`./dist` is normalised rather than rejected when it stands alone', async () => {
    // Not every unusual spelling is unreadable. A leading `./` is normalised,
    // because `git ls-files` never emits one and the intent is unambiguous —
    // so this must still CATCH, not complain about the parse.
    await withRepo(
      async (root) => {
        const pkg = JSON.parse(PACKAGE_JSON) as { scripts: Record<string, string> };
        pkg.scripts.clean = 'rm -rf ./dist ./coverage ./out-stage';
        await write(root, 'package.json', JSON.stringify(pkg, null, 2));
        await write(root, 'out-stage/bundle.js', "console.log('staged');\n");
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('out-stage/bundle.js');
      }
    );
  });

  test('a `clean` target that names a FILE is generated for both consumers', async () => {
    // `rm -rf` is routinely pointed at a file. When it is, the two users of
    // this derivation must agree: the seeds sweep must treat the path as
    // generated (so a fresh clone, where it does not exist, is not reported as
    // "names X, which does not exist"), and rule (4) must still refuse to let
    // it be tracked. A prefix-only test in one of them and an exact-or-prefix
    // test in the other would answer those two questions differently.
    await withRepo(
      async (root) => {
        const pkg = JSON.parse(PACKAGE_JSON) as { scripts: Record<string, string> };
        pkg.scripts.clean = 'rm -rf dist coverage out-stage scripts/generated-manifest.json';
        pkg.scripts['check:manifest'] = 'bun run scripts/kept.ts scripts/generated-manifest.json';
        await write(root, 'package.json', JSON.stringify(pkg, null, 2));
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        // The file is named by a script and absent from disk. Without the
        // shared predicate this reads "names scripts/generated-manifest.json,
        // which does not exist" — the report `isGenerated` exists to prevent.
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  test('...and rule (4) still refuses to let that file be tracked', async () => {
    // The other half of the same agreement. Asserted separately so a failure
    // says which direction broke.
    await withRepo(
      async (root) => {
        const pkg = JSON.parse(PACKAGE_JSON) as { scripts: Record<string, string> };
        pkg.scripts.clean = 'rm -rf dist coverage out-stage scripts/generated-manifest.json';
        await write(root, 'package.json', JSON.stringify(pkg, null, 2));
        await write(root, 'scripts/generated-manifest.json', '{}\n');
        await git(root, ['add', '-f', 'package.json', 'scripts/generated-manifest.json']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('scripts/generated-manifest.json');
        expect(stderr).toContain('`bun run clean` deletes');
      }
    );
  });

  test('a `clean` naming no directories fails loudly instead of passing over everything', async () => {
    // The anti-vacuity guard itself. A reworded `clean` would otherwise make
    // every case above pass by scanning nothing — the failure mode this repo
    // keeps finding, where an under-collecting scan is indistinguishable from
    // a clean run.
    await withRepo(
      async (root) => {
        const pkg = JSON.parse(PACKAGE_JSON) as { scripts: Record<string, string> };
        pkg.scripts.clean = 'echo nothing to do';
        await write(root, 'package.json', JSON.stringify(pkg, null, 2));
        await git(root, ['add', '-A']);
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('named no `rm -rf` targets');
      }
    );
  });
});
