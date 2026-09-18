/**
 * Behavioural tests for scripts/mutation-guards.ts — the `check:mutation-guards`
 * gate in `bun run check` and in `.github/workflows/test.yml`.
 *
 * The gate exists to catch a safety guard that executes but cannot fail
 * (#596, docs/bugs/596-vacuous-assertions-bulk-edit.md). A gate with that same
 * defect would be worse than none, so most of this file is the gate's own
 * mutation test: it is driven end-to-end against SYNTHETIC repositories — a
 * throwaway `src/` plus a throwaway test file — where the answer is known by
 * construction, the same way tests/scripts/check-workflows.test.ts drives its
 * gate against synthetic workflow trees.
 *
 * The negatives carry the weight, because each is a way the gate could report
 * green over nothing:
 *
 *   - a guard whose removal leaves its detector passing must be VACUOUS
 *     (the #596 instance itself, reproduced from scratch);
 *   - a detector that is red before any mutation must be rejected, so an
 *     always-failing test cannot be registered as proof of anything;
 *   - a mutation that leaves the file unparseable must be rejected, because
 *     "the test file went red" is satisfied by a broken mutation too;
 *   - a mutation that HANGS the detector must be killed and reported, not
 *     waited on — deleting an early exit is exactly the edit class that does
 *     that, and the hang would hold a tracked source file mutated;
 *   - a row whose named test passed while a SIBLING in the same detector file
 *     failed must fail, since four of the six real rows share one file;
 *   - a registry row deleted while its marker stays in `src/` must fail, since
 *     quietly dropping a row is the cheapest way to make this gate quiet;
 *   - a refused restore must surface as its own row and STOP the run, because
 *     the rows after it would otherwise read a third party's bytes as their
 *     `original`, and an unexpected throw must become a failing row rather than
 *     take every result computed so far with it.
 *
 * The restoration tests are the other half: this gate edits tracked source
 * files in place, so it has to put them back after a throw and after a SIGKILL
 * that skips every handler it could install — and it has to treat the journal
 * it recovers from as untrusted input, since that file is a list of "write
 * these bytes to that path" that runs before anything else.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMutation,
  assertRegistryConsistent,
  findMarkers,
  journalPath,
  MARKER_PREFIX,
  MUTATION_GUARDS,
  parseBunTestSummary,
  recoverJournal,
  REPO_ROOT,
  runGuards,
  withMutation,
  type MutationGuard,
} from '../../scripts/mutation-guards.js';

// --- Synthetic-repository helpers -----------------------------------------

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(journalPath(root), { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A two-file repository: one guarded source module, one detector.
 *
 * `guardLine` is the guard itself; `assertion` is the body of the detector's
 * second test. Varying just those two reproduces every outcome the gate has to
 * tell apart, without any of the real code being involved.
 */
function syntheticRepo(opts: {
  guardLine: string;
  assertion: string;
  markerName: string;
  /** Emit a loop whose ONLY exit is the guard, so removing it never returns. */
  nonTerminating?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'mutation-guards-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 't'));
  writeFileSync(
    join(root, 'src/pay.ts'),
    (opts.nonTerminating === true
      ? [
          'export function pay(rows: string[], failAt: string): string[] {',
          '  const written: string[] = [];',
          '  for (let i = 0; ; i++) {',
          '    const row = rows[i % rows.length]!;',
          // Capped: the point of this fixture is that it never RETURNS, not
          // that it exhausts the machine. Without the cap, raising the timeout
          // — the instinctive response to a flaky hang test — turns it into an
          // OOM of the runner.',
          '    if (written.length > 64) { i = 0; written.length = 0; }',
          '    if (row === failAt) {',
          `      ${MARKER_PREFIX}${opts.markerName}`,
          `      ${opts.guardLine}`,
          '    }',
          '    written.push(row);',
          '  }',
          '  return written;',
          '}',
          '',
        ]
      : [
          'export function pay(rows: string[], failAt: string): string[] {',
          '  const written: string[] = [];',
          '  for (const row of rows) {',
          '    if (row === failAt) {',
          `      ${MARKER_PREFIX}${opts.markerName}`,
          `      ${opts.guardLine}`,
          '    }',
          '    written.push(row);',
          '  }',
          '  return written;',
          '}',
          '',
        ]
    ).join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 't/pay.test.ts'),
    [
      "import { expect, test } from 'bun:test';",
      "import { pay } from '../src/pay.js';",
      '',
      "test('writes everything when nothing fails', () => {",
      // The non-terminating fixture's only loop exit IS the guard, so even its
      // unmutated form must be called with a row that trips it — otherwise the
      // BASELINE run hangs and the test proves nothing about the mutated one.
      opts.nonTerminating === true
        ? "  expect(pay(['a', 'b', 'c'], 'c')).toEqual(['a', 'b']);"
        : "  expect(pay(['a', 'b', 'c'], 'none')).toEqual(['a', 'b', 'c']);",
      '});',
      '',
      "test('the guard holds', () => {",
      `  ${opts.assertion}`,
      '});',
      '',
    ].join('\n'),
    'utf8'
  );
  return root;
}

