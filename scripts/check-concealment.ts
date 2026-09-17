#!/usr/bin/env bun
/**
 * Fail the build on content engineered to be invisible in code review.
 *
 * The bug class this catches: a change that reads as harmless in the diff
 * because the reviewer is never shown the dangerous part. better-auth PR #6003
 * appended an obfuscated loader to `demo/nextjs/postcss.config.mjs` after ~800
 * tab characters, so the rendered diff line ended at `};` and the payload sat
 * off-screen to the right. A later commit in the same PR deleted it, so the
 * combined "Files changed / All commits" view — the one maintainers actually
 * review from — showed only a trailing-newline change.
 *
 * Two properties of that attack matter for where this gate sits:
 *
 *   1. The payload was never merged. The PR was closed unmerged and the attack
 *      still worked, because a build config executes during install/build. It
 *      only had to survive on the branch long enough to run once, in CI or on a
 *      maintainer's machine.
 *   2. Nothing about it is unusual to a compiler. It parses, it lints, it type
 *      checks. Only its *shape on screen* is anomalous.
 *
 * So this checks shape, not semantics, and it runs on every PR rather than at
 * merge. The rules below have no legitimate use in this codebase — verified by
 * scanning every blob reachable from `main` and from all 31 external fork PR
 * heads, which produced zero hits at these thresholds.
 *
 * Known limits, so a green run is not over-read:
 *
 *   - Lockfiles are skipped. A malicious transitive dependency with its own
 *     install script is a different class, covered by `check:deps-pinned`.
 *   - Prose is not skipped — it is checked less. `.md`, `.txt` and `.rst` lose
 *     exactly two rules, long line and dynamic execution: a 900-column
 *     paragraph is a paragraph, and a doc that quotes `eval` is documentation.
 *     They keep the invisible-character rule and the whitespace-run rule, the
 *     latter because markdown here is read by agents as well as by people (see
 *     PROSE_EXTENSIONS). So a bidi trick in docs IS caught, and so is a
 *     gap-based payload whether the gap opens the line or sits mid-line. The
 *     bound that remains is length alone: prose has no MAX_LINE, so text pushed
 *     off-screen by nothing but a very long paragraph passes.
 *   - This gate sees what git would show in a diff — tracked files plus
 *     untracked-but-unignored ones, from `git ls-files` — and NOT the working
 *     tree as such: ignored files are out of scope. Outside a repo it falls
 *     back to a filesystem walk, which scans a materially different set (no
 *     .gitignore, SKIP_DIRS applied to everything); the summary line names
 *     which strategy ran, because that fallback used to be silent and both
 *     endings read `nothing hidden`. INSIDE a repo — a `.git` at the root —
 *     git declining is a failure rather than a fallback: see the strategy
 *     check at the bottom of this file. The swap only ever scans less.
 *   - The DEFAULT mode sees one tree, never a range of commits. The cross-commit
 *     half of #6003 — content added by one commit and removed by another, so it
 *     never appears in the combined diff — cannot be seen from a tree at all.
 *     `--ghost-lines` is that half (#648), and it is a MODE rather than an extra
 *     pass: it needs a pull request's commit range, which a working tree does
 *     not carry, so it runs as its own CI job and not inside `bun run check`.
 *     See the ghost-lines section further down for how the range is obtained,
 *     and what the mode does when there is none.
 *   - The dynamic-execution rule is regex-based, so it reads a construct inside
 *     a string literal the same as a real one. That is why this file and its
 *     test are exempt from that rule alone (see SELF_EXEMPT) — they necessarily
 *     quote the patterns they look for.
 */

import { spawnSync } from 'child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_CONCEALMENT_ROOT lets tests point the gate at a synthetic tree, the
// same pattern as CHECK_PRIVACY_ENDPOINTS_ROOT and CHECK_TOOL_COUNTS_ROOT.
const ROOT = process.env.CHECK_CONCEALMENT_ROOT ?? join(__dirname, '..');

/** A run of this many space characters (ASCII or unicode), leading or mid-line, is the gap. */
const WHITESPACE_RUN = 20;
/**
 * ...but only when the line is longer than a viewport, because that is what
 * makes the tail off-screen. This repo aligns JSDoc continuations with wide
 * gaps as a matter of house style (19 such lines, longest 94 cols); those are
 * legible precisely because the line ends where you can see it. Requiring both
 * a gap AND an over-wide line separates concealment from alignment without an
 * exemption list that would grow every time someone formats a comment.
 */
const CONCEALED_LINE = 120;
/** A line this long hides its tail with or without a gap. */
const MAX_LINE = 400;

/**
 * How much output the gate will take from one `git` invocation.
 *
 * Named rather than inline because the failure message quotes it, and a limit
 * whose diagnostic can drift from its value is the shape this file exists to
 * remove. 64 MiB against a 20,240-byte tracked listing on this repo — the bound
 * is headroom, not a threshold anything is near.
 */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'worktrees',
  '.turbo',
]);

/**
 * Prose. These are never executed, so exactly TWO rules are dropped: the
 * long-line rule and the dynamic-execution rule. A 900-column paragraph in a
 * CHANGELOG is a paragraph, and a doc that quotes `execSync` is documentation.
 *
 * Everything else still applies, and the list of what survives is the point:
 *
 *   - Invisible characters, because a zero-width character in prose is never
 *     benign.
 *   - The whitespace run. This one used to be dropped with the other two, on
 *     the reasoning that prose is only read by humans. It is not: `CLAUDE.md`
 *     and the instruction files under `skills/` are read in full by an agent,
 *     so a sentence parked past a 40-space gap is invisible to the reviewer
 *     and load-bearing to the model — the better-auth shape with the payload
 *     swapped for an instruction. Markdown's one legitimate whitespace idiom,
 *     the trailing double space that forces a line break, sits at end-of-line and
 *     cannot match `\S[gap]{n,}\S`. Extending the rule to prose produced one
 *     hit across the whole repo: an aligned ASCII file-tree at 147 columns in
 *     a design doc. That was reflowed rather than exempted, because the rule's
 *     own criterion — alignment is legible when the line ends where you can
 *     see it — says a 147-column line does not.
 *
 * Note which way this allowlist fails. Forgetting to list a prose extension
 * means that file gets the FULL rule set — more scrutiny, and at worst a false
 * positive a human resolves. That is the opposite of the extension allowlist
 * this replaced (F2), where forgetting an extension meant no scrutiny at all.
 * An allowlist is only safe when omission fails toward suspicion.
 */
// `.mdx` is deliberately NOT here: it compiles to JS/JSX and can carry
// executable expressions, so it must keep the code-shaped rules. No MDX
// pipeline exists today; listing it would have been a hole waiting for one.
const PROSE_EXTENSIONS = new Set(['.md', '.txt', '.rst']);

function isProse(rel: string): boolean {
  return PROSE_EXTENSIONS.has(extensionOf(rel));
}

/**
 * NOTE: there is deliberately no extension allowlist here any more.
 *
 * There was one — 14 entries, "executed or interpreted at some point". An
 * audit (docs/audits/2026-08-29-completeness-guard-audit.md, F2) showed it
 * was the same bug this gate exists to catch: it enumerated what to CHECK
 * rather than what to SKIP, so anything it forgot was invisible. A concealed
 * payload (long line, whitespace run, execSync of a piped curl) written to
 * `scripts/probe-hook` passed; the identical bytes in `scripts/probe.ts`
 * failed. The live exposure was `.husky/pre-push`, which has no extension at
 * all and runs on every developer push.
 *
 * Every text file is now in scope. Binaries are handled by BINARY_EXTENSIONS
 * below plus a NUL check — note that combination carefully: a NUL is NOT on its
 * own a reason to skip, because a NUL-bearing module still executes while git
 * shows the reviewer nothing. Only a NUL in a file whose extension says it
 * should be binary is skipped quietly; anywhere else it is reported.
 */

/** Generated, enormous, and not human-reviewed; a different gate covers them. */
const SKIP_FILES = new Set(['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock']);

/**
 * Binary formats that are inert: media, fonts, archives, documents. A diff of
 * one of these was never readable, so suppressing it hides nothing — which is
 * what makes `*.png binary` legitimate boilerplate. Deliberately excludes the
 * executable formats in BINARY_EXTENSIONS.
 */
const INERT_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.tar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.mov', '.webm', '.ogg',
]);

/**
 * Extensions where a NUL byte is EXPECTED, so a NUL there is not a finding.
 * This is a superset of the inert set: it also covers executable binaries,
 * which legitimately contain NULs but must never have their diffs suppressed
 * by an attribute — see DIFF_SUPPRESSING_ATTRS, which checks the inert set.
 *
 * Why the NUL check is scoped to a set at all: a NUL used to be an
 * unconditional free pass, and the main loop skipped any file containing one as
 * "binary". But a module with a NUL tucked inside a comment or a string literal
 * still runs under bun and node — NUL-containing is not the same as
 * non-executable — while git renders the whole file as `Binary files ... differ`
 * and the reviewer sees nothing at all. That is strictly better concealment than
 * the off-screen trick this gate was built for, so a NUL outside this set is now
 * reported rather than skipped.
 *
 * Note the direction: forgetting an extension here means a real binary gets
 * reported and a human adds it, rather than a payload running unwatched.
 */
const BINARY_EXTENSIONS = new Set([
  ...INERT_BINARY_EXTENSIONS,
  // Formats that carry NULs but are NOT inert, so they stay out of the
  // allowance above. Two disqualifying reasons:
  //   - they execute: .node, .wasm, .dylib, .so, .dll, .exe
  //   - they are containers whose contents a reviewer might genuinely need to
  //     see, and which can carry code: .mcpb bundles this server, .ldb/.sst
  //     are LevelDB tables holding cached user data
  '.mcpb', '.node', '.wasm', '.ldb', '.sst', '.dylib', '.so', '.dll', '.exe',
]);

/** Extension of the BASENAME — `docs/v1.2/README` has no extension, not `.2/README`. */
function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function isExpectedBinary(rel: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(rel));
}

/**
 * Built from a char code rather than written literally: an actual NUL byte in
 * this source would make the file binary to grep, git diff, and every reviewer's
 * editor — the exact opacity this gate exists to prevent.
 */
const NUL = String.fromCharCode(0);

/**
 * Exempt from the dynamic-execution rule ONLY — every other rule still applies.
 * Both files quote the constructs they exist to detect. Keep this list at two
 * entries: anything else claiming the exemption is the thing you are looking for.
 */
const SELF_EXEMPT = new Set([
  join('scripts', 'check-concealment.ts'),
  join('tests', 'scripts', 'check-concealment.test.ts'),
]);

/**
 * Machine-written, reviewed as a whole rather than line by line, and legitimately
 * one long string per operation. Exempt from the long-line rule only: a gap-based
 * payload appended to one of these still trips the whitespace rule.
 */
const GENERATED_RE = /\.generated\.[cm]?[jt]sx?$/;

/**
 * Every npm hook that fires WITHOUT being named on the command line. npm runs
 * these as a side effect of install, publish, pack, version, uninstall or
 * shrinkwrap, so a payload in any of them executes before anyone reads it.
 *
 * This list is the inversion of what used to be here. The old constant named
 * four hooks to refuse; the audit (F1) added `prepack` — which npm runs during
 * `npm publish`, inside the job that holds `id-token: write` — and the gate
 * reported "nothing hidden". Enumerating the attack was the bug. The rule is
 * now: any auto-fired hook is refused unless it is pinned to an exact reviewed
 * value in PINNED_LIFECYCLE.
 *
 * Deliberately excluded: `test`, `start`, `stop`, `restart`. npm gives those
 * names meaning only when you invoke them directly (`npm test`), and this repo
 * defines `test`. Their pre/post wrappers ARE auto-fired and are listed.
 */
