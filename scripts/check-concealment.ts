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

import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_CONCEALMENT_ROOT lets tests point the gate at a synthetic tree, the
// same pattern as CHECK_PRIVACY_ENDPOINTS_ROOT and CHECK_TOOL_COUNTS_ROOT.
const ROOT = process.env.CHECK_CONCEALMENT_ROOT ?? join(__dirname, '..');

/** A run of this many spaces or tabs mid-line is the concealment gap. */
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

/** Executed or interpreted at some point: install, build, test, CI, or runtime. */
const SCOPED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yml', '.yaml', '.toml',
  '.sh', '.bash', '.zsh', '.py',
]);

/** Generated, enormous, and not human-reviewed; a different gate covers them. */
const SKIP_FILES = new Set(['package-lock.json', 'bun.lock', 'bun.lockb', 'yarn.lock']);

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
 * the published package, including consumers. Nothing in this repo needs one, so
 * they are refused outright rather than allow-listed — an allowlist entry here is
 * indistinguishable from the attack.
 *
 * `prepare` / `prepublish*` run on contributor and publisher machines. Those are
 * still execution vectors (a contributor's `bun install` runs `prepare`), so each
 * is pinned to its exact reviewed value: changing what runs at install time means
 * changing this file, in the same PR, where a reviewer will see it.
 */
const FORBIDDEN_LIFECYCLE = ['preinstall', 'install', 'postinstall'];
const PINNED_LIFECYCLE: Record<string, string> = {
  prepare: 'husky',
  prepublishOnly: 'bun run clean && bun run build && bun test',
};
const PINNED_NAMES = ['prepare', 'prepublish', 'prepublishOnly'];

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

const WHITESPACE_RUN_RE = new RegExp(`\\S[ \\t]{${WHITESPACE_RUN},}\\S`);

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
  if (SKIP_FILES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && SCOPED_EXTENSIONS.has(name.slice(dot));
}

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(p, out);
    else if (inScope(p)) out.push(p);
  }
  return out;
}

/**
 * A zero-width joiner between two symbols is an emoji sequence and is fine; the
 * same character between ASCII is a hidden character in an identifier. Every
 * other formatting character is flagged wherever it appears.
 */
function invisibleIsBenign(cp: number, prev: number | undefined, next: number | undefined): boolean {
  if (cp !== 0x200d) return false;
  return prev !== undefined && next !== undefined && prev >= 0x2000 && next >= 0x2000;
}

function checkLine(rel: string, lineNo: number, line: string, exempt: boolean): void {
  if (line.length > CONCEALED_LINE && WHITESPACE_RUN_RE.test(line)) {
    report(
      rel,
      lineNo,
      'whitespace run',
      `${WHITESPACE_RUN}+ spaces or tabs mid-line on a ${line.length}-column line — ` +
        `the tail is off-screen in a diff`
    );
  }

  if (line.length > MAX_LINE && !GENERATED_RE.test(rel)) {
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

  if (exempt) return;
  for (const [re, label] of DYNAMIC_EXEC) {
    if (re.test(line)) report(rel, lineNo, 'dynamic execution', label);
  }
}

function checkLifecycleScripts(pkgPath: string, rel: string): void {
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
  } catch {
    return; // Malformed package.json is a different gate's problem.
  }
  const scripts = parsed.scripts ?? {};
  const raw = readFileSync(pkgPath, 'utf-8').split('\n');
  const lineOf = (hook: string): number => {
    const idx = raw.findIndex((l) => l.includes(`"${hook}"`));
    return idx >= 0 ? idx + 1 : 1;
  };

  for (const hook of FORBIDDEN_LIFECYCLE) {
    const value = scripts[hook];
    if (value === undefined) continue;
    report(
      rel,
      lineOf(hook),
      'install-time script',
      `"${hook}": ${JSON.stringify(value)} runs on every machine that installs this ` +
        `package, consumers included, before anyone reads the code`
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

const files = walk(ROOT, []);
for (const file of files) {
  const rel = relative(ROOT, file);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  if (contents.includes(NUL)) continue; // binary

  const exempt = SELF_EXEMPT.has(rel);
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) checkLine(rel, i + 1, lines[i], exempt);

  if (rel === 'package.json') checkLifecycleScripts(file, rel);
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
