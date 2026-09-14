/**
 * The `bun test` run itself must leave no LevelDB temp copy behind (#642).
 *
 * `src/core/leveldb-reader.ts` promises that a temp copy never outlives the
 * process that made it, and keeps that promise with `process.on('exit')` plus
 * the three termination signals (#631/#632). `bun test` honours none of it: the
 * runner hard-exits without emitting 'exit', so every temp copy made by a test
 * file that does not clean up in its own hooks was stranded in `$TMPDIR` — 46
 * per full run, measured on this repo, and they stack because repeat runs land
 * well inside the hour-long orphan-sweep window.
 *
 * `bunfig.toml` now preloads `tests/setup/temp-db-teardown.ts`, whose run-wide
 * `afterAll` does the sweep the runner skips. This file is the gate on that.
 *
 * WHY A CHILD PROCESS: the property is "nothing is left once the run is over",
 * which no test inside that same run can observe — the teardown has not fired
 * yet while we are still in it. So we run a real `bun test` as a child, with a
 * private `$TMPDIR` so the count is exact and can never collide with a
 * concurrent server, suite, or another worktree's run.
 *
 * WHY A SECOND, DELIBERATELY BROKEN RUN: an assertion that a directory is empty
 * passes just as happily when nothing ever wrote to it. The control run repeats
 * the identical probe with the preload disabled (`--config` pointed at an empty
 * bunfig) and requires a copy to be stranded. Delete the preload line from
 * `bunfig.toml` and the first test goes red; delete `cleanupAllTempDatabases`
 * from the teardown and it goes red too; break the probe so it never makes a
 * copy at all and the control goes red instead of the gate going quietly green.
 *
 * This gates the mechanism, not one test file: any future test that reads a
 * fixture database is covered by the same teardown, and any change that stops
 * the teardown running is caught here regardless of which file leaked.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * The leading `./` matters: without it bun reads the argument as a name filter
 * and, since the probe is deliberately not named `*.test.ts`, matches nothing.
 */
const PROBE = './tests/fixtures/temp-db-leak-probe.ts';

/** A child `bun test` invocation is two LevelDB fixtures and a worker decode. */
const PROBE_TIMEOUT_MS = 60_000;

interface ProbeRun {
  /** The private TMPDIR the child ran with. */
  tmpDir: string;
  /** `copilot-leveldb-*` directories still present after the child exited. */
  leftovers: string[];
  /** null when the child was signalled or never launched — see `signal`/`error`. */
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  output: string;
}

const runs: string[] = [];

/**
 * Run the leak probe as a real `bun test` child.
 *
 * @param preload - false disables `bunfig.toml`, and with it the run-wide
 *                  teardown, reproducing the pre-fix behaviour exactly.
 */
function runProbe(preload: boolean): ProbeRun {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-teardown-'));
  runs.push(tmpDir);

  const args = ['test'];
  if (!preload) {
    const emptyConfig = path.join(tmpDir, 'bunfig.toml');
    fs.writeFileSync(emptyConfig, '');
    args.push(`--config=${emptyConfig}`);
  }
  args.push(PROBE);

  // process.execPath is the bun binary that is running this suite, so the child
  // is the same runner rather than whatever `bun` resolves to on PATH.
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: tmpDir },
    encoding: 'utf8',
    // Without this a wedged child (a worker deadlock, a probe that awaits
    // something that never settles) hangs the whole job until CI kills it,
    // with nothing attributing the hang to this file.
    timeout: PROBE_TIMEOUT_MS,
  });

  const leftovers = fs
    .readdirSync(tmpDir)
    .filter((name) => name.startsWith('copilot-leveldb-'))
    .sort();

  return {
    tmpDir,
    leftovers,
    status: res.status,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

describe('a bun test run leaves no LevelDB temp copy behind', () => {
  let swept: ProbeRun;
  let control: ProbeRun;

  beforeAll(() => {
    swept = runProbe(true);
    control = runProbe(false);
    // Two full child `bun test` runs — each transpiles the decoder, builds two
    // LevelDB fixtures and decodes in a worker — against bun's 5s default hook
    // budget on a cold, coverage-instrumented CI runner. A hook that times out
    // leaves `swept`/`control` undefined and every test below fails with a
    // TypeError instead of its own message, so the budget is explicit.
    // Precedents: leveldb-reader-temp-cleanup.test.ts, mcpb-bundle.test.ts.
  }, 3 * PROBE_TIMEOUT_MS);

  afterAll(() => {
    for (const dir of runs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('guards the gate: both probe runs actually ran and passed', () => {
    // A probe that failed to launch — renamed, moved, or no longer matched by
    // the path argument — would leave an empty TMPDIR and make the sweep
    // assertion below pass over nothing.
    for (const [label, run] of [
      ['with the teardown', swept],
      ['without the teardown', control],
    ] as const) {
      expect(
        run.status,
        `The probe run ${label} did not exit 0 ` +
          `(signal=${run.signal ?? 'none'}, spawn error=${run.error?.message ?? 'none'}). ` +
          `Three things put it here: one of the probes failed its own assertion — the child ` +
          `output below names it, and the worker-sweep probe asserts there — or the child was ` +
          `killed at the ${PROBE_TIMEOUT_MS}ms timeout, or it never launched, in which case ` +
          `check that ${PROBE} still exists, still holds both probes, and is still excluded ` +
          `from the normal suite by its name.\n${run.output}`
      ).toBe(0);
      // Both probes must have run: a filtered or renamed one would read the
      // copy path fewer times than this file assumes. These two match bun's
      // own summary wording, so a bun release that rewords it fails HERE — if
      // that is what happened, these assertions are the stale thing, not the
      // teardown.
      const summary =
        `(bun summary wording; if bun changed it, fix this assertion, not the ` +
        `teardown)\n${run.output}`;
      expect(run.output, summary).toContain('Ran 2 tests');
      expect(run.output, summary).toContain('0 fail');
    }
  });

  test('guards the gate: the same run strands a copy when the teardown is removed', () => {
    // The control. Without it, "no leftovers" would also be the verdict for a
    // probe that never made a copy in the first place.
    expect(
      control.leftovers.length,
      `The probe run with bunfig.toml disabled left NO temp copy behind, so this file can no ` +
        `longer tell a working teardown from a probe that stopped exercising the copy path. ` +
        `Check that ${PROBE} still reads through \`iterateDocuments\` and still has no ` +
        `cleanup hook of its own.\n${control.output}`
    ).toBeGreaterThan(0);
  });

  test('the run-wide teardown deletes the copy the run made', () => {
    expect(
      swept.leftovers,
      `A \`bun test\` run left ${swept.leftovers.length} copilot-leveldb-* ` +
        `director${swept.leftovers.length === 1 ? 'y' : 'ies'} in its TMPDIR. The run-wide ` +
        `afterAll in tests/setup/temp-db-teardown.ts is what removes them, and bunfig.toml's ` +
        `[test].preload is what makes it run — bun test never fires process.on('exit'), so ` +
        `the sweep in src/core/leveldb-reader.ts cannot cover a test run (#642).\n` +
        `${swept.output}`
    ).toEqual([]);
  });
});
