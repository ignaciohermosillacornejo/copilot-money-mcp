#!/usr/bin/env bun
/**
 * Mutation-guard registry — make a safety invariant prove it has a detector.
 *
 * A guard can be fully *executed* by the suite and still have nothing that
 * would notice its deletion. That happened twice in one review (#587/#595,
 * `docs/bugs/596-vacuous-assertions-bulk-edit.md`): deleting the `stopOnError`
 * early-exit left all 2,435 tests green, because the only test pinned the error
 * *message* — `/failed at transaction_id=txn-05 \(\d+\/8 succeeded\)/` — and
 * `\d+` is satisfied by both the stopped batch and the runaway one. Codecov
 * reported 98.7% patch coverage on the same PR. Line coverage answers "did this
 * run", never "would anything notice if it were wrong".
 *
 * So: a small explicit ledger of designated safety invariants, each paired with
 * the exact mutation that disables it and the test file that must break. For
 * each entry the runner asserts BOTH directions:
 *
 *   1. unmutated → the named test file PASSES
 *   2. mutated   → the named test file FAILS, at the test(s) the row names,
 *      with the same number of tests executed and no module-level error
 *
 * Direction (1) is what stops the registry being trivially satisfiable: a
 * detector that always fails cannot be registered. Direction (2)'s two extra
 * conditions are what stop a *broken* mutation from counting as a detection —
 * a `find` string that happens to produce unparseable TypeScript makes the test
 * file "fail" while proving nothing, and bun reports that as `Ran 1 test … 1
 * error` rather than as the file's real test count, so the count and the error
 * line are both compared against the unmutated baseline.
 *
 * This is deliberately NOT full mutation testing. Stryker over this codebase
 * would be minutes per run and mostly noise; the point here is a ledger of the
 * handful of invariants whose violation writes wrong data to a real financial
 * account, pointed inward at our own guarantees the way `src/conformance/
 * ledger.ts` is pointed outward at Copilot's API.
 *
 * ## The site marker, and why `find` must contain it
 *
 * Each registered guard carries a `// mutation-guard: <name>` comment at its
 * site in `src/`, and every entry's `find` string must contain that comment.
 * Three things fall out, none of which proximity or a bare code snippet gives:
 *
 *   - **Identity, not resemblance.** `if (stopOnError && failures.length > 0)
 *     return;` appears twice in `runBoundedPool`; the marker makes the entry
 *     name which one it means, rather than an entry silently binding to the
 *     wrong occurrence. (The seed set proposed in #596 hit exactly this: three
 *     of its five strings were ambiguous or inert.)
 *   - **Deleting the entry is loud.** The cheapest false green for a registry
 *     like this is quietly dropping a row. `assertRegistryConsistent` requires a
 *     bijection between markers in `src/` and rows here, so a dropped row leaves
 *     an orphaned marker and fails the gate. It does not make removal
 *     impossible — nothing can — but it makes it a visible, deliberate edit in
 *     two files instead of one silent deletion.
 *   - **A drifted guard fails rather than skips.** `find` must match exactly
 *     once. Zero matches is an error, not a pass: a guard that has quietly
 *     stopped matching is worse than no guard, because it reports green.
 *
 * ## What this gate does NOT prove
 *
 * Stated because the rest of this file is careful about its own holes and this
 * is the one it cannot close. For a `replace` row the `with` string is
 * arbitrary, so what is established is "SOME edit at this marked site is
 * detected", not "disabling this guard is detected" — nothing can check that a
 * replacement is a faithful disabling. The mitigation is reporting rather than
 * enforcement: every passing row prints the names of the tests that caught it,
 * so a reviewer can see at a glance whether the detection is the one the row
 * claims. That is also why each row must name those tests up front
 * (`expectFailingTests`): "the file went red" is satisfied by a sibling test in
 * a shared detector file, and four of the six rows share one.
 *
 * ## Restoration
 *
 * The runner edits tracked source files in place, so leaving one mutated is the
 * worst thing it could do. Four layers, weakest failure first:
 *
 *   1. `finally` — the normal path.
 *   2. `process.on('exit')` plus SIGINT/SIGTERM handlers — covers a throw that
 *      escapes, an explicit `process.exit`, and Ctrl-C.
 *   3. A journal under the OS temp dir, written *before* the file is touched
 *      and deleted after it is restored. A SIGKILL or a power cut skips every
 *      handler; the next run finds the journal and restores from it before
 *      doing anything else.
 *   4. Restoration is content-addressed and verified: it writes the original
 *      bytes back only if what is on disk is still exactly the bytes this
 *      runner wrote. If something else changed the file mid-run (an editor
 *      saving over it), the original is dropped next to it as
 *      `<file>.mutation-guard-original` and the run fails loudly rather than
 *      clobbering someone's edit.
 *
 * Two things follow from the runner being the thing that holds the mutation.
 * The child test run is bounded (`TEST_TIMEOUT_MS`), because several registered
 * mutations delete an early exit and a hang would hold a tracked source file
 * mutated for as long as it liked. And the journal is read as UNTRUSTED input
 * (`validEntries`): it lives at a predictable path under `tmpdir()`, which is
 * shared on Linux, so a blob found there is a suggestion, never a list of write
 * instructions.
 *
 * #596 proposed refusing to run on a dirty working tree and verifying restore
 * with `git diff --quiet`. This does neither, deliberately: `bun run check` is
 * the pre-push hook and is routinely run mid-edit, so a clean-tree requirement
 * would mean the gate is skipped exactly when people are changing the code it
 * guards. Byte-comparison against the captured original is strictly stronger
 * than `git diff --quiet` anyway — it holds for a file that was already
 * modified before the run.
 *
 * ## Where this runs
 *
 * In `bun run check` (and so in the pre-push hook), and as its own step in
 * `.github/workflows/test.yml`. It is affordable there because each entry runs
 * ONE test file, baselines are shared across entries naming the same file, and
 * those files are ~0.2-0.4s each — single-digit seconds for the whole registry.
 * It is placed immediately before `bun test --bail` in the composite so the
 * full suite runs afterwards on the restored tree: if restoration were ever
 * wrong, the very next command in `check` is a whole-repo test run over the
 * damage.
 *
 * ## Usage
 *
 *   bun run check:mutation-guards
 *   bun run scripts/mutation-guards.ts --list
 *   bun run scripts/mutation-guards.ts --guard 'update_transactions stops on first failure'
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');

/** The comment that marks a guarded site in `src/`. */
export const MARKER_PREFIX = '// mutation-guard: ';

