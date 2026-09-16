/**
 * Behavioural tests for scripts/check-tool-counts.ts — the `bun run
 * check:tool-counts` gate that asserts every doc-facing tool count matches the
 * registry.
 *
 * Same pattern as tests/scripts/check-skills.test.ts: synthetic doc trees are
 * driven through the CHECK_TOOL_COUNTS_ROOT override. Counts always come from
 * the real registry import inside the script, so the pass case copies the real
 * doc surfaces into a temp tree and the fail cases corrupt them.
 */
import { describe, expect, test } from 'bun:test';
import { copyFile, mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_TOOL_DEFS } from '../../src/tools/registry/index.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-tool-counts.ts', import.meta.url));
const REAL_REPO = fileURLToPath(new URL('../..', import.meta.url));

const CHECKED_FILES = [
  'package.json',
  'README.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'docs/index.html',
  'docs/graphql-live-reads.md',
  'docs/EXAMPLE_QUERIES.md',
];

async function runCheck(root?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const env = { ...process.env };
  delete env.CHECK_TOOL_COUNTS_ROOT;
  if (root !== undefined) env.CHECK_TOOL_COUNTS_ROOT = root;
  const proc = Bun.spawn(['bun', SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

/** Copy the real doc surfaces into a fresh temp tree the tests can corrupt. */
async function makeDocTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'check-tool-counts-'));
  await mkdir(join(root, 'docs'), { recursive: true });
  for (const file of CHECKED_FILES) {
    await copyFile(join(REAL_REPO, file), join(root, file));
  }
  return root;
}

