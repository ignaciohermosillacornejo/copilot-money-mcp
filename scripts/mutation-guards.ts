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
 *   2. mutated   → the named test file FAILS, with the same number of tests
 *      executed and no module-level error
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
import { dirname, join } from 'path';
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
 * a deletion.
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
    if (!existsSync(join(root, guard.expectFails))) {
      problems.push(`${guard.name}: detector file not found: ${guard.expectFails}`);
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

function installHandlers(root: string): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const restoreAll = (): void => {
    for (const entry of [...ACTIVE.values()]) {
      if (!restoreEntry(entry)) restoreFailed = true;
      ACTIVE.delete(entry.abs);
    }
    clearJournal(root);
  };
  // 'exit' is synchronous-only, which is exactly what fs.*Sync needs; it covers
  // an escaped throw and an explicit process.exit. The signals do not fire
  // 'exit' on their own, so they get their own handler.
  process.on('exit', restoreAll);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      restoreAll();
      process.exit(130);
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
  const entry: JournalEntry = { abs, original, mutated };
  installHandlers(root);
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
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8')) as Journal;
  } catch {
    rmSync(path, { force: true });
    return { recovered: [], refused: [] };
  }
  if (journal.pid !== process.pid && isAlive(journal.pid)) {
    throw new Error(
      `mutation-guards: another run (pid ${String(journal.pid)}, started ${journal.startedAt}) ` +
        `holds ${path}. Two runs mutating the same files would restore each other's ` +
        `originals. Wait for it, or delete that file if you are sure the process is unrelated.`
    );
  }
  const recovered: string[] = [];
  const refused: string[] = [];
  for (const entry of journal.entries) {
    const before = existsSync(entry.abs) ? readFileSync(entry.abs, 'utf8') : '';
    if (before === entry.original) continue;
    if (restoreEntry(entry)) recovered.push(entry.abs);
    else refused.push(entry.abs);
  }
  rmSync(path, { force: true });
  return { recovered, refused };
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

export function parseBunTestSummary(output: string, exitCode: number): TestSummary {
  const num = (re: RegExp): number => {
    const m = re.exec(output);
    return m?.[1] === undefined ? 0 : Number(m[1]);
  };
  const ranMatch = /Ran (\d+) tests? across/.exec(output);
  return {
    ran: ranMatch?.[1] === undefined ? null : Number(ranMatch[1]),
    pass: num(/^\s*(\d+) pass\b/m),
    fail: num(/^\s*(\d+) fail\b/m),
    errors: num(/^\s*(\d+) errors?\b/m),
    exitCode,
    output,
  };
}

export function runTestFile(root: string, file: string): TestSummary {
  const res = spawnSync('bun', ['test', file], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return parseBunTestSummary(`${res.stdout ?? ''}\n${res.stderr ?? ''}`, res.status ?? -1);
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
  readonly log?: (line: string) => void;
}

export async function runGuards(
  options: RunOptions = {}
): Promise<{ ok: boolean; results: GuardResult[] }> {
  const root = options.root ?? REPO_ROOT;
  const all = options.guards ?? MUTATION_GUARDS;
  const log = options.log ?? ((line: string) => void console.log(line));
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
      baseline = runTestFile(root, guard.expectFails);
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
          `so this direction is checked first.`,
      });
      continue;
    }

    const abs = join(root, guard.file);
    const mutated = applyMutation(readFileSync(abs, 'utf8'), guard.mutation);
    const after = await withMutation(root, guard.file, mutated, () =>
      runTestFile(root, guard.expectFails)
    );

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
      detail: `${guard.expectFails}: ${String(baseline.pass)} pass unmutated → ${String(after.fail)} fail mutated`,
    });
  }

  return { ok: results.every((r) => r.ok) && !restoreFailed, results };
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