/**
 * How the registry disables a guard.
 *
 * `remove` deletes the matched text verbatim. Entries that want whole lines
 * gone write the `find` with a LEADING newline (see `wholeLines`) so the line
 * before the guard keeps its terminator; without that, deleting "line without
 * its newline" leaves a blank, wrongly-indented line behind and the file no
 * longer round-trips through prettier.
 *
 * `replace` swaps the matched text for `with`. Needed where deleting the guard
 * would not compile — widening a filter, for instance, is an edit rather than
 * a deletion — and preferred over `remove` for a multi-line `if` block, where
 * `if (…) {` → `if (false) {` disables exactly the guard while `remove` would
 * have to carry the block's whole body as a match string, re-breaking on the
 * next reword of an error message. What is being asserted either way is "with
 * this guard not running, the detector goes red"; how the guard is switched off
 * is an implementation detail of the mutation, not of the invariant.
 */
export type Mutation =
  | { readonly kind: 'remove'; readonly find: string }
  | { readonly kind: 'replace'; readonly find: string; readonly with: string };

export interface MutationGuard {
  /**
   * Unique name. Must equal the `// mutation-guard: <name>` comment at the
   * guarded site, and must appear inside the mutation's `find` string.
   */
  readonly name: string;
  /** Repo-relative path of the file holding the guard. */
  readonly file: string;
  /**
   * What breaks in the real world if this guard is gone — written for whoever
   * is about to delete it during a refactor, not for the person adding it.
   */
  readonly invariant: string;
  /** The edit that disables the guard. */
  readonly mutation: Mutation;
  /**
   * Repo-relative test file that must pass unmutated and fail mutated. One
   * file, not the suite: the point is a named detector, and "some test
   * somewhere goes red" is not one.
   */
  readonly expectFails: string;
  /**
   * The test(s) inside `expectFails` that must be among the failures, matched
   * as substrings of the names bun prints.
   *
   * `expectFails` alone would let a row ride on a sibling: four of the six rows
   * share `bulk-edit-transactions.test.ts`, so "the file went red" can be true
   * while the test covering THIS guard has quietly stopped covering it. Naming
   * the test turns that from invisible into a failure — the same reason `find`
   * must match exactly once rather than at least once.
   */
  readonly expectFailingTests: readonly string[];
}

/**
 * Join lines for a whole-line `remove`, prefixing the newline that makes the
 * deletion line-aligned.
 */
function wholeLines(...ls: readonly string[]): string {
  return '\n' + ls.join('\n');
}

