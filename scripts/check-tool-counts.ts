#!/usr/bin/env bun
/**
 * Assert that every doc-facing tool count matches the registry.
 *
 * The registry (`src/tools/registry/index.ts`) is the single source of truth
 * for tool counts, but several human-written surfaces (package.json's npm
 * description, README.md, CLAUDE.md, docs/index.html, docs/graphql-live-reads.md)
 * restate those counts in prose. Nothing enforced agreement, so a registry
 * change (or a copy edit that "helpfully" rewords a count) went stale twice in
 * a row (commits 49f267d and 1038ec7 shipped two different wrong splits of
 * the same description string before b22bacc caught the other two files).
 * Run as part of `bun run check`.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { READ_TOOL_DEFS, LIVE_TOOL_DEFS, WRITE_TOOL_DEFS } from '../src/tools/registry/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_TOOL_COUNTS_ROOT lets tests point the checker at a synthetic doc tree
// (same pattern as CHECK_SKILLS_REPO_ROOT in scripts/check-skills.py). Counts
// always come from the real registry import above.
const repoRoot = process.env.CHECK_TOOL_COUNTS_ROOT ?? join(__dirname, '..');
const root = (p: string) => join(repoRoot, p);

const read = READ_TOOL_DEFS.length;
const live = LIVE_TOOL_DEFS.length;
const write = WRITE_TOOL_DEFS.length;
const swapped = READ_TOOL_DEFS.filter((t) => t.swappedOutInLiveMode).length;
const survivingCache = read - swapped;
const liveModeTotal = survivingCache + live;
const baseTotal = read + write;
// Largest surface a user can actually be served: --write forcibly enables
// --live-reads (src/cli.ts), so write mode is live-mode reads + write tools.
const writeModeTotal = liveModeTotal + write;
const allTotal = read + live + write;

const mismatches: string[] = [];

function expectSubstring(file: string, needle: string, label: string): void {
  let content: string;
  try {
    content = readFileSync(root(file), 'utf-8');
  } catch {
    mismatches.push(`${file}: could not read file (checking "${label}")`);
    return;
  }
  if (!content.includes(needle)) {
    mismatches.push(`${file}: missing expected "${label}" text: ${JSON.stringify(needle)}`);
  }
}

/**
 * Assert that a Markdown table names exactly the given set of tools.
 *
 * A count needle on its own only proves a doc is self-consistent, which is
 * precisely how docs/EXAMPLE_QUERIES.md went stale: "12 tools" over a table of
 * 12, while default mode listed 14 (#723). Set equality is what makes the
 * surface complete rather than merely consistent, so adding a tool to the
 * registry fails here until the table gains a row.
 *
 * The section runs from `heading` to the next horizontal rule; tool names are
 * the backticked identifiers inside it. Duplicate rows are fine — one tool can
 * answer several questions — so the comparison is over the distinct set.
 */
