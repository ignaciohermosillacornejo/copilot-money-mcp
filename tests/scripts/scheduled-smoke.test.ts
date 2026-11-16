/**
 * Outcome classification for the scheduled drift check (#440).
 *
 * Two critical properties, both learned the hard way (see
 * docs/bugs/661-non-completion-classified-as-drift.md):
 *
 *  1. `fail` means "the smoke reached a verdict and the verdict was drift".
 *     It is never the fallthrough bucket. A run that was killed, crashed, or
 *     failed in a way this classifier does not model is `incomplete` —
 *     absence of completion is not presence of drift.
 *  2. Auth failures classify as `auth-missing`, never `pass` (absence of auth
 *     is not absence of drift) and never `fail` (logged-out is not drift).
 */
import { describe, expect, test } from 'bun:test';
import {
  DRIFT_VERDICT_MARKERS,
  SKIP_MARKERS,
  classifySmokeOutcome,
  findNotChecked,
  notCheckedFor,
  runScheduledSmoke,
  summarizeSmokeOutput,
  type SmokeRunResult,
} from '../../scripts/scheduled-smoke.js';
import {
  SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS,
  SCHEDULED_SMOKE_NOT_CHECKED_MAX,
} from '../../src/utils/scheduled-smoke-status.js';

/** A completed run: spawnSync reports a numeric exit code and no signal. */
function completed(status: number, output: string): SmokeRunResult {
  return { status, signal: null, errorCode: null, output };
}

const CONFORMANCE_DRIFT = [
  '[smoke] value { enum: "RecurringFrequency", value: "WEEKLY", serverValid: true }',
  '[smoke] FAIL — conformance drift detected:',
  '  - [RecurringFrequency] BIWEEKLY REJECTED by server',
].join('\n');

const READ_DRIFT = [
  '[smoke] Read smoke summary:',
  '[smoke] FAIL — read-surface drift detected:',
  '  - [Networth] response missing required field',
].join('\n');

/**
 * Real non-drift failure modes, reproduced in shape from the archived reports
 * under ~/.claude/copilot-money/smoke-reports/. Figures are synthetic — the
 * real reports embed live balances and budget totals (PII).
 */
const NON_DRIFT_FAILURES: Array<{ name: string; run: SmokeRunResult }> = [
  {
    // The 2026-08-17 report: laptop asleep at the scheduled slot, launchd
    // coalesced the run onto a dark wake, system sleep froze the process, and
    // the 10-minute *wall-clock* timeout fired on the next full wake.
    name: 'killed by the spawnSync timeout mid-run, after every gate had passed',
    run: {
      status: null,
      signal: 'SIGTERM',
      errorCode: 'ETIMEDOUT',
      output: [
        '[smoke] PASS — all 5 enums and 15 input types match the server.',
        '[smoke] PASS — 19/19 read operations verified against the server.',
        '[smoke] cold { rows: 10, total: 100, hit: false, ms: 100 }',
        'error: script "smoke" was terminated by signal SIGTERM (Polite quit request)',
        '[smoke] months_window=1 {',
      ].join('\n'),
    },
  },
  {
    name: 'killed by a signal with no spawn-level error',
    run: { status: null, signal: 'SIGKILL', errorCode: null, output: '[smoke] value ...' },
  },
  {
    name: 'the runner could not spawn bun at all',
    run: { status: null, signal: null, errorCode: 'ENOENT', output: '' },
  },
  {
    // The 2026-06-15 .. 2026-07-27 reports: seven consecutive weeks of
    // "drift check FAILED" that were really "you are logged out".
    name: "the smoke's own auth-failure wording (#530 candidates.slice era)",
    run: completed(
      1,
      [
        '[smoke] FAIL — could not acquire an authenticated Copilot session, no probes were sent.',
        '        The conformance smoke needs a logged-in app.copilot.money browser session',
        "        Underlying error: undefined is not an object (evaluating 'candidates.slice')",
      ].join('\n')
    ),
  },
  {
    name: 'the read smoke could not acquire a session',
    run: completed(
      1,
      '[smoke] FAIL — could not acquire an authenticated Copilot session, no reads were sent.'
    ),
  },
  {
    name: 'no browser session found',
    run: completed(1, 'error: No Copilot Money session found. Searched: Chrome, Safari'),
  },
  {
    name: 'foreign Firebase token (#454)',
    run: completed(
      1,
      'error: Firebase token exchange failed (400): {"error":{"message":"PROJECT_NUMBER_MISMATCH"}}'
    ),
  },
  {
    name: 'mid-run session expiry',
    run: completed(
      1,
      'error: validation probe got a non-JSON response (HTTP 401) — likely an expired or unauthenticated session'
    ),
  },
  {
    name: 'an unmodelled crash with no verdict of any kind',
    run: completed(1, 'error: Cannot find module "../../src/tools/live/budgets.js"'),
  },
  {
    name: 'the machine lost the network before any probe landed',
    run: completed(1, '[graphql] Categories failed: code=NETWORK\nerror: fetch failed'),
  },
];

