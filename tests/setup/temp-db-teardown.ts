/**
 * Run-wide teardown for `bun test` (#642).
 *
 * `src/core/leveldb-reader.ts` copies a LevelDB database to `$TMPDIR` before
 * reading it, and guarantees the copy never outlives the process by sweeping
 * on `process.on('exit')` plus SIGINT/SIGTERM/SIGHUP (#631, #632). That
 * guarantee holds for the server, the decode worker and standalone scripts —
 * and not for `bun test`, which hard-exits without emitting 'exit' at all
 * (verified on bun 1.3.5 with a marker probe: the listener never runs).
 *
 * So a full suite stranded one copy for every test file that reads a fixture
 * database without calling `cleanupAllTempDatabases()` in its own hooks —
 * 46 directories per run, measured on this repo. The hour-old orphan sweep
 * still reclaims them eventually, so this was never unbounded; it just meant
 * a test run did not leave the machine as it found it, and repeated runs
 * stack inside the sweep's own window.
 *
 * Registering the sweep here fixes it for every test file at once, including
 * ones written later, rather than asking each of them to remember. Test files
 * that clean up in their own hooks are unaffected: `cleanupAllTempDatabases`
 * iterates the in-process cache, which those files have already emptied.
 *
 * SCOPE, stated because the sentence "a test run leaves nothing behind" is
 * easy to over-trust:
 *   - it covers a run that REACHES THE END. `--bail` aborts without firing
 *     this hook (verified), and `bun run check` is `bun test --bail` — so a
 *     check run that fails a test still strands what it made. A Ctrl-C'd run
 *     is the same. The hour-old orphan sweep in leveldb-reader.ts remains the
 *     backstop for both, which is what it is for.
 *   - it covers copies made on THIS thread. A worker thread's isolate has its
 *     own temp-copy cache that nothing here can see, so the decode worker
 *     sweeps for itself before it posts its result.
 *   - the import binding is resolved at preload time, so a test file that
 *     `mock.module`s the reader does not replace the function this hook calls.
 *     That is the behaviour we want — a mocked cleanup would leave the real
 *     copies on disk — and it is stated here because it is easy to mistake
 *     for an accident.
 *
 * Wired in `bunfig.toml`. Guarded by `tests/core/temp-db-suite-teardown.test.ts`,
 * which proves a `bun test` run leaves no copy behind *and* that the same run
 * does strand one when this preload is removed.
 */

import { afterAll } from 'bun:test';
import { cleanupAllTempDatabases } from '../../src/core/leveldb-reader.js';

afterAll(() => {
  cleanupAllTempDatabases();
});
