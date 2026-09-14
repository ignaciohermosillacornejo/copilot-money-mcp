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

// Resolved once, so a test can strip PATH without also losing the interpreter.
const PYTHON = Bun.which('python3') ?? 'python3';

async function runLinter(
  repoRoot: string,
  envOverrides: Record<string, string> = {}
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn([PYTHON, SCRIPT], {
    env: { ...process.env, CHECK_SKILLS_REPO_ROOT: repoRoot, ...envOverrides },
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
 * The source files check 4 (#704) reads to work out what each tool returns by
 * default. Kept minimal but SHAPED like the real thing — the terse-default
 * discovery resolves a preset through the same three hops it uses in the real
 * repo: `preset:` inside a method, the method wired to a tool name in
 * registry/, and the `fields ?? ['default']` fallback that makes the preset
 * the default rather than an opt-in.
 */
const SOURCE_TREE: Record<string, string> = {
  'src/tools/field-selection.ts': `export const DEFAULT_TRANSACTION_FIELDS = [
  'transaction_id',
  'date',
  'amount',
] as const;
`,
  'src/tools/tools.ts': `export class CopilotMoneyTools {
  async getTransactions(options: { fields?: string[] }) {
    return projectRows([], options.fields ?? ['default'], {
      preset: DEFAULT_TRANSACTION_FIELDS,
    });
  }
}
`,
  'src/tools/registry/transactions.ts': `export const getTransactionsTool = defineTool({
  schema: { name: 'get_transactions' },
  handler: (ctx, args) => ctx.tools.getTransactions(args),
});
`,
  'src/models/transaction.ts': `export const TransactionSchema = z.object({
  transaction_id: z.string(),
  date: z.string(),
  amount: z.number(),
  tag_ids: z.array(z.string()),
});
`,
};

/**
 * Build a minimal repo tree. `dumpBody` is the entire body of the synthetic
 * scripts/dump-tool-names.ts — varying it simulates the tool lookup succeeding,
 * failing, or answering degenerately, without needing the real registry.
 * `sourceFiles` overrides SOURCE_TREE entry by entry; a `null` value omits
 * that file, which is how the check-4 discovery failures are provoked.
 */
async function makeRepo(opts: {
  dumpBody?: string;
  argsBody?: string;
  skill?: string;
  sourceFiles?: Record<string, string | null>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'check-skills-'));
  if (opts.dumpBody !== undefined) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'dump-tool-names.ts'), opts.dumpBody);
    await writeFile(join(root, 'scripts', 'dump-tool-args.ts'), opts.argsBody ?? WORKING_ARGS_DUMP);
  }
  for (const [path, body] of Object.entries({ ...SOURCE_TREE, ...opts.sourceFiles })) {
    if (body === null) continue;
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), body);
  }
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), opts.skill ?? SKILL_BODY);
  return root;
}

const WORKING_DUMP = `console.log(JSON.stringify(['get_transactions', 'update_transaction']));`;
const WORKING_ARGS_DUMP = `console.log(JSON.stringify({ get_transactions: ['fields', 'period'], update_transaction: ['transaction_id'] }));`;

async function withRepo(
  opts: {
    dumpBody?: string;
    argsBody?: string;
    skill?: string;
    sourceFiles?: Record<string, string | null>;
    env?: Record<string, string>;
  },
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const root = await makeRepo(opts);
  try {
    assertions(await runLinter(root, opts.env));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function skillWith(body: string): string {
  return `---
name: demo
description: A demo skill.
---

${body}
`;
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

  // The one lookup failure the table above cannot express: it is about the
  // environment, not the dump script's output, so the dump here is a good one.
  test('fails as a linter fault when bun is not on PATH', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'check-skills-nobun-'));
    try {
      // PATH points at an empty directory so shutil.which('bun') finds nothing.
      // python3 is spawned by absolute path, so stripping PATH cannot break the
      // run itself — the linter reaches the lookup and fails there.
      await withRepo({ dumpBody: WORKING_DUMP, env: { PATH: emptyDir } }, ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('linter self-check');
        expect(stderr).toContain('bun is not on PATH');
        expect(stderr).toContain('Skill references were NOT validated');
        expect(stderr).not.toContain('references unknown MCP tool');
      });
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

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

  test('documented tool PARAMETERS are not mistaken for tools', async () => {
    // `add_tag_ids` / `remove_tag_ids` are parameters of bulk_edit_transactions,
    // but they match the "add_"/"remove_"-style tool prefixes the scan uses.
    // Before KNOWN_TOOL_PARAMS, documenting them in backticks reported a
    // nonexistent tool — a linter fault that reads as a skill bug.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: `---
name: demo
description: A demo skill.
---

Call \`get_transactions\`, then tag via \`add_tag_ids\` and untag via \`remove_tag_ids\`.
`,
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 skills validated');
      }
    );
  });
});