const AUTO_LIFECYCLE = new Set([
  // install
  'preinstall', 'install', 'postinstall', 'dependencies',
  // publish + pack
  'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'publish', 'postpublish',
  // prepare runs on install AND publish
  'prepare',
  // version
  'preversion', 'version', 'postversion',
  // uninstall
  'preuninstall', 'uninstall', 'postuninstall',
  // shrinkwrap
  'preshrinkwrap', 'shrinkwrap', 'postshrinkwrap',
  // wrappers around the explicitly-invoked commands
  'pretest', 'posttest',
  'prestart', 'poststart',
  'prestop', 'poststop',
  'prerestart', 'postrestart',
]);

/**
 * `prepare` and `prepublishOnly` run on contributor and publisher machines.
 * Those are still execution vectors — a contributor's `bun install` runs
 * `prepare` — so each is pinned to its exact reviewed value instead of being
 * allow-listed by name: changing what runs at install time then means changing
 * this file, in the same PR, where a reviewer will see it.
 *
 * PINNED_NAMES is derived from this map rather than written out, so a hook can
 * never be listed as pinned without a value to pin it to.
 */
const PINNED_LIFECYCLE: Record<string, string> = {
  prepare: 'husky',
  prepublishOnly: 'bun run clean && bun run build && bun test',
};
const PINNED_NAMES = Object.keys(PINNED_LIFECYCLE);

const INVISIBLE: Record<number, string> = {
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x00ad: 'SOFT HYPHEN',
  0x180e: 'MONGOLIAN VOWEL SEPARATOR',
  0x3164: 'HANGUL FILLER',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
};

/**
 * The gap characters. `[ \t]` alone was defeatable: U+00A0 NBSP, U+202F narrow
 * NBSP, U+2003 em space and U+3000 ideographic space are all valid ECMAScript
 * whitespace, all render as blank horizontal space, and none were matched — so
 * a payload could be pushed off the right edge without tripping this rule.
 * Unicode Zs plus the format-ish spaces that behave the same way.
 */
const GAP_CHARS = ' \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000';
/**
 * `(^|\S)`, not `\S`, on the left. Requiring a non-space before the gap left a
 * whole form uncovered: a line that OPENS with the run. 200 spaces then an
 * instruction is a blank line to a reviewer scrolling a diff and an instruction
 * to a model reading the file, and prose is exempt from MAX_LINE, so nothing
 * else caught it either.
 *
 * Both halves of the conjunction were measured against this repo before the
 * left anchor was widened, because a rule with no margin becomes an exemption
 * list on its first false positive. Across every scanned file: of the 2125
 * lines over 120 columns, the deepest leading whitespace is 14 characters; of
 * the 46 lines carrying 20 or more leading gap characters, the longest is 95
 * columns. Neither axis is close to its threshold, and the whole-repo run
 * produced zero hits.
 *
 * The trailing `\S` matters too: a line of nothing but whitespace is trailing
 * junk, not a payload, and does not match.
 */
const WHITESPACE_RUN_RE = new RegExp(`(^|\\S)[${GAP_CHARS}]{${WHITESPACE_RUN},}\\S`);

