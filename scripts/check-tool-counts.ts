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

expectSubstring(
  'docs/graphql-live-reads.md',
  `${live} \`_live\` tools ship today`,
  'live tool count',
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