async function withDocTree(
  mutate: (root: string) => Promise<void>,
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const root = await makeDocTree();
  try {
    await mutate(root);
    assertions(await runCheck(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Apply a fixture edit, refusing to continue if it changed nothing.
 *
 * The discriminator is NOT the asserted exit code — an earlier version of this
 * comment said it was, and that was wrong. It is whether any single edit in the
 * chain is load-bearing on its own. A compound exit-1 fixture where edit A
 * already produces the asserted failure and edit B is the thing actually under
 * test passes green when B no-ops, having silently become a duplicate of some
 * other test. Only a fixture whose sole edit is what makes the assertion true
 * fails loudly by itself.
 *
 * So the compound fixtures route through here, and the single-edit exit-1 ones
 * deliberately do not — the discriminator above exempts them, and one
 * (`reports every mismatch`) edits two files while asserting on each name
 * separately, so either edit going stale fails loudly on its own. Throws rather
 * than asserts, so the message reads "the fixture is stale" and not "the gate
 * is broken" — the distinction that matters when it fires.
 *
 * A string `from` replaces every occurrence; a RegExp replaces the first only,
 * which is what both current regex callers want. Pass a global regex if you
 * mean all of them.
 */
function anchoredEdit(file: string, doc: string, from: string | RegExp, to: string): string {
  const out = typeof from === 'string' ? doc.replaceAll(from, to) : doc.replace(from, to);
  if (out === doc) {
    throw new Error(`fixture anchor gone from ${file}: ${String(from)}`);
  }
  return out;
}

/**
 * Fail if `needle` is not inside the section `expectToolTable` actually reads.
 *
 * `anchoredEdit` proves the edit changed the doc; it cannot prove the result is
 * in scope. `expectToolTable` reads from the heading to the next `^---$`, and
 * the prose this file anchors on sits three lines above that rule. Move it
 * below — a plausible edit, it is a "see the README" pointer — and the fixture
 * still applies, the prose lands out of section, and the row-scoping test
 * quietly becomes a duplicate of the plain missing-row one.
 *
 * MIRRORED, and the mirror must move in lockstep: the slicing below copies
 * `expectToolTable`'s. The test cannot import the script — running it IS the
 * check, which is why these tests spawn a subprocess — so there is no shared
 * function to depend on. A divergence in the HEADING is caught (it throws
 * "fixture anchor gone"); a divergence in the BOUNDARY is not. Change the
 * script to `^---+$`, or to "stop at the next `##`", and this copy keeps
 * returning a region that is no longer the scanned one.
 */
function assertInToolSection(doc: string, needle: string): void {
  const start = doc.indexOf(TOOL_SECTION_HEADING);
  if (start === -1)
    throw new Error(`fixture anchor gone from ${EXAMPLES}: the tool-reference heading`);
  const rest = doc.slice(start + TOOL_SECTION_HEADING.length);
  const end = rest.search(/^---$/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  if (!section.includes(needle)) {
    throw new Error(
      `fixture landed outside the scanned section of ${EXAMPLES}: ${JSON.stringify(needle)}`
    );
  }
}

/** Assert-and-return, so a fixture can wrap its result inline. */
function proseInSection(doc: string): string {
  assertInToolSection(doc, 'Balances over time come from `get_balance_history`.');
  return doc;
}

/** The heading `expectToolTable` scans from — mirrored from the script's call site. */
const TOOL_SECTION_HEADING = '## Tool Reference (Behind the Scenes)';

/** The doc every `anchoredEdit` call names — not every file the fixtures touch. */
const EXAMPLES = 'docs/EXAMPLE_QUERIES.md';

const read = READ_TOOL_DEFS.length;

describe('check:tool-counts', () => {
  test('passes against the checked-in docs', async () => {
    const { code, stdout, stderr } = await runCheck();
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('Tool counts in sync');
  });

  test('passes against a faithful copy of the doc surfaces', async () => {
    await withDocTree(
      async () => {},
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('Tool counts in sync');
      }
    );
  });

  test('fails on a corrupted count and names the file and label', async () => {
    await withDocTree(
      async (root) => {
        const pkg = await readFile(join(root, 'package.json'), 'utf-8');
        await writeFile(
          join(root, 'package.json'),
          pkg.replace(`(${read} cache-mode read tools)`, `(${read + 1} cache-mode read tools)`)
        );
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('Tool count check failed');
        expect(stderr).toContain('package.json');
        expect(stderr).toContain('cache-mode read tool count');
        // The remediation footer prints the registry-derived truth.
        expect(stderr).toContain('Derived from the registry');
      }
    );
  });

  test('reports every mismatch, not just the first', async () => {
    await withDocTree(
      async (root) => {
        for (const file of ['package.json', 'README.md']) {
          const content = await readFile(join(root, file), 'utf-8');
          await writeFile(join(root, file), content.replaceAll('cache', 'cachet'));
        }
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('package.json');
        expect(stderr).toContain('README.md');
      }
    );
  });

  // The #723 trap: docs/EXAMPLE_QUERIES.md said "12 tools" over a table of 12,
  // so the count was self-consistent and the surface was still two tools short.
  // A needle on the number alone would have ratcheted the understatement in, so
  // the table is asserted for set equality against the registry as well.
  test('fails when the tool-reference table omits a default-mode tool', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(path, anchoredEdit(EXAMPLES, doc, /^.*`get_balance_history`.*$/m, ''));
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('docs/EXAMPLE_QUERIES.md');
        expect(stderr).toContain('get_balance_history');
      }
    );
  });

  test('fails when the table is trimmed and the count is edited to match it', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          // Both edits guarded: the row removal alone already satisfies the
          // assertion, so a no-op in the count edit would leave the half this
          // test exists for — "the author fixed the number instead" — untested
          // and the test green.
          anchoredEdit(
            EXAMPLES,
            anchoredEdit(EXAMPLES, doc, /^.*`get_balance_history`.*$/m, ''),
            `these ${read} tools`,
            `these ${read - 1} tools`
          )
        );
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        // The count needle goes red too, but the table assertion is the one
        // that would still be red if the author had "fixed" the number.
        expect(stderr).toContain('omits 1 tool(s): get_balance_history');
      }
    );
  });

  // Detector for the ROW-SCOPING half. Prose inside the section must not be
  // able to satisfy `missing` on the table's behalf: without the row filter, a
  // sentence naming the tool would stand in for the row, and #723's property —
  // the TABLE names every default-mode tool — would be satisfiable by mentioning
  // it anywhere in the section.
  test('prose naming a tool does not stand in for its missing table row', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          // Same compound shape: without the prose edit guarded, rewording
          // that sentence in the real doc would make this a byte-for-byte
          // duplicate of the test above, covering nothing about row-scoping.
          proseInSection(
            anchoredEdit(
              EXAMPLES,
              anchoredEdit(EXAMPLES, doc, /^.*`get_balance_history`.*$/m, ''),
              'With `--live-reads`',
              'Balances over time come from `get_balance_history`.\n\nWith `--live-reads`'
            )
          )
        );
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('omits 1 tool(s): get_balance_history');
      }
    );
  });

  // `trimStart`, not a bare `startsWith`: a table nested in a list item, a
  // <details>, or a blockquote is indented, and skipping every row then reports
  // "omits 14 tool(s)" — a registry catastrophe caused by a whitespace edit.
  test('reads an indented table, rather than reporting every tool missing', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(path, anchoredEdit(EXAMPLES, doc, '\n|', '\n  |'));
      },
      ({ code, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  // Detector for the REGISTRY-FILTER half, which row-scoping cannot cover: a
  // backticked word inside a row that is no tool at all is prose. This table is
  // one edit from that shape — `get_transactions` (with merchant filter).
  test('a backticked non-tool inside a table row is not an unknown tool', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          anchoredEdit(EXAMPLES, doc, '(with merchant filter)', '(with `merchant` filter)')
        );
      },
      ({ code, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  // Argument names are snake_case exactly like tool names, so the shape rule
  // cannot tell `account_id` from a mistyped tool on form alone — and a doc
  // author reaching for a backtick in a row is at least as likely to reach for
  // the real parameter name as for an English word.
  test('a backticked argument name inside a table row is not an unknown tool', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          anchoredEdit(
            EXAMPLES,
            doc,
            '(with merchant filter)',
            '(with `account_id` or `start_date`)'
          )
        );
      },
      ({ code, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  // Nested arguments are arguments: `update_recurring` carries a `rule` object
  // whose `name_contains` the conformance ledger names as a real input. A
  // one-level property read would leave it failing as an unknown tool, and
  // would make the walk's "no edit needed here" claim false.
  test('a backticked NESTED argument name is not an unknown tool either', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          anchoredEdit(EXAMPLES, doc, '(with merchant filter)', '(with `name_contains`)')
        );
      },
      ({ code, stderr }) => {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }
    );
  });

  // The hole the registry filter opened, and the reason `extra` also admits
  // anything tool-SHAPED: this table has duplicate rows for `get_transactions`,
  // so typo-ing one leaves `missing` quiet — the real name is still on the other
  // row — and a membership-only filter would leave `extra` quiet too.
  test('reports a tool-shaped name the registry does not have', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          doc.replace(
            '| "Search for Amazon" | `get_transactions`',
            '| "Search for Amazon" | `get_transactons`'
          )
        );
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('get_transactons');
      }
    );
  });

  // The other half of the same guard: a name the registry DOES know, in a
  // section that should not be listing it, is the failure worth reporting.
  test('still reports a real tool the section should not be naming', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'docs/EXAMPLE_QUERIES.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(
          path,
          doc.replace(
            '| "Check cache status" |',
            '| "Net worth" | `get_networth_live` |\n| "Check cache status" |'
          )
        );
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('get_networth_live');
      }
    );
  });

  test('fails when CONTRIBUTING.md restates a count the registry disagrees with', async () => {
    await withDocTree(
      async (root) => {
        const path = join(root, 'CONTRIBUTING.md');
        const doc = await readFile(path, 'utf-8');
        await writeFile(path, doc.replaceAll(`(${read} read + `, `(${read + 1} read + `));
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('CONTRIBUTING.md');
      }
    );
  });

  test('reports an unreadable file as a mismatch, not a crash', async () => {
    await withDocTree(
      async (root) => {
        await rm(join(root, 'docs/index.html'));
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('docs/index.html: could not read file');
        expect(stderr).not.toContain('ENOENT');
      }
    );
  });
});