function guardFor(root: string, over: Partial<MutationGuard> = {}): MutationGuard {
  const name = [...findMarkers(root)][0]?.[0] ?? 'unnamed';
  return {
    name,
    file: 'src/pay.ts',
    invariant: 'Rows after the failing one are never written.',
    mutation: {
      kind: 'remove',
      find: `\n      ${MARKER_PREFIX}${name}\n      break;`,
    },
    expectFails: 't/pay.test.ts',
    expectFailingTests: ['the guard holds'],
    ...over,
  };
}

/**
 * A second guarded file in the same synthetic root, so a run can have a row
 * AFTER the one whose restore is refused.
 */
function addSecondGuard(root: string, name: string): MutationGuard {
  writeFileSync(
    join(root, 'src/ship.ts'),
    [
      'export function ship(rows: string[], failAt: string): string[] {',
      '  const sent: string[] = [];',
      '  for (const row of rows) {',
      '    if (row === failAt) {',
      `      ${MARKER_PREFIX}${name}`,
      '      break;',
      '    }',
      '    sent.push(row);',
      '  }',
      '  return sent;',
      '}',
      '',
    ].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(root, 't/ship.test.ts'),
    [
      "import { expect, test } from 'bun:test';",
      "import { ship } from '../src/ship.js';",
      '',
      "test('the guard holds', () => {",
      "  expect(ship(['a', 'b', 'c'], 'b')).toEqual(['a']);",
      '});',
      '',
    ].join('\n'),
    'utf8'
  );
  return {
    name,
    file: 'src/ship.ts',
    invariant: 'Rows after the failing one are never sent.',
    mutation: { kind: 'remove', find: `\n      ${MARKER_PREFIX}${name}\n      break;` },
    expectFails: 't/ship.test.ts',
    expectFailingTests: ['the guard holds'],
  };
}

async function run(
  root: string,
  guards: readonly MutationGuard[],
  over: { timeoutMs?: number; baselineTimeoutMs?: number } = {}
) {
  return runGuards({ root, guards, ...over, log: () => {} });
}

// --- The real registry -----------------------------------------------------

describe('the registry agrees with the source tree', () => {
  test('no static problems: markers, uniqueness, files, detectors', () => {
    expect(assertRegistryConsistent(REPO_ROOT)).toEqual([]);
  });

  test('every mutation string matches exactly once in its file', () => {
    // Stated separately from the sweep above because it is the acceptance
    // criterion #596 named, and because a `find` that matches twice is the
    // defect three of the five seed entries proposed in that issue carried.
    for (const guard of MUTATION_GUARDS) {
      const content = readFileSync(join(REPO_ROOT, guard.file), 'utf8');
      expect(content.split(guard.mutation.find).length - 1).toBe(1);
    }
  });

  test('every registered guard marks its own site, and nothing else does', () => {
    const markers = [...findMarkers(REPO_ROOT).keys()].sort();
    expect(markers).toEqual(MUTATION_GUARDS.map((g) => g.name).sort());
  });

  test('a mutation actually changes the file it names', () => {
    for (const guard of MUTATION_GUARDS) {
      const content = readFileSync(join(REPO_ROOT, guard.file), 'utf8');
      expect(applyMutation(content, guard.mutation)).not.toBe(content);
    }
  });
});

