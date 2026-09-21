/**
 * The action-pin consistency gate (scripts/check-action-pins.ts).
 *
 * The bug it exists for: `actions/checkout` was pinned to one SHA in eight
 * places, six commented `# v7` and two `# v6`. Dependabot bumped the SHA and
 * preserved both comments, so a single SHA carried two contradictory labels —
 * and the wrong one had been wrong across a major version.
 *
 * The cry-wolf control matters as much as the catch: two DIFFERENT SHAs of the
 * same action may legitimately carry different labels, and a gate that flags
 * that gets disabled.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPins, findPinProblems, runCheck } from '../../scripts/check-action-pins.ts';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-action-pins.ts', import.meta.url));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** A throwaway workflow tree. Swept in `afterAll` so a run leaves no tmp dirs. */
const fixtureDirs: string[] = [];
function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'pins-'));
  fixtureDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(joinPath(dir, name), body);
  return dir;
}
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

/** One `uses:` step, the shape the gate reads. */
const usesLine = (sha: string, comment?: string) =>
  `      - uses: actions/checkout@${sha}${comment === undefined ? '' : ` # ${comment}`}`;

const pin = (action: string, sha: string, comment: string | undefined, file = 'w.yml', line = 1) =>
  ({ action, sha, comment, file, line }) as const;

describe('check-action-pins', () => {
  test('guards the gate: a consistent set produces no problems', () => {
    // If this ever fails, every "detects" case below could be passing for the
    // wrong reason.
    expect(
      findPinProblems([pin('actions/checkout', SHA_A, 'v7'), pin('actions/checkout', SHA_A, 'v7')])
    ).toEqual([]);
  });

  test('detects one SHA labelled two different ways — the real bug', () => {
    const problems = findPinProblems([
      pin('actions/checkout', SHA_A, 'v7', 'test.yml', 19),
      pin('actions/checkout', SHA_A, 'v6', 'audit-reviews.yml', 43),
    ]);
    expect(problems).toHaveLength(1);
    // The message must name BOTH sides, or the reader cannot tell which to fix.
    expect(problems[0]).toContain('v7');
    expect(problems[0]).toContain('v6');
    expect(problems[0]).toContain('audit-reviews.yml:43');
    expect(problems[0]).toContain('test.yml:19');
  });

  test('detects a SHA pin with no version comment at all', () => {
    const problems = findPinProblems([pin('actions/checkout', SHA_A, undefined, 'x.yml', 7)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('x.yml:7');
    expect(problems[0]).toContain('no version comment');
  });

  test('does NOT flag two DIFFERENT SHAs carrying different labels', () => {
    // The cry-wolf control. Different SHAs are different versions; labelling
    // them differently is correct, and flagging it would get the gate disabled.
    expect(
      findPinProblems([pin('actions/checkout', SHA_A, 'v7'), pin('actions/checkout', SHA_B, 'v6')])
    ).toEqual([]);
  });

  test('does NOT flag different actions that share a label', () => {
    expect(
      findPinProblems([
        pin('actions/checkout', SHA_A, 'v7'),
        pin('actions/setup-node', SHA_B, 'v7'),
      ])
    ).toEqual([]);
  });

  test('reports every disagreeing location, not just the first', () => {
    const problems = findPinProblems([
      pin('actions/checkout', SHA_A, 'v7', 'a.yml', 1),
      pin('actions/checkout', SHA_A, 'v7', 'b.yml', 2),
      pin('actions/checkout', SHA_A, 'v6', 'c.yml', 3),
    ]);
    expect(problems).toHaveLength(1);
    for (const f of ['a.yml:1', 'b.yml:2', 'c.yml:3']) expect(problems[0]).toContain(f);
  });
});

describe('collectPins', () => {
  test("finds the real repo's pins, and enough of them to be non-vacuous", () => {
    // The floor is the point. A scan that found ZERO pins would satisfy the
    // consistency check trivially — every "all labelled consistently" pass
    // would be meaningless. 10 is well under the ~21 present and well over the
    // 0 that would signal a broken scan.
    const pins = collectPins('.github/workflows');
    expect(pins.length).toBeGreaterThan(10);
    expect(pins.every((p) => /^[0-9a-f]{40}$/.test(p.sha))).toBe(true);
    expect(pins.every((p) => p.action.includes('/'))).toBe(true);
    expect(pins.every((p) => p.line > 0)).toBe(true);
  });

  test('the real repo is currently consistent — the gate passes end to end', () => {
    expect(findPinProblems(collectPins('.github/workflows'))).toEqual([]);
  });

  test('parses action, sha, comment and line from a workflow file', () => {
    const dir = fixtureDir({
      'a.yml': ['jobs:', '  x:', `    - uses: actions/checkout@${'a'.repeat(40)} # v7`].join('\n'),
    });
    const pins = collectPins(dir);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ action: 'actions/checkout', comment: 'v7', line: 3 });
  });

  test('ignores non-workflow files and unpinned (tag-based) uses', () => {
    const dir = fixtureDir({
      'note.md': `- uses: actions/checkout@${'a'.repeat(40)} # v7`,
      'b.yml': '    - uses: actions/checkout@v7',
    });
    expect(collectPins(dir)).toEqual([]);
  });

  test('picks up a pin with no comment, so findPinProblems can flag it', () => {
    const dir = fixtureDir({ 'c.yaml': `    - uses: actions/setup-node@${'b'.repeat(40)}` });
    const pins = collectPins(dir);
    expect(pins).toHaveLength(1);
    expect(pins[0]!.comment).toBeUndefined();
    expect(findPinProblems(pins)).toHaveLength(1);
  });
});

