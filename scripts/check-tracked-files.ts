#!/usr/bin/env bun
/**
 * Assert that every file the repo's own tooling needs is tracked by git — and
 * that none of them is matched by `.gitignore`.
 *
 * `.gitignore` ignores all of `scripts/*` and re-admits individual files
 * through a hand-maintained allowlist of `!scripts/<name>` negations. A new
 * script nobody remembers to allowlist is therefore a **silent** `git add`
 * no-op: exit 0, no warning, the file stays local. Every local gate then
 * passes, because every local gate reads the file off disk — and CI, which
 * clones, is the first thing to notice.
 *
 * That happened on #727: `scripts/check-workflows.ts`, the entire point of the
 * PR, was never committed. `bun run check` and the pre-push hook were both
 * green on the author's machine; CI failed with `Module not found`. The
 * instance was fixed by adding one negation. The class — `silent-failure-
 * masking`, the most-recurring class in `docs/bugs/MINOR.md` — was not (#729).
 *
 * A gate only CI can run is a green box over an unenforced invariant, so this
 * one runs in `bun run check`, before the push that would have shipped the
 * hole.
 *
 * ## What counts as "needed"
 *
 * Three sources, all derived — nothing here is a list of files to keep in sync:
 *
 *   1. Every repo-relative path named in a `package.json` `"scripts"` command.
 *      Running a command that names a file it does not have is a hard failure,
 *      so a clean checkout must contain it.
 *   2. The relative-import closure of (1) plus every **tracked** file under
 *      `scripts/` and `tests/`. An import that cannot resolve is a hard
 *      failure too, transitively.
 *   3. `scripts/…` paths named as string literals inside those files — the
 *      spawn-not-import case, e.g. `scripts/check-skills.py` shelling out to
 *      `scripts/dump-tool-names.ts`. Deliberately narrowed to the `scripts/`
 *      prefix: a broader "any path-like literal" sweep would sweep up the
 *      directories tooling *writes* (snapshots, generated fixtures, the demo
 *      database), which are ignored on purpose.
 *
 * ## Why the roots are tracked-only
 *
 * (2) walks tracked files, not everything on disk, because an untracked file
 * under `scripts/` that nothing references is local scratch — which is exactly
 * what `scripts/local/` and the `scripts/*` rule exist to keep out of commits.
 * Demanding that every file on disk be tracked would fail on the files the
 * ignore rule was written for, and a gate that cries wolf gets disabled. A
 * scratch file that a tracked script imports or spawns is a different matter:
 * it enters the closure through (2) or (3) and is reported, correctly.
 *
 * ## Two failure kinds
 *
 * - **untracked** — the #727 instance. The file exists here and nowhere else.
 * - **tracked but ignore-matched** — a landmine rather than a live break. Git
 *   honours the index over `.gitignore`, so the file keeps working until
 *   something re-adds it: a rename, a `git rm --cached`, a move between
 *   worktrees. Then it silently disappears in exactly the #727 way. Reported
 *   because the fix (one negation) is cheap and the failure is not.
 *
 * Run as part of `bun run check`.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so tests can drive the real script against a synthetic git repo,
// matching CHECK_TOOL_COUNTS_ROOT / CHECK_WORKFLOWS_DIR / CHECK_DEPS_PINNED_PACKAGE_JSON.
const repoRoot = resolve(process.env.CHECK_TRACKED_FILES_ROOT ?? join(__dirname, '..'));

/**
 * Directories the build *produces*.
 *
 * `bun run build` names `dist/cli.js` and `dist/launcher.sh` after creating
 * them, so they are outputs, not inputs, and a clean checkout is right not to
 * have them. This is a hand-written list, which is the thing #729 is about —
 * but its failure mode is the opposite one: a generated path outside these
 * prefixes makes this gate fail loudly and the author adds a prefix. The
 * `.gitignore` allowlist fails silently, which is why it needed a gate.
 */
const GENERATED_PREFIXES = ['dist/'];

/**
 * The declared home for local scratch — gitignored on purpose, and excluded
 * from the scripts typecheck for the same reason. Excluded from the
 * string-literal sweep (3) only: a *comment* naming an example path under it
 * must not fail the gate, while an actual `import` of one still does, because
 * the import closure (2) does not consult this list.
 */
const LOCAL_SCRATCH_PREFIX = 'scripts/local/';

/** Roots whose tracked files are tooling by definition. */
const TOOLING_ROOTS = ['scripts/', 'tests/'];

/** Extensions whose files are read as source by something in this repo. */
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py)$/;

/** A repo-relative path with at least one directory segment and a known extension. */
const PATH_TOKEN = /(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py|json|ya?ml)/g;

/** A `scripts/…` path named anywhere in a tooling file — spawned, not imported. */
const SCRIPTS_PATH_TOKEN = /(?:[\w.-]+\/)*scripts\/(?:[\w.-]+\/)*[\w.-]+\.[\w]+/g;

/**
 * Relative module specifiers, in every form that reaches a file: `from './x.js'`,
 * `import('./x.js')`, `require('./x.js')`, and the bare side-effect `import './x.js'`
 * — which the first draft of this regex missed, so a probe file pulled in only by a
 * side-effect import went unreported while the package.json path was reported fine.
 */
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/**
 * The environment every `git` call here runs under.
 *
 * `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` are exported by git into
 * every hook it runs — and this gate runs from the pre-push hook. Inheriting
 * them silently redirects the query away from `repoRoot`: a gate answering
 * about a different repository than the one it names is the failure mode it
 * exists to prevent. Stripping every `GIT_*` variable keeps `cwd` the only
 * thing that decides which repository is inspected.
 */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);