/**
 * The registered safety invariants.
 *
 * Bar for entry: violating it writes wrong data to a real financial account (or
 * sends an unbounded write), AND a named test file detects the violation. Both
 * halves are enforced — the second by this runner, so an entry cannot be added
 * on the strength of a claim.
 *
 * Deliberately absent: the SECOND `stopOnError` check in `runBoundedPool`, the
 * one inside the `catch`. It keeps only the first recorded failure, but the
 * error the caller sees is built from `failures[0]` either way, so removing it
 * changes nothing observable — there is nothing for a detector to detect. It is
 * defence in depth, not a safety invariant, and registering it would mean
 * registering an entry that can only ever be green by accident.
 */
export const MUTATION_GUARDS: readonly MutationGuard[] = [
  {
    name: 'update_transactions stops on first failure',
    file: 'src/tools/tools.ts',
    invariant:
      'Under the default continue_on_error=false, entries queued behind the first failure ' +
      'must never reach the wire. Without it a 200-edit batch failing at row 3 writes the ' +
      'other 197, behind an error string indistinguishable from the stopped-early one.',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '          // mutation-guard: update_transactions stops on first failure',
        '          if (stopOnError && failures.length > 0) return;'
      ),
    },
    expectFailingTests: ['default: stops — entries queued behind the failure are never written'],
    expectFails: 'tests/tools/update-transactions-batching.test.ts',
  },
  {
    name: 'bulk write refuses an unbounded row set',
    file: 'src/core/graphql/transactions.ts',
    invariant:
      'bulkEditTransactions must refuse to send when `ids` is empty or not an array. The ' +
      'server treats an absent id filter as "every row you can match", so the failure mode ' +
      'is not a bad error message — it is one edit applied to the whole account.',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '  // mutation-guard: bulk write refuses an unbounded row set',
        '  if (!Array.isArray(args.ids) || args.ids.length === 0) {',
        '    throw new Error(',
        "      'bulkEditTransactions: refusing to send without explicit target ids — ' +",
        "        'an unfiltered bulk edit applies to an unbounded row set'",
        '    );',
        '  }'
      ),
    },
    // The invariant half of a `test.each` title, whose runtime names
    // interpolate the case label. Pinning a rendered name would pin text that
    // appears nowhere in the file, which the static half of this check catches.
    expectFailingTests: ['rather than sending a filterless request'],
    expectFails: 'tests/tools/bulk-edit-transactions.test.ts',
  },
  {
    name: 'bulk filter carries only ids',
    file: 'src/core/graphql/transactions.ts',
    invariant:
      '`ids` is the only key ever put in the BulkEditTransactions filter. Any additional key ' +
      'is a widening one — the server ORs them — so a filter that also carries, say, a ' +
      'matchString silently applies the edit to rows the caller never named.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: bulk filter carries only ids\n' +
        '    filter: { ids: args.ids.map(',
      with:
        '    // mutation-guard: bulk filter carries only ids\n' +
        "    filter: { matchString: '', ids: args.ids.map(",
    },
    expectFailingTests: ['filter carries ONLY ids — never a widening key'],
    expectFails: 'tests/tools/bulk-edit-transactions.test.ts',
  },
  {
    name: 'bulk_edit_transactions surfaces silently-skipped rows',
    file: 'src/tools/tools.ts',
    invariant:
      'The server drops unknown ids from a bulk edit without reporting them in failed[] ' +
      '(verified live). Rows the server never applied must fail the call, or the tool ' +
      'reports success for writes that did not happen and the cache is patched to match.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: bulk_edit_transactions surfaces silently-skipped rows\n' +
        '    if (result.skipped.length > 0) {',
      with:
        '    // mutation-guard: bulk_edit_transactions surfaces silently-skipped rows\n' +
        '    if (false) {',
    },
    expectFailingTests: ['a silently-skipped id fails the call'],
    expectFails: 'tests/tools/bulk-edit-transactions.test.ts',
  },
  {
    name: 'review_transactions surfaces silently-skipped rows',
    file: 'src/tools/tools.ts',
    invariant:
      'The same silent-skip contract for review_transactions, which shares the bulk mutation ' +
      'but not the code path. Registered separately because it is a separate guard: the ' +
      'ambiguous single entry proposed in #596 would have bound to one of the two at random.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: review_transactions surfaces silently-skipped rows\n' +
        '    if (result.skipped.length > 0) {',
      with:
        '    // mutation-guard: review_transactions surfaces silently-skipped rows\n' +
        '    if (false) {',
    },
    expectFailingTests: ['a silently-skipped id fails the call instead of reporting success'],
    expectFails: 'tests/tools/review-transactions-batching.test.ts',
  },
  {
    name: 'bulk edit validates category ids client-side',
    file: 'src/tools/tools.ts',
    invariant:
      'BulkEditTransactions performs no referential validation: a categoryId that does not ' +
      'exist is accepted verbatim and persisted as a dangling reference across every row in ' +
      'the batch. The client-side check is the only thing standing between a typo and that.',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '      // mutation-guard: bulk edit validates category ids client-side',
        '      await this.validateCategoryId(category_id);'
      ),
    },
    expectFailingTests: ['unknown category is rejected client-side — the server would persist it'],
    expectFails: 'tests/tools/bulk-edit-transactions.test.ts',
  },
];