const DYNAMIC_EXEC: Array<[RegExp, string]> = [
  [/(?<![\w$.])eval\s*\(/, 'eval() call'],
  [/(?<![\w$.])new\s+Function\s*\(/, 'new Function() constructor'],
  [/\[\s*['"]constructor['"]\s*\]/, 'constructor indirection (Function via property access)'],
  [/(?:\\x[0-9a-fA-F]{2}){8,}/, 'run of hex escapes'],
];

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const findings: Finding[] = [];

function report(file: string, line: number, rule: string, detail: string): void {
  findings.push({ file, line, rule, detail });
}

function inScope(path: string): boolean {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  return !SKIP_FILES.has(name);
}

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    // Tested AFTER isDirectory, so a FILE named `build` or `dist` is scanned.
    // Testing the entry name first dropped extensionless executables by name.
    if (isDir && SKIP_DIRS.has(entry)) continue;
    if (isDir) walk(p, out);
    else if (inScope(p)) out.push(p);
  }
  return out;
}

/**
 * The content git stores for a SYMLINK: its target path, not the target's
 * bytes.
 *
 * git tracks a symlink as mode 120000 whose blob is the target path, so the
 * target path is the entire content a reviewer is shown in a diff for it —
 * following the link and scanning the file at the other end scans something
 * the diff never contained.
 *
 * Called for EVERY symlink, not only for the ones that fail to resolve. The
 * first revision reached this from the `catch` alone, which left the principle
 * above stated but half-applied: a link that DOES resolve had its target's
 * bytes scanned — content no reviewer is shown — while the target path, the
 * only thing the diff actually contains, went unread. `link -> ../../outside/
 * payload` is the concrete case, and it is the same class as the bug this
 * function was added for, pointing the other way: content inspected is not
 * content listed. Caught in review of #724.
 *
 * So both are scanned now, and neither replaces the other. Following the link
 * is still how a resolvable one is read (`package.json` -> `manifest.json` in
 * the routing test depends on the resolved contents), and a link that resolves
 * to a DIRECTORY or to nothing stops being an unreadable file and becomes one
 * line of scannable content. This repo tracks two of the latter —
 * `.agents/skills` and `.claude/skills`, both pointing at directories — and
 * they are why the silent `continue` this replaces was invisible: every run
 * dropped two files while counting them as scanned.
 *
 * Returns undefined for anything that is not a symlink, so a genuinely
 * unreadable regular file still reaches the refusal below.
 *
 * Cost, so it is known rather than discovered: one lstat per LISTED file, ~549
 * on this repo, against a read of every one of them. Immeasurable here, and the
 * alternative — calling this only after a read fails — is the half-application
 * the paragraph above exists to describe.
 */
function linkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return readlinkSync(path);
  } catch {
    // CONFLATES "not a symlink" with "could not tell" — deliberately, and only
    // safe because of what the caller does with `undefined`. There it means
    // "no link content to scan", and the single caller reaches that branch only
    // after a read of the same path ALSO failed, in which case the file is
    // pushed onto `unreadable` and the gate refuses. So a path this function
    // could not resolve fails LOUD by the caller's route, not silently by this
    // one.
    //
    // The residual — `readlink` fails while a read of the same path succeeds,
    // so a real link target goes unscanned — needs the path to stop being a
    // symlink between the two calls, at which point the read scanned whatever
    // it is now and there is no target to miss. It is not claimed impossible,
    // only unreachable by any route that leaves something unexamined.
    //
    // The co-dependency is the load-bearing part: a future caller that treats
    // `undefined` as "definitely a regular file, definitely fine" and does not
    // read the path would reintroduce the fail-open this whole file exists to
    // remove. Distinguishing the two cases here would need a thrown error or a
    // third return state; nothing needs it yet.
    return undefined;
  }
}

/**
 * A zero-width joiner between two symbols is an emoji sequence and is fine; the
 * same character between ASCII is a hidden character in an identifier. Every
 * other formatting character is flagged wherever it appears.
 *
 * The 0x2000 floor is not the emoji block — it is the point above which every
 * character that legitimately neighbours a ZWJ in a standard sequence lives.
 * Pictographs sit at U+1F300+ and skin-tone modifiers at U+1F3FB–1F3FF, but the
 * lowest real neighbours are the gender signs, ♀ U+2640 and ♂ U+2642. Anything
 * an attacker would want to join — ASCII identifier characters, Latin-1 — is
 * below 0x2000, so the floor separates the two without enumerating emoji.
 */
function invisibleIsBenign(cp: number, prev: number | undefined, next: number | undefined): boolean {
  if (cp !== 0x200d) return false;
  return prev !== undefined && next !== undefined && prev >= 0x2000 && next >= 0x2000;
}

function checkLine(
  rel: string,
  lineNo: number,
  line: string,
  exempt: boolean,
  prose: boolean
): void {
  // Deliberately NOT gated on `!prose`, unlike the two rules below it. See
  // PROSE_EXTENSIONS: markdown in this repo is read by agents as well as by
  // people, and a gap wide enough to push text off-screen conceals it from
  // exactly one of those two readers.
  if (line.length > CONCEALED_LINE && WHITESPACE_RUN_RE.test(line)) {
    report(
      rel,
      lineNo,
      'whitespace run',
      `${WHITESPACE_RUN}+ consecutive space characters, leading or mid-line, on a ` +
        `${line.length}-column line — the text after the gap is off-screen in a diff. ` +
        `Unicode spaces (NBSP, U+2003, U+3000, ...) ` +
        `count as well as ASCII space and tab: they render identically and are valid ` +
        `ECMAScript whitespace`
    );
  }

  if (!prose && line.length > MAX_LINE && !GENERATED_RE.test(rel)) {
    report(rel, lineNo, 'long line', `${line.length} columns (limit ${MAX_LINE})`);
  }

  const cps = [...line].map((c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < cps.length; i++) {
    const name = INVISIBLE[cps[i]];
    if (name === undefined) continue;
    if (invisibleIsBenign(cps[i], cps[i - 1], cps[i + 1])) continue;
    report(
      rel,
      lineNo,
      'invisible character',
      `U+${cps[i].toString(16).toUpperCase().padStart(4, '0')} ${name}`
    );
  }

  if (exempt || prose) return;
  for (const [re, label] of DYNAMIC_EXEC) {
    if (re.test(line)) report(rel, lineNo, 'dynamic execution', label);
  }
}

/**
 * Attributes that make git or GitHub show a reviewer less than the content.
 * Same class as the NUL bypass — "ways to make git render nothing" — reached
 * with no NUL, no long line, no whitespace run, no dynamic-execution
 * construct. One tracked line does it:
 *
 *     src/payload.ts binary
 *
 * `binary` implies `-diff`, so git and GitHub print "Binary files ... differ"
 * instead of the content. `linguist-generated=true` collapses the file behind a
 * "Load diff" fold in the Files-changed view — the view maintainers review from.
 *
 * One legitimate use is refused-by-default and must not be: `*.png binary` and
 * `*.pdf binary` are the standard boilerplate for marking real binaries, and
 * this repo tracks .png and .mp4 files. Suppressing the diff of a file that is
 * genuinely binary hides nothing a reviewer could have read anyway, so a
 * pattern whose extension is in INERT_BINARY_EXTENSIONS is allowed — NOT
 * BINARY_EXTENSIONS, which also covers executable formats. Everything else
 * is refused rather than allow-listed — `text=auto`, `eol=lf` and
 * `linguist-language=...` do not hide content, so they need no exemption.
 *
 * `linguist-vendored` was checked as the obvious sibling and is deliberately
 * NOT here (2026-08-30). Three current primary sources agree that only
 * `linguist-generated` suppresses a diff:
 *
 *   - GitHub Docs, "Customizing how changed files appear on GitHub", names one
 *     attribute: "Use the `linguist-generated` attribute to mark or unmark
 *     paths that you would like to be ignored for the repository's language
 *     statistics and hidden by default in diffs."
 *   - linguist's docs/overrides.md, under Generated code: "As an added bonus,
 *     unlike vendored and documentation files, these files are suppressed in
 *     diffs." The contrast is explicit.
 *   - linguist's README describes its own job as "ignore binary or vendored
 *     files, suppress generated files in diffs" — again, generated only.
 *
 * Read the counter-evidence before trusting that, because there is some:
 * linguist issues #2206 and #2705 both quote "Vendored files are also hidden by
 * default in diffs on github.com" from the README OF THEIR DAY (2015/2016).
 * That sentence is gone from the README linked above; #2206 is a report that
 * the behaviour it promised did not happen. So the claim is stale rather than
 * contested.
 *
 * Note the evidence class, because it is weaker than this file's usual. This is
 * documentation, not a probe: `binary` and `-diff` are git-side and were pinned
 * with `git check-attr`, while both linguist attributes are rendered by
 * github.com and no local command can measure them. If anyone ever SEES a
 * vendored path folded in a Files-changed view, add it beside its neighbour
 * with the same `=false` carve-out — linguist's rule is `attr != "false"`, so
 * `=1` and `=yes` must still fire.
 */
const DIFF_SUPPRESSING_ATTRS = [
  /(^|\s)binary(\s|$)/,
  /(^|\s)-diff(\s|$)/,
  // Anchored on both sides, like its two neighbours, and with the un-setting
  // forms carved out. Bare `/linguist-generated/` also matched
  // `linguist-generated=false` and `-linguist-generated`, which take a file OUT
  // of the "Load diff" fold — the opposite of concealment. The gate reported
  // them and told the author to delete the thing making their file reviewable.
  //
  // The carve-out is `=false` specifically, not "anything but =true". Linguist
  // reads these with `boolean_attribute(attr) => attr != "false"`, so
  // `linguist-generated=1` and `=yes` collapse the diff exactly like `=true`
  // does. Narrowing to `(=true)?` would have been this file's recurring bug one
  // more time: a pattern here approximating a grammar defined elsewhere, and
  // failing OPEN on every value the approximation did not anticipate.
  /(^|\s)linguist-generated(=(?!false(\s|$))\S*)?(\s|$)/,
];

function checkGitAttributes(contents: string, rel: string): void {
  contents.split('\n').forEach((line, i) => {
    // gitattributes(5): "Lines that begin with # are ignored." ONLY at line
    // start — a mid-line `#` is literal and part of the pattern. Stripping
    // from any `#` discarded content git honours, so `src/pay#load.ts binary`
    // parsed down to `src/pay`, matched nothing, and still marked the real
    // file binary for every reviewer. A parser in this gate must not discard
    // more than the grammar it models.
    // git's parse_attr_line skips its blank set before the `#` test
    // (`strspn(line, blank)`), and that set is SPACE, TAB and CR — not the two
    // this comment used to claim. Probed on git 2.50.1 one character at a time,
    // in both positions, rather than recalled: space, tab and CR are skipped
    // before `#` and separate the pattern from its attributes; form feed,
    // vertical tab and NBSP do neither. JS `.trim()` would have been wrong in
    // the other direction — it strips NBSP, \f, \v, the unicode space
    // separators and U+FEFF, so `<NBSP># p.ts binary` is a real pattern to git
    // and was dropped here as a comment.
    //
    // Getting this set wrong is variation seven of this function's one bug, and
    // the first that came from asserting a set instead of measuring it: with CR
    // missing, `\r# p.ts binary` was reported though git reads it as a comment,
    // and — the direction that matters — the tokenizer below ran past a CR. Say
    // what was measured, not what was remembered.
    //
    // Trailing \s is still stripped, which is wider than git's set on purpose:
    // it normalises CRLF checkouts.
    const stripped = line.replace(/^[ \t\r]+/, '').replace(/\s+$/, '');
    if (stripped === '' || stripped.startsWith('#')) return;
    // `*.png binary` targets something with no readable diff to suppress.
    //
    // Checked against INERT_BINARY_EXTENSIONS, NOT BINARY_EXTENSIONS. The
    // latter answers a different question — where a NUL byte is expected — and
    // includes .node/.wasm/.so/.dll/.exe, whose whole point is that they
    // execute. Auto-approving `*.wasm binary` would bless diff suppression on
    // exactly the formats that run. An author who genuinely needs it writes
    // the exemption, which is what this gate's failure message asks for.
    // git separates the pattern from its attributes on the SAME blank set as
    // the leading-comment test above — space, tab, CR — and this must stay
    // literally the same set, because the two diverging is how variation seven
    // happened. `\s` here would be too wide: it splits on NBSP and friends, so
    // a pattern containing one would tokenize short and land in the allowance
    // below. `[ \t]` was too narrow: `src/payload.ts<CR>cover.png -diff` is a
    // .ts file with `-diff` to git (check-attr: `diff: unset`), while the
    // tokenizer read one token ending in `.png` and the allowance returned
    // before the attribute loop. A CR renders as nothing in a GitHub diff and
    // INVISIBLE carries no C0 controls, so that had no second line of defence.
    // Both mismatches fail OPEN; only the widths differ.
    // gitattributes patterns may be QUOTED to contain blanks — verified:
    // `"evil run.ts" binary` really does set binary on `evil run.ts`. Naive
    // tokenizing gives `"cover.png` for `"cover.png run.ts" binary`, whose
    // extension reads as inert, so the allowance would pass a .ts file. That
    // is the third variation of this same mismatch, and like the last it fails
    // OPEN. So the quoted form is PARSED rather than refused: refusing it would
    // fail the gate on `"my docs/logo.png" binary`, which is legitimate, and
    // this rule already learned that lesson with *.png.
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(stripped);
    const pattern = quoted ? (quoted[1] as string) : (stripped.split(/[ \t\r]+/)[0] ?? '');
    // An opening quote with no closing one. git's parse_attr_line calls
    // unquote_c_style, and on failure falls to its else-branch and reads the
    // raw token — quote mark included — as a LITERAL path. Probed on git
    // 2.50.1 with `.gitattributes` holding `"cover.png binary`:
    //
    //   git check-attr binary -- 'cover.png' '"cover.png'
    //   cover.png: binary: unspecified
    //   "\"cover.png": binary: set
    //
    // So nothing that executes gets its diff suppressed and there is no live
    // divergence here. The allowance still must not be the thing that says so.
    // It would answer `.png` — from `extensionOf('"cover.png')` — and be right
    // for a reason that has nothing to do with why git is harmless, which is
    // the coincidental agreement every earlier variation in this function was
    // built on. A pattern this parser REFUSED to parse does not get to reach an
    // allowance; it is reported and a human reads the line. Cheap here: the
    // repo tracks no .gitattributes at all (`git ls-files | grep -i
    // gitattributes` is empty), and an unterminated quote is a typo in every
    // case that is not an attack.
    const unterminatedQuote = quoted === null && stripped.startsWith('"');
    // A quoted pattern containing a backslash is NOT unquoted before the inert
    // check. git resolves the escapes with unquote_c_style before matching, and
    // stripping them here only ever SHORTENS the string, so a backslash after
    // the last dot manufactures an inert-looking extension that git never
    // resolves to: `"evil.p\ng"` reads as `.png` here and as a newline to
    // unquote_c_style. Approximating the grammar failed OPEN — the fourth
    // variation of the same mismatch in this one function — so the escape form
    // simply misses the allowance and gets reported. An author with a genuinely
    // escaped binary path writes the exemption, which is cheap; a payload that
    // spells its extension with an escape does not get waved through, which is
    // not.
    //
    // The fifth and sixth variations, and the reason the count is not a closed
    // list: gitattributes has a SECOND line form this parser had no concept of.
    // `[attr]<name> <attrs...>` defines a MACRO, and git's attr_name_valid
    // permits dots in the name, so the first token can be extension-shaped
    // without ever being a path:
    //
    //     [attr]a.png binary
    //     src/payload.ts a.png
    //
    // The first line reached the allowance as a `.png` and returned; the second
    // carries no suppressing attribute of its own, only the macro's name. git
    // renders payload.ts as `Binary files ... differ` while the gate said
    // nothing hidden. That a macro named `[attr]zz` WAS reported is what makes
    // that accidental rather than designed.
    //
    // The macro test therefore runs on `pattern` — AFTER the quoted form has
    // been opened — and not on the raw line, because git parses in that order
    // too. Verified on git 2.50.1: `"[attr]a.png" -diff` with
    // `src/payload.ts a.png` reports `src/payload.ts: diff: unset` from
    // check-attr, and git diff prints `Binary files ... differ`. A first
    // attempt tested the raw line and argued a quoted `[attr]` stays a literal
    // path; that was simply false, and it recreated the same hole one quote to
    // the left. Testing one spelling and not the other IS this function's bug,
    // so there is exactly one test, on the one string the extension check also
    // reads.
    //
    // An extension check answers "could a reviewer have read this file's diff",
    // which is a question about a path; asking it of a macro name is
    // meaningless, so macros skip the allowance outright and are judged on the
    // attributes they carry. Note this errs safely in the one place it diverges
    // from git: git requires a non-empty name after the prefix, so a bare
    // `[attr]` is a path pattern to git and a macro to us — and being wrong
    // that way only ever REMOVES an allowance.
    const isMacroDefinition = pattern.startsWith('[attr]');
    if (
      !isMacroDefinition &&
      !unterminatedQuote &&
      !pattern.includes('\\') &&
      INERT_BINARY_EXTENSIONS.has(extensionOf(pattern))
    )
      return;
    for (const re of DIFF_SUPPRESSING_ATTRS) {
      if (!re.test(stripped)) continue;
      report(
        rel,
        i + 1,
        'diff-suppressing gitattribute',
        `"${stripped}" stops git or GitHub showing this path's content in a diff, so a payload ` +
          `in it reaches main without a reviewer ever seeing the lines. If this path really is ` +
          `an inert binary — media, font, archive, document — add its extension to ` +
          `INERT_BINARY_EXTENSIONS in scripts/check-concealment.ts in the same PR and this ` +
          `attribute becomes legitimate boilerplate. Otherwise drop the attribute: a file that ` +
          `executes has to keep a diff a reviewer can read`
      );
      return;
    }
  });
}

function checkLifecycleScripts(contents: string, rel: string): void {
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(contents) as { scripts?: Record<string, string> };
  } catch {
    return; // Malformed package.json is a different gate's problem.
  }
  const scripts = parsed.scripts ?? {};
  const raw = contents.split('\n');
  const lineOf = (hook: string): number => {
    const idx = raw.findIndex((l) => l.includes(`"${hook}"`));
    return idx >= 0 ? idx + 1 : 1;
  };

  // Discover, do not enumerate: walk the scripts that actually exist and refuse
  // any that npm fires on its own. A hook nobody thought of is caught by being
  // auto-fired, not by having been predicted.
  for (const hook of Object.keys(scripts)) {
    if (!AUTO_LIFECYCLE.has(hook)) continue;
    if (PINNED_NAMES.includes(hook)) continue; // checked against its pinned value below
    const value = scripts[hook];
    if (value === undefined) continue;
    report(
      rel,
      lineOf(hook),
      'auto-fired lifecycle script',
      `"${hook}": ${JSON.stringify(value)} is run by npm without being named on the ` +
        `command line (install, publish, pack, version, uninstall or shrinkwrap), so it ` +
        `executes before anyone reads the code`
    );
  }

  // The general form of the same hole: npm auto-runs `preX`/`postX` around any
  // script X, so a wrapper around an existing script fires implicitly too.
  for (const hook of Object.keys(scripts)) {
    if (AUTO_LIFECYCLE.has(hook) || PINNED_NAMES.includes(hook)) continue;
    const base = hook.startsWith('pre') ? hook.slice(3) : hook.startsWith('post') ? hook.slice(4) : '';
    if (base === '' || scripts[base] === undefined) continue;
    report(
      rel,
      lineOf(hook),
      'auto-fired lifecycle script',
      `"${hook}": ${JSON.stringify(scripts[hook])} is run automatically by npm around ` +
        `"${base}", so it executes whenever that script does`
    );
  }

  for (const hook of PINNED_NAMES) {
    const value = scripts[hook];
    if (value === undefined) continue;
    if (PINNED_LIFECYCLE[hook] === value) continue;
    report(
      rel,
      lineOf(hook),
      'install-time script',
      `"${hook}": ${JSON.stringify(value)} differs from its pinned value — this runs ` +
        `automatically on contributor and publisher machines, so the change needs review`
    );
  }
}

/**
 * Why the git listing declined, set by whichever branch of gitFiles declined.
 *
 * The strategy check at the bottom of this file turns a decline into a hard
 * failure, so the operator is entitled to the cause that was actually observed
 * rather than the most likely one. Every `return undefined` in gitFiles sets
 * this first; there is no path that declines silently.
 */
let gitDecline: string | undefined;

/**
 * The environment every `git` in this file is spawned with.
 *
 * Extracted so the two callers cannot drift: the tree scan's `gitFiles`
 * below and the ghost-lines mode further down both depend on the SAME
 * sanitisation, and a range resolved under an inherited GIT_DIR would be the
 * range of a different repository. The reasoning is unchanged and unabridged;
 * only its address moved.
 */
function gitEnv(): NodeJS.ProcessEnv {
  // Strip inherited git plumbing vars before shelling out. A pre-push hook runs
  // with GIT_DIR set, and `git -C <dir>` does NOT override it — so without this,
  // `git ls-files` inside a scratch directory silently answers about the AMBIENT
  // repo and reports the scratch tree as untracked, bypassing SKIP_DIRS entirely.
  // That is how this gate started reporting node_modules under husky while
  // passing when run by hand. Caught by the pre-push hook it broke.
  //
  // Stripped as a NAMESPACE rather than as a list of seven names. The list was
  // the same shape as every other bug in this file: an enumeration of the cases
  // someone thought of, with everything unlisted falling straight through. It
  // did not include GIT_CONFIG_GLOBAL or GIT_CONFIG_COUNT, either of which can
  // set core.excludesFile — which `ls-files --exclude-standard` honours, so an
  // ambient value drops files out of the scan and the gate still prints a green
  // "nothing hidden". Every GIT_* variable is git's to interpret and none of
  // them is ours to inherit.
  //
  // Stripping that namespace closes only half the vector, though, because the
  // same setting reaches git without any GIT_ variable at all: core.excludesFile
  // in the GLOBAL config, which git finds through HOME (or XDG_CONFIG_HOME), and
  // in the SYSTEM config at /etc/gitconfig. Probed: a concealed untracked .ts
  // under a HOME whose .gitconfig excludes `*.ts` produced `files scanned (git),
  // nothing hidden` and exit 0. So the ambient environment is not sanitised
  // variable by variable — git is told to read NO config files, which is the
  // only form of this that does not need a list of the ways config arrives.
  //
  // GIT_CONFIG_GLOBAL/SYSTEM=/dev/null is git's own documented way to say that
  // (2.32+). HOME and XDG_CONFIG_HOME are dropped as well so an older git,
  // which would ignore those two variables, still cannot find a global config.
  // None of this affects the repo's own .git/config, .gitignore or
  // .git/info/exclude: those are the tree's, and ignored files being out of
  // scope is the design.
  //
  // Dropping HOME has one non-obvious consequence worth naming: it also hides a
  // global `safe.directory`, so scanning a repo owned by another user makes
  // `ls-files` refuse and the gate falls back to the filesystem walk.
  //
  // That fallback is NOT strictly safer, and an earlier version of this comment
  // claimed it was. The walk scans MORE in one direction — it ignores
  // .gitignore — and LESS in another: it applies SKIP_DIRS to everything, while
  // the git listing applies it to the untracked half only. Probed on an
  // identical tree holding a tracked, concealed `build/loader.ts`: the git
  // strategy reports it, the walk prints `0 files scanned (walk), nothing
  // hidden`. Latent here, since nothing tracked lives under a SKIP_DIRS name,
  // but the honest statement is that the two strategies differ rather than
  // that one dominates. See listFiles below, which has always said this
  // correctly. The summary line names the strategy so a swap announces itself,
  // and — because a green step is not read — the strategy check at the bottom
  // of this file turns the announcement into a refusal whenever the tree has a
  // .git at all. Returning undefined from here is therefore only a fallback
  // outside a repository.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.HOME;
  delete env.XDG_CONFIG_HOME;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
}

/**
 * The set of files this gate inspects: everything git would show in a diff.
 *
 * Removing the extension allowlist (F2) put the whole working tree in scope,
 * including trees git is told to ignore — `snapshots/`, a local
 * `tests/fixtures/demo_database/`, `docs/graphql-capture/raw/`, `.env.local`.
 * Two problems, both landing only on developer machines (CI is a clean
 * checkout, which is why this was invisible in the PR run): a
 * multi-hundred-MB LevelDB snapshot gets fully UTF-8-decoded into a JS string
 * before the NUL check discards it, and a Firebase JWT in `.env.local` runs
 * past MAX_LINE, failing the gate locally with a finding no PR can resolve.
 *
 * This is NOT a re-introduced allowlist. It is exactly the gate's threat
 * model: content that can reach a reviewer's diff. And it cannot be used to
 * evade the gate — adding a `.gitignore` entry does not untrack a file that
 * is already committed, so anything in the repo stays in scope.
 *
 * Falls back to the filesystem walk outside a git repo, which is how the
 * tests drive it (synthetic trees under CHECK_CONCEALMENT_ROOT). Both paths
 * are covered: see 'file list' in tests/scripts/check-concealment.test.ts.
 */
function gitFiles(root: string): { tracked: string[]; untracked: string[] } | undefined {
  // Sanitised as a namespace, not as a list of names — see gitEnv above.
  const env = gitEnv();

  const run = (args: string[]): string[] | undefined => {
    const shown = `git -C ${root} ${args.join(' ')}`;
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf-8',
      env,
      // Explicit, because the inherited default is 1 MiB and this listing is
      // not bounded by anything the gate controls — a big monorepo's `ls-files
      // -z` passes it. On this repo the tracked listing is 20,240 bytes, ~52x
      // under that default, so the bound is headroom rather than a fix.
      //
      // spawnSync does not TRUNCATE at the limit, it KILLS the child: measured
      // on node v25.2.1 and bun 1.3.5, both answer status=null, signal=SIGTERM,
      // error.code=ENOBUFS. Without a cause in the message that arrives as
      // "git declined", which would be this file's own recurring shape — a
      // limit inside the gate standing in for the real tool's.
      //
      // Bun does enforce it, checked rather than assumed, because that was an
      // open question: `spawnSync(self, ['-e', 'process.stdout.write("x"
      // .repeat(2*1024*1024))'])` dies on both runtimes at the default and
      // succeeds on both at 64 MiB. The runtimes differ only in where they
      // stop reading — node kept 1,114,112 bytes, bun 1,375,181 — which is
      // why the value is set here instead of reasoned about from the default.
      maxBuffer: MAX_GIT_OUTPUT,
    });
    // Three materially different things make `status !== 0`, and r.error is
    // what tells them apart. Collapsing them was survivable while this was a
    // silent fallback; the strategy check at the bottom of the file made the
    // message load-bearing, and it named only the first.
    // spawnSync types `error` as plain Error, but the spawn failures this
    // needs to tell apart are carried on `code` at runtime (ENOENT, ENOBUFS).
    // Narrowed rather than asserted non-null, so an error without a code falls
    // through to the status branch below instead of reading as `undefined`.
    const code = (r.error as (Error & { code?: string }) | undefined)?.code;
    if (code !== undefined) {
      gitDecline =
        code === 'ENOENT'
          ? `git is not on PATH — spawning \`${shown}\` failed with ENOENT`
          : code === 'ENOBUFS'
            ? `\`${shown}\` produced more than the ${MAX_GIT_OUTPUT} bytes this gate allows ` +
              `and was cut off — raise MAX_GIT_OUTPUT in scripts/check-concealment.ts`
            : `spawning \`${shown}\` failed with ${code}`;
      return undefined;
    }
    if (r.status !== 0 || typeof r.stdout !== 'string') {
      // git's own first line of stderr is the single most useful thing here:
      // for the motivating case it is `fatal: detected dubious ownership in
      // repository at '<path>'`, which names the cause exactly.
      const said = (typeof r.stderr === 'string' ? r.stderr : '').split('\n')[0]?.trim() ?? '';
      gitDecline =
        `\`${shown}\` exited ${r.status === null ? 'without a status' : String(r.status)}` +
        (said === '' ? '' : ` — ${said}`);
      return undefined;
    }
    return r.stdout.split('\0').filter((line) => line !== '');
  };

  // Belt to that braces: only trust git listing when `root` is itself the repo
  // root. If root is a subdirectory of some unrelated repo, its answer would be
  // scoped to that repo's rules rather than to the tree we were asked to scan.
  const top = run(['rev-parse', '--show-toplevel']);
  if (top === undefined) return undefined; // run() already said why
  if (top.length === 0) {
    gitDecline = `\`git -C ${root} rev-parse --show-toplevel\` printed nothing`;
    return undefined;
  }
  try {
    // .native for the same reason as answersToName below: the JS realpathSync
    // does not canonicalize the final path component, so under node a root
    // spelled differently from its on-disk name would compare unequal and drop
    // the gate onto the walk — a different scanned set, and not a safer
    // one.
    const topReal = realpathSync.native((top[0] ?? '').trim());
    if (topReal !== realpathSync.native(root)) {
      gitDecline = `${root} is not the toplevel of the repository git found (${topReal})`;
      return undefined;
    }
  } catch {
    gitDecline = `could not resolve ${root} or git's reported toplevel on disk`;
    return undefined;
  }

  const tracked = run(['ls-files', '-z']);
  if (tracked === undefined) return undefined;
  // Untracked-but-not-ignored files can be `git add`ed into the next diff, so
  // they are in scope too. Ignored files are not.
  //
  // A failure here returns undefined like every other run() in this function,
  // rather than defaulting to `[]`. The default was the one silent scan-shrink
  // the strategy check at the bottom of this file structurally CANNOT see: it
  // left `strategy` as 'git', so the summary read `N files scanned (git),
  // nothing hidden` over a scope that had lost its whole untracked half.
  // Measured, on this repo's own gate, by putting a `git` shim earlier on PATH
  // that exits 1 when it sees `--others` and execs the real git otherwise —
  // over a tree with a tracked src/a.ts and an untracked, concealed
  // src/added-later.ts:
  //
  //   real git:      `found content ... (2 files scanned, listed by git)`, exit 1
  //   shimmed git:   `1 files scanned (git), nothing hidden`,              exit 0
  //
  // Empty and failed are distinguishable, which is what makes returning
  // undefined exact rather than paranoid: probed on git 2.50.1, a clean tree
  // gives `ls-files --others --exclude-standard` status 0 with ZERO bytes of
  // stdout, which run() turns into `[]`. Only a non-zero status yields
  // undefined. So a repo with nothing untracked still scans, and still reports
  // (git).
  //
  // No tree state that makes `--others` exit non-zero was found, and it was
  // looked for: an unreadable subdirectory, an unreadable .git/info/exclude and
  // a .gitignore that is a directory all warn — or say nothing — and exit 0.
  // The failure is injected at the process boundary in the test for the same
  // reason it is guarded here: run() cannot tell why git failed, only that it
  // did, and a fail-open default in this file has never once stayed theoretical.
  const untracked = run(['ls-files', '-z', '--others', '--exclude-standard']);
  if (untracked === undefined) return undefined;
  const abs = (list: string[]): string[] => list.map((rel) => join(root, rel));
  // Set rather than Array#includes: both listings are whole-repo sized, so the
  // linear scan made the de-duplication quadratic in the file count.
  const trackedSet = new Set(tracked);
  return { tracked: abs(tracked), untracked: abs(untracked.filter((f) => !trackedSet.has(f))) };
}

