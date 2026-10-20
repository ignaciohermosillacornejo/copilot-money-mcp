/**
 * Behavioural tests for scripts/check-bug-corpus.ts — the `bun run
 * check:bug-corpus` gate that keeps docs/bugs/README.md's counts and index in
 * step with the entry files.
 *
 * Same pattern as tests/scripts/check-tool-counts.test.ts: the real docs/bugs
 * directory is copied into a temp tree driven through CHECK_BUG_CORPUS_ROOT,
 * and each failure case corrupts the copy in one way.
 */
import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-bug-corpus.ts', import.meta.url));
const REAL_BUGS = fileURLToPath(new URL('../../docs/bugs', import.meta.url));

async function runCheck(root?: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const env = { ...process.env };
  delete env.CHECK_BUG_CORPUS_ROOT;
  if (root !== undefined) env.CHECK_BUG_CORPUS_ROOT = root;
  const proc = Bun.spawn(['bun', SCRIPT], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

async function withCorpus(
  mutate: (bugs: string) => Promise<void>,
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'check-bug-corpus-'));
  try {
    const bugs = join(root, 'docs', 'bugs');
    await cp(REAL_BUGS, bugs, { recursive: true });
    await mutate(bugs);
    assertions(await runCheck(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function editReadme(bugs: string, edit: (text: string) => string): Promise<void> {
  const path = join(bugs, 'README.md');
  const before = await readFile(path, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error('fixture edit changed nothing');
  await writeFile(path, after);
}

const ENTRY = '661-non-completion-classified-as-drift.md';

describe('check:bug-corpus', () => {
  test('passes on the real corpus', async () => {
    const result = await runCheck();
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Bug corpus in sync');
  });

  test('an entry added without a re-count fails the headline, chart and index', async () => {
    await withCorpus(
      async (bugs) => {
        const text = await readFile(join(bugs, ENTRY), 'utf8');
        await writeFile(join(bugs, '9999-synthetic-new-entry.md'), text);
      },
      (r) => {
        expect(r.code).toBe(1);
        // Count-independent: the corpus grows, the relation does not.
        const head = /README\.md says (\d+) entries; docs\/bugs has (\d+) entry files/.exec(
          r.stderr
        );
        expect(Number(head?.[2])).toBe(Number(head?.[1]) + 1);
        const chart = /found-by `dogfooding`: README says (\d+), entries say (\d+)/.exec(r.stderr);
        expect(Number(chart?.[2])).toBe(Number(chart?.[1]) + 1);
        expect(r.stderr).toContain('9999-synthetic-new-entry.md has no index row');
      }
    );
  });

  test('a missing index row fails, naming the entry', async () => {
    await withCorpus(
      (bugs) =>
        editReadme(bugs, (t) =>
          t
            .replace(/^\| #661 \|.*\n/m, '')
            .replace('**`alarm-by-fallthrough`** — 1', '**`alarm-by-fallthrough`** — 0')
        ),
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(`${ENTRY} has no index row`);
        expect(r.stderr).toContain('index `alarm-by-fallthrough`: heading says 0, entries say 1');
      }
    );
  });

  test('a class heading count that disagrees with its rows fails', async () => {
    await withCorpus(
      (bugs) =>
        editReadme(bugs, (t) =>
          t.replace('**`alarm-by-fallthrough`** — 1', '**`alarm-by-fallthrough`** — 2')
        ),
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('index `alarm-by-fallthrough`: heading says 2, entries say 1');
        expect(r.stderr).toContain('heading says 2 but the section has 1 row(s)');
      }
    );
  });

  test('a chart bar that is not count - 1 blocks fails', async () => {
    await withCorpus(
      (bugs) => editReadme(bugs, (t) => t.replace(/(\| `dogfooding`[^|]*\| \d+ \| )█+/, '$1█')),
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(
          /found-by `dogfooding`: bar is 1 glyph\(s\), expected \d+ full blocks/
        );
      }
    );
  });

  test('a detected token outside the vocabulary fails', async () => {
    await withCorpus(
      async (bugs) => {
        const path = join(bugs, ENTRY);
        const text = await readFile(path, 'utf8');
        await writeFile(path, text.replace(/^detected: dogfooding/m, 'detected: hunch'));
      },
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          `${ENTRY}: detected \`hunch\` is not in TEMPLATE.md's vocabulary`
        );
      }
    );
  });

  test('a class with no definition row fails', async () => {
    await withCorpus(
      async (bugs) => {
        const path = join(bugs, ENTRY);
        const text = await readFile(path, 'utf8');
        await writeFile(
          path,
          text.replace(/^class: alarm-by-fallthrough/m, 'class: made-up-class')
        );
      },
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(`${ENTRY}: class \`made-up-class\` has no definition row`);
      }
    );
  });

  test("an index row's found-by or date cell that disagrees with the entry fails", async () => {
    await withCorpus(
      (bugs) =>
        editReadme(bugs, (t) =>
          t.replace(
            /^(\| #661 \|[^\n]*\| )`dogfooding` \| (\d{4}-\d{2}-\d{2}) \|$/m,
            '$1`code-review` | 1999-01-01 |'
          )
        ),
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          `index row for ${ENTRY}: found-by \`code-review\`, the entry's detected is \`dogfooding\``
        );
        expect(r.stderr).toContain(`index row for ${ENTRY}: date 1999-01-01`);
      }
    );
  });

  test("a pipe list under another TEMPLATE key does not widen detected:'s vocabulary", async () => {
    await withCorpus(
      async (bugs) => {
        const tpl = join(bugs, 'TEMPLATE.md');
        const text = await readFile(tpl, 'utf8');
        const widened = text.replace(/^(status: .*)$/m, '$1\n#   fixed | open | wont-fix');
        if (widened === text) throw new Error('fixture edit changed nothing');
        await writeFile(tpl, widened);
        const path = join(bugs, ENTRY);
        const entry = await readFile(path, 'utf8');
        await writeFile(path, entry.replace(/^detected: dogfooding/m, 'detected: open'));
      },
      (r) => {
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(
          `${ENTRY}: detected \`open\` is not in TEMPLATE.md's vocabulary`
        );
      }
    );
  });
});