// ---------------------------------------------------------------------------
// Static consistency: the registry, the markers in src/, and the files agree
// ---------------------------------------------------------------------------

/** Every `// mutation-guard: <name>` comment under `dir`, as name → files. */
export function findMarkers(root: string, dir = 'src'): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const line of readFileSync(join(root, childRel), 'utf8').split('\n')) {
        const at = line.indexOf(MARKER_PREFIX);
        if (at === -1) continue;
        const name = line.slice(at + MARKER_PREFIX.length).trim();
        found.set(name, [...(found.get(name) ?? []), childRel]);
      }
    }
  };
  walk(dir);
  return found;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Everything checkable without running a single test.
 *
 * Returns the problems rather than throwing, so the meta-test can assert the
 * empty list and a synthetic-tree test can assert a specific complaint.
 */
export function assertRegistryConsistent(
  root: string,
  guards: readonly MutationGuard[] = MUTATION_GUARDS,
  markerDir = 'src'
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const guard of guards) {
    if (seen.has(guard.name)) problems.push(`duplicate guard name: ${guard.name}`);
    seen.add(guard.name);

    const marker = MARKER_PREFIX + guard.name;
    if (!guard.mutation.find.includes(marker)) {
      problems.push(
        `${guard.name}: mutation.find does not contain its site marker (${marker}). ` +
          `The marker is what binds the entry to one specific site — without it the ` +
          `string may match a lookalike elsewhere in the file.`
      );
    }

    const abs = join(root, guard.file);
    if (!existsSync(abs)) {
      problems.push(`${guard.name}: file not found: ${guard.file}`);
      continue;
    }
    const content = readFileSync(abs, 'utf8');
    const matches = countOccurrences(content, guard.mutation.find);
    if (matches !== 1) {
      problems.push(
        `${guard.name}: mutation.find matches ${matches} times in ${guard.file}, expected ` +
          `exactly 1. ${
            matches === 0
              ? 'The guard moved or was reworded — a registry entry that no longer matches ' +
                'is a gate reporting green over nothing, so this is an error rather than a skip.'
              : 'Widen the string until it names one site.'
          }`
      );
    }
    const detector = join(root, guard.expectFails);
    if (!existsSync(detector)) {
      problems.push(`${guard.name}: detector file not found: ${guard.expectFails}`);
      continue;
    }
    if (guard.expectFailingTests.length === 0) {
      problems.push(
        `${guard.name}: expectFailingTests is empty. Naming the test is what stops the row ` +
          `riding on a sibling's failure in a shared detector file.`
      );
    }
    const detectorSource = readFileSync(detector, 'utf8');
    for (const needle of guard.expectFailingTests) {
      if (!detectorSource.includes(needle)) {
        problems.push(
          `${guard.name}: expectFailingTests names "${needle}", which does not appear in ` +
            `${guard.expectFails}. Renaming a detector must update the row, not silently ` +
            `leave it pinned to a test that no longer exists.`
        );
      }
    }
  }

  // Bijection with the markers actually present in the source tree. This is the
  // half that makes dropping a registry row fail rather than pass quietly.
  const markers = findMarkers(root, markerDir);
  const registered = new Map(guards.map((g) => [g.name, g]));
  for (const [name, files] of markers) {
    const guard = registered.get(name);
    if (!guard) {
      problems.push(
        `${markerDir}/ carries a marker with no registry entry: "${name}" (${files.join(', ')}). ` +
          `Either add the entry to MUTATION_GUARDS or delete the marker — an unregistered ` +
          `marker is a safety claim nothing verifies.`
      );
      continue;
    }
    if (files.length > 1) {
      problems.push(
        `marker "${name}" appears in ${String(files.length)} files: ${files.join(', ')}`
      );
    } else if (files[0] !== guard.file) {
      problems.push(`marker "${name}" is in ${String(files[0])}, registry says ${guard.file}`);
    }
  }
  for (const guard of guards) {
    if (!markers.has(guard.name)) {
      problems.push(
        `${guard.name}: no ${MARKER_PREFIX}${guard.name} marker found under ${markerDir}/. ` +
          `Every registered guard marks its own site.`
      );
    }
  }

  return problems;
}