/**
 * Returns the strategy alongside the list, and the summary line prints it.
 *
 * The fallback used to be silent, and the two strategies do not scan the same
 * set: the walk ignores .gitignore and applies SKIP_DIRS to everything, the git
 * listing honours .gitignore and applies SKIP_DIRS to untracked files only. Any
 * of `git` missing from PATH, a dubious-ownership refusal, or a toplevel
 * mismatch silently swaps one for the other, and both report the same green
 * `nothing hidden`. Naming the strategy makes a shrunken scan visible in the
 * output instead of only in a diff of this file.
 *
 * The caller does not settle for visible. When the tree has a `.git`, a walk
 * listing means git refused a repository it could have listed, and that run is
 * failed outright — see the strategy check after this function's only call.
 */
function listFiles(root: string): { files: string[]; strategy: 'git' | 'walk' } {
  const fromGit = gitFiles(root);
  if (fromGit === undefined) return { files: walk(root, []), strategy: 'walk' };
  // SKIP_DIRS exists for UNREVIEWED LOCAL ARTIFACTS, so it applies to the
  // untracked half only. A tracked file is in a diff by definition, which is
  // this gate's entire threat model — excluding `build/loader.ts` because of
  // its directory name would turn a list of vendored-output names into a list
  // of places a payload may sit unwatched. A previous revision did exactly
  // that, in a PR arguing against that shape.
  return {
    files: [...fromGit.tracked, ...fromGit.untracked.filter((f) => !underSkippedDir(root, f))],
    strategy: 'git',
  };
}