// --- The gate's own mutation test, on synthetic repositories ---------------

describe('a guard is only green when its detector really detects it', () => {
  test('a real detector passes unmutated and fails mutated', async () => {
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      // Pins the PROPERTY: the tail must not be written.
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const { ok, results } = await run(root, [guardFor(root)]);
    expect(results.map((r) => r.detail).join('\n')).toBeTruthy();
    expect(ok).toBe(true);
  });

  test('VACUOUS: a detector satisfied by both behaviours fails the gate', async () => {
    // The #596 instance, rebuilt: the assertion is true whether or not the
    // guard is there, which is precisely what 98.7% patch coverage could not
    // see. Nothing about it is red until this gate runs.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b').length).toBeGreaterThan(0);",
    });
    const { ok, results } = await run(root, [guardFor(root)]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('VACUOUS');
  });

  test('a detector that is red before any mutation is rejected', async () => {
    // Otherwise the registry is satisfiable by writing `expect(1).toBe(2)`:
    // the mutated run would "fail" exactly as required, proving nothing. The
    // unmutated direction is checked first for this reason.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a'], 'a')).toEqual(['never']);",
    });
    const { ok, results } = await run(root, [guardFor(root)]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('does not PASS unmutated');
  });

  test('a mutation that leaves the file unparseable is not a detection', async () => {
    // "The test file went red" is also what a syntax error looks like. Without
    // this, any entry could be made green by choosing a `find` that breaks the
    // parse — the guard would never be exercised at all.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const broken = guardFor(root, {
      mutation: {
        kind: 'replace',
        find: `      ${MARKER_PREFIX}rows after the failure are never written\n      break;`,
        with: `      ${MARKER_PREFIX}rows after the failure are never written\n      break; ((( ;`,
      },
    });
    const { ok, results } = await run(root, [broken]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toMatch(/tests RAN|module-level/);
  });

  test('deleting the registry row while the marker stays fails the gate', async () => {
    // The cheapest false green for a ledger like this. It cannot be made
    // impossible, but the marker bijection makes it a two-file edit that a
    // reviewer sees rather than one silent deletion.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const { ok, results } = await run(root, []);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('marker with no registry entry');
  });

  test('a mutation string that no longer matches is an error, not a skip', async () => {
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const drifted = guardFor(root, {
      mutation: {
        kind: 'remove',
        find: `\n      ${MARKER_PREFIX}rows after the failure are never written\n      return written;`,
      },
    });
    const { ok, results } = await run(root, [drifted]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('matches 0 times');
  });

  test('an entry whose find omits its marker is rejected', async () => {
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const unanchored = guardFor(root, {
      mutation: { kind: 'remove', find: '\n      break;' },
    });
    const { ok, results } = await run(root, [unanchored]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('does not contain its site marker');
  });

  test('a mutation that hangs the detector is killed, not counted as a detection', async () => {
    // The edit class most of these rows belong to is "delete an early exit", so
    // "the loop never ends" is a realistic outcome, not a contrived one. Without
    // a bound the pre-push hook would block forever with a tracked source file
    // mutated on disk. Short timeout here; the real one is TEST_TIMEOUT_MS.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
      nonTerminating: true,
    });
    // Only the MUTATED run is bounded at 3s; the baseline keeps the real
    // bound, so a slow cold runner cannot fail this test with a message about
    // the wrong thing.
    const { ok, results } = await run(root, [guardFor(root)], { timeoutMs: 3000 });
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('was killed after');
    // And the file is back, which is the part that would actually hurt.
    expect(readFileSync(join(root, 'src/pay.ts'), 'utf8')).toContain('break;');
  }, 60_000);

  test('a row riding on a sibling test in a shared detector file fails', async () => {
    // `expectFails` alone is satisfied by ANY test in the file going red. Four
    // of the six real rows share one detector file, so this is the shape by
    // which a row keeps printing a tick after its own coverage has rotted.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const misnamed = guardFor(root, {
      expectFailingTests: ['writes everything when nothing fails'],
    });
    const { ok, results } = await run(root, [misnamed]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('not because of the test(s) this row names');
  });

  test('a row naming a test that is not in its detector file fails statically', async () => {
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const renamed = guardFor(root, { expectFailingTests: ['a test nobody wrote'] });
    const { ok, results } = await run(root, [renamed]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('does not appear in');
  });

  test('a refused restore is reported as its own row, and stops the run', async () => {
    // The branch the previous review round was about, and the only one in this
    // file that had no test of its own. The first row's detector overwrites the
    // mutated source from inside the run — standing in for an editor saving
    // while the file is mutated — so restore is refused. Two things must then
    // happen: the run says so in a NAMED row (otherwise the summary reads "0 of
    // 2 failed" over exit 1, in the one outcome that needs hand reconciliation),
    // and the second row never runs, because its `original` would be the third
    // party's bytes.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: [
        // Relative path: bun test runs with cwd = the synthetic root. Guarded
        // on the mutation being present so the BASELINE run leaves the file
        // alone — clobbering it there would break the run before any mutation
        // and test something else entirely. Written before the assertion,
        // since a failing expect() ends the test body.
        "const fs = require('node:fs');",
        "if (!fs.readFileSync('src/pay.ts', 'utf8').includes('break;'))",
        "  fs.writeFileSync('src/pay.ts', 'SOMEONE ELSE WAS HERE');",
        "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
      ].join('\n  '),
    });
    const first = guardFor(root);
    const second = addSecondGuard(root, 'a second marked site');

    const { ok, results } = await run(root, [first, second]);

    expect(ok).toBe(false);
    const restore = results.find((r) => r.name === '(restore)');
    expect(restore?.detail).toContain('mutation-guard-original');
    expect(results.map((r) => r.name)).not.toContain(second.name);
    // And the report says so, rather than reading as a one-row registry.
    const skipped = results.find((r) => r.name === '(skipped)');
    expect(skipped?.detail).toContain(second.name);
  });

  test('a killed BASELINE is diagnosed as the detector, not as a red-either-way test', async () => {
    // Without its own branch this lands in "does not PASS unmutated", whose
    // advice — rewrite your detector — is the wrong fix for a run that never
    // finished.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const { ok, results } = await run(root, [guardFor(root)], { baselineTimeoutMs: 1 });
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('UNMUTATED run');
    expect(results[0]?.detail).toContain('nothing was proved');
  });

  test('an unexpected throw becomes a failing row, not a lost run', async () => {
    // Reachable, not hypothetical: a detector that rewrites its own source
    // during the BASELINE run leaves `find` absent by the time applyMutation
    // reads the file, and that throw used to escape runGuards entirely — taking
    // every result already computed, and the `(restore)` row, with it.
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: [
        "require('node:fs').writeFileSync('src/pay.ts', 'export const pay = () => [];');",
        'expect(1).toBe(1);',
      ].join('\n  '),
    });
    const { ok, results } = await run(root, [guardFor(root)]);
    expect(ok).toBe(false);
    expect(results[0]?.detail).toContain('the runner threw while evaluating this row');
    expect(results[0]?.detail).toContain('find string not present');
  });

  test('--guard selects one entry, and an unknown name is an error', async () => {
    const root = syntheticRepo({
      markerName: 'rows after the failure are never written',
      guardLine: 'break;',
      assertion: "expect(pay(['a', 'b', 'c'], 'b')).toEqual(['a']);",
    });
    const guard = guardFor(root);
    const selected = await runGuards({ root, guards: [guard], only: guard.name, log: () => {} });
    expect(selected.ok).toBe(true);
    expect(selected.results).toHaveLength(1);

    const missing = await runGuards({ root, guards: [guard], only: 'nope', log: () => {} });
    expect(missing.ok).toBe(false);
    expect(missing.results[0]?.detail).toContain('no guard named');
  });
});