/** The file content with the guard disabled. Assumes `find` matches once. */
export function applyMutation(content: string, mutation: Mutation): string {
  const at = content.indexOf(mutation.find);
  if (at === -1) throw new Error('applyMutation: find string not present');
  const replacement = mutation.kind === 'remove' ? '' : mutation.with;
  return content.slice(0, at) + replacement + content.slice(at + mutation.find.length);
}

// ---------------------------------------------------------------------------
// Restoration: journal, handlers, verified write-back
// ---------------------------------------------------------------------------

interface JournalEntry {
  /**
   * The run root this entry belongs to. Carried per entry rather than captured
   * once by `installHandlers`, because the handlers install on first use and a
   * process that drives more than one root (the meta-test does) would otherwise
   * clear the first root's journal on the crash path while restoring another's
   * file.
   */
  readonly root: string;
  readonly abs: string;
  readonly original: string;
  readonly mutated: string;
}

interface Journal {
  readonly pid: number;
  readonly startedAt: string;
  readonly entries: JournalEntry[];
}

/**
 * Deterministic per repo root, so a run that was killed can be cleaned up by
 * the next run in the same checkout — and so two different worktrees of this
 * repo (this project uses them heavily) never share one.
 */
export function journalPath(root: string): string {
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
  return join(tmpdir(), 'copilot-money-mcp-mutation-guards', `${key}.json`);
}

const ACTIVE = new Map<string, JournalEntry>();
let handlersInstalled = false;
/** Set when a restore could not be completed safely; forces a non-zero exit. */
let restoreFailed = false;

function writeJournal(root: string): void {
  const path = journalPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const journal: Journal = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    entries: [...ACTIVE.values()],
  };
  writeFileSync(path, JSON.stringify(journal), 'utf8');
}

function clearJournal(root: string): void {
  if (ACTIVE.size > 0) {
    writeJournal(root);
    return;
  }
  rmSync(journalPath(root), { force: true });
}

/**
 * Put `entry.original` back, but only over bytes this runner wrote.
 *
 * The alternative — an unconditional write — would silently discard an edit
 * made while the file was mutated (an editor saving in the background, a
 * concurrent run). Refusing and leaving a sidecar is the only safe answer:
 * this process knows the original bytes and nothing else does.
 */
function restoreEntry(entry: JournalEntry): boolean {
  let current: string;
  try {
    current = readFileSync(entry.abs, 'utf8');
  } catch {
    writeFileSync(entry.abs, entry.original, 'utf8');
    return true;
  }
  if (current === entry.original) return true;
  if (current === entry.mutated) {
    writeFileSync(entry.abs, entry.original, 'utf8');
    const after = readFileSync(entry.abs, 'utf8');
    if (after !== entry.original) {
      console.error(`mutation-guards: FAILED to restore ${entry.abs} — content still differs`);
      return false;
    }
    return true;
  }
  const sidecar = `${entry.abs}.mutation-guard-original`;
  writeFileSync(sidecar, entry.original, 'utf8');
  console.error(
    `mutation-guards: ${entry.abs} changed while it was mutated, so it was NOT overwritten.\n` +
      `  The pre-mutation content is at ${sidecar}. Reconcile by hand — restoring ` +
      `automatically here would throw away whatever made the change.`
  );
  return false;
}

/** 128 + signal number, the shell convention for "died from this signal". */
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const restoreAll = (): void => {
    const roots = new Set<string>();
    for (const entry of [...ACTIVE.values()]) {
      if (!restoreEntry(entry)) restoreFailed = true;
      ACTIVE.delete(entry.abs);
      roots.add(entry.root);
    }
    for (const root of roots) clearJournal(root);
  };
  // 'exit' is synchronous-only, which is exactly what fs.*Sync needs; it covers
  // an escaped throw and an explicit process.exit. The signals do not fire
  // 'exit' on their own, so they get their own handler.
  process.on('exit', restoreAll);
  for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
    process.on(signal as NodeJS.Signals, () => {
      restoreAll();
      process.exit(code);
    });
  }
}

/**
 * Run `fn` with `file` mutated, and put it back afterwards no matter how `fn`
 * ends. Exported so tests can exercise restoration directly — including the
 * SIGKILL case, which by construction cannot be tested through the CLI.
 */
