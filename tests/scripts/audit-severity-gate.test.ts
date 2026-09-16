/**
 * The audit workflow's severity gate (.github/audit-severity-gate.jq).
 *
 * `audit-reviews.yml` opens an `[Audit]` issue after every merged PR. Until the
 * gate existed it opened one for ANY finding at ANY severity — it collected a
 * severity field and never read it — so the repo's open-issue count had a floor
 * set by merge rate rather than by what was wrong (76 filed lifetime; at one
 * point half the open backlog, mostly comment-precision nits).
 *
 * This test runs the REAL filter file the workflow reads, not a copy of its
 * logic. A copy would drift, and the thing being guarded here is itself a
 * "nothing re-derives this" problem.
 *
 * The fail-safe direction is the important half: unclassifiable input must
 * escalate, never vanish. Those cases are asserted below and are the ones to
 * keep if this file is ever trimmed.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const GATE = join(import.meta.dir, '../../.github/audit-severity-gate.jq');

function escalating(threshold: string, findings: unknown[]): number {
  const out = execFileSync('jq', ['--arg', 't', threshold, '-f', GATE], {
    input: JSON.stringify({ unaddressed: findings }),
    encoding: 'utf-8',
  });
  return Number(out.trim());
}

describe('audit severity gate', () => {
  test('guards the gate: the filter file the workflow reads actually exists', () => {
    // If this path moves, every assertion below would silently test nothing —
    // execFileSync would throw, but a skipped/renamed file is the failure mode
    // worth naming explicitly.
    expect(existsSync(GATE)).toBe(true);
  });

  test('a batch of only low findings does not open an issue', () => {
    expect(escalating('medium', [{ severity: 'low' }, { severity: 'low' }])).toBe(0);
  });

  test('one medium among lows opens an issue', () => {
    expect(escalating('medium', [{ severity: 'low' }, { severity: 'medium' }])).toBe(1);
  });

  test('high always clears a medium threshold', () => {
    expect(escalating('medium', [{ severity: 'high' }])).toBe(1);
  });

  test('severity is matched case-insensitively', () => {
    expect(escalating('medium', [{ severity: 'LOW' }])).toBe(0);
    expect(escalating('medium', [{ severity: 'Medium' }])).toBe(1);
  });

  // --- fail-safe direction: unclassifiable input must ESCALATE ---

  test('a finding with NO severity escalates rather than being dropped', () => {
    expect(escalating('medium', [{ summary: 'no severity field' }])).toBe(1);
  });

  test('an UNRECOGNISED severity escalates — a new value upstream gets louder, not quieter', () => {
    expect(escalating('medium', [{ severity: 'critical' }])).toBe(1);
  });

  test('an unrecognised THRESHOLD escalates everything rather than silencing the gate', () => {
    // A typo in AUDIT_ISSUE_THRESHOLD must not disable issue creation. The
    // wrong direction here is the dangerous one: it would be invisible.
    expect(escalating('mediumm', [{ severity: 'low' }, { severity: 'low' }])).toBe(2);
  });

  test('threshold "low" restores the previous file-everything behaviour', () => {
    // The documented escape hatch, pinned so it keeps working.
    expect(escalating('low', [{ severity: 'low' }, { severity: 'low' }])).toBe(2);
  });

  test('threshold "high" narrows to high only', () => {
    expect(escalating('high', [{ severity: 'medium' }, { severity: 'high' }])).toBe(1);
  });
});