/**
 * `runCheck` is the CLI's decisions without the exiting: which outcomes are
 * failures, and what a reviewer reading CI is told about them. Until it was
 * split out, that half was reachable only by running the gate and looking.
 */
describe('runCheck', () => {
  test('a consistent tree exits 0 and reports how many pins it saw', () => {
    const result = runCheck(
      fixtureDir({ 'a.yml': usesLine(SHA_A, 'v7'), 'b.yml': usesLine(SHA_A, 'v7') })
    );
    expect(result).toMatchObject({ code: 0, stderr: [] });
    // The count is the only evidence a passing run gives that the scan saw
    // anything at all — "all labelled consistently" over nothing reads the same.
    expect(result.stdout.join('\n')).toContain('2 pinned actions');
  });

  test('a contradictory tree exits 1, annotates it, and says nothing reassuring', () => {
    const result = runCheck(
      fixtureDir({ 'a.yml': usesLine(SHA_A, 'v7'), 'b.yml': usesLine(SHA_A, 'v6') })
    );
    expect(result.code).toBe(1);
    // No "all labelled consistently" line alongside a failure.
    expect(result.stdout).toEqual([]);
    // `::error::` is what makes GitHub surface the line as an annotation;
    // without the prefix the failure exists only inside a collapsed log.
    expect(result.stderr.filter((l) => l.startsWith('::error::'))).toHaveLength(1);
    expect(result.stderr.at(-1)).toContain('1 problem(s) across 2 pins');
  });

  test('a tree with no pins at all exits 1 instead of passing vacuously', () => {
    // The floor, at the level that decides the exit code. A scan that matched
    // nothing satisfies the consistency check trivially, and that is the shape
    // in which a broken scan looks healthiest.
    const result = runCheck(fixtureDir({ 'b.yml': '      - uses: actions/checkout@v7' }));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr.join('\n')).toContain('the scan is broken');
  });

  test('the default directory is the real one — no argument, real repo, exit 0', () => {
    // Everything above passes an explicit path, so nothing else would notice
    // the shipped default pointing somewhere that does not exist.
    expect(runCheck()).toMatchObject({ code: 0, stderr: [] });
  });
});

/**
 * The script as `bun run check` actually invokes it. The tests above stop one
 * step short of `process.exit`, and an exit code that never leaves the process
 * is the one thing a composite `&&` chain reads.
 */
describe('the CLI', () => {
  async function spawnGate(dir: string): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(['bun', 'run', SCRIPT], {
      env: { ...process.env, CHECK_ACTION_PINS_DIR: dir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out, err };
  }

  test('exits 0 and prints the count when the tree is consistent', async () => {
    const dir = fixtureDir({ 'a.yml': usesLine(SHA_A, 'v7'), 'b.yml': usesLine(SHA_A, 'v7') });
    const { code, out, err } = await spawnGate(dir);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toContain('2 pinned actions, all labelled consistently');
  });

  test('exits 1 and writes the annotation to stderr when the tree contradicts itself', async () => {
    const dir = fixtureDir({ 'a.yml': usesLine(SHA_A, 'v7'), 'b.yml': usesLine(SHA_A, 'v6') });
    const { code, out, err } = await spawnGate(dir);
    // A non-zero exit is the entire mechanism by which this gate stops a push.
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('::error::');
    expect(err).toContain('is labelled 2 different ways');
  });

  test('exits 1 when the tree holds no pins, rather than reporting a clean scan', async () => {
    const { code, out, err } = await spawnGate(fixtureDir({ 'readme.md': usesLine(SHA_B, 'v7') }));
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('the scan is broken');
  });
});
