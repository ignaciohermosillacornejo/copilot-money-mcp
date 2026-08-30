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
 *   - Markdown is skipped: it is prose, it is not executed, and its long lines
 *     are load-bearing. A reviewer-facing bidi trick in docs would pass here.
 *   - This gate sees the working tree. The cross-commit half of #6003 — content
 *     added by one commit and removed by another, so it never appears in the
 *     combined diff — cannot be seen from a tree at all. That needs the PR's
 *     commit range; see `--range`.
 *   - The dynamic-execution rule is regex-based, so it reads a construct inside
 *     a string literal the same as a real one. That is why this file and its
 *     test are exempt from that rule alone (see SELF_EXEMPT) — they necessarily
 *     quote the patterns they look for.
 */

import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_CONCEALMENT_ROOT lets tests point the gate at a synthetic tree, the
// same pattern as CHECK_PRIVACY_ENDPOINTS_ROOT and CHECK_TOOL_COUNTS_ROOT.
const ROOT = process.env.CHECK_CONCEALMENT_ROOT ?? join(__dirname, '..');

/** A run of this many space characters (ASCII or unicode) mid-line is the gap. */
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
 * Extensions where a NUL byte is expected, because the file genuinely is
 * binary. Everything else containing a NUL is REPORTED rather than skipped.
 *
 * A NUL used to be an unconditional free pass: the main loop skipped any file
 * containing one as "binary". But a module with a NUL byte tucked inside a
 * comment or string literal still runs under bun and node — NUL-containing is
 * not the same as non-executable —
 * while git renders the whole file as `Binary files ... differ`, so the
 * reviewer sees nothing at all. That is strictly better concealment than the
 * off-screen trick this gate was built for.
 *
 * Note the direction: forgetting an extension here means a real binary gets
 * reported and a human adds it. The reverse — the old behaviour — meant a
 * payload ran with nobody looking.
 */
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
 * Install hooks split by who runs them.
 *
 * `preinstall` / `install` / `postinstall` execute on every machine that installs
 * the published package, including consumers. `prepublish` is the deprecated npm
 * hook that also ran on plain `npm install`, so it belongs with them. Nothing in
 * this repo needs any of the four, so they are refused outright rather than
 * allow-listed — an allowlist entry here is indistinguishable from the attack.
 *
 * `prepare` and `prepublishOnly` run on contributor and publisher machines. Those
 * are still execution vectors (a contributor's `bun install` runs `prepare`), so
 * each is pinned to its exact reviewed value: changing what runs at install time
 * means changing this file, in the same PR, where a reviewer will see it. The
 * pinned names are derived from the map so a hook can never be listed as pinned
 * without a value to pin it to.
 */
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
const WHITESPACE_RUN_RE = new RegExp(`\\S[${GAP_CHARS}]{${WHITESPACE_RUN},}\\S`);

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
      `${WHITESPACE_RUN}+ consecutive space characters mid-line on a ${line.length}-column ` +
        `line — the tail is off-screen in a diff. Unicode spaces (NBSP, U+2003, U+3000, ...) ` +
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
 */
const DIFF_SUPPRESSING_ATTRS = [/(^|\s)binary(\s|$)/, /(^|\s)-diff(\s|$)/, /linguist-generated/];

function checkGitAttributes(contents: string, rel: string): void {
  contents.split('\n').forEach((line, i) => {
    // gitattributes(5): "Lines that begin with # are ignored." ONLY at line
    // start — a mid-line `#` is literal and part of the pattern. Stripping
    // from any `#` discarded content git honours, so `src/pay#load.ts binary`
    // parsed down to `src/pay`, matched nothing, and still marked the real
    // file binary for every reviewer. A parser in this gate must not discard
    // more than the grammar it models.
    // git's parse_attr_line skips ONLY spaces and tabs before the `#` test
    // (`strspn(line, blank)`, `blank[] = " \t"`). JS .trim() also strips NBSP,
    // \f, \v, the unicode space separators and U+FEFF — so `<NBSP># p.ts binary`
    // is a real pattern to git and was dropped here as a comment. That is the
    // mirror of the bug this function just fixed: the old code discarded
    // content AFTER a `#`, this discarded a whole line that is not a comment.
    // Trailing \s is still stripped, for CRLF checkouts.
    const stripped = line.replace(/^[ \t]+/, '').replace(/\s+$/, '');
    if (stripped === '' || stripped.startsWith('#')) return;
    // `*.png binary` targets something with no readable diff to suppress.
    //
    // Checked against INERT_BINARY_EXTENSIONS, NOT BINARY_EXTENSIONS. The
    // latter answers a different question — where a NUL byte is expected — and
    // includes .node/.wasm/.so/.dll/.exe, whose whole point is that they
    // execute. Auto-approving `*.wasm binary` would bless diff suppression on
    // exactly the formats that run. An author who genuinely needs it writes
    // the exemption, which is what this gate's failure message asks for.
    // git separates the pattern from its attributes on spaces and tabs only,
    // the same blank set as the leading-comment test above. `\s` here would
    // split on NBSP and friends, so a pattern containing one would tokenize
    // short and could land in the allowance below — the blank-set mismatch
    // surviving one statement past its own fix, and this one fails OPEN.
    // gitattributes patterns may be QUOTED to contain blanks — verified:
    // `"evil run.ts" binary` really does set binary on `evil run.ts`. Naive
    // tokenizing gives `"cover.png` for `"cover.png run.ts" binary`, whose
    // extension reads as inert, so the allowance would pass a .ts file. That
    // is the third variation of this same mismatch, and like the last it fails
    // OPEN. So the quoted form is PARSED rather than refused: refusing it would
    // fail the gate on `"my docs/logo.png" binary`, which is legitimate, and
    // this rule already learned that lesson with *.png.
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(stripped);
    const pattern = quoted ? (quoted[1] as string) : (stripped.split(/[ \t]+/)[0] ?? '');
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
    if (!pattern.includes('\\') && INERT_BINARY_EXTENSIONS.has(extensionOf(pattern))) return;
    for (const re of DIFF_SUPPRESSING_ATTRS) {
      if (!re.test(stripped)) continue;
      report(
        rel,
        i + 1,
        'diff-suppressing gitattribute',
        `"${stripped}" stops git or GitHub showing this path's content in a diff, so a payload ` +
          `in it reaches main without a reviewer ever seeing the lines`
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
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
  ])
    delete env[key];

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
    const topReal = realpathSync((top[0] ?? '').trim());
    if (topReal !== realpathSync(root)) return undefined;
  } catch {
    return undefined;
  }

  const tracked = run(['ls-files', '-z']);
  if (tracked === undefined) return undefined;
  // Untracked-but-not-ignored files can be `git add`ed into the next diff, so
  // they are in scope too. Ignored files are not.
  const untracked = run(['ls-files', '-z', '--others', '--exclude-standard']) ?? [];
  const abs = (list: string[]): string[] => list.map((rel) => join(root, rel));
  return { tracked: abs(tracked), untracked: abs(untracked.filter((f) => !tracked.includes(f))) };
}

function listFiles(root: string): string[] {
  const fromGit = gitFiles(root);
  if (fromGit === undefined) return walk(root, []);
  // SKIP_DIRS exists for UNREVIEWED LOCAL ARTIFACTS, so it applies to the
  // untracked half only. A tracked file is in a diff by definition, which is
  // this gate's entire threat model — excluding `build/loader.ts` because of
  // its directory name would turn a list of vendored-output names into a list
  // of places a payload may sit unwatched. A previous revision did exactly
  // that, in a PR arguing against that shape.
  return [...fromGit.tracked, ...fromGit.untracked.filter((f) => !underSkippedDir(root, f))];
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

const files = listFiles(ROOT).filter((f) => inScope(f));
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
  if (rel === 'package.json' || rel.endsWith(`${sep}package.json`)) {
    checkLifecycleScripts(contents, rel);
  }
  if (rel === '.gitattributes' || rel.endsWith(`${sep}.gitattributes`)) {
    checkGitAttributes(contents, rel);
  }
}

if (findings.length === 0) {
  console.log(`check-concealment: ${files.length} files scanned, nothing hidden`);
  process.exit(0);
}

console.error('check-concealment: found content engineered to be invisible in review.\n');
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