describe('classifySmokeOutcome', () => {
  test('a clean exit is a pass', () => {
    expect(classifySmokeOutcome(completed(0, '[smoke] PASS — all good'))).toBe('pass');
  });

  test('a conformance drift verdict is a fail', () => {
    expect(classifySmokeOutcome(completed(1, CONFORMANCE_DRIFT))).toBe('fail');
  });

  test('a read-surface drift verdict is a fail', () => {
    expect(classifySmokeOutcome(completed(1, READ_DRIFT))).toBe('fail');
  });

  test('a drift verdict already printed before the kill still counts as drift', () => {
    expect(
      classifySmokeOutcome({
        status: null,
        signal: 'SIGTERM',
        errorCode: 'ETIMEDOUT',
        output: CONFORMANCE_DRIFT,
      })
    ).toBe('fail');
  });

  test('a run killed by the wall-clock timeout is incomplete, not drift', () => {
    const timedOut = NON_DRIFT_FAILURES[0]!.run;
    expect(classifySmokeOutcome(timedOut)).toBe('incomplete');
  });

  test("the smoke's own auth-failure wording is auth-missing, not drift", () => {
    expect(
      classifySmokeOutcome(
        completed(
          1,
          '[smoke] FAIL — could not acquire an authenticated Copilot session, no probes were sent.'
        )
      )
    ).toBe('auth-missing');
  });

  test('an unmodelled nonzero exit is incomplete, not drift', () => {
    expect(classifySmokeOutcome(completed(1, 'error: something nobody predicted'))).toBe(
      'incomplete'
    );
  });

  describe.each(NON_DRIFT_FAILURES)('non-drift failure: $name', ({ run }) => {
    test('never classifies as drift', () => {
      expect(classifySmokeOutcome(run)).not.toBe('fail');
    });

    test('never classifies as pass', () => {
      expect(classifySmokeOutcome(run)).not.toBe('pass');
    });
  });

  /**
   * The class-level invariant, not another instance. `fail` is the state that
   * fires a "conformance failure" alarm and sends the reader hunting for API
   * drift; it must be reachable only with positive evidence that the smoke
   * printed a drift verdict. Delete the marker check in the classifier and
   * this goes red for every fixture above.
   */
  test('fail is reachable only when the output carries a drift verdict', () => {
    const corpus: SmokeRunResult[] = [
      ...NON_DRIFT_FAILURES.map((f) => f.run),
      completed(0, '[smoke] PASS'),
      completed(1, CONFORMANCE_DRIFT),
      completed(1, READ_DRIFT),
      completed(2, ''),
      { status: null, signal: 'SIGTERM', errorCode: 'ETIMEDOUT', output: CONFORMANCE_DRIFT },
    ];
    for (const run of corpus) {
      if (classifySmokeOutcome(run) === 'fail') {
        expect(DRIFT_VERDICT_MARKERS.some((m) => run.output.includes(m))).toBe(true);
      }
    }
    // Guard against the invariant holding vacuously.
    expect(corpus.filter((r) => classifySmokeOutcome(r) === 'fail')).toHaveLength(3);
  });
});

