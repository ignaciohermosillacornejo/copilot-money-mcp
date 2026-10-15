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
 * Members that print no drift marker. The four refresh smokes throw on a
 * failed assertion and the scheduled run reports that as `incomplete`. That is
 * right for their local assertions (e.g. a warm-cache timing bound), but some
 * of what they assert is server-controlled (budgets.ts: a non-empty budget
 * list, and `months_window` anchoring to the current month), so a server-side
 * change there is reported as "drift NOT checked" today. Exempt, so the gap is
 * visible here rather than silent; splitting the server-controlled assertions
 * behind their own marker is tracked in #819.
 */
const EXEMPT: Record<string, string> = {
  'scripts/smoke/budgets.ts': 'refresh smoke without a drift marker (#819)',
  'scripts/smoke/categories.ts': 'refresh smoke without a drift marker (#819)',
  'scripts/smoke/recurring.ts': 'refresh smoke without a drift marker (#819)',
  'scripts/smoke/tags.ts': 'refresh smoke without a drift marker (#819)',
};

function compositeMembers(): string[] {
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  // `stack` is the current path, not every alias seen so far: an alias used by
  // two steps is fine, and only one that reaches itself is a cycle.
  const walk = (name: string, stack: readonly string[] = []): string[] => {
    if (stack.includes(name)) {
      throw new Error(`package.json script cycle: ${[...stack, name].join(' -> ')}`);
    }
    const body = scripts[name];
    if (body === undefined) throw new Error(`package.json has no script "${name}"`);
    return body.split('&&').flatMap((part) => {
      const m = /^bun run (\S+)$/.exec(part.trim());
      if (!m) throw new Error(`unrecognised composite step in "${name}": ${part.trim()}`);
      const target = m[1] as string;
      return target.startsWith('scripts/') ? [target] : walk(target, [...stack, name]);
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
      // The marker must be the start of a console.error/console.log argument
      // (optionally after leading newlines), not merely somewhere in the file:
      // a copy in a comment or docblock would otherwise satisfy the check.
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const printed = new RegExp(`console\\.(?:error|log)\\(\\s*['"\`](?:\\\\n)*${escaped}`);
      if (!printed.test(fs.readFileSync(path.join(ROOT, m), 'utf8'))) {
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
