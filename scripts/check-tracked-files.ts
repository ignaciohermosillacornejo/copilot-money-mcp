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
 *   3. `scripts/…` and `.github/…` paths named as text in those files — and in
 *      every tracked file under `.github/workflows/`, `.husky/` and `skills/`,
 *      none of which has an import graph to walk. This is the spawn-and-read
 *      case that (2) cannot reach: `scripts/check-skills.py` shells out to
 *      `scripts/dump-tool-names.ts`, `required-sections.yml` runs
 *      `scripts/check-pr-sections.sh` (named by nothing in package.json), and
 *      `tests/scripts/audit-severity-gate.test.ts` reads
 *      `.github/audit-severity-gate.jq` through a joined path. Deliberately
 *      narrowed to those two prefixes: a broader "any path-like literal" sweep
 *      would sweep up the directories tooling *writes* (snapshots, generated
 *      fixtures, the demo database), which are ignored on purpose.
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
 * The second kind is **platform-dependent**, and legitimately so. Matching
 * honours `core.ignoreCase`, which git sets at clone time from the
 * filesystem, so a rule like `MANIFEST-*` catches `manifest-sync.test.ts` on
 * default macOS APFS and nothing at all on Linux. All eight instances this
 * gate found on its first run were invisible to CI for that reason. So the
 * local run can be red while the CI run is green — always in that direction,
 * never the reverse, because the stricter filesystem is the one a contributor
 * is working on. "CI green, my machine red" is the gate working, not broken:
 * the fix is the same negation either way.
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
 * Read a repo file, or null when it is not there.
 *
 * Defined this high because the generated-directory derivation below needs
 * `package.json` before anything else runs.
 */
function readIfPossible(rel: string): string | null {
  try {
    return readFileSync(join(repoRoot, rel), 'utf-8');
  } catch {
    return null;
  }
}

const pkgRaw = readIfPossible('package.json');
if (pkgRaw === null) {
  console.error(`Tracked-files check failed: cannot read ${join(repoRoot, 'package.json')}`);
  process.exit(1);
}
const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };

/**
 * Tokens in `clean` that the parse below refuses to read as a directory.
 *
 * A quoted or `./`-prefixed name is not WRONG shell, it just is not what
 * `git ls-files` emits — `./dist` matches no tracked path, so the gate would
 * guard nothing while reporting a directory count. A shell operator is worse:
 * `rm -rf dist && rm -rf coverage` parses to four tokens, two of which are not
 * directories at all. Both are handled by normalising what can be normalised
 * (`./`, surrounding quotes, trailing slashes) and treating anything still
 * carrying shell syntax as "this script says something I cannot read".
 */