describe('summarizeSmokeOutput', () => {
  test('uses the last [smoke] marker line', () => {
    const out = '[smoke] value ...\n[ledger] distribution ...\n[smoke] PASS — all 3 enums match.';
    expect(summarizeSmokeOutput('pass', completed(0, out))).toBe(
      '[smoke] PASS — all 3 enums match.'
    );
  });

  test('fail summaries also come from the last [smoke] marker line', () => {
    expect(summarizeSmokeOutput('fail', completed(1, CONFORMANCE_DRIFT))).toBe(
      '[smoke] FAIL — conformance drift detected:'
    );
  });

  /**
   * Captured from a real full `bun run smoke`: the composite ends with the
   * refresh smokes, whose last line is an object-open brace. Picking "the last
   * [smoke] line" therefore summarized a clean run as `[smoke] done {`. The
   * summary must track the last *verdict*, not the last line that happens to
   * carry the prefix.
   */
  test('a clean full run summarizes to its last verdict, not its last log line', () => {
    const out = [
      '[smoke] PASS — all 5 enums and 15 input types match the server.',
      '[smoke] accounts {',
      '[smoke] PASS — 19/19 read operations verified against the server.',
      '[smoke] cold {',
      '[smoke] recold {',
      '[smoke] done {',
    ].join('\n');
    expect(summarizeSmokeOutput('pass', completed(0, out))).toBe(
      '[smoke] PASS — 19/19 read operations verified against the server.'
    );
  });

  test('a drift verdict wins over later log lines too', () => {
    const out = [
      '[smoke] PASS — all 5 enums and 15 input types match the server.',
      '[smoke] FAIL — read-surface drift detected:',
      '[smoke] trailing debris {',
    ].join('\n');
    expect(summarizeSmokeOutput('fail', completed(1, out))).toBe(
      '[smoke] FAIL — read-surface drift detected:'
    );
  });

  test('falls back to the last [smoke] line when no verdict was printed', () => {
    expect(summarizeSmokeOutput('pass', completed(0, '[smoke] something unusual'))).toBe(
      '[smoke] something unusual'
    );
  });

  test('truncates summaries to 300 chars', () => {
    const out = `[smoke] ${'x'.repeat(500)}`;
    expect(summarizeSmokeOutput('fail', completed(1, out)).length).toBe(300);
  });

  test('auth-missing has a fixed actionable summary', () => {
    expect(summarizeSmokeOutput('auth-missing', completed(1, 'whatever'))).toContain(
      'drift NOT checked'
    );
  });

  /**
   * The pre-fix summary for the timed-out run was `[smoke] months_window=1 {`
   * — the last [smoke] line of a run that was cut off mid-sentence. An
   * incomplete run must describe how it ended, not quote its own debris.
   */
  test('incomplete summaries name the termination, not the last log line', () => {
    const summary = summarizeSmokeOutput('incomplete', NON_DRIFT_FAILURES[0]!.run);
    expect(summary).toContain('SIGTERM');
    expect(summary).toContain('drift NOT checked');
    expect(summary).not.toContain('months_window');
  });

  test('incomplete summaries report a plain nonzero exit when no signal fired', () => {
    const summary = summarizeSmokeOutput('incomplete', completed(3, 'error: unmodelled'));
    expect(summary).toContain('exit 3');
    expect(summary).toContain('drift NOT checked');
  });
});

describe('runScheduledSmoke', () => {
  /** Builds a fake spawn that returns the queued results in order. */
  function spawnQueue(results: SmokeRunResult[]): {
    spawn: () => SmokeRunResult;
    calls: () => number;
  } {
    let i = 0;
    return {
      spawn: () => results[i++] ?? results[results.length - 1]!,
      calls: () => i,
    };
  }

  const PASSING = completed(0, '[smoke] PASS — all 5 enums and 15 input types match the server.');
  const TIMED_OUT = NON_DRIFT_FAILURES[0]!.run;

  test('retries once when the first attempt never completed', () => {
    const q = spawnQueue([TIMED_OUT, PASSING]);
    const written: Record<string, unknown>[] = [];
    const code = runScheduledSmoke({
      spawn: q.spawn,
      write: (s) => written.push(s),
      notify: () => {},
    });
    expect(q.calls()).toBe(2);
    expect(code).toBe(0);
    expect(written.at(-1)?.result).toBe('pass');
  });

  test('does not retry a completed run', () => {
    const q = spawnQueue([completed(1, CONFORMANCE_DRIFT), PASSING]);
    const code = runScheduledSmoke({ spawn: q.spawn, write: () => {}, notify: () => {} });
    expect(q.calls()).toBe(1);
    expect(code).toBe(1);
  });

  test('does not retry a logged-out machine', () => {
    const q = spawnQueue([
      completed(1, 'error: No Copilot Money session found. Searched: Chrome, Safari'),
      PASSING,
    ]);
    const code = runScheduledSmoke({ spawn: q.spawn, write: () => {}, notify: () => {} });
    expect(q.calls()).toBe(1);
    expect(code).toBe(0);
  });

  test('reports incomplete when the retry also fails to complete', () => {
    const q = spawnQueue([TIMED_OUT, TIMED_OUT]);
    const written: Record<string, unknown>[] = [];
    const notified: string[] = [];
    const code = runScheduledSmoke({
      spawn: q.spawn,
      write: (s) => written.push(s),
      notify: (title) => notified.push(title),
    });
    expect(q.calls()).toBe(2);
    expect(code).toBe(1);
    expect(written.at(-1)?.result).toBe('incomplete');
    expect(notified.join(' ')).not.toContain('conformance failure');
  });

  test('an incomplete run never announces a conformance failure', () => {
    const q = spawnQueue([TIMED_OUT, TIMED_OUT]);
    const notified: Array<{ title: string; message: string }> = [];
    runScheduledSmoke({
      spawn: q.spawn,
      write: () => {},
      notify: (title, message) => notified.push({ title, message }),
    });
    expect(notified).toHaveLength(1);
    expect(notified[0]!.title).toContain('DID NOT COMPLETE');
  });
});