export async function withMutation<T>(
  root: string,
  file: string,
  mutated: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const abs = join(root, file);
  const original = readFileSync(abs, 'utf8');
  const entry: JournalEntry = { root, abs, original, mutated };
  installHandlers();
  ACTIVE.set(abs, entry);
  // Journal BEFORE the write: a crash between these two lines leaves a journal
  // whose recorded "mutated" content is not on disk, and recovery is a no-op.
  // A crash the other way round would leave a mutated file nothing knows about.
  writeJournal(root);
  writeFileSync(abs, mutated, 'utf8');
  try {
    return await fn();
  } finally {
    const ok = restoreEntry(entry);
    if (!ok) restoreFailed = true;
    ACTIVE.delete(abs);
    clearJournal(root);
  }
}

export interface RecoveryReport {
  readonly recovered: string[];
  readonly refused: string[];
}

/**
 * Restore anything a killed run left behind, before this run touches a file.
 *
 * Throws if the journal names a live process: two concurrent runs mutating the
 * same files would each restore the other's "original", and the loser wins.
 */
export function recoverJournal(root: string): RecoveryReport {
  const path = journalPath(root);
  if (!existsSync(path)) return { recovered: [], refused: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Recovery state, not a source of truth. The crash this file exists for can
    // truncate the file mid-write, and a gate that then throws on every
    // `bun run check` until someone hand-deletes a file in the temp dir would be
    // a worse failure than the one it is recovering from.
    rmSync(path, { force: true });
    return { recovered: [], refused: [] };
  }
  const journal = isRecord(parsed) ? parsed : {};
  const pid = typeof journal.pid === 'number' ? journal.pid : 0;
  if (pid !== process.pid && isAlive(pid)) {
    throw new Error(
      `mutation-guards: another run (pid ${String(pid)}, started ${String(journal.startedAt)}) ` +
        `holds ${path}. Two runs mutating the same files would restore each other's ` +
        `originals. Wait for it, or delete that file if you are sure the process is unrelated.`
    );
  }
  const recovered: string[] = [];
  const refused: string[] = [];
  for (const entry of validEntries(journal.entries, root)) {
    const before = existsSync(entry.abs) ? readFileSync(entry.abs, 'utf8') : '';
    if (before === entry.original) continue;
    if (restoreEntry(entry)) recovered.push(entry.abs);
    else refused.push(entry.abs);
  }
  rmSync(path, { force: true });
  return { recovered, refused };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The entries of a journal that this runner could plausibly have written.
 *
 * `journalPath` is predictable — `tmpdir()/copilot-money-mcp-mutation-guards/
 * <sha1(root)>.json` — and on Linux `tmpdir()` is the shared `/tmp`. Treating a
 * blob found there as a list of write instructions would make "someone can
 * create a file in /tmp" into "someone can write any file, as you, on your next
 * `bun run check`", which runs before anything else this script does. The pid
 * check is no defence at all against that: a planted journal simply names a
 * dead pid.
 *
 * So the file is read as untrusted input. Two conditions, and an entry failing
 * either is dropped rather than obeyed:
 *
 *   - it has the three string fields a real entry has, which also stops a
 *     structurally-corrupt-but-parseable journal (`entries: [{}]`) from
 *     reaching `writeFileSync(undefined, undefined)`;
 *   - its path resolves INSIDE the run root. This runner only ever mutates
 *     files under the root it was given, so an entry outside it is definitionally
 *     not one of ours, whoever wrote it.
 */
function validEntries(raw: unknown, root: string): JournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const prefix = resolve(root) + sep;
  const kept: JournalEntry[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const { abs, original, mutated } = candidate;
    if (typeof abs !== 'string' || typeof original !== 'string' || typeof mutated !== 'string') {
      continue;
    }
    if (!resolve(abs).startsWith(prefix)) {
      console.error(
        `mutation-guards: ignoring a journal entry for ${abs}, which is outside ${root}. ` +
          `This runner only ever mutates files under the root it was given, so that entry ` +
          `was not written by it.`
      );
      continue;
    }
    kept.push({ root, abs, original, mutated });
  }
  return kept;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Running the detector
// ---------------------------------------------------------------------------

export interface TestSummary {
  /** Total tests bun reported executing, or null when it reported none. */
  readonly ran: number | null;
  /**
   * The names bun printed on its `(fail) …` lines.
   *
   * `fail > 0` alone only says the FILE went red. Four of the six seed rows
   * share one detector file, so a row could stay green on a sibling test's
   * failure while the test covering its own guard rotted — a silent weakening
   * of exactly the property this gate exists to establish. Each row names the
   * tests that must be among these.
   */
  readonly failingTests: string[];
  /** True when the child was killed for exceeding TEST_TIMEOUT_MS. */
  readonly timedOut: boolean;
  readonly pass: number;
  readonly fail: number;
  /**
   * bun's `N error` line, printed for module-level and uncaught errors and
   * absent for an ordinary assertion failure. A mutation that makes the file
   * unparseable shows up here — and would otherwise look like a detection.
   */
  readonly errors: number;
  readonly exitCode: number;
  readonly output: string;
}

export function parseBunTestSummary(
  output: string,
  exitCode: number,
  timedOut = false
): TestSummary {
  const num = (re: RegExp): number => {
    const m = re.exec(output);
    return m?.[1] === undefined ? 0 : Number(m[1]);
  };
  const ranMatch = /Ran (\d+) tests? across/.exec(output);
  // bun prints `(fail) <describe> > <name> [1.23ms]`; the duration is optional
  // and the name may itself contain brackets, so only a trailing timing suffix
  // is stripped.
  const failingTests = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?\s*$/gm)].map((m) =>
    (m[1] ?? '').trim()
  );
  return {
    ran: ranMatch?.[1] === undefined ? null : Number(ranMatch[1]),
    failingTests,
    timedOut,
    pass: num(/^\s*(\d+) pass\b/m),
    fail: num(/^\s*(\d+) fail\b/m),
    errors: num(/^\s*(\d+) errors?\b/m),
    exitCode,
    output,
  };
}

