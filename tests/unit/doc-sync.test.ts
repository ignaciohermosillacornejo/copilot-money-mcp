/**
 * Doc-sync gates: assert that the tool counts stated in CLAUDE.md,
 * CONTRIBUTING.md, and README.md match the code.
 *
 * Counting convention (documented in CLAUDE.md):
 *   - "base" tools = cache-mode read tools (`createToolSchemas()`) plus
 *     write tools (`createWriteToolSchemas()`).
 *   - Live-mode tools are counted separately. `--live-reads` removes some
 *     cache reads and adds GraphQL-backed live tools; both numbers are
 *     derived here from `CopilotMoneyServer.handleListTools()` rather than
 *     hardcoded, so the gate stays correct as tools are added or removed.
 *
 * Same pattern as tests/unit/manifest-sync.test.ts: if a doc count rots,
 * this test fails in CI with a message pointing at the stale file.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createToolSchemas, createWriteToolSchemas } from '../../src/tools/tools.js';
import { CopilotMoneyServer } from '../../src/server.js';

const repoRoot = join(import.meta.dir, '../..');
const claudeMd = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8');
const contributingMd = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf-8');
const readmeMd = readFileSync(join(repoRoot, 'README.md'), 'utf-8');

// --- Counts derived from code (never hardcoded) ---

const readCount = createToolSchemas().length;
const writeCount = createWriteToolSchemas().length;
const baseCount = readCount + writeCount;

// Live-mode counts come from the server's own tool-list assembly so the
// gate tracks src/server.ts (which wires in src/tools/live/*.ts) exactly.
const cacheModeNames = new Set(
  new CopilotMoneyServer('/nonexistent/doc-sync').handleListTools().tools.map((t) => t.name)
);
const liveModeNames = new CopilotMoneyServer('/nonexistent/doc-sync', undefined, false, true)
  .handleListTools()
  .tools.map((t) => t.name);

const liveModeReadCount = liveModeNames.length;
const survivingCacheCount = liveModeNames.filter((n) => cacheModeNames.has(n)).length;
const liveToolCount = liveModeReadCount - survivingCacheCount;
const swappedCacheCount = readCount - survivingCacheCount;

function allMatches(content: string, regex: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    out.push(m);
  }
  return out;
}

describe('Doc-sync: tool counts match code', () => {
  test('sanity: derived counts are coherent', () => {
    expect(readCount).toBeGreaterThan(0);
    expect(writeCount).toBeGreaterThan(0);
    expect(liveToolCount).toBeGreaterThan(0);
    expect(survivingCacheCount + liveToolCount).toBe(liveModeReadCount);
  });

  // Pinned phrase: "N base tools (R read + W write)"
  test.each([
    ['CLAUDE.md', claudeMd, 2],
    ['CONTRIBUTING.md', contributingMd, 3],
  ])('%s: every "base tools" phrase matches code counts', (file, content, minOccurrences) => {
    const matches = allMatches(content, /(\d+) base tools \((\d+) read \+ (\d+) write\)/g);
    expect(matches.length).toBeGreaterThanOrEqual(minOccurrences);
    for (const m of matches) {
      expect(
        { file, phrase: m[0], total: Number(m[1]), read: Number(m[2]), write: Number(m[3]) },
        `${file} says "${m[0]}" but code has ${baseCount} base tools (${readCount} read + ${writeCount} write)`
      ).toEqual({
        file,
        phrase: m[0],
        total: baseCount,
        read: readCount,
        write: writeCount,
      });
    }
  });

  // Catch reintroduced stale "(X read + Y write)" anywhere, even without
  // the "base tools" wording.
  test.each([
    ['CLAUDE.md', claudeMd],
    ['CONTRIBUTING.md', contributingMd],
  ])('%s: every "(X read + Y write)" matches code counts', (file, content) => {
    const matches = allMatches(content, /\((\d+) read \+ (\d+) write\)/g);
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(Number(m[1]), `${file}: "${m[0]}" read count != ${readCount}`).toBe(readCount);
      expect(Number(m[2]), `${file}: "${m[0]}" write count != ${writeCount}`).toBe(writeCount);
    }
  });

  test('CLAUDE.md: live-mode counts in the headline match code', () => {
    const m = claudeMd.match(
      /swaps (\d+) cache reads for (\d+) live tools \((\d+) read tools in live mode\)/
    );
    expect(m, 'CLAUDE.md is missing the pinned live-mode phrase').not.toBeNull();
    expect(Number(m![1]), 'swapped cache reads').toBe(swappedCacheCount);
    expect(Number(m![2]), 'live tool count').toBe(liveToolCount);
    expect(Number(m![3]), 'live-mode read tool total').toBe(liveModeReadCount);
  });

  test('README.md: headline tool counts match code', () => {
    const m = readmeMd.match(
      /(\d+) cache-mode read tools \(or (\d+) in `--live-reads` mode: (\d+) surviving cache \+ (\d+) live\), plus up to (\d+) write tools/
    );
    expect(m, 'README.md is missing the pinned headline phrase').not.toBeNull();
    expect(Number(m![1]), 'cache-mode read count').toBe(readCount);
    expect(Number(m![2]), 'live-mode read total').toBe(liveModeReadCount);
    expect(Number(m![3]), 'surviving cache count').toBe(survivingCacheCount);
    expect(Number(m![4]), 'live tool count').toBe(liveToolCount);
    expect(Number(m![5]), 'write tool count').toBe(writeCount);
  });

  test('docs do not reference the nonexistent tests/fixtures/synthetic-db path', () => {
    expect(claudeMd).not.toInclude('fixtures/synthetic-db');
    expect(contributingMd).not.toInclude('fixtures/synthetic-db');
    expect(readmeMd).not.toInclude('fixtures/synthetic-db');
  });
});