const SHELL_SYNTAX = /[&|;<>*?$()`'"]/;

/**
 * Directories the repo GENERATES, derived from `package.json`'s `clean`.
 *
 * Derived rather than listed, which is this file's rule everywhere else: the
 * `clean` script already IS the repo's statement of what is generated, and a
 * second list beside it is a second thing to keep in sync. It was a
 * hand-written `['dist/']` until #766, which is how `coverage/` came to be
 * neither recognised here nor ignored by git.
 *
 * One derivation, two consumers, and they MUST agree. {@link isGenerated}
 * excludes these paths from the "needed by tooling, so it must be tracked"
 * sweep; rule (4) forbids tracking anything under them. Two lists could
 * disagree, and disagreeing is worse than either being wrong alone: rename the
 * build output and update `clean`, and the seeds sweep would report
 * `build/cli.js` as "needed but NOT TRACKED" while rule (4) forbade tracking
 * it — one run, two failures, opposite remedies.
 */
const cleanScript = pkg.scripts?.clean ?? '';
const cleanTokens = [...cleanScript.matchAll(/(?:^|\s)rm\s+-rf?\s+(.+)$/gm)]
  .flatMap((m) => (m[1] ?? '').split(/\s+/))
  .filter((d) => d !== '' && !d.startsWith('-'));
const unreadableCleanTokens = cleanTokens.filter((d) => SHELL_SYNTAX.test(d));
const generatedDirs = cleanTokens
  .filter((d) => !SHELL_SYNTAX.test(d))
  .map((d) => d.replace(/^\.\//, '').replace(/\/+$/, ''));

// Both of these stop the world rather than joining `failures` below, unlike
// every other check in this file. That is deliberate: they mean the gate does
// not know what "generated" is, and every later result depends on that answer —
// `isGenerated` feeds the seeds sweep, so a bad derivation does not merely skip
// rule (4), it makes the "needed but not tracked" report wrong too. Reporting
// downstream findings computed from a definition we just admitted we could not
// read would be worse than reporting one failure at a time.
if (unreadableCleanTokens.length > 0) {
  console.error(
    'Tracked-files check failed: package.json scripts.clean names ' +
      `${unreadableCleanTokens.map((t) => `\`${t}\``).join(', ')}, which this script cannot ` +
      'read as a directory (shell operators, globs and quoting are not interpreted). ' +
      'Write the targets as plain paths, or re-point the parse in this script.',
  );
  process.exit(1);
}
if (generatedDirs.length === 0) {
  // A scan that finds nothing looks exactly like a pass, which is the failure
  // shape this repo keeps meeting. Say so instead.
  console.error(
    'Tracked-files check failed: package.json scripts.clean named no `rm -rf` targets, ' +
      'so the generated-directory check would silently pass over everything. Re-point ' +
      'the parse in this script at whatever states which directories are generated.',
  );
  process.exit(1);
}

const GENERATED_PREFIXES = generatedDirs.map((d) => `${d}/`);

/**
 * The declared home for local scratch — gitignored on purpose, and excluded
 * from the scripts typecheck for the same reason. Honoured by the text sweep
 * (3) only, in `resolveLiteral`: a comment naming an example path under it
 * must not fail the gate, while an actual `import` of one still does, because
 * the import closure (2) does not consult this.
 */
const LOCAL_SCRATCH_PREFIX = 'scripts/local/';

/** Roots whose tracked source files are tooling by definition. */
const TOOLING_ROOTS = ['scripts/', 'tests/'];

/**
 * Roots read for the text sweep (3) but not walked for imports.
 *
 * Two different reasons, both ending in the same treatment.
 *
 * `.github/workflows/` and `.husky/` invoke scripts by name, from YAML and
 * shell that has no import graph to follow — and `scripts/check-pr-sections.sh`
 * is named ONLY from `.github/workflows/required-sections.yml`, by nothing in
 * package.json. Without these roots it passed the gate incidentally, because it
 * happens to be tracked already; a *new* workflow-only script would reproduce
 * #727 exactly, through a different door.
 *
 * `skills/` is here for a different reason, and earns its keep through the
 * OTHER half of what a root does. A root contributes twice: every tracked file
 * under it becomes a closure MEMBER (asserted tracked and un-ignored), and
 * becomes a text-sweep SOURCE. `skills/` is listed for membership:
 * `scripts/pack-mcpb.ts` stages it into the shipped `.mcpb`, and it is the only
 * directory besides `scripts/` with a hand-written `.gitignore` rule inside it,
 * while the repo-wide UNANCHORED rules — `LOG`, `CURRENT`, `LOCK`, `*.log` —
 * match at any depth. So a skill reference file can be ignore-matched exactly
 * the way `tests/unit/manifest-sync.test.ts` was, and nothing would say so
 * until `pack:mcpb` threw in CI.
 *
 * Its sweep half is a side effect, and a harmless one: `resolveLiteral`
 * requires both a LITERAL_PREFIXES hit and `isFile`, so narrative prose naming
 * a path that does not exist is skipped in silence rather than reported. Adding
 * every tracked file under it to the sweep therefore carries none of the
 * blast radius the PATH_TOKEN widening did. It does pull in real references —
 * `scripts/decode-coverage.ts`, named by `skills/boundary-audit/SKILL.md`.
 *
 * Known limit: roots are tracked-only, so this closes the ignore-matched half
 * for `skills/` and NOT the untracked half. A whole-directory dependency like
 * `pack-mcpb.ts`'s `'skills'` names no individual file for the closure to miss.
 *
 * Every tracked file here is a sweep source, extension or not — `.husky/pre-push`
 * has none.
 */
const TEXT_SWEEP_ROOTS = ['.github/workflows/', '.husky/', 'skills/'];

/** Extensions whose files are read as source by something in this repo. */
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py)$/;

/**
 * A repo-relative path with a known extension. The directory prefix is
 * OPTIONAL: `typecheck` names `tsconfig.tests.json` and `tsconfig.scripts.json`
 * at the repo root, and requiring a directory segment silently dropped both —
 * the header's claim to cover "every repo-relative path" was one character
 * wider than the regex.
 *
 * The trailing `(?![\w])` is load-bearing, not decoration. Alternation is
 * ordered, so `js` matched first inside `.json` and the token came out as
 * `tsconfig.tests.js` — a path that does not exist, reported as a dangling
 * reference. Requiring the extension to end the word makes the match
 * independent of the order the alternatives happen to be written in. It does
 * NOT make it suffix-independent: `(?![\w])` permits a following `.`, so a
 * `foo.yml.j2` or `foo.js.map` name would still match its `foo.yml` prefix.
 * No instances today.
 *
 * Dropping the directory requirement also widened the blast radius for prose.
 * `package.json` carries deliberate prose in its `_comment_*` entries, and a
 * bare filename in one of those — "was old-config.json" — is now a hard
 * dangling failure where before prose had to name a `dir/file.ext` to trip it.
 * Nothing does today; the fix if one ever does is to name no file, or to name
 * one that exists.
 */
const PATH_TOKEN =
  /(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|mts|cts|js|mjs|cjs|sh|py|json|ya?ml)(?![\w])/g;

/**
 * Directories whose files are always tooling *inputs*, never build output.
 *
 * A path naming a file under one of these, anywhere in a tooling file, joins
 * the closure even when nothing imports it — the spawn-and-read case:
 * `check-skills.py` shells out to `scripts/dump-tool-names.ts`, and
 * `tests/scripts/audit-severity-gate.test.ts` reads
 * `.github/audit-severity-gate.jq` through a `join()`ed path rather than an
 * import. Neither is reachable from the import graph, and both are files a
 * clean checkout must have.
 *
 * Deliberately a short prefix list rather than "any path-like literal". A
 * broader sweep would pull in the directories tooling *writes* — snapshots,
 * generated fixtures, the demo database — which are ignored on purpose, and a
 * gate that flags those gets switched off. Nothing in this repo writes into
 * `scripts/` (except `scripts/local/`, excluded below) or `.github/`.
 */
const LITERAL_PREFIXES = ['scripts/', '.github/'];

/** A path with at least one directory segment, optionally reached via `../`. */
const PATH_LITERAL = /(?:\.\.?\/)*(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g;

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

// ---------------------------------------------------------------------------
// (1) Paths named by package.json scripts.
// ---------------------------------------------------------------------------

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
  if (TEXT_SWEEP_ROOTS.some((r) => file.startsWith(r))) needed.add(file);
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

/**
 * Resolve a path named in a tooling file's text, or null if it is not one of
 * the inputs this gate is about.
 *
 * Tried both ways a tooling file writes such a path: repo-relative
 * (`'scripts/dump-tool-names.ts'`, spawned from a `cwd` at the repo root) and
 * relative to the file itself (`'../../.github/audit-severity-gate.jq'`,
 * joined onto `import.meta.dir`). The result must land under a
 * LITERAL_PREFIXES directory and exist, so ordinary prose and every path
 * outside those two directories is ignored.
 */
function resolveLiteral(fromFile: string, token: string): string | null {
  const candidates = [token, join(dirname(fromFile), token)];
  for (const candidate of candidates) {
    const rel = toRepoRelative(join(repoRoot, candidate));
    if (rel === null) continue;
    if (!LITERAL_PREFIXES.some((p) => rel.startsWith(p))) continue;
    // scripts/local/ is the declared home for local scratch. A comment naming
    // an example path under it must not fail the gate; an actual `import` of
    // one still does, because the import closure does not consult this.
    if (rel.startsWith(LOCAL_SCRATCH_PREFIX)) continue;
    if (isGenerated(rel) || !isFile(rel)) continue;
    return rel;
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

  for (const match of source.matchAll(PATH_LITERAL)) {
    const rel = resolveLiteral(file, match[0]);
    if (rel === null || needed.has(rel)) continue;
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

// ---------------------------------------------------------------------------
// (4) The inverse: nothing GENERATED may be tracked.
// ---------------------------------------------------------------------------

/**
 * The other direction, and nothing checked it before #766.
 *
 * Everything above asks whether every file the tooling NEEDS survives a fresh
 * clone. Nothing asked whether anything is here that should not be, so a
 * `git add -A` after a local `bun test --coverage` committed `coverage/` —
 * 43,687 lines of machine output, including bun's in-progress `.tmp` scratch
 * file — and every gate stayed green.
 *
 * What a tracked generated directory costs, beyond the diff noise: `bun run
 * clean` deletes tracked files, so a routine clean dirties the tree and the
 * next `git add -A` commits the deletion; a fresh clone has `coverage/lcov.info`
 * on disk BEFORE the test step writes it, and CI's upload step reads that path
 * unconditionally, so a run that does not fully overwrite it uploads the
 * committed numbers as if they were its own; and a 21k-line generated file
 * conflicts on every branch that regenerates it.
 */
const trackedGenerated = [...tracked]
  .filter((f) => generatedDirs.some((d) => f === d || f.startsWith(`${d}/`)))
  .sort();

const failures: string[] = [];
for (const problem of dangling) failures.push(problem);
for (const file of untracked) {
  failures.push(`${file}: needed by the repo's tooling but NOT TRACKED by git`);
}
for (const file of trackedGenerated) {
  failures.push(
    `${file}: TRACKED, but sits under a directory \`bun run clean\` deletes — ` +
      'it is generated output and must not be in the index',
  );
}
for (const file of ignoreMatched.sort()) {
  // An untracked file that is also ignore-matched is already reported above,
  // with the failure that actually bites. Saying "tracked, but…" about it too
  // would be a second line that contradicts the first.
  if (!tracked.has(file)) continue;
  const rule =
    git(['check-ignore', '--no-index', '-v', '--', file]).stdout.trim().split('\t')[0] ?? '';
  // The source is whatever `-v` reports — .gitignore, .git/info/exclude, or the
  // user's global excludes — so name the rule rather than assuming .gitignore.
  failures.push(
    `${file}: tracked, but matched by an ignore rule${rule === '' ? '' : ` (${rule})`} — ` +
      'a rename or re-add would silently drop it',
  );
}

