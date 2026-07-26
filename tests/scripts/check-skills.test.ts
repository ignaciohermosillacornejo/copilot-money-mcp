/**
 * Behavioural tests for scripts/check-skills.py — the `bun run check:skills`
 * linter that validates skills/*\/SKILL.md against the real tool definitions.
 *
 * Regression context: the linter collected tool names from a hardcoded
 * src/tools/tools.ts. When the tool schemas moved to src/tools/registry/*.ts
 * the parser went blind, and because an empty-ish result was treated as a
 * valid answer it reported every tool reference in every skill as unknown —
 * 38 false failures that read as skill bugs rather than one linter bug.
 *
 * The class-level gate is `check_parser_health`: manifest.json independently
 * declares the shipped tools, so anything it names must be visible to the
 * parser. These tests drive the script against synthetic repo trees via the
 * CHECK_SKILLS_REPO_ROOT override.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Build a minimal repo tree. `toolsPath` is where the tool definitions get
 * written, relative to the repo root — varying it simulates the schemas
 * living in (or moving out of) src/tools/.
 */
async function makeRepo(opts: {
  toolsPath: string;
  manifestTools: string[];
  definedTools: string[];
  skill?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'check-skills-'));
  const toolsFile = join(root, opts.toolsPath);
  await mkdir(join(toolsFile, '..'), { recursive: true });
  await writeFile(
    toolsFile,
    opts.definedTools.map((n) => `  { name: '${n}', description: 'x' },`).join('\n')
  );
  // src/tools/ must exist even when the definitions were moved away, so the
  // run reaches the parser-health gate rather than the missing-dir guard.
  await mkdir(join(root, 'src', 'tools'), { recursive: true });
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({ tools: opts.manifestTools.map((n) => ({ name: n, description: 'x' })) })
  );
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), opts.skill ?? SKILL_BODY);
  return root;
}

describe('parser health gate (class-level detector)', () => {
  test('fails loudly when tool definitions move out of src/tools/', async () => {
    const root = await makeRepo({
      toolsPath: 'src/elsewhere/tools.ts',
      manifestTools: ['get_transactions', 'update_transaction'],
      definedTools: ['get_transactions', 'update_transaction'],
    });
    try {
      const { code, stderr } = await runLinter(root);
      expect(code).toBe(1);
      expect(stderr).toContain('linter self-check');
      // The whole point: it must NOT blame the skills.
      expect(stderr).not.toContain('references unknown MCP tool');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a near-empty parse does not slip through as a valid answer', async () => {
    // The historical failure shape: tools.ts still parses to one incidental
    // `name:` literal, so an emptiness-only guard passes and the run proceeds.
    const root = await makeRepo({
      toolsPath: 'src/tools/tools.ts',
      manifestTools: ['get_transactions', 'update_transaction'],
      definedTools: ['name'],
    });
    try {
      const { code, stderr } = await runLinter(root);
      expect(code).toBe(1);
      expect(stderr).toContain('linter self-check');
      expect(stderr).not.toContain('references unknown MCP tool');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('names the missing tools so the failure is actionable', async () => {
    const root = await makeRepo({
      toolsPath: 'src/tools/tools.ts',
      manifestTools: ['get_transactions'],
      definedTools: ['name'],
    });
    try {
      const { stderr } = await runLinter(root);
      expect(stderr).toContain('get_transactions');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('tool discovery', () => {
  test('finds definitions in nested subdirectories of src/tools/', async () => {
    const root = await makeRepo({
      toolsPath: 'src/tools/registry/transactions.ts',
      manifestTools: ['get_transactions', 'update_transaction'],
      definedTools: ['get_transactions', 'update_transaction'],
    });
    try {
      const { code, stdout } = await runLinter(root);
      expect(code).toBe(0);
      expect(stdout).toContain('1 skills validated');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('still rejects a skill referencing a genuinely nonexistent tool', async () => {
    const root = await makeRepo({
      toolsPath: 'src/tools/registry/transactions.ts',
      manifestTools: ['get_transactions'],
      definedTools: ['get_transactions'],
      skill: `---
name: demo
description: A demo skill.
---

Call \`get_transactions\` and then \`delete_everything\`.
`,
    });
    try {
      const { code, stderr } = await runLinter(root);
      expect(code).toBe(1);
      expect(stderr).toContain('references unknown MCP tool `delete_everything`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the real repository', () => {
  test('check:skills passes against the checked-in skills and tools', async () => {
    const { code, stdout, stderr } = await runLinter(REAL_REPO);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('skills validated');
  });
});