function git(args: string[]): { code: number; stdout: string } {
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    env: GIT_ENV,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

function isFile(rel: string): boolean {
  const abs = join(repoRoot, rel);
  try {
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

function isGenerated(rel: string): boolean {
  return GENERATED_PREFIXES.some((p) => rel.startsWith(p));
}

/** Normalise a matched token to a repo-relative path, or null if it escapes the repo. */
function toRepoRelative(abs: string): string | null {
  const rel = relative(repoRoot, abs);
  if (rel === '' || rel.startsWith('..')) return null;
  return rel.split('\\').join('/');
}

function readIfPossible(rel: string): string | null {
  try {
    return readFileSync(join(repoRoot, rel), 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// (1) Paths named by package.json scripts.
// ---------------------------------------------------------------------------

const pkgRaw = readIfPossible('package.json');
if (pkgRaw === null) {
  console.error(`Tracked-files check failed: cannot read ${join(repoRoot, 'package.json')}`);
  process.exit(1);
}
const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };

const seeds = new Set<string>();
/** A package.json script names a path that is neither generated nor on disk. */
const dangling: string[] = [];

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  for (const match of String(command).matchAll(PATH_TOKEN)) {
    const rel = match[0];
    if (isGenerated(rel)) continue;
    if (isFile(rel)) seeds.add(rel);
    else dangling.push(`package.json scripts.${name} names ${rel}, which does not exist`);
  }
}

// ---------------------------------------------------------------------------
// (2) + (3) Closure over tracked tooling files.
// ---------------------------------------------------------------------------

const lsFiles = git(['ls-files', '-z']);
if (lsFiles.code !== 0) {
  console.error('Tracked-files check failed: `git ls-files` did not succeed');
  process.exit(1);
}
const tracked = new Set(lsFiles.stdout.split('\0').filter((p) => p !== ''));

const needed = new Set<string>(seeds);
for (const file of tracked) {
  if (TOOLING_ROOTS.some((r) => file.startsWith(r)) && SOURCE_EXT.test(file)) needed.add(file);
}

/** Resolve a relative specifier the way bun/tsc would, including `.js` → `.ts`. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = join(repoRoot, dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    const rel = toRepoRelative(candidate);
    if (rel !== null && isFile(rel)) return rel;
  }
  return null;
}

const queue = [...needed];
while (queue.length > 0) {
  const file = queue.pop() as string;
  const source = readIfPossible(file);
  if (source === null) continue;

  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const rel = resolveSpecifier(file, match[1] as string);
    if (rel !== null && !isGenerated(rel) && !needed.has(rel)) {
      needed.add(rel);
      queue.push(rel);
    }
  }

  for (const match of source.matchAll(SCRIPTS_PATH_TOKEN)) {
    const rel = match[0];
    if (rel.startsWith(LOCAL_SCRATCH_PREFIX)) continue;
    if (isGenerated(rel) || needed.has(rel) || !isFile(rel)) continue;
    needed.add(rel);
    queue.push(rel);
  }
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

const candidates = [...needed].sort();

const untracked = candidates.filter((f) => !tracked.has(f));

// `git check-ignore` consults the index by default and reports a tracked file
// as not-ignored, which would hide precisely the landmine case. `--no-index`
// asks the question we mean: does a rule match this path?
let ignoreMatched: string[] = [];
if (candidates.length > 0) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: repoRoot,
    env: GIT_ENV,
    input: `${candidates.join('\0')}\0`,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // Exit 0 = some path is ignored, 1 = none are. Anything else is a real error.
  if (r.status !== 0 && r.status !== 1) {
    console.error('Tracked-files check failed: `git check-ignore` did not succeed');
    console.error(r.stderr ?? '');
    process.exit(1);
  }
  ignoreMatched = (r.stdout ?? '').split('\0').filter((p) => p !== '');
}

const failures: string[] = [];
for (const problem of dangling) failures.push(problem);
for (const file of untracked) {
  failures.push(`${file}: needed by the repo's tooling but NOT TRACKED by git`);
}
for (const file of ignoreMatched.sort()) {
  // An untracked file that is also ignore-matched is already reported above,
  // with the failure that actually bites. Saying "tracked, but…" about it too
  // would be a second line that contradicts the first.
  if (!tracked.has(file)) continue;
  const rule = git(['check-ignore', '--no-index', '-v', file]).stdout.trim().split('\t')[0] ?? '';
  failures.push(
    `${file}: tracked, but matched by .gitignore${rule === '' ? '' : ` (${rule})`} — ` +
      'a rename or re-add would silently drop it',
  );
}

if (failures.length > 0) {
  console.error('Tracked-files check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nEvery file the repo\'s tooling reaches must survive a fresh clone. Add a ' +
      '`!<path>` negation to the allowlist under the `scripts/*` rule in .gitignore ' +
      '(or fix the over-broad rule the message names), then `git add` the file and ' +
      're-run. If the path is genuinely produced by the build, add its directory to ' +
      'GENERATED_PREFIXES in this script.',
  );
  process.exit(1);
}

console.log(
  `All ${candidates.length} tooling files are tracked and un-ignored ` +
    `(${seeds.size} named by package.json scripts).`,
);