/**
 * True when a DIRECTORY segment of the path is in SKIP_DIRS. The final segment
 * is the filename and is excluded: an extensionless `scripts/build` is a shell
 * script — the exact shape of `.husky/pre-push` that this gate's scoping fix
 * was written about — and dropping it for its name would be that bug surviving
 * inside its own fix.
 */
function underSkippedDir(root: string, file: string): boolean {
  return relative(root, file).split(sep).slice(0, -1).some((seg) => SKIP_DIRS.has(seg));
}

/**
 * Only the route TARGET is memoized, and the asymmetry is a decision rather
 * than an oversight — it has been read as one, so here is the measurement.
 *
 * Counted by instrumenting a copy of this file with a counter around
 * `realOrUndefined` and running it over this repo (535 files):
 *
 *   realpath total=140  targetMisses=120  selfCalls=20  distinctSelfFiles=20
 *
 * Two things fall out. The cache that exists is on the hot side: 120 of the 140
 * calls are target lookups, and without it they would be roughly two per
 * scanned file. And a second cache keyed on `file` would save exactly ZERO of
 * the remaining 20, because every one of those 20 calls is already for a
 * distinct file.
 *
 * That is structural, not luck. `realOrUndefined(file)` sits after the
 * `target === undefined` early return, so it is reached only for a file whose
 * OWN directory contains the routed name — and reached twice only for a file
 * whose directory contains BOTH `package.json` and `.gitattributes`. The bound
 * on what a second Map could ever save is therefore one call per file sitting
 * beside both, which is not a number worth a second piece of mutable state in
 * the routing path.
 */
const routeTargetCache = new Map<string, string | undefined>();

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * Does `file` answer to `name` in its own directory — is it the file that git
 * or npm opens when it asks for `.gitattributes` or `package.json`?
 *
 * This exists because the previous answer to that question was a fold function
 * written here. Matching a lower-cased basename closed the `.GITATTRIBUTES`
 * hole and opened a smaller one: APFS folds U+017F (LATIN SMALL LETTER LONG S)
 * to `s`, and `String.prototype.toLowerCase` does not, so a file committed as
 * `.gitattributeſ` is read by git — `check-attr` reports `binary: set` — and was
 * skipped here. Sweeping 0x80-0x10FFFF against the actual filesystem found TWO
 * codepoints that fold into a letter these filenames contain: U+017F to `s` and
 * U+212A KELVIN SIGN to `k`. Only U+017F DIVERGED, because toLowerCase happens
 * to map U+212A — so the divergent set was one codepoint and a special case
 * would have worked. That is precisely the move this file keeps being punished
 * for: a parser standing in for a real system. Every one of these has been a
 * fold, a blank set, an unquote or a grammar approximated in JS instead of
 * measured, and each looked like a set of one until it wasn't.
 *
 * So the gate no longer holds an opinion about folding. It asks the filesystem
 * to resolve the name and compares what comes back.
 *
 * `realpathSync.NATIVE`, not `realpathSync`, and that distinction is the whole
 * oracle: this depends on realpath canonicalizing the FINAL component, and the
 * JS-implemented `fs.realpathSync` does not do that. Measured, both runtimes,
 * against the same file on disk (a package.json spelled with U+017F):
 *
 *   node v25.2.1   realpathSync -> "package.json"   .native -> the on-disk name
 *   bun  1.3.5     realpathSync -> the on-disk name  .native -> the on-disk name
 *
 * Bun's happens to canonicalize, so the plain form worked here and would have
 * gone on working until someone ran this under node — one `tsx` away — where
 * the probe silently returns false and variation ten walks back in through the
 * basename fallback. `.native` calls the OS in both, so the oracle stops
 * depending on which runtime invokes it. An unstated assumption about a system
 * that happens to hold today is the shape of every bug in this file.
 *
 * Kept as an OR with the basename test at the call site, never as a
 * replacement, for two reasons. It preserves the deliberate posture from the
 * case-sensitivity trade: on a case-sensitive filesystem `.GITATTRIBUTES` is a
 * different file, so this probe correctly says no and the name test still
 * routes it, which is the false positive that was chosen on purpose. And it
 * makes the probe purely ADDITIVE — a broken symlink, a permissions error or
 * any other failure resolves to `undefined` and simply falls back to the name
 * test, so a failure here can only ever scan more, never skip something that
 * was already being checked.
 */
function answersToName(file: string, name: string): boolean {
  const dir = dirname(file);
  const key = `${dir}\0${name}`;
  if (!routeTargetCache.has(key)) routeTargetCache.set(key, realOrUndefined(join(dir, name)));
  const target = routeTargetCache.get(key);
  if (target === undefined) return false;
  const self = realOrUndefined(file);
  return self !== undefined && self === target;
}

// ───────────────────────────────── ghost lines ──────────────────────────────
//
// Everything from here to the dispatch below is the PR-scoped half of this
// gate, and it answers a question no tree scan can.
//
// better-auth #6003 concealed its payload twice over. The scan above catches
// the horizontal half. The other half was temporal: the payload was added by
// one commit on the branch and deleted by a later one, so the combined "Files
// changed / All commits" view — the view a maintainer reviews from — showed a
// trailing-newline change and nothing else. The branch still built on the way
// past, and building it is what ran the payload.
//
// No tree contains that content at any point after the deleting commit, so
// nothing that reads a tree can see it. It needs the PR's commit RANGE.
//
// What gets reported is an INTERSECTION, not a fact about git:
//
//   ghost line  = a line in a blob introduced somewhere in base..head that is
//                 absent from the final tree's version of the same path
//   reported    = a ghost line that ALSO trips one of the rules above
//
// The first half alone is worthless as a gate. The audit that produced #648
// counted 195 ghost lines in this repository's history and every one was
// ordinary review churn — a reworded comment, a renamed variable, a fixture
// deleted three commits later. A gate that fired on those would be switched
// off inside a week, and a switched-off gate is the outcome this whole file is
// written to avoid. So the churn is the SCOPE and the rules are the PREDICATE,
// and the pair was measured rather than hoped for: see the numbers on the
// ghost-blob loop below.

const GHOST_MODE = process.argv.slice(2).includes('--ghost-lines');

/**
 * Is this run inside a CI job?
 *
 * The two endings of this mode differ by exactly this flag. On a laptop with no
 * branch to compare, skipping is the honest answer — there is nothing to check.
 * In CI there always is, so the same state means the range resolution broke,
 * and printing a green line over it would be this file's own recurring bug: a
 * scan that quietly covered nothing while reporting success.
 *
 * Both spellings, and the broad direction on purpose. GitHub sets CI and
 * GITHUB_ACTIONS to "true"; other runners set CI to "1". A CI that cannot say
 * which range it is testing must not print a green concealment gate, so an
 * unrecognised runner failing LOUD is the error worth having.
 */
const IN_CI =
  ['true', '1'].includes(process.env.CI ?? '') ||
  ['true', '1'].includes(process.env.GITHUB_ACTIONS ?? '');

interface CommitRange {
  base: string;
  head: string;
  /** How it was resolved. Quoted in every message: a range nobody can trace is a range nobody trusts. */
  how: string;
}

/**
 * Three outcomes, and they are not two.
 *
 * `skip` means there is nothing to compare — exit 0, but only outside CI, and
 * never silently. `refuse` means there IS something to compare and this gate
 * could not do it — always exit 1. Collapsing the second into the first is the
 * fail-open #724 removed from the tree scan, arriving by a different road.
 */
type RangeOutcome =
  | { kind: 'range'; range: CommitRange }
  | { kind: 'skip'; why: string }
  | { kind: 'refuse'; why: string; remedy: string };

/**
 * The remedy for every "that commit is not in this checkout" ending.
 *
 * `actions/checkout` fetches ONE commit by default (fetch-depth: 1). On a
 * pull_request event that one commit is the merge ref's tip, so neither
 * `base.sha` nor `head.sha` is present as an object and no range can be walked
 * — which is why the job that runs this mode sets fetch-depth: 0 and why that
 * is the first thing to check when this fires.
 */
const FETCH_DEPTH_REMEDY =
  'actions/checkout fetches a single commit by default (fetch-depth: 1), which is not a ' +
  'history. A job running this mode must set `fetch-depth: 0` — see the Cross-commit ' +
  'concealment job in .github/workflows/test.yml. Locally, `git fetch --unshallow`.';

/** Text from one git invocation, or the reason it did not produce any. */
function gitText(
  args: string[],
  input?: string
): { ok: true; text: string } | { ok: false; why: string } {
  const shown = `git -C ${ROOT} ${args.join(' ')}`;
  const r = spawnSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf-8',
    env: gitEnv(),
    maxBuffer: MAX_GIT_OUTPUT,
    ...(input === undefined ? {} : { input }),
  });
  // Same three-way split as run() inside gitFiles, and for the same reason: a
  // spawn failure, a kill for exceeding maxBuffer and git's own non-zero exit
  // have three different remedies, and a message naming the wrong one sends the
  // operator to a command that reproduces nothing.
  const code = (r.error as (Error & { code?: string }) | undefined)?.code;
  if (code !== undefined) {
    return {
      ok: false,
      why:
        code === 'ENOENT'
          ? `git is not on PATH — spawning \`${shown}\` failed with ENOENT`
          : code === 'ENOBUFS'
            ? `\`${shown}\` produced more than the ${MAX_GIT_OUTPUT} bytes this gate allows ` +
              `and was cut off — raise MAX_GIT_OUTPUT in scripts/check-concealment.ts`
            : `spawning \`${shown}\` failed with ${code}`,
    };
  }
  if (r.status !== 0 || typeof r.stdout !== 'string') {
    const said = (typeof r.stderr === 'string' ? r.stderr : '').split('\n')[0]?.trim() ?? '';
    return {
      ok: false,
      why:
        `\`${shown}\` exited ${r.status === null ? 'without a status' : String(r.status)}` +
        (said === '' ? '' : ` — ${said}`),
    };
  }
  return { ok: true, text: r.stdout };
}

/**
 * Bytes, not text, because this reads blob CONTENT.
 *
 * `git cat-file --batch` frames each object as a header line followed by
 * exactly `size` BYTES, and `size` is a byte count. Decoding the stream as
 * UTF-8 before framing it would move every frame boundary by however many
 * multi-byte sequences preceded it, so the parser has to see bytes and the
 * decode has to happen per object, after the split.
 */
function gitBytes(args: string[], input: string): { ok: true; bytes: Buffer } | { ok: false; why: string } {
  const shown = `git -C ${ROOT} ${args.join(' ')}`;
  const r = spawnSync('git', ['-C', ROOT, ...args], {
    env: gitEnv(),
    maxBuffer: MAX_GIT_OUTPUT,
    input,
  });
  const code = (r.error as (Error & { code?: string }) | undefined)?.code;
  if (code !== undefined) {
    return {
      ok: false,
      why:
        code === 'ENOBUFS'
          ? `\`${shown}\` produced more than the ${MAX_GIT_OUTPUT} bytes this gate allows ` +
            `and was cut off — raise MAX_GIT_OUTPUT in scripts/check-concealment.ts`
          : `spawning \`${shown}\` failed with ${code}`,
    };
  }
  if (r.status !== 0 || !Buffer.isBuffer(r.stdout)) {
    const said = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf-8').split('\n')[0]?.trim() : '';
    return {
      ok: false,
      why:
        `\`${shown}\` exited ${r.status === null ? 'without a status' : String(r.status)}` +
        (said === undefined || said === '' ? '' : ` — ${said}`),
    };
  }
  return { ok: true, bytes: r.stdout };
}

