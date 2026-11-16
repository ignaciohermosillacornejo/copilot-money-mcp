/**
 * Every member of the `bun run smoke` composite must speak the scheduled
 * runner's language (`scripts/scheduled-smoke.ts`), in three ways:
 *
 * 1. Drift (#818). The runner classifies a nonzero run as `fail` only when the
 *    output contains one of `DRIFT_VERDICT_MARKERS`; anything else becomes
 *    `incomplete`, reported as "drift NOT checked". A drift check whose failure
 *    line is not on that list turns real drift into a dismissed non-completion.
 *    That happened twice (`synthesized-fields-conformance.ts`, then #791's
 *    `account-names.ts`), and the four refresh smokes did it for their
 *    server-controlled assertions until #819.
 * 2. Not checked (#819). A member that exits 0 without having compared
 *    anything (SKIP) or without being able to discriminate (WARN) must print a
 *    line from `SKIP_MARKERS`, or the run reads as a clean pass.
 * 3. Pass (#819). Each member prints a `[smoke] PASS — …` line, the shape the
 *    run summary recognises as a verdict.
 *
 * This walks the composite from `package.json` (following `bun run smoke:x`
 * aliases), so a new member must be classified here before it can join.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  DRIFT_VERDICT_MARKERS,
  SKIP_MARKERS,
  SMOKE_VERDICT_LINE,
} from '../../scripts/scheduled-smoke.js';
import { ROOT, compositeMembers, printedLines } from '../helpers/smoke-composite.js';

/** Drift checks, and the marker each prints before exiting nonzero. */
const MARKER_OF: Record<string, (typeof DRIFT_VERDICT_MARKERS)[number]> = {
  'scripts/smoke/conformance.ts': '[smoke] FAIL — conformance drift detected',
  'scripts/smoke/synthesized-fields-conformance.ts':
    '[smoke] FAIL — synthesized-field absence drift detected',
  'scripts/smoke/reads.ts': '[smoke] FAIL — read-surface drift detected',
  'scripts/smoke/account-names.ts': '[smoke] FAIL — account-name parity drift detected',
  'scripts/smoke/budgets.ts': '[smoke] FAIL — budgets server drift detected',
  'scripts/smoke/categories.ts': '[smoke] FAIL — categories server drift detected',
  'scripts/smoke/recurring.ts': '[smoke] FAIL — recurring server drift detected',
  'scripts/smoke/tags.ts': '[smoke] FAIL — tags server drift detected',
};

const members = compositeMembers();
const linesOf = (m: string): string[] => printedLines(fs.readFileSync(path.join(ROOT, m), 'utf8'));

describe('bun run smoke composite verdicts (#818, #819)', () => {
  test('the composite resolves to script files', () => {
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(fs.existsSync(path.join(ROOT, m)), m).toBe(true);
  });

  test('every member is classified as a drift check', () => {
    expect(
      members.filter((m) => !(m in MARKER_OF)),
      'add the member to MARKER_OF'
    ).toEqual([]);
  });

  test('every drift check prints a marker the scheduled runner recognises', () => {
    const missing: string[] = [];
    for (const m of members) {
      const marker = MARKER_OF[m] as string;
      if (!(DRIFT_VERDICT_MARKERS as readonly string[]).includes(marker)) {
        missing.push(`${m}: marker not in DRIFT_VERDICT_MARKERS`);
      }
      if (!linesOf(m).some((l) => l.startsWith(marker))) {
        missing.push(`${m}: never prints "${marker}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('every member prints a PASS line the run summary recognises', () => {
    const missing = members.filter(
      (m) => !linesOf(m).some((l) => l.startsWith('[smoke] PASS') && SMOKE_VERDICT_LINE.test(l))
    );
    expect(missing, 'print `[smoke] PASS — <what was verified>` on success').toEqual([]);
  });

  test('every SKIP or WARN line a member prints is a registered skip marker', () => {
    const offenders: string[] = [];
    for (const m of members) {
      for (const line of linesOf(m)) {
        // A line whose first word is interpolated could print SKIP or WARN
        // without anything here seeing it (#791's `${status} account-name…`).
        if (/^\[smoke\] \$\{/.test(line)) {
          offenders.push(`${m}: first word is interpolated, so it cannot be checked: ${line}`);
        } else if (
          /^\[smoke\] (SKIP|WARN)\b/.test(line) &&
          !SKIP_MARKERS.some((s) => line.startsWith(s.marker))
        ) {
          offenders.push(`${m}: unregistered "${line}" — add it to SKIP_MARKERS`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The SKIP/WARN line check above only sees `[smoke] `-prefixed lines. A
   * member can also record a SKIP or WARN as a row status and print it in a
   * table (`reads.ts` did, with `${r.status}`), which no line check can read.
   * So a member whose source assigns or compares a quoted 'SKIP' or 'WARN'
   * status must also print a registered marker with that verdict (#819
   * review). Status words that live only in an imported helper are out of
   * reach; `account-names.ts` still compares 'WARN' itself, so it is covered.
   */
  test('a member that records a SKIP or WARN status prints a registered marker for it', () => {
    const offenders: string[] = [];
    for (const m of members) {
      const source = fs.readFileSync(path.join(ROOT, m), 'utf8');
      const printed = printedLines(source);
      for (const verdict of ['SKIP', 'WARN'] as const) {
        if (!new RegExp(`['"\`]${verdict}['"\`]`).test(source)) continue;
        const registered = SKIP_MARKERS.filter((s) => s.verdict === verdict);
        if (!printed.some((l) => registered.some((s) => l.startsWith(s.marker)))) {
          offenders.push(
            `${m}: has a '${verdict}' status but prints no ${verdict} SKIP_MARKERS line`
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every registered skip marker is printed by some member', () => {
    const printed = members.flatMap(linesOf);
    const dead = SKIP_MARKERS.filter((s) => !printed.some((l) => l.startsWith(s.marker)));
    expect(dead.map((s) => s.marker)).toEqual([]);
  });

  test('no stale entries: every classified script is still in the composite', () => {
    expect(Object.keys(MARKER_OF).filter((m) => !members.includes(m))).toEqual([]);
  });
});
