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
 *   - It sees one tree, never a range of commits. The cross-commit half of
 *     #6003 — content added by one commit and removed by another, so it never
 *     appears in the combined diff — cannot be seen from a tree at all. That
 *     needs the PR's commit range, which this gate does not read: there is no
 *     flag for it and nothing passes one. Open work, not an option somebody
 *     forgot to switch on.
 *   - The dynamic-execution rule is regex-based, so it reads a construct inside
 *     a string literal the same as a real one. That is why this file and its
 *     test are exempt from that rule alone (see SELF_EXEMPT) — they necessarily
 *     quote the patterns they look for.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
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

  const run = (args: string[]): string[] | undefined => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf-8', env });
    if (r.status !== 0 || typeof r.stdout !== 'string') return undefined;
    return r.stdout.split('\0').filter((line) => line !== '');
  };

  // Belt to that braces: only trust git listing when `root` is itself the repo
  // root. If root is a subdirectory of some unrelated repo, its answer would be
  // scoped to that repo's rules rather than to the tree we were asked to scan.
  const top = run(['rev-parse', '--show-toplevel']);
  if (top === undefined || top.length === 0) return undefined;
  try {
    // .native for the same reason as answersToName below: the JS realpathSync
    // does not canonicalize the final path component, so under node a root
    // spelled differently from its on-disk name would compare unequal and drop
    // the gate onto the walk — a different scanned set, and not a safer
    // one.
    const topReal = realpathSync.native((top[0] ?? '').trim());
    if (topReal !== realpathSync.native(root)) return undefined;
  } catch {
    return undefined;
  }

  const tracked = run(['ls-files', '-z']);
  if (tracked === undefined) return undefined;
  // Untracked-but-not-ignored files can be `git add`ed into the next diff, so
  // they are in scope too. Ignored files are not.
  const untracked = run(['ls-files', '-z', '--others', '--exclude-standard']) ?? [];
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
const routeTargetCache = new Map<string, string | undefined>();

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function answersToName(file: string, name: string): boolean {
  const dir = dirname(file);
  const key = `${dir}\0${name}`;
  if (!routeTargetCache.has(key)) routeTargetCache.set(key, realOrUndefined(join(dir, name)));
  const target = routeTargetCache.get(key);
  if (target === undefined) return false;
  const self = realOrUndefined(file);
  return self !== undefined && self === target;
}

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
// all (`printf garbage > .git/config`) prints the same two lines — both were
// run; the ownership refusal was NOT, because it needs a second uid. It reaches
// this branch identically, as a non-zero status from `run()`.
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
    `check-concealment: ${ROOT} has a .git, but git declined to list it, so the scan fell ` +
      `back to the filesystem walk — a different and smaller set, since SKIP_DIRS applies to ` +
      `tracked files there. Refusing rather than reporting a green run over a shrunken scan.\n`
  );
  console.error(
    `  Run \`git -C ${ROOT} ls-files\` to see the refusal. If it is dubious ownership, note ` +
      `that this gate runs git with no HOME and GIT_CONFIG_GLOBAL/SYSTEM=/dev/null, and that ` +
      `safe.directory is "only respected in protected configuration" (git help config) — ` +
      `which the repository's own .git/config is not. Run the gate as the checkout's owner ` +
      `rather than trying to allow-list the path.`
  );
  process.exit(1);
}

const files = listing.files.filter((f) => inScope(f));
for (const file of files) {
  const rel = relative(ROOT, file);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf-8');
  } catch {
    continue;
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
  const prose = isProse(rel);
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

if (findings.length === 0) {
  console.log(`check-concealment: ${files.length} files scanned (${listing.strategy}), nothing hidden`);
  process.exit(0);
}

console.error(
  `check-concealment: found content engineered to be invisible in review ` +
    `(${files.length} files scanned, listed by ${listing.strategy}).\n`
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
process.exit(1);