/** The commit a ref names, or undefined if this checkout does not have it. */
function commitSha(ref: string): string | undefined {
  // `^{commit}` so a tag or a tree spelled into --range fails here rather than
  // producing a range git will not walk three calls later.
  const r = gitText(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!r.ok) return undefined;
  const sha = r.text.trim();
  return sha === '' ? undefined : sha;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** An explicit range from `--range=<base>..<head>` or CHECK_GHOST_LINES_RANGE. */
function explicitRangeSpec(): string | undefined {
  const flag = process.argv.slice(2).find((a) => a.startsWith('--range='));
  if (flag !== undefined) return flag.slice('--range='.length);
  const fromEnv = process.env.CHECK_GHOST_LINES_RANGE;
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
}

function rangeFrom(baseRef: string, headRef: string, how: string): RangeOutcome {
  const base = commitSha(baseRef);
  const head = commitSha(headRef);
  if (base === undefined || head === undefined) {
    const missing = [base === undefined ? baseRef : '', head === undefined ? headRef : '']
      .filter((s) => s !== '')
      .join(' and ');
    return {
      kind: 'refuse',
      why: `${missing} is not a commit object in this checkout (range from ${how})`,
      remedy: FETCH_DEPTH_REMEDY,
    };
  }
  return { kind: 'range', range: { base, head, how } };
}

/**
 * The range GitHub Actions is testing, read from the event payload.
 *
 * `pull_request.base.sha`..`pull_request.head.sha`, not GITHUB_SHA: on a
 * pull_request event GITHUB_SHA is the ephemeral merge commit, whose tree is
 * the merged RESULT. The range wanted here is the contributor's own commits,
 * and `head.sha` names exactly those.
 *
 * `base.sha` being stale — the base branch moved after the event fired — is
 * harmless in this direction. `A..B` is "reachable from B, not from A", so a
 * base that has run ahead only removes objects that are already on the base
 * branch, and a base that has fallen behind only adds some. Neither can drop a
 * commit the contributor pushed, which is the set this mode exists to read.
 *
 * `pull_request_target` is deliberately NOT accepted. Its checkout is the BASE
 * branch by default, so the PR's own commits are not present and any range
 * built from it would describe something the reviewer is not being asked to
 * review. It is also the trigger that runs with repository secrets, which is
 * the last place this gate should be teaching anyone to fetch fork refs into.
 */
function actionsRange(): RangeOutcome | undefined {
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === undefined) return undefined;
  if (event !== 'pull_request') {
    return {
      kind: 'refuse',
      why: `this mode compares a pull request's commits against its final tree, and this run is a "${event}" event`,
      remedy:
        'Gate the step on `if: github.event_name == \'pull_request\'`, or pass an explicit ' +
        '`--range=<base>..<head>`.',
    };
  }
  const payloadPath = process.env.GITHUB_EVENT_PATH;
  if (payloadPath === undefined) {
    return {
      kind: 'refuse',
      why: 'GITHUB_EVENT_NAME is pull_request but GITHUB_EVENT_PATH is unset, so the event payload cannot be read',
      remedy: 'Pass an explicit `--range=<base>..<head>`.',
    };
  }
  let payload: { pull_request?: { base?: { sha?: unknown }; head?: { sha?: unknown } } };
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf-8')) as typeof payload;
  } catch (err) {
    return {
      kind: 'refuse',
      why: `${payloadPath} could not be read as JSON — ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'Pass an explicit `--range=<base>..<head>`.',
    };
  }
  const base = payload.pull_request?.base?.sha;
  const head = payload.pull_request?.head?.sha;
  if (typeof base !== 'string' || typeof head !== 'string') {
    return {
      kind: 'refuse',
      why: `${payloadPath} has no pull_request.base.sha / pull_request.head.sha to build a range from`,
      remedy: 'Pass an explicit `--range=<base>..<head>`.',
    };
  }
  return rangeFrom(base, head, 'the pull_request event payload (base.sha..head.sha)');
}

/**
 * The range a developer's own branch implies, with no PR anywhere.
 *
 * This is a convenience, not the gate's contract: it lets the same command run
 * before the push and produce the same answer CI will. It is inferred and says
 * so in every line it prints, because a merge-base against a STALE origin/main
 * quietly widens the range — which scans more, never less, and so is the
 * direction to be wrong in.
 *
 * `origin/HEAD` first because it names whatever the remote's default branch
 * actually is; the two literals after it are for clones that never had it set.
 * HEAD already contained in the base ref yields base === head, a zero-commit
 * range, which the caller reports as such rather than as a clean run.
 */
function localRange(): RangeOutcome {
  const head = commitSha('HEAD');
  if (head === undefined) {
    return {
      kind: 'skip',
      why: 'HEAD does not name a commit — an empty repository, or a checkout with no history',
    };
  }
  for (const ref of ['origin/HEAD', 'origin/main', 'main']) {
    const tip = commitSha(ref);
    if (tip === undefined) continue;
    const merged = gitText(['merge-base', tip, head]);
    if (!merged.ok) continue;
    const base = merged.text.trim();
    if (base === '') continue;
    return {
      kind: 'range',
      range: { base, head, how: `merge-base(${ref}, HEAD), inferred locally — no PR context` },
    };
  }
  return {
    kind: 'skip',
    why: 'no pull-request context, and none of origin/HEAD, origin/main or main exists to take a merge-base against',
  };
}

function resolveRange(): RangeOutcome {
  const spec = explicitRangeSpec();
  if (spec !== undefined) {
    // `...` is the symmetric difference and would silently include the base
    // branch's own commits. Refused by name rather than split on `..` and
    // mis-parsed into an empty endpoint.
    if (spec.includes('...')) {
      return {
        kind: 'refuse',
        why: `"${spec}" uses the three-dot symmetric difference, which includes commits from the base branch too`,
        remedy: 'Use the two-dot form: `--range=<base>..<head>`.',
      };
    }
    const parts = spec.split('..');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      return {
        kind: 'refuse',
        why: `"${spec}" is not a <base>..<head> range`,
        remedy: 'Spell both endpoints: `--range=<base>..<head>`.',
      };
    }
    return rangeFrom(parts[0] as string, parts[1] as string, `--range=${spec}`);
  }
  const fromActions = actionsRange();
  if (fromActions !== undefined) return fromActions;
  if (IN_CI) {
    return {
      kind: 'refuse',
      why: 'this run is in CI (CI or GITHUB_ACTIONS is set) but there is no pull_request event and no --range',
      remedy:
        'A CI job that cannot say which range it is testing must not report this gate green. ' +
        'Pass `--range=<base>..<head>`, or run the step only on `pull_request`.',
    };
  }
  return localRange();
}

function ghostRefuse(why: string, remedy: string): never {
  console.error('check-concealment --ghost-lines: REFUSING to report on a range it could not read.\n');
  console.error(`  Cause: ${why}\n`);
  console.error(`  ${remedy}\n`);
  process.exit(1);
}

function ghostSkip(why: string): never {
  // Not `console.log`, and not the word "clean" anywhere in it. A skip is an
  // absence of evidence; the tree scan's green line is evidence. Printing them
  // in the same voice is how a gate stops meaning anything.
  console.error('check-concealment --ghost-lines: SKIPPED — nothing was checked.\n');
  console.error(`  ${why}.\n`);
  console.error(
    '  This mode compares a pull request\'s own commits against its final tree, so it needs a\n' +
      '  commit range. Give it one with `--range=<base>..<head>` or CHECK_GHOST_LINES_RANGE.\n'
  );
  console.error(
    '  Exit 0 because there is nothing here to check, NOT because anything was found clean.\n' +
      '  The same state inside CI exits 1 — see resolveRange.\n'
  );
  process.exit(0);
}

/** One object from `git cat-file --batch`: `<sha> <type> <size>\n<size bytes>\n`. */
function parseCatFileBatch(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i < bytes.length) {
    const nl = bytes.indexOf(0x0a, i);
    if (nl < 0) break;
    const header = bytes.subarray(i, nl).toString('utf-8');
    const [sha, type, size] = header.split(' ');
    // `<name> missing` — no content frame follows, so the cursor advances by
    // the header alone. Silently dropping the object here is safe only because
    // the caller reports every sha it asked for and did not get back.
    if (sha === undefined || type === undefined || size === undefined) {
      i = nl + 1;
      continue;
    }
    const start = nl + 1;
    const length = Number(size);
    if (!Number.isFinite(length) || length < 0) break;
    out.set(sha, bytes.subarray(start, start + length));
    i = start + length + 1; // +1 for the LF git writes after the content
  }
  return out;
}

/**
 * Blob contents for `shas`, fetched in batches that stay inside MAX_GIT_OUTPUT.
 *
 * Sizes come from a `--batch-check` pass the caller already ran, so the batching
 * is measured rather than guessed. A SINGLE blob larger than the budget is a
 * refusal, not a skip: the one thing this file must never do is vouch for
 * content it did not read.
 */
function blobContents(
  shas: string[],
  sizeOf: Map<string, number>
): { ok: true; contents: Map<string, Buffer> } | { ok: false; why: string } {
  const budget = Math.floor(MAX_GIT_OUTPUT / 2); // headroom for the header lines
  const contents = new Map<string, Buffer>();
  let batch: string[] = [];
  let used = 0;
  const flush = (): string | undefined => {
    if (batch.length === 0) return undefined;
    const got = gitBytes(['cat-file', '--batch'], batch.join('\n') + '\n');
    if (!got.ok) return got.why;
    for (const [sha, buf] of parseCatFileBatch(got.bytes)) contents.set(sha, buf);
    batch = [];
    used = 0;
    return undefined;
  };
  for (const sha of shas) {
    const size = sizeOf.get(sha) ?? 0;
    if (size > budget) {
      return {
        ok: false,
        why:
          `blob ${shortSha(sha)} is ${size} bytes, past the ${budget} this gate reads in one ` +
          `batch — raise MAX_GIT_OUTPUT in scripts/check-concealment.ts rather than skipping it`,
      };
    }
    if (used + size > budget) {
      const failed = flush();
      if (failed !== undefined) return { ok: false, why: failed };
    }
    batch.push(sha);
    used += size;
  }
  const failed = flush();
  return failed === undefined ? { ok: true, contents } : { ok: false, why: failed };
}

/**
 * Which commit first put each blob on the branch, for the report only.
 *
 * Best-effort by construction: `git log --raw` shows no diff for a merge
 * commit, so a blob introduced by an evil merge has no attribution here and is
 * printed without one. That is a gap in the LABEL, never in the scan — the scan
 * enumerates by object reachability (see ghostBlobs), which no commit shape can
 * hide from. Keeping the two separate is the point: a best-effort enumeration
 * would be a hole, a best-effort label is a label.
 *
 * `git log` walks newest-first, so the last writer wins and the map ends up
 * holding the OLDEST commit that carries each blob — the one that introduced it.
 */
function attribution(range: CommitRange): Map<string, string> {
  const byBlob = new Map<string, string>();
  const log = gitText([
    'log',
    '--format=%H %s',
    '--raw',
    '-r',
    '--no-abbrev',
    '--no-renames',
    '--no-color',
    `${range.base}..${range.head}`,
  ]);
  if (!log.ok) return byBlob;
  let current = '';
  for (const line of log.text.split('\n')) {
    if (line.startsWith(':')) {
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>
      const fields = line.slice(1).split(' ');
      const dst = fields[3];
      if (current !== '' && dst !== undefined && !/^0+$/.test(dst)) byBlob.set(dst, current);
      continue;
    }
    const match = /^([0-9a-f]{40})(?: (.*))?$/.exec(line);
    if (match !== null) current = `${shortSha(match[1] as string)} "${(match[2] ?? '').trim()}"`;
  }
  return byBlob;
}

/**
 * The PR-scoped scan. Returns `never` on purpose: this is a MODE, not a phase,
 * and the tree scan below must not run after it. Typing it so makes that a
 * compile error rather than a code-review question — add a `return` here and
 * `tsc` rejects the file.
 */
function runGhostScan(): never {
  // Same belt-and-braces as gitFiles: if ROOT is a subdirectory of some
  // unrelated repository, git would answer about THAT repository's history and
  // every number below would describe the wrong tree.
  const top = gitText(['rev-parse', '--show-toplevel']);
  if (!top.ok) ghostRefuse(top.why, 'Run this inside the repository whose pull request you are checking.');
  try {
    if (realpathSync.native(top.text.trim()) !== realpathSync.native(ROOT)) {
      ghostRefuse(
        `${ROOT} is not the toplevel of the repository git found (${top.text.trim()})`,
        'Point CHECK_CONCEALMENT_ROOT at the repository root.'
      );
    }
  } catch {
    ghostRefuse(
      `could not resolve ${ROOT} or git's reported toplevel on disk`,
      'Point CHECK_CONCEALMENT_ROOT at the repository root.'
    );
  }

  const outcome = resolveRange();
  if (outcome.kind === 'refuse') ghostRefuse(outcome.why, outcome.remedy);
  if (outcome.kind === 'skip') ghostSkip(outcome.why);
  const range = outcome.range;

  // A shallow clone is the CI default, and it is the one state where every
  // command below still SUCCEEDS while describing a history that was cut off.
  // Checked before the walk rather than inferred from its results.
  const shallow = gitText(['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok) ghostRefuse(shallow.why, FETCH_DEPTH_REMEDY);
  if (shallow.text.trim() === 'true') {
    ghostRefuse(
      'this checkout is SHALLOW, so the commits between the endpoints are not all present and ' +
        'any range walked over it would be silently incomplete',
      FETCH_DEPTH_REMEDY
    );
  }

  const label = `${shortSha(range.base)}..${shortSha(range.head)} (via ${range.how})`;

  const commits = gitText(['rev-list', `${range.base}..${range.head}`]);
  if (!commits.ok) ghostRefuse(commits.why, FETCH_DEPTH_REMEDY);
  const commitCount = commits.text.split('\n').filter((l) => l !== '').length;
  if (commitCount === 0) {
    // In CI this is not "nothing to do", it is "the range resolved to nothing",
    // and a pull request with no commits of its own cannot be merged anyway.
    if (IN_CI) {
      ghostRefuse(
        `the range ${label} contains no commits, so this job inspected none of the pull request`,
        'Check how the range was resolved — a pull request always has at least one commit not on its base.'
      );
    }
    ghostSkip(`the range ${label} contains no commits`);
  }

  // Enumeration is by OBJECT REACHABILITY, not by walking diffs. `A..B` on
  // rev-list --objects is every object reachable from B and not from A, so it
  // covers blobs introduced by a merge commit, by an amended commit still on
  // the branch, and by anything else a diff-based walk would have had to
  // anticipate. The file this gate lives in has been bitten four times by
  // enumerating the cases somebody thought of; this is the same lesson applied
  // to a commit graph.
  const objects = gitText(['rev-list', '--objects', `${range.base}..${range.head}`]);
  if (!objects.ok) ghostRefuse(objects.why, FETCH_DEPTH_REMEDY);

  const headTree = gitText(['ls-tree', '-r', '-z', range.head]);
  if (!headTree.ok) ghostRefuse(headTree.why, FETCH_DEPTH_REMEDY);
  const headShaByPath = new Map<string, string>();
  const headShas = new Set<string>();
  for (const entry of headTree.text.split('\0')) {
    if (entry === '') continue;
    // <mode> SP <type> SP <sha> TAB <path>
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const fields = entry.slice(0, tab).split(' ');
    const sha = fields[2];
    if (sha === undefined) continue;
    headShaByPath.set(entry.slice(tab + 1), sha);
    headShas.add(sha);
  }

  // git speaks '/' whatever the platform does. Normalising here is what lets
  // SELF_EXEMPT, isProse and extensionOf — all written against the tree scan's
  // `relative()` output — mean the same thing in this mode.
  const toRel = (gitPath: string): string => gitPath.split('/').join(sep);

  const candidates: Array<{ sha: string; rel: string }> = [];
  const seen = new Set<string>();
  for (const line of objects.text.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue; // a commit: no path
    const sha = line.slice(0, space);
    const rel = toRel(line.slice(space + 1));
    if (headShas.has(sha)) continue; // survives into the final tree; the tree scan owns it
    if (!inScope(rel)) continue; // lockfiles, exactly as above
    const key = `${sha}\0${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ sha, rel });
  }

  // --batch-check first: it returns type and size without content, which is
  // what makes the content fetch below bounded by measurement instead of hope.
  // It is also how trees are separated from blobs — rev-list --objects lists
  // both, and both carry paths.
  const sizeOf = new Map<string, number>();
  const ghosts: Array<{ sha: string; rel: string }> = [];
  if (candidates.length > 0) {
    const uniqueShas = [...new Set(candidates.map((c) => c.sha))];
    const checked = gitText(['cat-file', '--batch-check'], uniqueShas.join('\n') + '\n');
    if (!checked.ok) ghostRefuse(checked.why, FETCH_DEPTH_REMEDY);
    const blobs = new Set<string>();
    for (const line of checked.text.split('\n')) {
      const [sha, type, size] = line.split(' ');
      if (sha === undefined || type !== 'blob' || size === undefined) continue;
      blobs.add(sha);
      sizeOf.set(sha, Number(size));
    }
    for (const c of candidates) if (blobs.has(c.sha)) ghosts.push(c);
  }

  // The final tree's version of each path a ghost blob claims. Absent from the
  // map means the path is not in the final tree at all — a file added and
  // deleted inside the pull request, whose every line is therefore a ghost.
  const wantedHeadShas = [
    ...new Set(
      ghosts
        .map((g) => headShaByPath.get(g.rel.split(sep).join('/')))
        .filter((s): s is string => s !== undefined)
    ),
  ];
  const headSizes = new Map<string, number>();
  if (wantedHeadShas.length > 0) {
    const checked = gitText(['cat-file', '--batch-check'], wantedHeadShas.join('\n') + '\n');
    if (!checked.ok) ghostRefuse(checked.why, FETCH_DEPTH_REMEDY);
    for (const line of checked.text.split('\n')) {
      const [sha, type, size] = line.split(' ');
      if (sha === undefined || type !== 'blob' || size === undefined) continue;
      headSizes.set(sha, Number(size));
    }
  }

  const ghostBytes = blobContents([...new Set(ghosts.map((g) => g.sha))], sizeOf);
  if (!ghostBytes.ok) ghostRefuse(ghostBytes.why, FETCH_DEPTH_REMEDY);
  const headBytes = blobContents(wantedHeadShas, headSizes);
  if (!headBytes.ok) ghostRefuse(headBytes.why, FETCH_DEPTH_REMEDY);

  const headLineCache = new Map<string, Set<string>>();
  const headLinesFor = (rel: string): Set<string> => {
    let lines = headLineCache.get(rel);
    if (lines !== undefined) return lines;
    lines = new Set<string>();
    const sha = headShaByPath.get(rel.split(sep).join('/'));
    const buf = sha === undefined ? undefined : headBytes.contents.get(sha);
    if (buf !== undefined) for (const line of buf.toString('utf-8').split('\n')) lines.add(line);
    headLineCache.set(rel, lines);
    return lines;
  };

  const introducedBy = attribution(range);

  interface GhostFinding extends Finding {
    origin: string | undefined;
  }
  const ghostFindings: GhostFinding[] = [];
  const missing: string[] = [];
  let scannedBlobs = 0;

  for (const { sha, rel } of ghosts) {
    const buf = ghostBytes.contents.get(sha);
    if (buf === undefined) {
      // Asked for and not returned. Same standard as the tree scan's
      // `unreadable` list: a blob that was listed and not read is a hole in the
      // claim this gate makes, so it is named rather than counted as scanned.
      missing.push(`${rel}  blob ${shortSha(sha)}`);
      continue;
    }
    scannedBlobs++;
    const text = buf.toString('utf-8');
    const lines = text.split('\n');

    // Findings land in the shared `findings` array, exactly as the tree scan's
    // do, and are taken back out here. Reusing report() is the point: a rule
    // added above is a rule this mode enforces, with nothing to keep in sync.
    const before = findings.length;
    if (text.includes(NUL)) {
      if (!isExpectedBinary(rel)) {
        report(
          rel,
          1,
          'NUL byte in a non-binary file',
          'a NUL makes git render the whole file as binary — no diff for a reviewer to read — ' +
            'while the module still executes'
        );
      }
    } else {
      const exempt = SELF_EXEMPT.has(rel);
      const prose = isProse(rel);
      for (let i = 0; i < lines.length; i++) checkLine(rel, i + 1, lines[i] as string, exempt, prose);
      const basename = rel.slice(rel.lastIndexOf(sep) + 1).toLowerCase();
      // Name only — `answersToName` asks the filesystem which file a name
      // opens, and a blob that is not in any tree has no filesystem to ask.
      // The case-folding hole that probe closes is a working-tree property, so
      // the tree scan still owns it.
      if (basename === 'package.json') checkLifecycleScripts(text, rel);
      if (basename === '.gitattributes') checkGitAttributes(text, rel);
    }

    // THE predicate, in one place and in one form: a finding is reported iff the
    // LINE it sits on is absent from the final tree's version of the same path.
    // Applied uniformly to the per-line rules and to the two whole-file checkers
    // — both of those report against a line of the blob they parsed, so both
    // answer the same question. Anything still present at head is content the
    // combined diff DOES show, and the tree scan above is what judges it.
    const surviving = headLinesFor(rel);
    for (const f of findings.splice(before)) {
      const text2 = lines[f.line - 1];
      if (text2 !== undefined && surviving.has(text2)) continue;
      ghostFindings.push({ ...f, origin: introducedBy.get(sha) });
    }
  }

  const scope =
    `${commitCount} commit${commitCount === 1 ? '' : 's'}, ` +
    `${scannedBlobs} blob${scannedBlobs === 1 ? '' : 's'} absent from the final tree`;

  if (ghostFindings.length > 0) {
    console.error(
      'check-concealment --ghost-lines: found content that this pull request added and then ' +
        'removed, which the combined diff never shows.\n'
    );
    console.error(`  Range ${label}: ${scope}.\n`);
    const byRule = new Map<string, GhostFinding[]>();
    for (const f of ghostFindings) {
      const list = byRule.get(f.rule) ?? [];
      list.push(f);
      byRule.set(f.rule, list);
    }
    for (const [rule, items] of byRule) {
      console.error(`  ${rule}:`);
      for (const f of items) {
        console.error(`    ${f.file}:${f.line}${f.origin === undefined ? '' : `  added in ${f.origin}`}`);
        console.error(`      ${f.detail}`);
      }
      console.error('');
    }
    console.error(
      '  A line that a later commit removed is not suspicious by itself — ordinary review churn\n' +
        '  produces those constantly, and none of them are listed here. What is listed is content\n' +
        '  that BOTH vanished before the final tree AND trips a concealment rule: the shape of\n' +
        '  better-auth #6003, where a build config carried a loader for exactly as long as it took\n' +
        '  CI to run it.\n'
    );
    console.error(
      '  The remedy is never to squash the history away. Say in the pull request what the removed\n' +
        '  content was and why it was there, or rewrite the branch so the content never existed.\n'
    );
  }

  if (missing.length > 0) {
    console.error(
      `check-concealment --ghost-lines: ${missing.length} blob(s) were listed by git and could ` +
        `not be read back, so they were NOT inspected — ${scannedBlobs} of ${ghosts.length} were.\n`
    );
    for (const m of missing) console.error(`    ${m}`);
    console.error('');
  }

  if (ghostFindings.length === 0 && missing.length === 0) {
    console.log(
      `check-concealment --ghost-lines: ${scope}, range ${label} — nothing hidden from the ` +
        `combined diff`
    );
    process.exit(0);
  }
  process.exit(1);
}

if (GHOST_MODE) runGhostScan();

const listing = listFiles(ROOT);

// The strategy is an INVARIANT here, not only a label.
//
// gitFiles drops HOME and XDG_CONFIG_HOME, so a global `safe.directory` is
// invisible to it and a repo owned by another uid makes git refuse — plausible
// in a container job whose checkout uid differs from the runner's. Every way
// git can decline lands on the same `run() === undefined` path and falls back
// to the walk, which applies SKIP_DIRS to TRACKED files and so scans a
// strictly different, smaller set.
//
// Naming the strategy in the summary made that visible. Visible is not
// enforced: both endings are exit 0 and nobody reads a green step. Measured on
// git 2.50.1 against one tree — a tracked, concealed `build/loader.ts` beside a
// clean `src/a.ts` — copied twice, run with the version of this file that had
// only the label:
//
//   as a real repo:          `(2 files scanned, listed by git)`, exit 1
//   after `chmod 000 .git`:  `1 files scanned (walk), nothing hidden`, exit 0
//
// Reproduce: `git init` such a tree and commit it, run the gate with
// CHECK_CONCEALMENT_ROOT pointed at it, then `chmod 000 .git` and run it again.
// The payload vanishes and the run stays green. A `.git` that is not a repo at
// all (`printf garbage > .git/config`) prints the same two lines.
//
// The MOTIVATING refusal — dubious ownership — has now been run too, on that
// same tree, and it does not need a second uid: git ships
// GIT_TEST_ASSUME_DIFFERENT_OWNER, which drives the real
// `fatal: detected dubious ownership ...` (status 128) from
// ensure_valid_ownership. Put it on a `git` shim earlier in PATH, since this
// function strips the whole GIT_ namespace before spawning:
//
//   pre-guard:  `1 files scanned (walk), nothing hidden`, exit 0
//   with this:  the refusal below,                        exit 1
//
// Pinned end-to-end in tests/scripts/check-concealment.test.ts.
//
// So a tree that HAS a .git and that git nevertheless would not list is
// refused. The remedy is never "accept the walk": the swap only ever scans
// less.
//
// The test is `.git` AT ROOT, which is where this gate runs and what a worktree
// has too (there it is a file, and existsSync answers for both). One case it
// does NOT cover, stated rather than left to be discovered: pointing
// CHECK_CONCEALMENT_ROOT at a SUBDIRECTORY of a repo. gitFiles already declines
// that on the toplevel mismatch, and there is no `.git` in a subdirectory, so
// it walks silently — the tests' own path.
if (listing.strategy === 'walk' && existsSync(join(ROOT, '.git'))) {
  console.error(
    `check-concealment: ${ROOT} has a .git, but the git listing declined, so the scan fell ` +
      `back to the filesystem walk — a different and smaller set, since SKIP_DIRS applies to ` +
      `tracked files there. Refusing rather than reporting a green run over a shrunken scan.\n`
  );
  // The measured cause, not the likely one. `git declined` covers git refusing
  // (status 128), git not being on PATH at all, and git being killed for
  // exceeding maxBuffer — and the remedy differs for each, so guessing here
  // would send the operator to a command that reproduces nothing.
  console.error(`  Cause: ${gitDecline ?? 'not recorded'}\n`);
  console.error(
    `  If that is a dubious-ownership refusal, note that this gate runs git with no HOME and ` +
      `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, and that safe.directory is "only respected in ` +
      `protected configuration" (git help config) — which the repository's own .git/config is ` +
      `not, verified with GIT_TEST_ASSUME_DIFFERENT_OWNER. Run the gate as the checkout's ` +
      `owner rather than trying to allow-list the path.`
  );
  process.exit(1);
}

const files = listing.files.filter((f) => inScope(f));

/**
 * Files that were listed and then could NOT be inspected, with the cause.
 *
 * This list and the `scanned` counter beside it exist because the summary used
 * to print `files.length` — computed BEFORE the loop — while the loop dropped
 * an unreadable file with a bare `catch { continue }`: no log, no counter, no
 * finding. A file the gate never opened was reported as scanned, on a gate
 * whose entire output is a claim about what it inspected. That is a fail-open,
 * and the cheapest attack on it was to make a file unreadable rather than to
 * hide anything inside it.
 *
 * Two changes, and they are separate: the number printed is now `scanned`,
 * incremented at the point of inspection, so it cannot overstate by
 * construction; and an unreadable file is a refusal rather than a note, for the
 * same reason the walk fallback above is one — "refusing rather than reporting
 * a green run over a shrunken scan". A scan that is quietly smaller than its
 * listing is the shape of every bug in this file.
 */
const unreadable: Array<{ file: string; cause: string }> = [];
let scanned = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  // undefined for everything that is not a symlink. See linkTarget: for a
  // symlink this string IS the diff, so it is checked whether or not the link
  // also resolves to something readable.
  const link = linkTarget(file);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf-8');
  } catch (err) {
    if (link === undefined) {
      unreadable.push({ file: rel, cause: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // Nothing else to scan: the link is the whole of the content.
    contents = link;
  }
  scanned++;

  // Ahead of the NUL check below, which returns early for an expected binary —
  // a link to a `.png` still has an attacker-chosen target path.
  //
  // `prose: false` regardless of the link's own extension, because a target
  // path is a path and not a paragraph: `AGENTS.md -> CLAUDE.md` should be held
  // to the code rules on the string `CLAUDE.md`. The cost is that a legitimate
  // target path past MAX_LINE would be reported, which is the direction this
  // gate errs in everywhere else.
  //
  // Skipped when the target is already what `contents` holds — the per-line
  // loop further down would otherwise report the same payload a second time.
  if (link !== undefined && link !== contents) {
    checkLine(rel, 1, link, SELF_EXEMPT.has(rel), false);
  }
  if (contents.includes(NUL)) {
    // Not "binary, therefore safe" — see BINARY_EXTENSIONS. A NUL in a file
    // that is not an expected binary is itself the concealment: it makes git
    // show the reviewer nothing while the module still executes.
    if (!isExpectedBinary(rel)) {
      report(
        rel,
        1,
        'NUL byte in a non-binary file',
        'a NUL makes git render the whole file as binary — no diff for a reviewer to read — ' +
          'while the module still executes'
      );
    }
    continue;
  }

  const exempt = SELF_EXEMPT.has(rel);
  // `contents !== link` is the same condition as the dedicated checkLine above,
  // and it is here for the case that call skips: a link that does NOT resolve,
  // where `contents` IS the target path and this loop is the only thing that
  // sees it. Without the conjunct a link named `*.md`, `*.txt` or `*.rst` had
  // its target path checked as PROSE — no MAX_LINE, no DYNAMIC_EXEC — so the
  // DANGLING case, the more attacker-controlled of the two since the target
  // need not exist, was checked less strictly than the resolving one. This repo
  // tracks `AGENTS.md` and `GEMINI.md` as mode-120000 blobs, so that was one
  // rename of CLAUDE.md away from being the live configuration. Caught in
  // review of #724.
  //
  // Not `false` for every symlink, which would over-apply: `AGENTS.md` RESOLVES
  // to CLAUDE.md, whose prose lines run past MAX_LINE, so the code rules on a
  // resolving link's target bytes would manufacture findings on this repo's own
  // tree. Prose is a property of the bytes being scanned, not of the path.
  //
  // Which leaves one asymmetry, stated so nobody "fixes" it the wrong way: for
  // a symlink that RESOLVES, `prose` is still derived from the LINK's extension
  // while `contents` are the TARGET's bytes, so `notes.md -> thing.ts` reads
  // code under prose rules. Not a hole, for two reasons that have to hold
  // together — the git-visible content, the target path, gets code rules
  // unconditionally from the checkLine above, and a target tracked in this tree
  // is listed and scanned strictly under its own path. It would become one for
  // a link pointing OUTSIDE the tree, which is content no diff contains at all.
  const prose = isProse(rel) && contents !== link;
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) checkLine(rel, i + 1, lines[i], exempt, prose);

  // Any package.json, not just the root one: workspace installs run
  // sub-package lifecycle scripts too, so `packages/x/package.json` with a
  // postinstall is the same exposure with a longer path.
  //
  // Matched case-INSENSITIVELY, which is a deliberate trade rather than an
  // oversight. This repo is developed on macOS and consumed on Windows, both
  // case-insensitive by default, and there the lookup resolves whatever the
  // file is actually called: probed on this filesystem, `git check-attr diff
  // src/payload.ts` reports `diff: unset` from a file named `.GITATTRIBUTES`,
  // and `npm pkg get scripts` returns the postinstall from a file named
  // `PACKAGE.JSON`. Exact-case routing sent neither to its checker and the gate
  // exited 0 on both — variation eight, and the cheapest one yet to exploit.
  //
  // The cost: on a case-sensitive filesystem `.GITATTRIBUTES` is a different
  // file that git ignores, so this reports a finding git would not honour. That
  // is a false positive, and it is the right way round for this gate — a human
  // spends a minute and writes an exemption, where the other error ships a
  // suppressed diff. It is also the direction every other allowance here
  // already fails in: omission must fail toward suspicion.
  //
  // The lower-cased name is only the FLOOR, though, not the mechanism.
  // toLowerCase is a fold function written in JS, and the filesystem's fold is
  // wider than it — U+017F, variation ten, which arrived inside the fix for
  // eight and nine. answersToName asks the OS which file the name actually
  // opens; the name test stays OR'd beside it to keep the deliberate false
  // positive above and to make the probe purely additive. See answersToName.
  const basename = rel.slice(rel.lastIndexOf(sep) + 1).toLowerCase();
  if (basename === 'package.json' || answersToName(file, 'package.json')) {
    checkLifecycleScripts(contents, rel);
  }
  if (basename === '.gitattributes' || answersToName(file, '.gitattributes')) {
    checkGitAttributes(contents, rel);
  }
}

if (findings.length > 0) {
  console.error(
    `check-concealment: found content engineered to be invisible in review ` +
      `(${scanned} files scanned, listed by ${listing.strategy}).\n`
  );
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byRule.get(f.rule) ?? [];
    list.push(f);
    byRule.set(f.rule, list);
  }
  for (const [rule, items] of byRule) {
    console.error(`  ${rule}:`);
    for (const f of items) console.error(`    ${f.file}:${f.line}  ${f.detail}`);
    console.error('');
  }
  console.error('  Each of these has no legitimate use in this repository. If one is genuinely');
  console.error('  needed, add a narrow, justified exemption to scripts/check-concealment.ts');
  console.error('  in the same PR — do not widen a threshold to make the gate quiet.\n');
}

// Reported AFTER the findings, never instead of them: an unreadable file and a
// concealed payload are independent, and a run that hit both has to show both.
if (unreadable.length > 0) {
  console.error(
    `check-concealment: ${unreadable.length} of ${files.length} listed files could not be read, ` +
      `so they were NOT inspected. Refusing rather than reporting a scan over a set smaller ` +
      `than the one git listed — ${scanned} of ${files.length} were actually inspected.\n`
  );
  for (const u of unreadable) console.error(`    ${u.file}  ${u.cause}`);
  console.error(
    `\n  A tracked file that is missing from the working tree is the usual cause: stage the ` +
      `deletion so the listing and the tree agree. Otherwise it is a permissions problem on ` +
      `the file itself — fix that rather than making this gate quiet, because the one thing ` +
      `it must never do is vouch for a file it did not open.\n`
  );
}

if (findings.length === 0 && unreadable.length === 0) {
  console.log(`check-concealment: ${scanned} files scanned (${listing.strategy}), nothing hidden`);
  process.exit(0);
}

process.exit(1);