function expectToolTable(
  file: string,
  heading: string,
  expected: string[],
  label: string,
): void {
  let content: string;
  try {
    content = readFileSync(root(file), 'utf-8');
  } catch {
    mismatches.push(`${file}: could not read file (checking "${label}")`);
    return;
  }
  const start = content.indexOf(heading);
  if (start === -1) {
    mismatches.push(`${file}: no "${heading}" section to check "${label}" against`);
    return;
  }
  const rest = content.slice(start + heading.length);
  const end = rest.search(/^---$/m);
  const section = end === -1 ? rest : rest.slice(0, end);

  const named = new Set<string>();
  for (const m of section.matchAll(/`([a-z_]+)`/g)) named.add(m[1]);

  const want = new Set(expected);
  const missing = [...want].filter((t) => !named.has(t)).sort();
  const extra = [...named].filter((t) => !want.has(t)).sort();
  if (missing.length > 0) {
    mismatches.push(`${file}: "${label}" omits ${missing.length} tool(s): ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    mismatches.push(`${file}: "${label}" names ${extra.length} unknown tool(s): ${extra.join(', ')}`);
  }
}

expectSubstring(
  'package.json',
  `(${read} cache-mode read tools)`,
  'cache-mode read tool count',
);
expectSubstring(
  'package.json',
  `(${liveModeTotal} read tools: ${survivingCache} cache + ${live} live)`,
  'live-mode read tool breakdown',
);
expectSubstring(
  'package.json',
  `(${write} write tools, opt-in with --write)`,
  'write tool count',
);

expectSubstring(
  'README.md',
  `**${read} cache-mode read tools (or ${liveModeTotal} in \`--live-reads\` mode: ${survivingCache} surviving cache + ${live} live), plus up to ${write} write tools**`,
  'headline tool counts',
);
expectSubstring(
  'README.md',
  `${read} cache-mode read + utility tools`,
  'default mode row',
);
expectSubstring(
  'README.md',
  `${liveModeTotal} read tools (${survivingCache} cache + ${live} live)`,
  'live-reads mode row',
);
expectSubstring(
  'README.md',
  `+${write} write tools, on top of the ${liveModeTotal} live read tools`,
  'write mode row',
);
expectSubstring(
  'README.md',
  `Replaces ${swapped} cache-mode read tools`,
  'swapped-tool count',
);

expectSubstring(
  'CLAUDE.md',
  `${baseTotal} base tools (${read} read + ${write} write)`,
  'base tool count',
);
expectSubstring(
  'CLAUDE.md',
  `\`--live-reads\` swaps ${swapped} cache reads for ${live} live tools (${liveModeTotal} read tools in live mode)`,
  'live-reads summary',
);
expectSubstring(
  'CLAUDE.md',
  `The ${live} live-mode tools live in`,
  'live tool count in Key Files',
);
expectSubstring(
  'CLAUDE.md',
  `swaps ${swapped} cache-backed reads`,
  'live-reads swap count',
);
expectSubstring(
  'CLAUDE.md',
  `— ${live} live tools total`,
  'live tools total callout',
);

// The landing page states per-mode counts, not the total definition count —
// no mode ever lists every definition, so that total was unobservable (#610).
expectSubstring(
  'docs/index.html',
  `${read} read tools locally, up to ${writeModeTotal} with writes enabled`,
  'meta description tool count',
);
expectSubstring(
  'docs/index.html',
  `${read} read tools by default, ${liveModeTotal} with --live-reads, and ${writeModeTotal} with writes enabled`,
  'features subtitle tool count',
);
// The hero stat tile was the third hardcoded count in this file, and the only
// one no needle covered — it read "17 AI Tools", which is LIVE_TOOL_DEFS.length
// and therefore a count no mode ever lists. Guarded now so it can't drift back.
expectSubstring(
  'docs/index.html',
  `<div class="num">${read}</div><div class="label">Local Read Tools</div>`,
  'hero stat tile tool count',
);

expectSubstring(
  'docs/graphql-live-reads.md',
  `${live} \`_live\` tools ship today`,
  'live tool count',
);

// CONTRIBUTING.md restated the same three counts CLAUDE.md does, in the same
// shape, with no needle behind any of them (#723). Correct at the time, but
// "correct today" is what every stale count used to be.
expectSubstring(
  'CONTRIBUTING.md',
  `advertises all ${baseTotal} base tools (${read} read + ${write} write)`,
  'writes-enabled bundle tool count',
);
expectSubstring(
  'CONTRIBUTING.md',
  `implements the ${baseTotal} base tools (${read} read + ${write} write); \`src/tools/live/\` adds ${live} GraphQL-backed live read tools`,
  'data-flow tool counts',
);
expectSubstring(
  'CONTRIBUTING.md',
  `All ${baseTotal} base tools (${read} read + ${write} write) as async methods`,
  'Key Files tool count',
);

// docs/EXAMPLE_QUERIES.md is the one surface where a needle alone would have
// ratcheted in a falsehood: the count there agreed with the table under it, and
// the table was missing two default-mode tools (#723). So the count is asserted
// AND the table is required to name every tool default mode lists — otherwise
// the cheapest way to pass is to edit one digit and leave the table short.
expectSubstring(
  'docs/EXAMPLE_QUERIES.md',
  `Claude uses these ${read} tools automatically`,
  'default-mode tool count',
);
expectToolTable(
  'docs/EXAMPLE_QUERIES.md',
  '## Tool Reference (Behind the Scenes)',
  READ_TOOL_DEFS.map((t) => t.schema.name),
  'default-mode tool reference table',
);

if (mismatches.length > 0) {
  console.error('Tool count check failed:');
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error(
    `\nDerived from the registry: ${read} read, ${live} live, ${write} write, ` +
      `${swapped} swapped out in live mode (${survivingCache} surviving cache + ${live} live = ${liveModeTotal} in live mode; ` +
      `${baseTotal} base tools total).\n` +
      'Update the doc text above to match, or update this script if the wording legitimately changed.',
  );
  process.exit(1);
}

console.log(
  `Tool counts in sync: ${read} read, ${live} live, ${write} write ` +
    `(${liveModeTotal} in live mode, ${baseTotal} base tools, ${allTotal} total definitions).`,
);
