/**
 * Every member of the `bun run smoke` composite that checks for drift must
 * print a marker `scripts/scheduled-smoke.ts` recognises (#818).
 *
 * The scheduled runner classifies a nonzero run as `fail` (drift) only when
 * the output contains one of `DRIFT_VERDICT_MARKERS`; anything else becomes
 * `incomplete` and is reported as "drift NOT checked". So a drift check whose
 * failure line is not on that list turns real drift into a dismissed
 * non-completion. That happened twice: `synthesized-fields-conformance.ts`
 * joined the composite with its own wording, and #791 added
 * `account-names.ts` the same way.
 *
 * This walks the composite from `package.json` (following `bun run smoke:x`
 * aliases), so a new member must be classified here before it can join.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { DRIFT_VERDICT_MARKERS } from '../../scripts/scheduled-smoke.js';

const ROOT = path.join(import.meta.dir, '..', '..');

/** Drift checks, and the marker each prints before exiting nonzero. */
const MARKER_OF: Record<string, (typeof DRIFT_VERDICT_MARKERS)[number]> = {
  'scripts/smoke/conformance.ts': '[smoke] FAIL — conformance drift detected',
  'scripts/smoke/synthesized-fields-conformance.ts':
    '[smoke] FAIL — synthesized-field absence drift detected',
  'scripts/smoke/reads.ts': '[smoke] FAIL — read-surface drift detected',
  'scripts/smoke/account-names.ts': '[smoke] FAIL — account-name parity drift detected',
};

/**
 * Members that are not drift checks. The refresh scripts exercise the live
 * cache-refresh paths and throw on a broken refresh; that is an error in our
 * code, not a change in Copilot's API, so `incomplete` is the honest bucket.
 */
const EXEMPT: Record<string, string> = {
  'scripts/smoke/budgets.ts': 'refresh exerciser, not a drift check',
  'scripts/smoke/categories.ts': 'refresh exerciser, not a drift check',
  'scripts/smoke/recurring.ts': 'refresh exerciser, not a drift check',
  'scripts/smoke/tags.ts': 'refresh exerciser, not a drift check',
};

function compositeMembers(): string[] {
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const seen = new Set<string>();
  const walk = (name: string): string[] => {
    if (seen.has(name)) throw new Error(`package.json script cycle at ${name}`);
    seen.add(name);
    const body = scripts[name];
    if (body === undefined) throw new Error(`package.json has no script "${name}"`);
    return body.split('&&').flatMap((part) => {
      const m = /^bun run (\S+)$/.exec(part.trim());
      if (!m) throw new Error(`unrecognised composite step in "${name}": ${part.trim()}`);
      const target = m[1] as string;
      return target.startsWith('scripts/') ? [target] : walk(target);
    });
  };
  return walk('smoke');
}

describe('bun run smoke composite drift verdicts (#818)', () => {
  const members = compositeMembers();

  test('the composite resolves to script files', () => {
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(fs.existsSync(path.join(ROOT, m)), m).toBe(true);
  });

  test('every member is classified as a drift check or exempt, not both', () => {
    const unclassified = members.filter((m) => !(m in MARKER_OF) && !(m in EXEMPT));
    const both = members.filter((m) => m in MARKER_OF && m in EXEMPT);
    expect(unclassified, 'add the member to MARKER_OF or EXEMPT').toEqual([]);
    expect(both).toEqual([]);
  });

  test('every drift check prints a marker the scheduled runner recognises', () => {
    const missing: string[] = [];
    for (const m of members.filter((x) => x in MARKER_OF)) {
      const marker = MARKER_OF[m] as string;
      if (!(DRIFT_VERDICT_MARKERS as readonly string[]).includes(marker)) {
        missing.push(`${m}: marker not in DRIFT_VERDICT_MARKERS`);
      }
      if (!fs.readFileSync(path.join(ROOT, m), 'utf8').includes(marker)) {
        missing.push(`${m}: never prints "${marker}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('no stale entries: every classified script is still in the composite', () => {
    const listed = [...Object.keys(MARKER_OF), ...Object.keys(EXEMPT)];
    expect(listed.filter((m) => !members.includes(m))).toEqual([]);
  });
});