/**
 * How long one detector file gets before the child is killed.
 *
 * Load-bearing, not a nicety. Several registered mutations delete an early-exit
 * guard — a `return`, a `break` — which is precisely the edit class that can
 * turn a bounded loop into an unbounded one. Bun's per-test timeout covers a
 * hang inside a `test()`, not a hang at module scope and not a child that never
 * writes its summary. Without this bound, `bun run check` (the pre-push hook)
 * would block forever with a tracked source file mutated on disk, and CI would
 * burn to the job timeout with no diagnostic.
 *
 * Generous against the real numbers: the slowest registered detector is under
 * half a second.
 */
export const TEST_TIMEOUT_MS = 120_000;

export function runTestFile(root: string, file: string, timeoutMs = TEST_TIMEOUT_MS): TestSummary {
  const res = spawnSync('bun', ['test', file], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    // SIGKILL rather than the default SIGTERM: the case being bounded is a
    // child that is not making progress, and one that ignores SIGTERM would
    // keep the mutation on disk for exactly as long as it liked.
    killSignal: 'SIGKILL',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const timedOut =
    res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return parseBunTestSummary(
    `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    res.status ?? -1,
    timedOut || res.signal === 'SIGKILL'
  );
}

/** The last few lines of a child's output, for a failure a human has to debug. */
function tail(output: string, lines = 12): string {
  return output
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .map((line) => `      | ${line}`)
    .join('\n');
}

export interface GuardResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface RunOptions {
  readonly root?: string;
  readonly guards?: readonly MutationGuard[];
  /** Run only the guard with this exact name. */
  readonly only?: string;
  readonly markerDir?: string;
  /** Per-detector-file bound; overridable so the timeout path is testable. */
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
}

export async function runGuards(
  options: RunOptions = {}
): Promise<{ ok: boolean; results: GuardResult[] }> {
  const root = options.root ?? REPO_ROOT;
  const all = options.guards ?? MUTATION_GUARDS;
  const log = options.log ?? ((line: string) => void console.log(line));
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  // Module-level, because the exit handler has nowhere else to report from.
  // Each run owns its own verdict, so clear it rather than inheriting one from
  // a previous call in the same process (the meta-test makes several).
  restoreFailed = false;

  const recovery = recoverJournal(root);
  for (const file of recovery.recovered) {
    log(`  ! recovered a file left mutated by an earlier killed run: ${file}`);
  }
  if (recovery.refused.length > 0) {
    return {
      ok: false,
      results: [
        {
          name: '(journal recovery)',
          ok: false,
          detail: `could not restore ${recovery.refused.join(', ')} — see the sidecar files`,
        },
      ],
    };
  }

  const problems = assertRegistryConsistent(root, all, options.markerDir);
  if (problems.length > 0) {
    return {
      ok: false,
      results: problems.map((detail) => ({ name: '(registry)', ok: false, detail })),
    };
  }

  const selected = options.only === undefined ? all : all.filter((g) => g.name === options.only);
  if (selected.length === 0) {
    return {
      ok: false,
      results: [{ name: '(selection)', ok: false, detail: `no guard named "${options.only}"` }],
    };
  }

  // One baseline per distinct detector file, not per guard: four of the six
  // seed entries name the same file, and the unmutated result cannot differ
  // between them.
  const baselines = new Map<string, TestSummary>();
  const results: GuardResult[] = [];

  for (const guard of selected) {
    let baseline = baselines.get(guard.expectFails);
    if (baseline === undefined) {
      baseline = runTestFile(root, guard.expectFails, timeoutMs);
      baselines.set(guard.expectFails, baseline);
    }
    if (baseline.ran === null || baseline.ran === 0 || baseline.fail > 0 || baseline.errors > 0) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `detector ${guard.expectFails} does not PASS unmutated ` +
          `(ran=${String(baseline.ran)} pass=${String(baseline.pass)} fail=${String(baseline.fail)} ` +
          `errors=${String(baseline.errors)}). A detector that is red either way proves nothing, ` +
          `so this direction is checked first.\n${tail(baseline.output)}`,
      });
      continue;
    }

    const abs = join(root, guard.file);
    const mutated = applyMutation(readFileSync(abs, 'utf8'), guard.mutation);
    const after = await withMutation(root, guard.file, mutated, () =>
      runTestFile(root, guard.expectFails, timeoutMs)
    );

    if (after.timedOut) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `the mutated run was killed after ${String(timeoutMs / 1000)}s. Deleting an ` +
          `early-exit guard is the edit class that turns a bounded loop unbounded, so treat ` +
          `this as "the mutation hung the detector", not as a detection.\n${tail(after.output)}`,
      });
      continue;
    }
    if (after.ran !== baseline.ran) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `the mutation changed how many tests RAN (${String(baseline.ran)} → ${String(after.ran)}), ` +
          `so ${guard.expectFails} did not fail for a behavioural reason. Almost always a ` +
          `mutation that leaves the file unparseable — fix the find/with strings.`,
      });
      continue;
    }
    if (after.errors > 0) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `the mutated run reported ${String(after.errors)} module-level/uncaught error(s). ` +
          `That is a broken mutation wearing a detection's clothes; the guard is unproven.`,
      });
      continue;
    }
    const undetectedBy = guard.expectFailingTests.filter(
      (needle) => !after.failingTests.some((name) => name.includes(needle))
    );
    if (after.fail > 0 && undetectedBy.length > 0) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `${guard.expectFails} went red, but not because of the test(s) this row names: ` +
          `${undetectedBy.join(', ')} still passed. What failed instead: ` +
          `${after.failingTests.join(', ')}. A row riding on a sibling test's failure is the ` +
          `same hole as a guard with no detector, one level up.`,
      });
      continue;
    }
    if (after.fail === 0) {
      results.push({
        name: guard.name,
        ok: false,
        detail:
          `VACUOUS — disabling this guard left ${guard.expectFails} entirely green ` +
          `(${String(after.pass)} pass, 0 fail). Nothing detects its removal. Write a test that ` +
          `pins the PROPERTY ("${guard.invariant.split('.')[0]!.trim()}"), not the error message.`,
      });
      continue;
    }

    results.push({
      name: guard.name,
      ok: true,
      detail:
        `${guard.expectFails}: ${String(baseline.pass)} pass unmutated → ${String(after.fail)} ` +
        `fail mutated\n      caught by: ${after.failingTests.join(' | ')}`,
    });
  }

  if (restoreFailed) {
    // As its own row rather than a silent `ok: false`: every other failure here
    // names itself, and "0 of 6 failed" over a red exit code is the kind of
    // report that gets read as a flake and rerun.
    results.push({
      name: '(restore)',
      ok: false,
      detail:
        'a mutated file could not be put back safely — see the message above and the ' +
        '.mutation-guard-original sidecar. Reconcile before trusting anything else in this run.',
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const guard of MUTATION_GUARDS) {
      console.log(`${guard.name}\n  ${guard.file} → ${guard.expectFails}\n  ${guard.invariant}\n`);
    }
    process.exit(0);
  }
  const onlyAt = argv.indexOf('--guard');
  const only = onlyAt === -1 ? undefined : argv[onlyAt + 1];
  if (onlyAt !== -1 && only === undefined) {
    // Falling through with `only: undefined` would run the WHOLE registry and
    // report success — a green that the operator asked a narrower question for.
    console.error('mutation-guards: --guard needs a name. `--list` prints them.');
    process.exit(2);
  }

  const { ok, results } = await runGuards({ only });
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}\n      ${r.detail}`);
  }
  if (ok) {
    console.log(
      `\nmutation-guards: ${String(results.length)} safety invariant(s) each proved to have a ` +
        `detector — every one passes unmutated and fails mutated.`
    );
    process.exit(0);
  }
  console.error(
    `\nmutation-guards: ${String(results.filter((r) => !r.ok).length)} of ${String(results.length)} ` +
      `failed. A registered guard is a claim that something notices its removal; a failure here ` +
      `means the claim is false, not that the gate is fussy.`
  );
  process.exit(1);
}