/**
 * #819: a member that exits 0 without having compared anything (SKIP), or
 * whose comparison could not discriminate (WARN), used to be indistinguishable
 * from a clean pass. Not an alarm, but the status must say what went unchecked.
 */
describe('members that were not checked (#819)', () => {
  const SKIPPED_RUN = completed(
    0,
    [
      '[smoke] PASS — 19/19 read operations verified against the server.',
      '[smoke] SKIP — account-name parity not checked: no local Copilot cache to compare against.',
      '[smoke] PASS — tags refresh smoke: 4 checks passed.',
    ].join('\n')
  );
  const WARNED_RUN = completed(
    0,
    '[smoke] WARN — account-name parity inconclusive: no discriminating accounts.\n' +
      '[smoke] PASS — tags refresh smoke: 4 checks passed.'
  );

  test('every registered skip marker is found', () => {
    for (const s of SKIP_MARKERS) {
      expect(findNotChecked(`${s.marker}: detail`)).toEqual([
        { check: s.check, verdict: s.verdict },
      ]);
    }
  });

  test('a run with no skip marker has nothing unchecked', () => {
    expect(findNotChecked('[smoke] PASS — all good')).toEqual([]);
  });

  test('a skipped member is still a pass (no new alarm state)', () => {
    expect(classifySmokeOutcome(SKIPPED_RUN)).toBe('pass');
  });

  test('the pass summary names the member that was not checked', () => {
    expect(summarizeSmokeOutput('pass', SKIPPED_RUN)).toContain(
      'NOT checked: account-name parity (SKIP)'
    );
    expect(summarizeSmokeOutput('pass', WARNED_RUN)).toContain(
      'NOT checked: account-name parity (WARN)'
    );
  });

  test('the status record lists skipped and warned members', () => {
    for (const [run, verdict] of [
      [SKIPPED_RUN, 'SKIP'],
      [WARNED_RUN, 'WARN'],
    ] as const) {
      const written: Record<string, unknown>[] = [];
      const code = runScheduledSmoke({
        spawn: () => run,
        write: (s) => written.push(s),
        notify: () => {},
      });
      expect(code).toBe(0);
      expect(written.at(-1)?.result).toBe('pass');
      expect(written.at(-1)?.not_checked).toEqual([{ check: 'account-name parity', verdict }]);
    }
  });

  test('a fully checked run records an empty list', () => {
    const written: Record<string, unknown>[] = [];
    runScheduledSmoke({
      spawn: () => completed(0, '[smoke] PASS — all good'),
      write: (s) => written.push(s),
      notify: () => {},
    });
    expect(written.at(-1)?.not_checked).toEqual([]);
  });

  test('every registered skip marker fits the reader bound', () => {
    // The writer records every marker a run prints; the reader keeps at most
    // SCHEDULED_SMOKE_NOT_CHECKED_MAX entries and truncates each name. A
    // marker past either bound would be recorded and then lost on read.
    expect(SKIP_MARKERS.length).toBeLessThanOrEqual(SCHEDULED_SMOKE_NOT_CHECKED_MAX);
    for (const s of SKIP_MARKERS) {
      expect(s.check.length).toBeLessThanOrEqual(SCHEDULED_SMOKE_CHECK_NAME_MAX_CHARS);
    }
  });

  test('only a pass records what it did not check', () => {
    const output = SKIP_MARKERS.map((s) => s.marker).join('\n');
    expect(notCheckedFor('pass', output)).toHaveLength(SKIP_MARKERS.length);
    for (const result of ['fail', 'incomplete', 'auth-missing'] as const) {
      expect(notCheckedFor(result, output)).toEqual([]);
    }
    const written: Record<string, unknown>[] = [];
    runScheduledSmoke({
      spawn: () =>
        completed(1, `${SKIP_MARKERS[0].marker}\n[smoke] FAIL — read-surface drift detected:`),
      write: (s) => written.push(s),
      notify: () => {},
    });
    expect(written.at(-1)?.result).toBe('fail');
    expect(written.at(-1)?.not_checked).toEqual([]);
  });

  test('skip markers never double as drift verdicts', () => {
    for (const s of SKIP_MARKERS) {
      expect(classifySmokeOutcome(completed(1, s.marker))).not.toBe('fail');
    }
  });
});
