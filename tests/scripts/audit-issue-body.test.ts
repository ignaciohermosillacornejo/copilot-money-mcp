/**
 * The audit workflow's body renderer (.github/audit-issue-body.jq).
 *
 * `audit-reviews.yml` writes one Markdown section per unaddressed finding into
 * the issue (or PR comment) it files. The filter's contract is stated in the
 * workflow itself — "BOTH bodies list EVERY finding, not just the escalating
 * ones, so lowering the threshold later never recovers information that was
 * lost — it was never lost" — and until this file existed nothing held it: the
 * renderer called `ascii_upcase` on `.severity` unguarded, which throws on a
 * missing or non-string value, and the step runs under `set -e`. One
 * unclassifiable finding therefore took its whole BATCH down, before any issue
 * or comment was filed.
 *
 * As with tests/scripts/audit-severity-gate.test.ts, this runs the REAL filter
 * file the workflow reads. That is also why the filter is a file at all: an
 * inline `run:` block is unreachable from here, and the claim above would stay
 * a comment.
 *
 * The pairing with the severity gate is the property worth keeping if this file
 * is ever trimmed: the gate counts an unclassifiable finding as ESCALATING, so
 * the issue it opens is one this renderer has to be able to print.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FILTER = join(import.meta.dir, '../../.github/audit-issue-body.jq');

/** Render a batch of findings exactly as the workflow does. */
function render(findings: unknown[]): string {
  return execFileSync('jq', ['-r', '-f', FILTER], {
    input: JSON.stringify({ unaddressed: findings }),
    encoding: 'utf-8',
  });
}

const FULL = {
  severity: 'high',
  summary: 'a summary',
  file: 'src/thing.ts',
  line: 12,
  quote: 'what the reviewer said',
  evidence: 'why it is not applied',
};

describe('audit issue body renderer', () => {
  test('guards the filter: the file the workflow reads actually exists', () => {
    // If this path moves, every assertion below would fail through
    // execFileSync rather than saying what happened. Named explicitly, the
    // same way the severity gate's own existence is.
    expect(existsSync(FILTER)).toBe(true);
  });

  test('renders a well-formed finding in full', () => {
    const out = render([FULL]);
    expect(out).toContain('### HIGH: a summary');
    expect(out).toContain('- **File:** `src/thing.ts`:12');
    expect(out).toContain('- **Reviewer said:** > what the reviewer said');
    expect(out).toContain('- **Evidence not applied:** why it is not applied');
  });

  test('omits the line suffix entirely when there is no line number', () => {
    // Not `:null` — the guard is an `if`, not a coalesce, for this reason.
    const { line: _line, ...noLine } = FULL;
    const out = render([noLine]);
    expect(out).toContain('- **File:** `src/thing.ts`\n');
    expect(out).not.toContain('null');
  });

  // --- the crash class: an unclassifiable finding must not take the batch ---

  test('a finding with NO severity renders, and its siblings survive it', () => {
    // The regression in one row. Under the old filter this input aborted the
    // step, so the SECOND finding — perfectly well-formed, and the reason the
    // issue was being opened — was never filed either.
    const out = render([{ ...FULL, severity: undefined, summary: 'no severity' }, FULL]);
    expect(out).toContain('### UNSPECIFIED: no severity');
    expect(out).toContain('### HIGH: a summary');
  });

  test('a NON-STRING severity renders instead of throwing', () => {
    // `ascii_upcase` refuses a number as loudly as it refuses null, and
    // `// "unspecified"` alone would not have covered this one — hence the
    // `tostring`. A throw here surfaces as execFileSync raising, not as a
    // mismatched string.
    expect(render([{ ...FULL, severity: 3 }])).toContain('### 3: a summary');

    // `false` takes the OTHER branch, and that is jq, not a second guard: `//`
    // is "not null and not false", so a false severity reads as absent. Worth
    // pinning because the two non-string cases land in different places and
    // both have to land somewhere.
    expect(render([{ ...FULL, severity: false }])).toContain('### UNSPECIFIED: a summary');
  });

  test('every finding in a batch is rendered', () => {
    // The workflow's "nothing is dropped either way" claim, as an assertion
    // over a mixed batch rather than as prose next to the threshold.
    const out = render([
      { ...FULL, severity: 'low', summary: 'one' },
      { ...FULL, severity: 'medium', summary: 'two' },
      { ...FULL, summary: 'three' },
    ]);
    expect(out.match(/^### /gm) ?? []).toHaveLength(3);
  });
});
