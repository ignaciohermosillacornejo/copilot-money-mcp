#!/usr/bin/env bun
/**
 * Assert that docs/bugs/README.md agrees with the entry files it summarises.
 *
 * The README both COUNTS the corpus (the "across all N entries" claim, the
 * found-by chart, a count per class section) and ENUMERATES it (one index row
 * per entry). Nothing enforced either half, so it drifted silently twice: an
 * entry landed without a re-count (848-recurring-category-name-cold-cache.md)
 * and another was never indexed (661-non-completion-classified-as-drift.md),
 * both found by hand in #857. That is `doc-reality-drift` in the corpus's own
 * index.
 *
 * Every number here is derived from the entries' frontmatter (`class:` and
 * `detected:`), never pinned: a needle for a count alone would ratchet an
 * understatement in, the lesson scripts/check-tool-counts.ts records (#723).
 * Checks:
 *   1. the entry-file count equals the "across all N entries" claim;
 *   2. each found-by row's count equals its `detected:` tally, and every
 *      token in use has a row;
 *   3. each index class section's count equals its `class:` tally, and its
 *      rows are exactly that class's entries;
 *   4. every entry file is linked from exactly one index row, and every index
 *      row links an existing entry;
 *   5. every chart bar is count − 1 full blocks (`▌` for a count of 1);
 *   6. every `detected:` value is in TEMPLATE.md's vocabulary, and every
 *      `class:` value is defined in the README's class tables.
 *
 * Runs in CI as its own step, and under `bun run check` through its test
 * (tests/scripts/check-bug-corpus.test.ts runs it on the real tree): the
 * `check` chain itself is at check-concealment's line-length limit.
 */

import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_BUG_CORPUS_ROOT points the checker at a synthetic tree (tests), the
// same override pattern as CHECK_TOOL_COUNTS_ROOT.
const repoRoot = process.env.CHECK_BUG_CORPUS_ROOT ?? join(__dirname, '..');
const bugsDir = join(repoRoot, 'docs', 'bugs');

const problems: string[] = [];

// ── The entries ─────────────────────────────────────────────────────────────

interface Entry {
  file: string;
  cls: string | null;
  detected: string | null;
}

