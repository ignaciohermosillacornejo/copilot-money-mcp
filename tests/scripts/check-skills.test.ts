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

import { CopilotMoneyServer } from '../../src/server.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

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
metadata:
  modes: "live"
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
  /** Body of the synthetic scripts/dump-tool-modes.ts (check 6, #847). */
  modesBody?: string;
  /** Write the names dump but NOT the args dump — the only way to reach
   *  `_run_dump_script`'s "is missing" branch for ARGS_SCRIPT, since removing
   *  the whole scripts/ directory makes the names lookup raise first. */
  omitArgs?: boolean;
  skill?: string;
  /** Extra markdown files beside SKILL.md, e.g. a test matrix the skill reads. */
  extraDocs?: Record<string, string>;
  sourceFiles?: Record<string, string | null>;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'check-skills-'));
  // EITHER body, not just `dumpBody`. Gating on `dumpBody` alone meant a case
  // that set only `argsBody` got no `scripts/` directory at all and silently
  // tested "the dump script is missing entirely" instead — invisible in this
  // file, because that case asserts the same four invariants.
  if (opts.dumpBody !== undefined || opts.argsBody !== undefined || opts.modesBody !== undefined) {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'dump-tool-names.ts'), opts.dumpBody ?? WORKING_DUMP);
    if (opts.omitArgs !== true) {
      await writeFile(
        join(root, 'scripts', 'dump-tool-args.ts'),
        opts.argsBody ?? WORKING_ARGS_DUMP
      );
    }
    await writeFile(
      join(root, 'scripts', 'dump-tool-modes.ts'),
      opts.modesBody ?? WORKING_MODES_DUMP
    );
  }
  for (const [path, body] of Object.entries({ ...SOURCE_TREE, ...opts.sourceFiles })) {
    if (body === null) continue;
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), body);
  }
  await mkdir(join(root, 'skills', 'demo'), { recursive: true });
  await writeFile(join(root, 'skills', 'demo', 'SKILL.md'), opts.skill ?? SKILL_BODY);
  for (const [name, body] of Object.entries(opts.extraDocs ?? {})) {
    const path = join(root, 'skills', 'demo', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

// get_accounts / get_accounts_live are the synthetic cache-only / live-only
// pair the mode check (#847) needs; get_transactions is listed in both modes
// here so the older checks' fixtures need no mode tags.
const WORKING_DUMP = `console.log(JSON.stringify(['get_accounts', 'get_accounts_live', 'get_transactions', 'update_transaction']));`;
const WORKING_ARGS_DUMP = `console.log(JSON.stringify({ get_accounts: ['include_hidden', 'view'], get_accounts_live: ['fields'], get_transactions: ['fields', 'period'], update_transaction: ['transaction_id'] }));`;
const WORKING_MODES_DUMP = `console.log(JSON.stringify({ get_accounts: ['cache'], get_accounts_live: ['live'], get_transactions: ['cache', 'live'], update_transaction: ['live'] }));`;

async function withRepo(
  opts: {
    dumpBody?: string;
    argsBody?: string;
    modesBody?: string;
    omitArgs?: boolean;
    skill?: string;
    extraDocs?: Record<string, string>;
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

function skillWith(body: string, modes = 'live'): string {
  return `---
name: demo
description: A demo skill.
metadata:
  modes: "${modes}"
---

${body}
`;
}

describe('tool-lookup gate (class-level detector)', () => {
  // Each case is a different way the lookup can go wrong. The invariant is the
  // same every time: report the linter, validate nothing, blame no skill.
  // `because` pins each case to ITS failure, not just to the shared invariants.
  // Without it a case that silently degrades into another case's scenario —
  // e.g. an args-only case whose scripts/ directory never got written, so it
  // really tests "the dump script is missing entirely" — passes identically,
  // since every row asserts the same four things. Every row sets one: the
  // mechanism is only worth having if the table is self-pinning throughout,
  // and a row without one is a row that can quietly become a duplicate.
  const cases: Array<{
    name: string;
    dumpBody?: string;
    argsBody?: string;
    modesBody?: string;
    omitArgs?: boolean;
    /**
     * REQUIRED — enforced by the type (this file is in tsconfig.tests.json
     * since #847) AND at runtime below. The runtime check stays because
     * `bun test` does not typecheck: a row without one would otherwise reach
     * `toContain(undefined)`, which fails with a type complaint instead of
     * naming the row that lost its pin.
     */
    because: string;
  }> = [
    {
      name: 'the dump script is missing entirely',
      dumpBody: undefined,
      because: 'dump-tool-names.ts is missing',
    },
    {
      name: 'the dump script exits non-zero',
      dumpBody: `console.error('registry blew up'); process.exit(1);`,
      because: 'exited 1:',
    },
    {
      name: 'the dump script prints something that is not JSON',
      dumpBody: `console.log('not json at all');`,
      because: 'did not print valid JSON',
    },
    {
      name: 'the dump script prints JSON of the wrong shape',
      dumpBody: `console.log(JSON.stringify({ tools: ['get_transactions'] }));`,
      because: 'expected a JSON array of strings',
    },
    {
      // The historical shape: a lookup that "works" but answers with nothing.
      name: 'the dump script returns an empty list',
      dumpBody: `console.log(JSON.stringify([]));`,
      // Qualified: check-skills.py raises this sentence for BOTH dumps,
      // differing only by the script-name prefix, so the bare phrase would pin
      // the message class rather than this row.
      because: 'dump-tool-names.ts returned an empty tool list',
    },
    {
      // The ARGS dump's version of the same shape, and the one an empty-map
      // check cannot see: renaming the schema field the collector reads gives
      // a healthy-looking map of empty lists, which passes shape validation
      // and the emptiness check and then silently turns every argument name in
      // the repo into a candidate row field.
      name: 'the args dump returns a map of empty lists',
      argsBody: `console.log(JSON.stringify({ get_transactions: [], update_transaction: [] }));`,
      because: 'not one argument between them',
    },
    {
      // `_run_dump_script`'s "is missing" branch was only ever reached for the
      // NAMES dump: case 1 removes the whole scripts/ directory and the names
      // lookup raises first. This omits just the args dump.
      name: 'the args dump script is missing',
      dumpBody: WORKING_DUMP,
      omitArgs: true,
      because: 'dump-tool-args.ts is missing',
    },
    {
      // The mode dump's degenerate answer (#847): a filter reading renamed
      // registry flags lists every tool in every mode, and the mode check then
      // passes every skill.
      name: 'the modes dump lists every tool in both modes',
      modesBody: `console.log(JSON.stringify({ get_accounts: ['cache', 'live'], get_accounts_live: ['cache', 'live'], get_transactions: ['cache', 'live'], update_transaction: ['cache', 'live'] }));`,
      because: 'reports no cache-only tool',
    },
    {
      name: 'the modes dump and the names dump disagree on the tool list',
      modesBody: `console.log(JSON.stringify({ get_accounts: ['cache'], get_accounts_live: ['live'] }));`,
      because: 'disagree on the tool list',
    },
    {
      name: 'the modes dump lists a tool in no mode at all',
      modesBody: `console.log(JSON.stringify({ get_accounts: ['cache'], get_accounts_live: ['live'], get_transactions: [], update_transaction: ['live'] }));`,
      because: 'in no mode at all',
    },
    {
      name: 'the modes dump names a mode that does not exist',
      modesBody: `console.log(JSON.stringify({ get_accounts: ['cache'], get_accounts_live: ['live'], get_transactions: ['offline'], update_transaction: ['live'] }));`,
      because: 'array of modes drawn from',
    },
  ];

  for (const { name, dumpBody, argsBody, modesBody, omitArgs, because } of cases) {
    test(`fails as a linter fault when ${name}`, async () => {
      if (!because) {
        throw new Error(
          `detector-table row "${name}" has no \`because\`: every row must pin itself ` +
            'to its own failure, or it can silently become a duplicate of another row'
        );
      }
      await withRepo({ dumpBody, argsBody, modesBody, omitArgs }, ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('linter self-check');
        expect(stderr).toContain('Skill references were NOT validated');
        // The whole point: it must NOT blame the skills.
        expect(stderr).not.toContain('references unknown MCP tool');
        expect(stderr).toContain(because);
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

  // A skill's instructions can live beside SKILL.md: release-parity-test keeps
  // its ~150 cases in test-matrix.md. When the linter read SKILL.md alone, every
  // reference in that file went unchecked (review on #826).
  test('lints markdown files beside SKILL.md, naming the file', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'test-matrix.md': 'Then call `get_everything_live`.\n' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain(
          'demo/test-matrix.md: references unknown MCP tool `get_everything_live`'
        );
      }
    );
  });

  test('applies the terse-default field check to files beside SKILL.md', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'test-matrix.md': 'Use `get_transactions`, then read `tag_ids`.\n' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/test-matrix.md:1: `tag_ids` is a row field');
      }
    );
  });

  test('lints markdown nested below the skill folder too', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'references/notes.md': 'Then call `get_everything_live`.\n' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/references/notes.md: references unknown MCP tool');
      }
    );
  });

  test('a clean extra file needs no frontmatter of its own', async () => {
    // Frontmatter is a SKILL.md-only check. The two cases above both carry a
    // bad reference and expect exit 1, so they would still pass if frontmatter
    // validation leaked onto every file; this one would not.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'test-matrix.md': '# Matrix\n\nCall `get_transactions`.\n' },
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 skills validated');
      }
    );
  });

  test('rejects a table row with more cells than its header', async () => {
    // GFM silently drops the extra cell, so the row renders shifted: in a test
    // matrix the real status vanishes from the Last run column (review on #826).
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: {
          'test-matrix.md':
            '| ID | Case | Last run |\n|---|---|---|\n| A-1 | ok | PASS |\n| A-2 | steps | expected | not run |\n',
        },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/test-matrix.md:4: table row has 4 cells, its header has 3');
      }
    );
  });

  test('a short row is reported as rendering blank, not shifted', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'test-matrix.md': '| ID | Case | Last run |\n|---|---|---|\n| A-1 | ok |\n' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/test-matrix.md:3: table row has 2 cells, its header has 3');
        expect(stderr).toContain('renders blank');
      }
    );
  });

  test('recognises a one-dash separator, so the table is still checked', async () => {
    // A separator the regex did not recognise used to leave the whole table
    // unchecked with no output: a check that fails open (#577's class).
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: { 'test-matrix.md': '| ID | Case |\n|-|-|\n| A-1 | ok | extra |\n' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/test-matrix.md:3: table row has 3 cells, its header has 2');
      }
    );
  });

  test('ignores table-shaped lines inside a fenced code block', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: {
          'test-matrix.md': '```\n| a | b |\n|---|---|\n| 1 | 2 | 3 |\n```\n',
        },
      },
      ({ code }) => {
        expect(code).toBe(0);
      }
    );
  });

  test('accepts tables whose rows match, including escaped pipes in a cell', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        extraDocs: {
          'test-matrix.md':
            '| ID | Steps |\n|---|---|\n| A-1 | `ps \\| grep cli` |\n\nProse after the table.\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n',
        },
      },
      ({ code }) => {
        expect(code).toBe(0);
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
metadata:
  modes: "live"
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

  test("a WRITE tool's parameter is excused when that write tool is on the line", async () => {
    // The realistic skill line: pull rows, then write one back. `category_id`
    // is an update_transaction parameter AND a transaction row field the diet
    // dropped, and update_transaction is not terse-by-default — so a filter
    // built from the TERSE tools on the line would report it while the line
    // names both tools and instructs nothing wrong.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        argsBody: `console.log(JSON.stringify({ get_transactions: ['fields'], update_transaction: ['category_id'] }));`,
        sourceFiles: {
          'src/models/transaction.ts': `export const TransactionSchema = z.object({
  transaction_id: z.string(),
  date: z.string(),
  amount: z.number(),
  category_id: z.string(),
});
`,
        },
        skill: skillWith(
          'Pull with `get_transactions`, then call `update_transaction` with the new `category_id`.'
        ),
      },
      ({ code, stdout, stderr }) => {
        expect(stdout + stderr).not.toContain('`category_id` is a row field');
        expect(code).toBe(0);
      }
    );
  });

  test("...but the terse tool's OWN parameter is still excused", async () => {
    // The weaker half of the pair, kept because it is the regression the
    // narrowing could most easily cause. It does NOT discriminate between the
    // repo-wide union and either narrowing — all three excuse this token —
    // which is why the two tests around it carry the real load.
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

/**
 * Check 6 (#847): finance-pulse and finance named `get_accounts`,
 * `get_transactions` with `period`, `get_budgets` with `active_only` — all real
 * tools, so check 2 passed — while the server runs in live mode whenever
 * --write is on, where none of them is listed. Both directions and the quiet
 * cases are covered, for the same reason as check 4's.
 */
describe('mode surface (#847)', () => {
  test('a skill that declares no modes fails, naming the fix', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: `---\nname: demo\ndescription: A demo skill.\n---\n\nCall \`get_transactions\`.\n`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('demo/SKILL.md: frontmatter must declare the server mode(s)');
        expect(stderr).toContain('modes: "live, cache"');
      }
    );
  });

  test('an unknown mode value fails', async () => {
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Call `get_transactions`.', 'live, offline') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain("`metadata.modes` has 'offline'");
      }
    );
  });

  test('a live skill naming a cache-only tool fails', async () => {
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Call `get_accounts` for balances.') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain(
          'demo/SKILL.md:8: `get_accounts` is listed only in cache mode, but this skill declares live'
        );
      }
    );
  });

  test('...and the reverse: a cache skill naming a live-only tool fails', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith('Call `get_accounts_live` for balances.', 'cache'),
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('`get_accounts_live` is listed only in live mode');
        expect(stderr).toContain('does not exist in cache mode');
      }
    );
  });

  test('a two-mode skill may name both variants, each tagged with its mode', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith(
          'Call `get_accounts_live` (live) / `get_accounts` (cache only), then `get_transactions`.',
          'live, cache'
        ),
      },
      ({ code, stdout, stderr }) => {
        expect(stderr).not.toContain('FAIL');
        expect(code).toBe(0);
        expect(stdout).toContain('1 skills validated');
      }
    );
  });

  test('...but an untagged variant still fails beside a tagged one', async () => {
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith('Call `get_accounts_live` / `get_accounts` (cache).', 'live, cache'),
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('`get_accounts_live` is listed only in live mode');
        expect(stderr).not.toContain('`get_accounts` is listed only');
      }
    );
  });

  test('a tag for the wrong mode does not excuse the tool', async () => {
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Call `get_accounts` (live).', 'live, cache') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('`get_accounts` is listed only in cache mode');
      }
    );
  });

  test('a tag for a mode the skill does not declare does not excuse the tool', async () => {
    // A live-only skill cannot opt a cache tool back in by tagging it: its
    // own declaration says that mode never runs it.
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Call `get_accounts` (cache).') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('`get_accounts` is listed only in cache mode');
      }
    );
  });

  test("an argument the line's tool does not take fails", async () => {
    // The #847 shape: the live tool swapped in, the cache tool's argument kept.
    await withRepo(
      { dumpBody: WORKING_DUMP, skill: skillWith('Call `get_accounts_live` with `view: "list"`.') },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('argument `view` is not taken by `get_accounts_live`');
      }
    );
  });

  test('an argument of the tool on the line passes, and so does a response value', async () => {
    // `success: true` is not an argument of ANY tool: it describes a response,
    // so it is not something this check can judge.
    await withRepo(
      {
        dumpBody: WORKING_DUMP,
        skill: skillWith(
          'Call `get_accounts_live` with `fields: ["default"]`; expect `success: true`.'
        ),
      },
      ({ code, stderr }) => {
        expect(stderr).not.toContain('FAIL');
        expect(code).toBe(0);
      }
    );
  });
});

describe('dump-tool-modes.ts matches the server', () => {
  // The dump re-implements handleListTools()'s filter. Pin it to real servers
  // in both modes, so a change to the server's gating that the dump does not
  // follow fails here instead of linting every skill against the wrong surface.
  test('cache and live surfaces equal handleListTools() in each mode', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/dump-tool-modes.ts'], {
      cwd: REAL_REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const modes: Record<string, string[]> = JSON.parse(stdout);

    const listed = (write: boolean, live: boolean): string[] =>
      new CopilotMoneyServer(
        '/nonexistent/check-skills-mode-fixture',
        undefined,
        write,
        live,
        live ? createMockGraphQLClient({}) : undefined
      )
        .handleListTools()
        .tools.map((t) => t.name)
        .sort();
    const inMode = (mode: string): string[] =>
      Object.keys(modes)
        .filter((name) => modes[name]?.includes(mode))
        .sort();

    expect(inMode('cache')).toEqual(listed(false, false));
    expect(inMode('live')).toEqual(listed(true, true));
    expect(Object.keys(modes).sort()).toEqual(ALL_TOOL_DEFS.map((d) => d.name).sort());
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