// --- Restoration -----------------------------------------------------------

describe('the working tree is put back whatever happens', () => {
  test('a throw inside the mutated window still restores', async () => {
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    const file = join(root, 'src/pay.ts');
    const original = readFileSync(file, 'utf8');

    await expect(
      withMutation(root, 'src/pay.ts', 'MUTATED', () => {
        expect(readFileSync(file, 'utf8')).toBe('MUTATED');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(journalPath(root))).toBe(false);
  });

  test('a SIGKILL leaves the file mutated, and the next run recovers it', () => {
    // SIGKILL is the one thing no handler can catch, so this is the case the
    // on-disk journal exists for. Asserting the file IS mutated first is the
    // point: it proves the kill really did bypass `finally`, so the recovery
    // below is doing the work rather than following a restore that already ran.
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    const file = join(root, 'src/pay.ts');
    const original = readFileSync(file, 'utf8');

    const child = join(root, 'crash.ts');
    writeFileSync(
      child,
      [
        `import { withMutation } from ${JSON.stringify(join(REPO_ROOT, 'scripts/mutation-guards.ts'))};`,
        `await withMutation(${JSON.stringify(root)}, 'src/pay.ts', 'MUTATED', async () => {`,
        "  process.kill(process.pid, 'SIGKILL');",
        '  await new Promise((r) => setTimeout(r, 10_000));',
        '});',
        '',
      ].join('\n'),
      'utf8'
    );
    const res = spawnSync('bun', ['run', child], { cwd: root, encoding: 'utf8' });
    expect(res.signal).toBe('SIGKILL');

    expect(readFileSync(file, 'utf8')).toBe('MUTATED');
    expect(existsSync(journalPath(root))).toBe(true);

    const report = recoverJournal(root);
    expect(report.refused).toEqual([]);
    expect(report.recovered).toEqual([file]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(journalPath(root))).toBe(false);
  });

  test('a file changed while mutated is left alone, with the original beside it', async () => {
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    const file = join(root, 'src/pay.ts');

    await withMutation(root, 'src/pay.ts', 'MUTATED', () => {
      // Someone else's editor saving over the mutated file.
      writeFileSync(file, 'SOMEONE ELSE WAS HERE', 'utf8');
    });

    expect(readFileSync(file, 'utf8')).toBe('SOMEONE ELSE WAS HERE');
    expect(readFileSync(`${file}.mutation-guard-original`, 'utf8')).toContain(
      'export function pay'
    );
  });

  test('a journal owned by a live process is refused rather than raced', () => {
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    mkdirSync(join(journalPath(root), '..'), { recursive: true });
    writeFileSync(
      journalPath(root),
      JSON.stringify({
        // This process: alive by definition, and not us, since recoverJournal
        // only waives the check for its own pid.
        pid: process.ppid,
        startedAt: new Date().toISOString(),
        // One REAL entry. The refusal is about two runs restoring each other's
        // originals, so it is gated on the journal naming a file at all — see
        // the sibling test below for why an entry-less one must not brick the
        // gate.
        entries: [{ abs: join(root, 'src/pay.ts'), original: 'ORIGINAL', mutated: 'MUTATED' }],
      }),
      'utf8'
    );
    expect(() => recoverJournal(root)).toThrow(/another run/);
  });

  test('an entry-less journal from a live pid does not brick the gate', () => {
    // Reachable by accident through pid reuse, and the consequence would be
    // every `bun run check` in the checkout throwing until someone found a file
    // and deleted it — the same failure the unreadable-journal branch exists to
    // avoid. writeJournal never emits an empty entry list for a root, so such a
    // journal names no file the two runs could collide over.
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    mkdirSync(join(journalPath(root), '..'), { recursive: true });
    writeFileSync(
      journalPath(root),
      JSON.stringify({ pid: process.ppid, startedAt: '', entries: [] }),
      'utf8'
    );
    expect(recoverJournal(root)).toEqual({ recovered: [], refused: [] });
    expect(existsSync(journalPath(root))).toBe(false);
  });

  test('a journal entry pointing outside the run root is ignored, not obeyed', () => {
    // journalPath() is predictable and on Linux tmpdir() is the shared /tmp, so
    // a planted journal would otherwise be an arbitrary-file-write primitive
    // that fires on every `bun run check`, before anything else runs. The pid
    // field is no defence — a planted journal names a dead pid.
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    const outsider = join(mkdtempSync(join(tmpdir(), 'mutation-guards-victim-')), 'victim.txt');
    roots.push(join(outsider, '..'));
    writeFileSync(outsider, 'ORIGINAL CONTENT', 'utf8');

    mkdirSync(join(journalPath(root), '..'), { recursive: true });
    writeFileSync(
      journalPath(root),
      JSON.stringify({
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        entries: [
          { abs: outsider, original: 'PLANTED', mutated: 'ANYTHING' },
          // Structurally corrupt: without validation this reaches
          // writeFileSync(undefined, undefined) and throws a TypeError instead
          // of the intended message.
          {},
        ],
      }),
      'utf8'
    );

    expect(recoverJournal(root)).toEqual({ recovered: [], refused: [] });
    expect(readFileSync(outsider, 'utf8')).toBe('ORIGINAL CONTENT');
  });

  test('an unreadable journal is discarded, not left to block every future run', () => {
    // The journal is recovery state, not a source of truth. A truncated write
    // (the crash case it exists for can truncate it too) must not turn into a
    // gate that throws on every `bun run check` until someone finds a file in
    // the temp dir and deletes it by hand.
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    mkdirSync(join(journalPath(root), '..'), { recursive: true });
    writeFileSync(journalPath(root), '{"pid": 1, "entr', 'utf8');

    expect(recoverJournal(root)).toEqual({ recovered: [], refused: [] });
    expect(existsSync(journalPath(root))).toBe(false);
  });

  test('a journal whose file is already back is a no-op', () => {
    // The ordinary case after a clean run that was killed between restoring the
    // file and deleting the journal: recovery must not report having fixed
    // something it did not touch.
    const root = syntheticRepo({
      markerName: 'x',
      guardLine: 'break;',
      assertion: 'expect(1).toBe(1);',
    });
    const file = join(root, 'src/pay.ts');
    mkdirSync(join(journalPath(root), '..'), { recursive: true });
    writeFileSync(
      journalPath(root),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        entries: [{ abs: file, original: readFileSync(file, 'utf8'), mutated: 'MUTATED' }],
      }),
      'utf8'
    );

    expect(recoverJournal(root)).toEqual({ recovered: [], refused: [] });
    expect(existsSync(journalPath(root))).toBe(false);
  });
});