const NON_ENTRIES = new Set(['README.md', 'MINOR.md', 'TEMPLATE.md']);
const entries: Entry[] = readdirSync(bugsDir)
  .filter((f) => f.endsWith('.md') && !NON_ENTRIES.has(f))
  .sort()
  .map((file) => {
    const text = readFileSync(join(bugsDir, file), 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const cls = /^class:\s*([\w-]+)/m.exec(front)?.[1] ?? null;
    const detected = /^detected:\s*([\w-]+)/m.exec(front)?.[1] ?? null;
    if (cls === null) problems.push(`${file}: no \`class:\` in its frontmatter`);
    if (detected === null) problems.push(`${file}: no \`detected:\` in its frontmatter`);
    return { file, cls, detected };
  });

function tally(key: 'cls' | 'detected'): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const v = e[key];
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
const byClass = tally('cls');
const byDetected = tally('detected');

const readme = readFileSync(join(bugsDir, 'README.md'), 'utf8');
const template = readFileSync(join(bugsDir, 'TEMPLATE.md'), 'utf8');

// ── 6. Vocabularies ─────────────────────────────────────────────────────────

// TEMPLATE.md's `detected:` comment lists the tokens as `#   a | b | c` lines.
const templateFront = /^---\n([\s\S]*?)\n---/.exec(template)?.[1] ?? '';
const detectedVocab = new Set<string>();
for (const line of templateFront.split('\n')) {
  const m = /^#\s+([\w-]+(?:\s*\|\s*[\w-]+)+)\s*$/.exec(line);
  if (m) for (const t of m[1]!.split('|')) detectedVocab.add(t.trim());
}
if (detectedVocab.size === 0) problems.push('TEMPLATE.md: found no `detected:` vocabulary');

// The class definition tables under "## Bug classes": `| \`slug\` | … |` rows.
const classesSection = readme.split(/^## /m).find((s) => s.startsWith('Bug classes')) ?? '';
const classVocab = new Set([...classesSection.matchAll(/^\| `([\w-]+)` \|/gm)].map((m) => m[1]!));
if (classVocab.size === 0) problems.push('README.md: found no class definition rows');

for (const e of entries) {
  if (e.detected !== null && detectedVocab.size > 0 && !detectedVocab.has(e.detected)) {
    problems.push(`${e.file}: detected \`${e.detected}\` is not in TEMPLATE.md's vocabulary`);
  }
  if (e.cls !== null && classVocab.size > 0 && !classVocab.has(e.cls)) {
    problems.push(`${e.file}: class \`${e.cls}\` has no definition row in README.md`);
  }
}

// ── 1. The headline count ───────────────────────────────────────────────────

const claim = /across all (\d+) entries/.exec(readme);
if (!claim) problems.push('README.md: no "across all N entries" claim found');
else if (Number(claim[1]) !== entries.length) {
  problems.push(`README.md says ${claim[1]} entries; docs/bugs has ${entries.length} entry files`);
}

// ── 2 and 5. The found-by chart ─────────────────────────────────────────────

const chartRows = [
  ...readme.matchAll(
    /^\| (?:\*\*)?`([\w-]+)`(?:\*\*)?[^|]*\| (?:\*\*)?(\d+)(?:\*\*)? \| ([^|]*)\|$/gm
  ),
];
const charted = new Set<string>();
for (const m of chartRows) {
  const [, token, countText, barCell] = m as unknown as [string, string, string, string];
  charted.add(token);
  const count = Number(countText);
  const actual = byDetected.get(token) ?? 0;
  if (count !== actual) {
    problems.push(`found-by \`${token}\`: README says ${count}, entries say ${actual}`);
  }
  const bar = barCell.trim();
  const expectedBar = count === 0 ? '' : count === 1 ? '▌' : '█'.repeat(count - 1);
  if (bar !== expectedBar) {
    problems.push(
      `found-by \`${token}\`: bar is ${[...bar].length} glyph(s), expected ` +
        `${count <= 1 ? JSON.stringify(expectedBar) : `${count - 1} full blocks`} for ${count}`
    );
  }
}
if (chartRows.length === 0) problems.push('README.md: found no found-by chart rows');
for (const token of byDetected.keys()) {
  if (!charted.has(token))
    problems.push(`found-by \`${token}\` is used by entries but has no chart row`);
}

// ── 3 and 4. The index ──────────────────────────────────────────────────────

const indexSection = readme.split(/^## Index$/m)[1] ?? '';
if (indexSection === '') problems.push('README.md: no "## Index" section');
const linkedFrom = new Map<string, string[]>();
const sectioned = new Set<string>();
for (const part of indexSection.split(/^(?=\*\*`[\w-]+`\*\* — \d+$)/m)) {
  const head = /^\*\*`([\w-]+)`\*\* — (\d+)$/m.exec(part);
  if (!head) continue;
  const [, cls, countText] = head as unknown as [string, string, string];
  sectioned.add(cls);
  const rows = [...part.matchAll(/^\| #\d+ \| \[[^\]]*\]\(([^)]+\.md)\) \|/gm)].map((m) => m[1]!);
  const actual = byClass.get(cls) ?? 0;
  if (Number(countText) !== actual) {
    problems.push(`index \`${cls}\`: heading says ${countText}, entries say ${actual}`);
  }
  if (rows.length !== Number(countText)) {
    problems.push(
      `index \`${cls}\`: heading says ${countText} but the section has ${rows.length} row(s)`
    );
  }
  for (const file of rows) {
    linkedFrom.set(file, [...(linkedFrom.get(file) ?? []), cls]);
    const entry = entries.find((e) => e.file === file);
    if (!entry) problems.push(`index \`${cls}\`: links ${file}, which is not an entry file`);
    else if (entry.cls !== cls) {
      problems.push(`index \`${cls}\`: lists ${file}, whose class is \`${entry.cls ?? '(none)'}\``);
    }
  }
}
for (const e of entries) {
  const where = linkedFrom.get(e.file) ?? [];
  if (where.length === 0) problems.push(`${e.file} has no index row`);
  if (where.length > 1)
    problems.push(`${e.file} has ${where.length} index rows (${where.join(', ')})`);
}
for (const cls of byClass.keys()) {
  if (!sectioned.has(cls))
    problems.push(`class \`${cls}\` is used by entries but has no index section`);
}

// ── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('Bug corpus check failed (docs/bugs/README.md vs the entry files):');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\nDerived from frontmatter: ${entries.length} entries; ` +
      `${byDetected.size} found-by tokens; ${byClass.size} classes. ` +
      'Update README.md to match the entries.'
  );
  process.exit(1);
}

console.log(
  `Bug corpus in sync: ${entries.length} entries, ${byDetected.size} found-by tokens, ` +
    `${byClass.size} classes, every entry indexed once.`
);
