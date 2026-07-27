/**
 * Behavioural tests for scripts/check-skills.py — the `bun run check:skills`
 * linter that validates skills/*\/SKILL.md against the real tool definitions.
 *
 * Regression context: the linter collected tool names by scraping `name: '...'`
 * literals out of a hardcoded src/tools/tools.ts. When the schemas moved to
 * src/tools/registry/*.ts the parse collapsed to one incidental literal, and
 * because a near-empty result was treated as a valid answer the linter reported
 * every tool reference in every skill as unknown — 38 false failures that read
 * as skill bugs rather than one linter bug.
 *
 * The fix removes the failure mode instead of guarding it: tool names now come
 * from scripts/dump-tool-names.ts, which imports the same ALL_TOOL_DEFS the
 * server dispatches from. So the tests below cover the two things that still
 * matter — every way the lookup can fail must be reported as a linter fault and
 * validate nothing, and the lookup must cover write and live tools, not just
 * the 14 cache-mode reads manifest.json knows about.
 *
 * Synthetic repo trees are driven through the CHECK_SKILLS_REPO_ROOT override.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-skills.py', import.meta.url));
const REAL_REPO = fileURLToPath(new URL('../..', import.meta.url));

async function runLinter(
  repoRoot: string
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['python3', SCRIPT], {
    env: { ...process.env, CHECK_SKILLS_REPO_ROOT: repoRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

const SKILL_BODY = `---
name: demo
description: A demo skill.
---

Call \`get_transactions\` and then \`update_transaction\`.
`;

/**
 * Build a minimal repo tree. `dumpBody` is the entire body of the synthetic
 * scripts/dump-tool-names.ts — varying it simulates the tool lookup succeeding,
 * failing, or answering degenerately, without needing the real registry.
 */
async function makeRepo(opts: { dumpBody?: string; skill?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'check-skills-'));
  if (opts.dumpBody !== undefined) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'dump-tool-names.ts'), opts.dumpBody);
  }
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), opts.skill ?? SKILL_BODY);
  return root;
}

const WORKING_DUMP = `console.log(JSON.stringify(['get_transactions', 'update_transaction']));`;

async function withRepo(
  opts: { dumpBody?: string; skill?: string },
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const root = await makeRepo(opts);
  try {
    assertions(await runLinter(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('tool-lookup gate (class-level detector)', () => {
  // Each case is a different way the lookup can go wrong. The invariant is the
  // same every time: report the linter, validate nothing, blame no skill.
  const cases: Array<{ name: string; dumpBody?: string }> = [
    { name: 'the dump script is missing entirely', dumpBody: undefined },
    {
      name: 'the dump script exits non-zero',
      dumpBody: `console.error('registry blew up'); process.exit(1);`,
    },
    {
      name: 'the dump script prints something that is not JSON',
      dumpBody: `console.log('not json at all');`,
    },
    {
      name: 'the dump script prints JSON of the wrong shape',
      dumpBody: `console.log(JSON.stringify({ tools: ['get_transactions'] }));`,
    },
    {
      // The historical shape: a lookup that "works" but answers with nothing.
      name: 'the dump script returns an empty list',
      dumpBody: `console.log(JSON.stringify([]));`,
    },
  ];

  for (const { name, dumpBody } of cases) {
    test(`fails as a linter fault when ${name}`, async () => {
      await withRepo({ dumpBody }, ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('linter self-check');
        expect(stderr).toContain('Skill references were NOT validated');
        // The whole point: it must NOT blame the skills.
        expect(stderr).not.toContain('references unknown MCP tool');
      });
    });
  }

  test('reports the failure cleanly rather than as a traceback', async () => {
    await withRepo({ dumpBody: `console.log('not json at all');` }, ({ stderr }) => {
      expect(stderr).toContain('FAIL:');
      expect(stderr).not.toContain('Traceback (most recent call last)');
    });
  });
});

describe('skill validation', () => {
  test('passes when every referenced tool is in the registry', async () => {
    await withRepo({ dumpBody: WORKING_DUMP }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('1 skills validated');
    });
  });

  test('still rejects a skill referencing a genuinely nonexistent tool', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: `---
name: demo
description: A demo skill.
---

Call \`get_transactions\` and then \`delete_everything\`.
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('references unknown MCP tool `delete_everything`');
      }
    );
  });
});

describe('registry coverage', () => {
  // manifest.json declares only the 14 cache-mode reads, so a manifest-based
  // lookup silently omitted all 17 write tools — including the 9 the skills
  // lean on hardest. Assert the lookup spans every family the registry has.
  test('the dump covers read, write and live tools', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/dump-tool-names.ts'], {
      cwd: REAL_REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const names: string[] = JSON.parse(stdout);
    const registry = ALL_TOOL_DEFS.map((def) => def.name);

    expect(names.sort()).toEqual([...registry].sort());
    expect(names).toContain('get_transactions'); // cache read
    expect(names).toContain('update_transaction'); // write
    expect(names).toContain('get_transactions_live'); // live
  });
});

describe('the real repository', () => {
  test('check:skills passes against the checked-in skills and tools', async () => {
    const { code, stdout, stderr } = await runLinter(REAL_REPO);
    // Not toBe('') — an unrelated python deprecation warning on stderr should
    // not turn this red.
    expect(stderr).not.toContain('FAIL');
    expect(code).toBe(0);
    expect(stdout).toContain('skills validated');
  });
});