if (failures.length > 0) {
  console.error('Tracked-files check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  // Each remedy prints only for the failure kind it addresses. Stacking both
  // on every run means one of them is always advice for a problem the reader
  // does not have — and the "add it to the list" half no longer exists as an
  // action, since the list is derived from `clean`.
  if (trackedGenerated.length > 0) {
    console.error(
      '\nA file listed as TRACKED-but-generated is fixed with `git rm -r --cached <dir>` ' +
        'plus a `<dir>/` rule in .gitignore, so the next `git add -A` cannot re-add it.',
    );
  }
  if (failures.length > trackedGenerated.length) {
    console.error(
      '\nEvery file the repo\'s tooling reaches must survive a fresh clone. Add a ' +
        '`!<path>` negation to the allowlist under the `scripts/*` rule in .gitignore ' +
        '(or fix the over-broad rule the message names), then `git add` the file and ' +
        're-run. If the path is genuinely produced by the build, name its directory in ' +
        "package.json's `clean` script, which is where this gate reads that from.",
    );
  }
  process.exit(1);
}

console.log(
  `All ${candidates.length} tooling files are tracked and un-ignored ` +
    `(${seeds.size} named by package.json scripts), and no file is tracked under ` +
    `the ${generatedDirs.length} generated directories \`clean\` deletes ` +
    `(${generatedDirs.join(', ')}).`,
);
