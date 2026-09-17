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
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { collectPins, findPinProblems } from '../../scripts/check-action-pins.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
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

  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(joinPath(tmpdir(), 'pins-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(joinPath(dir, name), body);
    return dir;
  }

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