/**
 * Check 4 (#704): a skill that tells its agent to read a field the tool's
 * `"default"` preset no longer returns is not an error anywhere — the row just
 * arrives without the key — so it fails silently at use time. PR #703 shipped
 * three such instructions and hand-auditing missed all three.
 *
 * Both directions are covered on purpose: a guard that rejects everything is
 * as useless as one that accepts everything, and the four "stays quiet" cases
 * below are what stop this check from being disabled the first week it ships.
 */
describe('terse-default field references (#704)', () => {
  test('reports a field the default row no longer carries', async () => {
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Use `get_transactions`, then read `tag_ids`.') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('`tag_ids` is a row field');
        expect(stderr).toContain('get_transactions does not return it by default');
        // The message must carry the remedy, not just the complaint.
        expect(stderr).toContain('fields: ["default", "tag_ids"]');
      }
    );
  });

  test('stays quiet when the same instruction passes an explicit fields: argument', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith(
          'Use `get_transactions` with `fields: ["default", "tag_ids"]`, then read `tag_ids`.'
        ),
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 terse-by-default tools cross-checked');
      }
    );
  });

  test('stays quiet on preset fields and on documented parameters', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith('Use `get_transactions` with `period`; sum `amount` per `date`.'),
      },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('stays quiet on backticked prose that names no field at all', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith('Pipe the `get_transactions` response through `jq`.'),
      },
      ({ code }) => expect(code).toBe(0)
    );
  });

  test("a name that is another tool's PARAMETER is still a field here", async () => {
    // The check skipped any token that was an argument of ANY tool in the
    // repo, so a name with two jobs was invisible: `tag_ids` is a parameter of
    // update_transaction AND a transaction row field the v3 diet dropped. A
    // skill told to read it off `get_transactions` sailed through. Parameters
    // now only excuse a token on a line that names the tool they belong to.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        argsBody: `console.log(JSON.stringify({ get_transactions: ['fields'], update_transaction: ['tag_ids'] }));`,
        skill: skillWith('Read `tag_ids` off each `get_transactions` row.'),
      },
      ({ code, stdout, stderr }) => {
        expect(code).toBe(1);
        expect(stdout + stderr).toContain('`tag_ids` is a row field');
      }
    );
  });

  test('...but a parameter of a tool NAMED ON THE LINE is still excused', async () => {
    // The narrowing must not start flagging real parameters. Same token, same
    // skill line, except the tool it belongs to is the one being called.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        argsBody: `console.log(JSON.stringify({ get_transactions: ['fields', 'tag_ids'], update_transaction: ['transaction_id'] }));`,
        skill: skillWith('Call `get_transactions` with `tag_ids`.'),
      },
      ({ code }) => expect(code).toBe(0)
    );
  });

  // The three ways the discovery can quietly stop discovering. Each must be a
  // LINTER fault (validate nothing, blame no skill), never a silent pass — a
  // check that validates every field against an empty world reports OK for a
  // skill riddled with dropped fields.
  const discoveryFaults: Array<{
    name: string;
    sourceFiles: Record<string, string | null>;
    expect: string;
  }> = [
    {
      name: 'the preset file is gone',
      sourceFiles: { 'src/tools/field-selection.ts': null },
      expect: 'field-selection.ts is missing',
    },
    {
      name: 'the presets are written in a shape the parser cannot read',
      sourceFiles: {
        'src/tools/field-selection.ts': `export const DEFAULT_TRANSACTION_FIELDS = new Set(['date']);\n`,
      },
      expect: 'declares no DEFAULT_*_FIELDS presets',
    },
    {
      name: 'the handler is no longer wired to any tool name',
      sourceFiles: { 'src/tools/registry/transactions.ts': null },
      expect: 'cannot attribute to any registered tool',
    },
  ];

  for (const { name, sourceFiles, expect: needle } of discoveryFaults) {
    test(`fails as a linter fault when ${name}`, async () => {
      await withRepo({ dumpBody: WORKING_DUMP, sourceFiles }, ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('linter self-check');
        expect(stderr).toContain(needle);
        expect(stderr).toContain('Skill references were NOT validated');
      });
    });
  }

  test('fails as a linter fault when no tool defaults to its preset any more', async () => {
    // The tool keeps its preset but takes `fields` as a pure opt-in, which is
    // what every diet tool looked like before v3 flipped it. Nothing is
    // terse-by-default, so there is nothing to cross-check — and reporting
    // "OK" there is the vacuous pass this whole check exists to prevent.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        sourceFiles: {
          'src/tools/tools.ts': `export class CopilotMoneyTools {
  async getTransactions(options: { fields?: string[] }) {
    return projectRows([], options.fields, { preset: DEFAULT_TRANSACTION_FIELDS });
  }
}
`,
        },
        skill: skillWith('Use `get_transactions`, then read `tag_ids`.'),
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('no tool was found to be terse-by-default');
        expect(stderr).not.toContain('`tag_ids` is a row field');
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