// --- Output parsing --------------------------------------------------------

describe('bun output is read for the difference that matters', () => {
  test('an ordinary failure reports a count and no error line', () => {
    const summary = parseBunTestSummary(
      ['(fail) b [0.78ms]', '', ' 1 pass', ' 1 fail', 'Ran 2 tests across 1 file. [8.00ms]'].join(
        '\n'
      ),
      1
    );
    expect(summary).toMatchObject({ ran: 2, pass: 1, fail: 1, errors: 0 });
  });

  test('a module that will not parse reports an error line and a different count', () => {
    // This is what makes the two indistinguishable on exit code alone, and why
    // the gate compares both numbers against the unmutated baseline.
    const summary = parseBunTestSummary(
      [
        'error: Unexpected end of file',
        '',
        ' 0 pass',
        ' 1 fail',
        ' 1 error',
        'Ran 1 test across 1 file. [7.00ms]',
      ].join('\n'),
      1
    );
    expect(summary).toMatchObject({ ran: 1, fail: 1, errors: 1 });
  });

  test('failing test names are captured, with or without a timing suffix', () => {
    const summary = parseBunTestSummary(
      [
        '(fail) a describe > a test [0.78ms]',
        '(fail) another test',
        ' 1 pass',
        ' 2 fail',
        'Ran 3 tests across 1 file.',
      ].join('\n'),
      1
    );
    expect(summary.failingTests).toEqual(['a describe > a test', 'another test']);
  });

  test('output with no summary at all reports ran: null', () => {
    expect(parseBunTestSummary('bun: command not found', 127).ran).toBeNull();
  });
});
