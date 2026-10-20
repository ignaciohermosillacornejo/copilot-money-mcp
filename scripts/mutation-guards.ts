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
 * a shared detector file, and four of the nine rows share one.
 *
 * ## Restoration
 *
 * The runner edits tracked source files in place, so leaving one mutated is the
 * worst thing it could do. Four layers, weakest failure first:
 *
 *   1. `finally` — the normal path.
 *   2. `process.on('exit')` plus SIGINT/SIGTERM/SIGHUP handlers — covers a throw
 *      that escapes, an explicit `process.exit`, Ctrl-C, and a closed terminal.
 *   3. A journal under the checkout's own `node_modules/.cache/`, written
 *      *before* the file is touched and deleted after it is restored — and
 *      KEPT whenever a restore was refused, so the next run inherits the
 *      refusal instead of starting green over a tree nobody reconciled. A
 *      SIGKILL or a power cut skips every handler; the next run finds the
 *      journal and restores from it before doing anything else.
 *   4. Restoration is content-addressed and verified: it writes the original
 *      bytes back only if what is on disk is still exactly the bytes this
 *      runner wrote. If something else changed the file mid-run (an editor
 *      saving over it), or if the write-back reads back as something else, the
 *      original is dropped next to it as `<file>.mutation-guard-original` —
 *      both give-up branches, through `refuse()` — and the run fails loudly
 *      rather than clobbering someone's edit. That sidecar is the one piece of
 *      state that outlives the process that wrote it, so every run scans for one
 *      (`findSidecars`) before it touches anything: an orphaned sidecar means
 *      an earlier run gave up on a file and nobody has reconciled it since,
 *      which is not a tree to report a green registry over.
 *
 * Giving up is itself a write, so it can fail. Each of the three callers of
 * `restoreEntry` survives a throw from it: `withMutation` does its bookkeeping
 * in a `finally`, and the exit sweep and `recoverJournal` catch per entry —
 * otherwise a sidecar write that throws would leave the run's stop-editing flag
 * unset, or abandon the entries after it. The journal writes on those paths go
 * through `persistJournal`, which reports a failure instead of raising it, for
 * the same reason one level down. A kept journal records `NO_OWNER` rather than
 * the writer's pid, because it is meant to outlive that process and a reused
 * pid would otherwise read as a live run holding it. One residual is left, and
 * stated rather than implied away: a run SIGKILLed MID-mutation leaves its own
 * pid in the journal with no handler left to rewrite it, so if the OS reuses
 * that pid before the next run, recovery throws "another run holds the
 * journal" instead of recovering. Fail-closed, and the message names the pid
 * and the remedy (delete the journal once sure the process is unrelated); a
 * liveness token that is not a bare pid would close it. A give-up path that does
 * not leave the process in a state the next step can trust is the class this
 * file is about.
 *
 * Two things follow from the runner being the thing that holds the mutation.
 * The child test run is bounded (`TEST_TIMEOUT_MS`), because several registered
 * mutations delete an early exit and a hang would hold a tracked source file
 * mutated for as long as it liked. And the journal is read as UNTRUSTED input
 * (`validEntries`) even though it now lives inside the checkout: it is a list of
 * "write these bytes to this path", so it gets validated on the way in whether
 * or not the directory it came from is trusted today.
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
 *
 * Those three spellings and nothing else: anything the parser does not
 * recognise exits 2 naming the offender (`parseCliArgs`), because the failure
 * mode of a lenient parser here is a typo'd `--gaurd` running the WHOLE
 * registry and exiting 0 — a green answer to a question nobody asked.
 */

import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'fs';
import { dirname, join, resolve, sep } from 'path';
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
   * `expectFails` alone would let a row ride on a sibling: four of the nine rows
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
  {
    name: 'create_transaction validates its category id',
    file: 'src/tools/tools.ts',
    invariant:
      'CreateTransaction stores an unknown categoryId verbatim (parity run 2026-10-18, ' +
      '#846): the new row points at no category and the web shows none. The client-side ' +
      'check is the only guard, as it is for bulk edits.',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '    // mutation-guard: create_transaction validates its category id',
        '    if (category_id !== undefined) await this.validateCategoryId(category_id);'
      ),
    },
    expectFailingTests: ['an unknown category id is rejected with nothing sent'],
    expectFails: 'tests/tools/write-reference-validation.test.ts',
  },
  {
    name: 'split_transaction validates child category ids',
    file: 'src/tools/tools.ts',
    invariant:
      "SplitTransactionInput.categoryId goes through the same server path as a created row's " +
      '(#846), so an unknown id would leave a split child pointing at no category. Every ' +
      "child's id is checked before the split is sent.",
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: split_transaction validates child category ids\n' +
        '    for (const categoryId of new Set(splits.map((s) => s.category_id))) {',
      with:
        '    // mutation-guard: split_transaction validates child category ids\n' +
        '    for (const categoryId of new Set<string>([])) {',
    },
    expectFailingTests: ['an unknown category id is rejected with nothing sent'],
    expectFails: 'tests/tools/write-reference-validation.test.ts',
  },
  {
    name: 'a failed transaction write drops its live months',
    file: 'src/tools/tools.ts',
    invariant:
      'A transport error or timeout can follow a write the server already applied. A ' +
      "transaction write's catch must drop the cached months holding its target, or the cold " +
      'tier serves the pre-write row for up to a week while the user retries a write that ' +
      'already landed (#832).',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '      // mutation-guard: a failed transaction write drops its live months',
        '      this.liveDb?.invalidateLiveTransactionMonths(ids);'
      ),
    },
    expectFailingTests: ['the mutation throws, and the cached month is refetched'],
    expectFails: 'tests/tools/live-write-coherence.test.ts',
  },
  {
    name: 'create_transaction writes through to the live cache',
    file: 'src/tools/tools.ts',
    invariant:
      'A created transaction must enter its month in the live window cache. Months older ' +
      'than 14 days are cached for a week, so without the write-through a row created in ' +
      'one is invisible to get_transactions_live for up to seven days while the write ' +
      'reports success — the caller sees wrong totals and repeats the write (#820).',
    mutation: {
      kind: 'remove',
      find: wholeLines(
        '      // mutation-guard: create_transaction writes through to the live cache',
        '      this.liveDb?.upsertLiveTransaction(tx, {',
        '        insert: true,',
        '        refusalMonths: CopilotMoneyTools.monthOf(args.date),',
        '      });'
      ),
    },
    // The table key, which is the `%s` half of the test.each title — the only
    // part of the rendered name that is unique to this case.
    expectFailingTests: ['create_transaction'],
    expectFails: 'tests/tools/live-write-coherence.test.ts',
  },
  {
    name: 'an edit never inserts an uncached row',
    file: 'src/core/live-database.ts',
    invariant:
      'An edit tool may target a split parent, which the Transactions query omits from every ' +
      'month, and the mutation response does not say the row is a parent. Inserting an edited ' +
      'row that was not cached puts the hidden parent back beside its children, so the live ' +
      "read double-counts the parent's amount for up to a week. Edits of uncached rows must " +
      'invalidate the month instead; only creates and split children may insert.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: an edit never inserts an uncached row\n' +
        '    if (!existing && (opts.insert !== true || !hasRouting)) {',
      with:
        '    // mutation-guard: an edit never inserts an uncached row\n' +
        '    if (!existing && !hasRouting) {',
    },
    // The invariant half of the test.each title; every edit tool's case runs it.
    expectFailingTests: [
      'on a row absent from a cached month: the next read comes from the server',
    ],
    expectFails: 'tests/tools/live-write-coherence.test.ts',
  },
  {
    name: 'a drifted routing id is never inserted',
    file: 'src/core/live-database.ts',
    invariant:
      'Mutation responses are validated warn-only, so a drifted create or split response can ' +
      'carry an empty accountId or itemId. Inserting that row puts a transaction into the live ' +
      'cache that no later write can address (every write needs the routing pair), and that ' +
      'reads report with empty account ids. Such a row must not be inserted; its month is ' +
      'refetched instead.',
    mutation: {
      kind: 'replace',
      // Stacked above the edit guard's marker, which this find leaves in place,
      // so the two rows bind to the same condition without sharing a find.
      find:
        '    // mutation-guard: a drifted routing id is never inserted\n' +
        '    // mutation-guard: an edit never inserts an uncached row\n' +
        '    if (!existing && (opts.insert !== true || !hasRouting)) {',
      with:
        '    // mutation-guard: a drifted routing id is never inserted\n' +
        '    // mutation-guard: an edit never inserts an uncached row\n' +
        '    if (!existing && opts.insert !== true) {',
    },
    expectFailingTests: ['insert: a row with empty routing ids is not inserted'],
    expectFails: 'tests/core/live-database.test.ts',
  },
  {
    name: 'a malformed returned row is never cached',
    file: 'src/core/live-database.ts',
    invariant:
      'Mutation responses are validated warn-only, so a drifted row can reach the live cache ' +
      'without a field the read path dereferences (a tags array, a name, a date). Every live ' +
      'read runs the tag mapper on every row of a month, so one stored row with no tags makes ' +
      'each later read of that month throw until the TTL expires. Such a row must not be ' +
      'stored; its months are dropped so the next read refetches (#864 review).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a malformed returned row is never cached\n' +
        '    if (!LiveCopilotDatabase.isCacheableRow(node)) {',
      with:
        '    // mutation-guard: a malformed returned row is never cached\n' +
        '    if (!LiveCopilotDatabase.isCacheableRow(node) && false) {',
    },
    expectFailingTests: [
      'a response without tags succeeds, leaves the month uncached, and the next read refetches',
    ],
    expectFails: 'tests/tools/live-write-coherence.test.ts',
  },
  {
    name: 'a non-string id is never coerced into a valid one',
    file: 'src/tools/tools.ts',
    invariant:
      'MCP arguments arrive unvalidated and are cast to their declared types, and RegExp.test ' +
      'coerces its argument, so without a typeof check a number or null passes validateDocId ' +
      'as "42" / "null" and is sent to Copilot as an id: a routing id the server may resolve ' +
      'differently, or a transaction id no one meant. Every id validateDocId checks must be a ' +
      'string (#836 review).',
    mutation: {
      kind: 'replace',
      find:
        '  // mutation-guard: a non-string id is never coerced into a valid one\n' +
        "  if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {",
      with:
        '  // mutation-guard: a non-string id is never coerced into a valid one\n' +
        '  if (!SAFE_ID_RE.test(id)) {',
    },
    expectFailingTests: ['a numeric transaction_id is rejected, nothing sent'],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'delete_transaction refuses a split parent',
    file: 'src/tools/tools.ts',
    invariant:
      "Deleting a split parent makes Copilot credit the parent's amount back to the account a " +
      'second time (the children already replaced it), so the account balance ends wrong by ' +
      'that amount, and on a manual account it stays wrong. There is no unsplit mutation, so ' +
      'a known split parent must be refused before anything is sent (#822).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: delete_transaction refuses a split parent\n' +
        '    if (evidence.isParent) {',
      with:
        '    // mutation-guard: delete_transaction refuses a split parent\n' + '    if (false) {',
    },
    // The exact #822 sequence (both children deleted first, so only the session
    // record knows the parent) and a cache-only source of evidence.
    expectFailingTests: [
      '(b) delete both children, then the parent',
      '(d) parent known only via a live-cache child row',
      '(842) split, delete both children, the parent comes back as an ordinary row',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: "a split parent's amount, date and type are not edited",
    file: 'src/tools/tools.ts',
    invariant:
      "A split parent's amount is already replaced on the account by its children's. What " +
      "Copilot does to the balance when the parent's amount, date or type changes is " +
      'unverified, and it could move the balance twice, so update_transaction(s) refuse those ' +
      'edits on a known split parent before anything is sent (#836).',
    mutation: {
      kind: 'replace',
      find:
        "    // mutation-guard: a split parent's amount, date and type are not edited\n" +
        '    if (evidence.isParent) {',
      with:
        "    // mutation-guard: a split parent's amount, date and type are not edited\n" +
        '    if (false) {',
    },
    expectFailingTests: [
      'edit is refused, nothing sent',
      'update_transactions: one amount edit on a parent refuses the whole batch, nothing sent',
    ],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'a split parent is not linked to a recurring',
    file: 'src/tools/tools.ts',
    invariant:
      'Whether a recurring counts a split parent on top of its children is unverified; linking ' +
      'one could count the same money twice, so add_transaction_to_recurring refuses a known ' +
      'split parent before anything is sent (#836).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a split parent is not linked to a recurring\n' +
        '    if (evidence.isParent) {',
      with:
        '    // mutation-guard: a split parent is not linked to a recurring\n' + '    if (false) {',
    },
    expectFailingTests: ['a parent is refused, nothing sent'],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'a split parent is not split again',
    file: 'src/tools/tools.ts',
    invariant:
      "What Copilot does to the balance on a re-split is unverified, and the parent's amount " +
      'could be counted twice, so split_transaction refuses a known split parent (#836).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a split parent is not split again\n' +
        '    if (splitEvidence.isParent) {',
      with: '    // mutation-guard: a split parent is not split again\n' + '    if (false) {',
    },
    expectFailingTests: [
      're-splitting a known parent is refused, nothing sent',
      'a parent this server just split is refused a second split',
    ],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'a split child is not split',
    file: 'src/tools/tools.ts',
    invariant:
      'What Copilot does to the balance when a split child is split again is unverified, and ' +
      'the amount could be counted twice, so split_transaction refuses a known split child ' +
      '(#836).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a split child is not split\n' +
        '    if (splitEvidence.parentOfTarget) {',
      with: '    // mutation-guard: a split child is not split\n' + '    if (false) {',
    },
    expectFailingTests: ['splitting a split child is refused, nothing sent'],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'bulk_edit_transactions does not retype a split parent',
    file: 'src/tools/tools.ts',
    invariant:
      'A type change on a split parent has the same unverified balance effect through ' +
      'bulkEditTransactions as through editTransaction, so a bulk edit setting a type refuses ' +
      'the whole call when any target is a known split parent (#836).',
    mutation: {
      kind: 'replace',
      find:
        '        // mutation-guard: bulk_edit_transactions does not retype a split parent\n' +
        '        if (evidence.isParent) {',
      with:
        '        // mutation-guard: bulk_edit_transactions does not retype a split parent\n' +
        '        if (false) {',
    },
    expectFailingTests: ['a type change targeting a parent refuses the whole call, nothing sent'],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'an unchecked split target is not written',
    file: 'src/tools/tools.ts',
    invariant:
      'When the window fetch fails, an id cannot be shown not to be a split parent. The ' +
      '#836 writes, whose effect on a split is unverified, are refused then rather than sent ' +
      'on partial evidence (delete_transaction alone proceeds, as documented).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: an unchecked split target is not written\n' +
        '    if (evidence.windowChecked === false) {',
      with:
        '    // mutation-guard: an unchecked split target is not written\n' + '    if (false) {',
    },
    expectFailingTests: [
      'an amount edit is refused when the window cannot be loaded',
      'add_transaction_to_recurring and split_transaction are refused too',
      'create_recurring is refused when the window cannot be loaded',
    ],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'a recurring is not seeded from a split parent',
    file: 'src/tools/tools.ts',
    invariant:
      'A recurring seeded from a split parent could count its amount on top of its ' +
      "children's; the server's behaviour is unverified, so create_recurring refuses a known " +
      'split parent before sending, as add_transaction_to_recurring does (#836).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a recurring is not seeded from a split parent\n' +
        '    if (evidence.isParent) {',
      with:
        '    // mutation-guard: a recurring is not seeded from a split parent\n' +
        '    if (false) {',
    },
    expectFailingTests: ['create_recurring: a split parent is refused, nothing sent'],
    expectFails: 'tests/unit/split-target-refusal.test.ts',
  },
  {
    name: 'a fresh row never retires a split record',
    file: 'src/tools/tools.ts',
    invariant:
      'Once all of its children are deleted, Copilot returns a split parent as an ordinary ' +
      'row with no split marker, and deleting it still credits its amount back a second time ' +
      '(#842). So a recorded split parent must be refused whatever the server now returns for ' +
      'the id: the #822 guard retired its record on a freshly fetched row and sent the delete.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a fresh row never retires a split record\n' +
        '    if (this.isRecordedSplitParent(id)) return { isParent: true, parentOfTarget: null };',
      with:
        '    // mutation-guard: a fresh row never retires a split record\n' +
        '    if (false) return { isParent: true, parentOfTarget: null };',
    },
    expectFailingTests: [
      '(842) split, delete both children, the parent comes back as an ordinary row',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'split-parent records survive a restart',
    file: 'src/tools/tools.ts',
    invariant:
      'After a restart no server row can say an id was ever split (#842), so a parent split ' +
      'through this server must stay refused by the next process: the split record is ' +
      'persisted per uid and consulted on every delete.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: split-parent records survive a restart\n' +
        '    return this.knownSplitParents.has(id) || (this.splitParentStore?.has(id) ?? false);',
      with:
        '    // mutation-guard: split-parent records survive a restart\n' +
        '    return this.knownSplitParents.has(id);',
    },
    expectFailingTests: ['a split recorded by one process is refused by the next one'],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: "delete reads the local cache's split evidence in live mode",
    file: 'src/tools/tools.ts',
    invariant:
      'A soft-deleted split child keeps its parent_transaction_id in the local cache, and it ' +
      'is the only evidence left of a parent whose children were deleted in the app or by an ' +
      'earlier process (#842). Live mode, which every shipped write runs in, must consult it ' +
      'too — decoding the local cache if no read has yet — or the childless parent is deleted.',
    mutation: {
      kind: 'replace',
      find:
        "    // mutation-guard: delete reads the local cache's split evidence in live mode\n" +
        '    const local = await this.localSplitEvidence(id);',
      with:
        "    // mutation-guard: delete reads the local cache's split evidence in live mode\n" +
        '    const local = this.liveDb\n' +
        '      ? { isParent: false, parentOfTarget: null }\n' +
        '      : await this.localSplitEvidence(id);',
    },
    expectFailingTests: [
      'live mode, empty session: a soft-deleted child in the local cache refuses its parent',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'split-parent evidence honours the cache TTL',
    file: 'src/core/database.ts',
    invariant:
      'In live mode nothing else reloads the local cache, so the split-parent id set read on ' +
      'the first delete would otherwise be frozen for the process. A split made in the app ' +
      'and un-split there afterwards would then never be known, and its childless parent ' +
      'deleted (#842, #852 review): the set must be re-read once the cache is past its TTL.',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: split-parent evidence honours the cache TTL\n' +
        '    return !this._allCollectionsLoaded || this.isCacheStale();',
      with:
        '    // mutation-guard: split-parent evidence honours the cache TTL\n' +
        '    return !this._allCollectionsLoaded;',
    },
    expectFailingTests: [
      'past the cache TTL a delete re-reads the local cache and sees a newly deleted child',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'local split evidence only accumulates',
    file: 'src/core/database.ts',
    invariant:
      'A split parent never stops being one, so an id a decode once named must stay named ' +
      'for the process even when a later decode does not (the app purged the soft-deleted ' +
      'children, or a partial read missed them). Replacing the set on each decode would let ' +
      "a re-read past the TTL retire evidence the session held, and the childless parent's " +
      'delete through (#842, #852 review round 2).',
    mutation: {
      kind: 'replace',
      find:
        '      // mutation-guard: local split evidence only accumulates\n' +
        '      for (const id of result.splitParentIds) this._splitParentIds.add(id);',
      with:
        '      // mutation-guard: local split evidence only accumulates\n' +
        '      this._splitParentIds.clear();\n' +
        '      for (const id of result.splitParentIds) this._splitParentIds.add(id);',
    },
    expectFailingTests: [
      'evidence only accumulates: a re-decode that no longer holds the children still refuses',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'a login change re-reads split evidence',
    file: 'src/core/database.ts',
    invariant:
      'A login change empties the accumulated split-parent ids. Unless it also marks the ' +
      'loaded cache stale, the next delete answers from the empty set until the cache TTL ' +
      "runs out, and a childless split parent named only by the cache's soft-deleted " +
      'children is deleted (#842, #852 review round 3).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: a login change re-reads split evidence\n' +
        '    this._cacheLoadedAt = null;',
      with: '    // mutation-guard: a login change re-reads split evidence\n',
    },
    expectFailingTests: [
      'after a uid transition the next delete re-reads the local cache, even while it is fresh',
    ],
    expectFails: 'tests/integration/uid-transition-sweep.test.ts',
  },
  {
    name: 'the split-evidence latch waits for the decode',
    file: 'src/core/database.ts',
    invariant:
      'The split-evidence latch rate-limits decode attempts. Stamped when an attempt starts, ' +
      'it makes a second delete that arrives during the decode skip it and answer from ' +
      'evidence the decode has not added yet, so a childless split parent named only by ' +
      "the cache's soft-deleted children is deleted (#842, #852 review round 4). It must be " +
      'stamped when the attempt resolves, so concurrent callers join the in-flight decode.',
    mutation: {
      kind: 'replace',
      find:
        '      // mutation-guard: the split-evidence latch waits for the decode\n' +
        '      try {\n' +
        '        await this.loadAllCollections();',
      with:
        '      // mutation-guard: the split-evidence latch waits for the decode\n' +
        '      this._splitEvidenceAttemptAt = Date.now();\n' +
        '      try {\n' +
        '        await this.loadAllCollections();',
    },
    expectFailingTests: [
      'two deletes during one slow decode both see its evidence, and it decodes once',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'soft-deleted split children still name their parent',
    file: 'src/core/decoder.ts',
    invariant:
      'The decoder drops soft-deleted transaction documents as rows (#326), but a deleted ' +
      "split child's parent_transaction_id must still be collected: after its last child is " +
      'deleted nothing else marks a split parent, and deleting it double-credits (#842).',
    mutation: {
      kind: 'replace',
      find:
        '        // mutation-guard: soft-deleted split children still name their parent\n' +
        '        collectSplitParentIds(fields, documentId, rawSplitParentIds);',
      with:
        '        // mutation-guard: soft-deleted split children still name their parent\n' +
        '        if (isDecodableTransactionDocument(fields))\n' +
        '          collectSplitParentIds(fields, documentId, rawSplitParentIds);',
    },
    expectFailingTests: [
      'live mode, empty session: a soft-deleted child in the local cache refuses its parent',
      'cache-only mode: a soft-deleted child in the local cache refuses its parent',
    ],
    expectFails: 'tests/unit/delete-split-parent.test.ts',
  },
  {
    name: 'an ambiguous Chromium profile name is refused',
    file: 'src/core/auth/browser-token.ts',
    invariant:
      'A --browser-profile that matches two Chromium profiles (a directory name and another ' +
      "profile's display name, or two display names) must search nothing. Edge's built-in " +
      'display names are off by one from its directories, so resolving by precedence hands ' +
      "the server another person's session, and under --write their account (#837).",
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: an ambiguous Chromium profile name is refused\n' +
        '    if (matches.size > 1) {',
      with:
        '    // mutation-guard: an ambiguous Chromium profile name is refused\n' +
        '    if (matches.size > 99) {',
    },
    expectFailingTests: [
      'Edge off-by-one display names',
      'two profiles with the same display name are refused',
      'Chromium pair is refused',
    ],
    expectFails: 'tests/core/auth/browser-selection.test.ts',
  },
  {
    name: 'an ambiguous Firefox profile name is refused',
    file: 'src/core/auth/browser-token.ts',
    invariant:
      'A --browser-profile that matches two Firefox profiles (by directory, post-dot suffix ' +
      'or profiles.ini Name=, in any combination) must search nothing, for the same reason ' +
      'as the Chromium guard: either match may be another person, and the first token to ' +
      'exchange would win (#837).',
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: an ambiguous Firefox profile name is refused\n' +
        '    if (matches.size > 1) {',
      with:
        '    // mutation-guard: an ambiguous Firefox profile name is refused\n' +
        '    if (matches.size > 99) {',
    },
    expectFailingTests: [
      'Firefox: a suffix match and a different profile’s Name= are refused',
      'Firefox pair is refused',
    ],
    expectFails: 'tests/core/auth/browser-selection.test.ts',
  },
  {
    name: 'the internal income flag is never returned',
    file: 'src/tools/tools.ts',
    invariant:
      'Cache rows must never carry the decoded `income` flag (#854). It exists only so the ' +
      'shared transaction_type rules can recognise an INCOME row in cache mode; live rows ' +
      'have no such field, so surfacing it reopens the cache/live field-name divergence ' +
      '#843 closed. Not a write-safety invariant like the rows above: registered at review ' +
      'request because it is a one-line strip whose only other defence is a type.',
    mutation: {
      kind: 'replace',
      find:
        '      // mutation-guard: the internal income flag is never returned\n' +
        '      transactions.map(async ({ income: _internal, ...txn }) => ({',
      with:
        '      // mutation-guard: the internal income flag is never returned\n' +
        '      transactions.map(async (txn) => ({',
    },
    expectFailingTests: ['the internal `income` flag is never returned'],
    expectFails: 'tests/tools/transaction-type-parity.test.ts',
  },
  {
    name: 'tool arguments are validated at dispatch',
    file: 'src/server.ts',
    invariant:
      "Every tool call is checked against the tool's inputSchema before any handler runs " +
      '(#845). Without it an argument a tool does not take is dropped in silence — a filter ' +
      'the caller believes ran did not — and on a write tool an unrecognised or mistyped ' +
      "argument reaches the handler and, for enum values, Copilot's server.",
    mutation: {
      kind: 'replace',
      find:
        '    // mutation-guard: tool arguments are validated at dispatch\n' +
        '    const argsError = validateToolArgs(toolDef, typedArgs);',
      with:
        '    // mutation-guard: tool arguments are validated at dispatch\n' +
        '    const argsError: string | null = null;',
    },
    expectFailingTests: [
      'every tool rejects an argument it does not declare, before any handler runs',
      'get_investment_balance_live time_frame "1W" is a clean client-side error',
    ],
    expectFails: 'tests/unit/dispatch-arg-validation.test.ts',
  },
  {
    name: 'handler-rejected arguments pass dispatch',
    file: 'src/tools/input-validation.ts',
    invariant:
      'An argument a tool lists in argsRejectedByHandler must reach that handler, which ' +
      'explains it better than dispatch can: a v3 migration hint, "not supported in live ' +
      'mode", or why Copilot cannot do it (#877). Without the pass-through the caller gets a ' +
      'bare "unknown argument" and, for a removed argument, no hint of what to pass instead.',
    mutation: {
      kind: 'replace',
      find:
        '      // mutation-guard: handler-rejected arguments pass dispatch\n' +
        '      if (!rejectUnknown || passThrough.includes(key)) continue;',
      with:
        '      // mutation-guard: handler-rejected arguments pass dispatch\n' +
        '      if (!rejectUnknown) continue;',
    },
    expectFailingTests: [
      'every argsRejectedByHandler entry is rejected by its own handler, with or without a cache',
    ],
    expectFails: 'tests/unit/dispatch-arg-validation.test.ts',
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
 * Inside the run root's own `node_modules`, not the OS temp dir.
 *
 * It has to be derivable from `root` alone, so the next run in the same
 * checkout can find what a killed one left behind — which rules out a random
 * name. A fixed path under `tmpdir()` satisfies that too, but on Linux
 * `tmpdir()` is the shared `/tmp`: `mkdirSync(..., { recursive: true })` adopts
 * a directory someone else created, and `writeFileSync` follows a symlink
 * planted at the journal's name. `validEntries` closes the READ side of that,
 * but a docblock claiming the journal is untrusted should not leave the write
 * side pointing at a world-writable directory.
 *
 * `node_modules/` is per-checkout (this project uses worktrees heavily, and
 * they do not share it), already gitignored, and writable only by whoever owns
 * the checkout — which is the same person the runner is already acting as.
 */
export function journalPath(root: string): string {
  return join(root, 'node_modules', '.cache', 'mutation-guards', 'journal.json');
}

/**
 * What `restoreEntry` names the file it refuses to overwrite.
 *
 * A constant rather than an inline template because two very different things
 * depend on the spelling: the give-up path that writes it, and the pre-run scan
 * that has to find one written by a process that has long since exited.
 */
export const SIDECAR_SUFFIX = '.mutation-guard-original';

/**
 * Every leftover `<file>.mutation-guard-original` under `root`.
 *
 * The sidecar outlives everything else about a refused restore: the journal can
 * be deleted, the process is gone, and what is left is one untracked file next
 * to a source file holding somebody's unreconciled bytes. Nothing was looking
 * for it, so the run after the refusal could evaluate the whole registry green
 * over exactly the tree the refusal said not to trust.
 *
 * Root-wide rather than `src`-only like `findMarkers`, because a row may name
 * a file anywhere in the checkout and a refusal must be findable without
 * knowing which row produced it — the scan runs before the registry is even
 * read. `SKIPPED_DIRS` is the cost control and the statement of what cannot
 * hold one: dependencies, git's object store, and build output are not files a
 * registry row names, so a sidecar there would not be one this runner wrote.
 * Symlinked directories are not followed — `isDirectory()` is false for a
 * symlink — which keeps the scan inside the checkout it was given.
 */
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

export function findSidecars(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory is not a reason to abandon the scan, and not a
      // finding either: the scan reports sidecars, not permissions.
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      // The name decides, not the entry type, and before the descent: a
      // directory at a sidecar's name is exactly what a give-up whose sidecar
      // write THREW leaves behind (the write hit something in the way), and a
      // symlink there is no less a sign that something gave up or interfered.
      // Matching on `isFile()` made both invisible to the one scan whose job
      // is to say so.
      if (entry.name.endsWith(SIDECAR_SUFFIX)) {
        found.push(abs);
        continue;
      }
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(abs);
    }
  };
  walk(root);
  return found.sort();
}

const ACTIVE = new Map<string, JournalEntry>();
/**
 * Entries this process gave up on, per root, that no human has reconciled yet.
 *
 * One journal per root holds two kinds of entry: the live mutations in
 * `ACTIVE`, and refusals kept for a human. Deciding "may this journal go?"
 * from `ACTIVE` alone deleted the record of a refusal the moment a sibling
 * mutation in the same root restored cleanly — a nested `withMutation` whose
 * inner call refuses and whose outer call succeeds. So the refusals are state
 * of their own, and `persistJournal` writes the union. `recoverJournal` resets
 * a root's set from what is on disk, because between runs it is the journal,
 * not this process's memory, that a human edits.
 */
const REFUSED = new Map<string, JournalEntry[]>();
let handlersInstalled = false;
/** Set when a restore could not be completed safely; forces a non-zero exit. */
let restoreFailed = false;
/**
 * The files whose restore THREW rather than returned `false`, this run.
 *
 * Kept apart because the two give-ups leave different evidence. A `false`
 * comes out of `refuse()` after it printed its message and wrote the sidecar;
 * a throw means at least one of those never happened, so a report pointing at
 * "the message above and the sidecar" would send the operator after things
 * that do not exist.
 */
let restoreThrew: string[] = [];

/**
 * The `pid` a journal records when no run holds it.
 *
 * A kept journal is the one journal meant to outlive its process — for days,
 * until a human reconciles. Stamped with the writer's pid, it reads as "held
 * by a live run" as soon as the OS hands that pid to anything else, and the
 * next run throws "another run holds the journal" instead of reporting the
 * refusal. `isAlive` treats this value as dead by definition.
 */
const NO_OWNER = 0;

function addRefused(entry: JournalEntry): void {
  const others = (REFUSED.get(entry.root) ?? []).filter((e) => e.abs !== entry.abs);
  REFUSED.set(entry.root, [...others, entry]);
}

/**
 * The one writer: `entries` becomes this root's journal, replacing whatever is
 * there. Throws on a write failure — whether that is fatal is the caller's
 * call (`withMutation` must not mutate a file it could not journal), or it is
 * something to report and survive (`persistJournal`).
 */
function writeJournalEntries(root: string, entries: readonly JournalEntry[], owner: number): void {
  const path = journalPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const journal: Journal = {
    // `process.pid` while a live mutation in this root is in flight, so a
    // concurrent run backs off; `NO_OWNER` once only refusals are left, so a
    // reused pid cannot make a journal kept for a human look held.
    pid: owner,
    startedAt: new Date().toISOString(),
    entries: [...entries],
  };
  writeFileSync(path, JSON.stringify(journal), 'utf8');
}

/** This root's kept refusals plus its live entries, and who (if anyone) holds them. */
function journalStateFor(root: string): { entries: JournalEntry[]; owner: number } {
  // This root's entries only. A process driving more than one root (the
  // meta-test does) would otherwise write every root's journal with every other
  // root's files in it — which `validEntries` then rejects on read, turning a
  // bookkeeping slip into a stream of scary-looking warnings.
  const live = [...ACTIVE.values()].filter((entry) => entry.root === root);
  return {
    entries: [...(REFUSED.get(root) ?? []), ...live],
    owner: live.length > 0 ? process.pid : NO_OWNER,
  };
}

/** Journal BEFORE mutating, and throw if that fails: an unrecorded mutation is the worst state. */
function writeJournal(root: string): void {
  const { entries, owner } = journalStateFor(root);
  try {
    writeJournalEntries(root, entries, owner);
  } catch (e) {
    // Recorded before rethrowing, so `JOURNAL_UNWRITTEN` really is "the last
    // write failed" for every writer, not only for `persistJournal`.
    JOURNAL_UNWRITTEN.add(root);
    throw e;
  }
  JOURNAL_UNWRITTEN.delete(root);
}

/**
 * Roots whose LAST journal write failed.
 *
 * The rows that tell an operator "the original bytes are in the kept journal"
 * must read this, not the disk: a failed rewrite usually leaves something at
 * the path — the previous file, one truncated by `writeFileSync`'s `O_TRUNC`
 * before the write failed, a directory — so `existsSync` vouches for bytes the
 * write just failed to put there. The write's own outcome is the evidence.
 *
 * Every journal writer records into it (`writeJournal` and `persistJournal`),
 * and `runGuards` clears a root's entry at the start of each run alongside
 * `restoreFailed`, so a verdict never carries over from an earlier call in
 * the same process.
 */
const JOURNAL_UNWRITTEN = new Set<string>();

/**
 * The ONE sentence any report makes about the kept journal. Every row that
 * mentions it goes through here, so the claim cannot drift between them, and
 * which wording applies is decided once per row by the caller (`unwritten`).
 */
export function keptJournalClause(root: string, unwritten: boolean): string {
  const path = journalPath(root);
  return unwritten
    ? `the journal at ${path} could not be rewritten (see the messages above), so whatever ` +
        `is there now may not hold the pre-mutation bytes — reconcile from the ` +
        `${SIDECAR_SUFFIX} sidecar, where one could be written`
    : `the pre-mutation bytes are in the kept journal, ${path}`;
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Bring this root's journal in line with what is still unreconciled — rewrite
 * it if anything is, delete it if nothing is — and never throw.
 *
 * Every caller is on a give-up or clean-up path, and "giving up is a write too"
 * applies to this write as much as to the sidecar: unguarded, a throw here
 * escaped the exit sweep before the remaining roots were handled. A failure is
 * printed with the path rather than raised — not swallowed, because a journal
 * that could not be narrowed or cleared is one the next run will read, and the
 * operator should know why it says what it says.
 */
function persistJournal(root: string): boolean {
  const { entries, owner } = journalStateFor(root);
  try {
    if (entries.length === 0) rmSync(journalPath(root), { force: true });
    else writeJournalEntries(root, entries, owner);
    JOURNAL_UNWRITTEN.delete(root);
    return true;
  } catch (e) {
    JOURNAL_UNWRITTEN.add(root);
    console.error(
      `mutation-guards: could not update ${journalPath(root)} ` +
        `(${e instanceof Error ? e.message : String(e)}), so the next run may read a ` +
        `journal that disagrees with this one. Unreconciled here: ` +
        `${entries.length === 0 ? 'nothing' : entries.map((entry) => entry.abs).join(', ')}.`
    );
    return false;
  }
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
      return refuse(
        entry,
        `FAILED to restore ${entry.abs} — the write-back reported success and read back ` +
          `different bytes, so the file holds neither the mutation nor the original.`
      );
    }
    return true;
  }
  return refuse(
    entry,
    `${entry.abs} changed while it was mutated, so it was NOT overwritten. Restoring ` +
      `automatically here would throw away whatever made the change.`
  );
}

/**
 * Give up on one entry, loudly and with the evidence on disk.
 *
 * Every `false` out of `restoreEntry` comes through here, which is the point:
 * the verification branch used to return without writing a sidecar, so that
 * refusal ended the run with the `(restore)` row pointing at a file nobody had
 * written — and, once `withMutation` cleared the journal, with nothing at all
 * for the next run to find. That is the same shape as the bug this file was
 * just fixed for, one branch over.
 */
function refuse(entry: JournalEntry, why: string): boolean {
  const sidecar = `${entry.abs}${SIDECAR_SUFFIX}`;
  writeFileSync(sidecar, entry.original, 'utf8');
  console.error(
    `mutation-guards: ${why}\n  The pre-mutation content is at ${sidecar}. Reconcile by ` +
      `hand: put those bytes back, or keep what is there and delete the sidecar.`
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
      let ok = false;
      try {
        ok = restoreEntry(entry);
      } catch {
        // This is the last chance every OTHER entry gets, so one that throws
        // on the way out — the sidecar write hitting a read-only directory, a
        // full disk — must not take the rest of the sweep with it. Counted as
        // a refusal, which keeps the journal that names it.
      }
      if (!ok) {
        restoreFailed = true;
        addRefused(entry);
      }
      ACTIVE.delete(entry.abs);
      roots.add(entry.root);
    }
    // A root with a refused entry keeps a journal, for the same reason
    // `recoverJournal` does: the journal is the record that the refusal
    // happened and the only copy of the original bytes, so clearing it here
    // would hand the next run an empty desk. Decided per root from `REFUSED`
    // rather than off the module-level `restoreFailed`, which is sticky across
    // calls in one process and would keep journals for roots that restored
    // cleanly — and narrowed to the refused entries, because what is left on
    // disk otherwise still names the entries that DID come back and re-arms
    // them against the next ordinary edit. `persistJournal` does not throw:
    // this is the last write every OTHER root gets, too.
    for (const root of roots) persistJournal(root);
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
    let ok = false;
    let threw = true;
    try {
      ok = restoreEntry(entry);
      threw = false;
    } finally {
      // Bookkeeping in a `finally` of its own, because `restoreEntry` can THROW
      // — it writes a sidecar, and a read-only directory or a full disk makes
      // that a throw rather than a `false`. Assigning the flag after the call
      // meant the throw left `restoreFailed` false, the loop's stop-editing
      // guard read false, and the run carried on mutating a tree whose last
      // file was never put back. Three of the six rows name one file, so the
      // next row would have read that content as its `original`.
      if (!ok) {
        restoreFailed = true;
        addRefused(entry);
        if (threw) restoreThrew.push(abs);
      }
      // Dropped from ACTIVE either way: a throwing entry left in it is retried
      // by the exit handler, where the same throw is an uncaught exception
      // inside `process.on('exit')` and takes the rest of the sweep with it.
      ACTIVE.delete(abs);
      // A refusal is kept — in `REFUSED`, and so in the journal, with the
      // sidecar beside the file where one could be written — so the next run
      // in this checkout inherits it instead of finding nothing and starting
      // green. A success narrows the journal to what is left: the live entries
      // of an enclosing call AND any refusal a sibling call recorded, which a
      // decision made from `ACTIVE` alone used to delete.
      persistJournal(root);
    }
  }
}

export interface RecoveryReport {
  readonly recovered: string[];
  readonly refused: string[];
  /**
   * `<file>.mutation-guard-original` files that were already on disk when this
   * run started — an EARLIER run gave up restoring those files and nothing has
   * reconciled them since. Reported separately from `refused`, which is this
   * run's own give-ups, because the two need different sentences: one says
   * "I could not put this back", the other "someone before me could not, and
   * you have not dealt with it yet".
   */
  readonly sidecars: string[];
}

/**
 * Restore anything a killed run left behind, before this run touches a file.
 *
 * Throws if the journal names a live process: two concurrent runs mutating the
 * same files would each restore the other's "original", and the loser wins.
 */
export function recoverJournal(root: string): RecoveryReport {
  // Before the journal, and unconditionally: the sidecar is what a refusal
  // leaves behind AFTER its journal is gone, so a scan that only ran when there
  // was a journal to read would miss the exact state it exists to catch.
  const sidecars = findSidecars(root);
  // The journal on disk is what a human reconciles between runs, so it — not
  // whatever this process remembered — is the record of this root's refusals.
  // Reset BEFORE any early return: "no journal" is the documented way to
  // accept a refusal, and an early exit that skipped this reset let the next
  // successful mutation in the same process write the accepted refusal back.
  // It also precedes the live-owner throw below, deliberately: a root whose
  // journal another live run holds is not this process's to remember refusals
  // for. Harmless today: that throw leaves `runGuards` before any
  // `withMutation` puts an entry for this root in `ACTIVE`, and the exit sweep
  // only persists roots it found there — so nothing in this process reaches
  // `persistJournal(root)` afterwards to rewrite (or delete) that run's journal.
  REFUSED.delete(root);
  const path = journalPath(root);
  if (!existsSync(path)) return { recovered: [], refused: [], sidecars };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Recovery state, not a source of truth. The crash this file exists for can
    // truncate the file mid-write, and a gate that then throws on every
    // `bun run check` until someone hand-deletes a file in the temp dir would be
    // a worse failure than the one it is recovering from.
    rmSync(path, { force: true });
    return { recovered: [], refused: [], sidecars };
  }
  const journal = isRecord(parsed) ? parsed : {};
  const entries = validEntries(journal.entries, root);
  const pid = typeof journal.pid === 'number' ? journal.pid : NO_OWNER;
  // Only refuse over a journal that actually holds something. `writeJournal` is
  // never called with an empty entry list for this root, so an entry-less
  // journal names no file either run could collide over — and refusing on one
  // would brick every `bun run check` until someone hand-deleted it, which is
  // the failure the JSON-parse branch above exists to avoid. Reachable without
  // an attacker, too: pid reuse.
  if (entries.length > 0 && pid !== process.pid && isAlive(pid)) {
    throw new Error(
      `mutation-guards: another run (pid ${String(pid)}, started ${safe(journal.startedAt)}) ` +
        `holds ${path}. Two runs mutating the same files would restore each other's ` +
        `originals. Wait for it, or delete that file if you are sure the process is unrelated.`
    );
  }
  const recovered: string[] = [];
  const refused: string[] = [];
  for (const entry of entries) {
    let ok = false;
    try {
      const before = existsSync(entry.abs) ? readFileSync(entry.abs, 'utf8') : '';
      if (before === entry.original) continue;
      ok = restoreEntry(entry);
    } catch (e) {
      // The same per-entry catch the exit sweep has, for the same reason: a
      // give-up that throws (its sidecar write hitting a directory, a full
      // disk) must not abandon every entry after it and escape runGuards
      // before a single row exists. Counted as a refusal, so the journal that
      // holds its original bytes is kept — which matters most here, since a
      // throwing refuse() may have written no sidecar at all.
      console.error(
        `mutation-guards: recovering ${entry.abs} threw ` +
          `(${e instanceof Error ? e.message : String(e)}); its original bytes stay in ` +
          `${path}.`
      );
    }
    if (ok) recovered.push(entry.abs);
    else {
      refused.push(entry.abs);
      addRefused(entry);
    }
  }
  // The journal is deleted only when there is nothing left to recover. Deleting
  // it after a REFUSED entry destroys the only record of the original bytes and
  // the only thing that reports the refusal: the next `bun run check` finds no
  // journal, calls recovery a no-op, and evaluates every row green over a file
  // still holding a third party's content with a stale sidecar beside it. So
  // the refusal is re-read and re-reported every run until a human reconciles
  // it — by restoring those bytes, or by deleting this file to accept what is
  // on disk, which is what the `(journal recovery)` row tells them.
  //
  // Narrowed to the refused entries rather than kept verbatim: an entry that
  // DID come back is finished, and leaving it armed would turn the next
  // ordinary edit to that file into a refusal of its own — a sidecar dropped
  // over a file this runner never left mutated.
  //
  // `persistJournal` writes exactly `REFUSED` for this root (nothing is live
  // yet), stamped `NO_OWNER`: the journal is now waiting on a human, not held
  // by this process, and a pid that outlives its meaning is what pid reuse
  // turns into "another run holds the journal". It does not throw — this is a
  // give-up path too, and one that runs before runGuards has built any row.
  persistJournal(root);
  return { recovered, refused, sidecars };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strip control characters from a string that came out of the journal.
 *
 * `validEntries` treats that file as hostile, so its contents must not be
 * echoed to a terminal verbatim: the reachable payoff is ANSI escapes rewriting
 * the very message that reports the rejection, which would undo the reporting.
 * Small, but the threat model is only worth stating if it is carried all the
 * way through.
 */
function safe(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '?');
}

/**
 * The entries of a journal that this runner could plausibly have written.
 *
 * The journal is a list of "write these bytes to that path", executed before
 * anything else this script does. `journalPath` now points inside the
 * checkout's own `node_modules`, which closes the original hole — it used to be
 * a fixed name under the shared `/tmp`, where creating the file is not a
 * privilege — but the validation stays, because the pid field was never a
 * defence (a planted journal names a dead pid) and a file's trustworthiness is
 * a property of today's path, not of the code that reads it.
 *
 * Two conditions, and an entry failing either is dropped rather than obeyed:
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
        `mutation-guards: ignoring a journal entry for ${safe(abs)}, which is outside ${root}. ` +
          `This runner only ever mutates files under the root it was given, so that entry ` +
          `was not written by it.`
      );
      continue;
    }
    kept.push({ root, abs, original, mutated });
  }
  return kept;
}

/**
 * Whether `pid` names one live process.
 *
 * Only a positive integer can. `kill(0, 0)` signals the caller's own process
 * GROUP and `kill(-1, 0)` every process it may signal, so both "succeed" and
 * read as alive — which would make a `NO_OWNER` journal, or a planted
 * negative pid, look held forever.
 */
function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
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
  /**
   * How the child died, when it did not exit on its own. `'timeout'` is the
   * bounded-run case; `'signal'` is any other kill (an OOM, most likely), kept
   * separate so the report does not name a timeout that did not happen.
   */
  readonly killedBy: 'timeout' | 'signal' | null;
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
  killedBy: 'timeout' | 'signal' | null = null
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
    killedBy,
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
  // The OR is a fail-safe: spawnSync reports the timeout through `error`, but a
  // child that died to SIGKILL some other way (an OOM) must not be read as a
  // clean run either. They are reported apart so neither borrows the other's
  // explanation.
  const timedOut =
    res.error !== undefined && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const killedBy = timedOut ? 'timeout' : res.signal === 'SIGKILL' ? 'signal' : null;
  return parseBunTestSummary(
    `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    res.status ?? -1,
    killedBy
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
  /** Bound on the MUTATED run; overridable so the timeout path is testable. */
  readonly timeoutMs?: number;
  /**
   * Bound on the unmutated baseline, kept separate on purpose. A test that
   * shortens `timeoutMs` to exercise a hanging mutation must not also shorten
   * the baseline, or a cold runner transpiling the fixture slowly fails with a
   * message about the wrong thing.
   */
  readonly baselineTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export async function runGuards(
  options: RunOptions = {}
): Promise<{ ok: boolean; results: GuardResult[] }> {
  const root = options.root ?? REPO_ROOT;
  const all = options.guards ?? MUTATION_GUARDS;
  const log = options.log ?? ((line: string) => void console.log(line));
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  const baselineTimeoutMs = options.baselineTimeoutMs ?? TEST_TIMEOUT_MS;
  // Module-level, because the exit handler has nowhere else to report from.
  // Each run owns its own verdict, so clear it rather than inheriting one from
  // a previous call in the same process (the meta-test makes several).
  restoreFailed = false;
  restoreThrew = [];
  JOURNAL_UNWRITTEN.delete(root);

  const recovery = recoverJournal(root);
  for (const file of recovery.recovered) {
    log(`  ! recovered a file left mutated by an earlier killed run: ${file}`);
  }
  // Both rows, not the first one only: they name different files as often as
  // not, and a run blocked on an unreconciled tree should print everything the
  // operator has to deal with before the next run can say anything.
  const blocked: GuardResult[] = [];
  if (recovery.refused.length > 0) {
    // From the write's own outcome, not a disk probe: see `JOURNAL_UNWRITTEN`.
    const unwritten = JOURNAL_UNWRITTEN.has(root);
    blocked.push({
      name: '(journal recovery)',
      ok: false,
      detail: unwritten
        ? `could not restore ${recovery.refused.join(', ')}, AND ` +
          // `unwritten`, not a literal, in both arms: a literal would only be
          // right because of the arm it sits in, and swapping the arms would
          // then invert what the row claims about the journal.
          `${keptJournalClause(root, unwritten)}. Reconcile by hand before trusting this ` +
          `tree, then delete each sidecar and whatever is at that journal path.`
        : `could not restore ${recovery.refused.join(', ')} — ` +
          `${keptJournalClause(root, unwritten)}, and in the ${SIDECAR_SUFFIX} file beside ` +
          `each where one could be written (see the messages above). The journal was KEPT, ` +
          `so this run and every run after it says so rather than handing the next one a ` +
          `green registry over the same tree. Two ways to end it, and BOTH are reconciling: ` +
          `put the original bytes back, or keep the file as it stands and delete ` +
          `${journalPath(root)}. Either way delete the sidecar — while it is there the run ` +
          `below still refuses.`,
    });
  }
  if (recovery.sidecars.length > 0) {
    blocked.push({
      name: '(unreconciled sidecar)',
      ok: false,
      detail:
        `an earlier run gave up restoring a file and left ${recovery.sidecars.join(', ')} ` +
        `behind. Nothing has reconciled it since, so the tree this registry would be ` +
        `measured over is not one this runner wrote. Compare the sidecar with the file ` +
        `beside it, keep the version you want, delete the sidecar — and if ` +
        `${journalPath(root)} is still there, it holds the same refusal and goes too.`,
    });
  }
  if (blocked.length > 0) return { ok: false, results: blocked };

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

  /**
   * One row, evaluated. Separated out so the loop can turn an UNEXPECTED throw
   * into a failing row: without that, a surprise here (applyMutation on content
   * the runner no longer understands, an unreadable file) escapes runGuards
   * entirely and the operator gets a stack trace instead of the results already
   * computed — including the `(restore)` row that points at the sidecar.
   */
  const evaluate = async (guard: MutationGuard): Promise<GuardResult> => {
    let baseline = baselines.get(guard.expectFails);
    if (baseline === undefined) {
      baseline = runTestFile(root, guard.expectFails, baselineTimeoutMs);
      baselines.set(guard.expectFails, baseline);
    }
    if (baseline.killedBy !== null) {
      // Read BEFORE the red-either-way branch below, which a killed baseline
      // would otherwise land in: `ran: null` looks identical there, and
      // "your detector fails without any mutation" is the wrong thing to send
      // someone to fix when what happened is that it never finished.
      return {
        name: guard.name,
        ok: false,
        detail:
          `the UNMUTATED run of ${guard.expectFails} was killed ` +
          (baseline.killedBy === 'timeout'
            ? `after ${String(baselineTimeoutMs / 1000)}s`
            : 'by a signal (an out-of-memory kill is the usual cause)') +
          `, so nothing was mutated and nothing was proved. This is the detector or the ` +
          `machine, not the guard.\n${tail(baseline.output)}`,
      };
    }
    if (baseline.ran === null || baseline.ran === 0 || baseline.fail > 0 || baseline.errors > 0) {
      return {
        name: guard.name,
        ok: false,
        detail:
          `detector ${guard.expectFails} does not PASS unmutated ` +
          `(ran=${String(baseline.ran)} pass=${String(baseline.pass)} fail=${String(baseline.fail)} ` +
          `errors=${String(baseline.errors)}). A detector that is red either way proves nothing, ` +
          `so this direction is checked first.\n${tail(baseline.output)}`,
      };
    }

    const abs = join(root, guard.file);
    const mutated = applyMutation(readFileSync(abs, 'utf8'), guard.mutation);
    const after = await withMutation(root, guard.file, mutated, () =>
      runTestFile(root, guard.expectFails, timeoutMs)
    );

    if (after.killedBy !== null) {
      return {
        name: guard.name,
        ok: false,
        detail:
          (after.killedBy === 'timeout'
            ? `the mutated run was killed after ${String(timeoutMs / 1000)}s. Deleting an ` +
              `early-exit guard is the edit class that turns a bounded loop unbounded, so ` +
              `treat this as "the mutation hung the detector", not as a detection.`
            : `the mutated run was killed by a signal without hitting the ${String(
                timeoutMs / 1000
              )}s bound — an out-of-memory kill is the usual cause. Either way the detector ` +
              `never reported, so this is not a detection.`) + `\n${tail(after.output)}`,
      };
    }
    if (after.ran !== baseline.ran) {
      return {
        name: guard.name,
        ok: false,
        detail:
          `the mutation changed how many tests RAN (${String(baseline.ran)} → ${String(after.ran)}), ` +
          `so ${guard.expectFails} did not fail for a behavioural reason. Almost always a ` +
          `mutation that leaves the file unparseable — fix the find/with strings.`,
      };
    }
    if (after.errors > 0) {
      return {
        name: guard.name,
        ok: false,
        detail:
          `the mutated run reported ${String(after.errors)} module-level/uncaught error(s). ` +
          `That is a broken mutation wearing a detection's clothes; the guard is unproven.`,
      };
    }
    const undetectedBy = guard.expectFailingTests.filter(
      (needle) => !after.failingTests.some((name) => name.includes(needle))
    );
    if (after.fail > 0 && undetectedBy.length > 0) {
      return {
        name: guard.name,
        ok: false,
        detail:
          `${guard.expectFails} went red, but not because of the test(s) this row names: ` +
          `${undetectedBy.join(', ')} still passed. What failed instead: ` +
          `${after.failingTests.join(', ')}. A row riding on a sibling test's failure is the ` +
          `same hole as a guard with no detector, one level up.`,
      };
    }
    if (after.fail === 0) {
      return {
        name: guard.name,
        ok: false,
        detail:
          `VACUOUS — disabling this guard left ${guard.expectFails} entirely green ` +
          `(${String(after.pass)} pass, 0 fail). Nothing detects its removal. Write a test that ` +
          `pins the PROPERTY ("${guard.invariant.split('.')[0]!.trim()}"), not the error message.`,
      };
    }

    return {
      name: guard.name,
      ok: true,
      detail:
        `${guard.expectFails}: ${String(baseline.pass)} pass unmutated → ${String(after.fail)} ` +
        `fail mutated\n      caught by: ${after.failingTests.join(' | ')}`,
    };
  };

  for (const [index, guard] of selected.entries()) {
    // A refused restore means some file under `root` now holds a third party's
    // bytes and this runner no longer has a model of it. Three of the six rows
    // target src/tools/tools.ts, so continuing would read THAT content as the
    // next row's `original` — either mutating a file we no longer understand,
    // or throwing out of applyMutation and losing the `(restore)` row that
    // tells the operator about the sidecar. Stop editing the tree instead.
    if (restoreFailed) {
      // Naming what was skipped, because `results` only ever holds rows that
      // were evaluated and the summary counts against it: a refusal on row 1 of
      // six would otherwise print "1 of 2 failed" and read as a two-row
      // registry. A run that covered less than it appears to, without saying
      // so, is the shape of the bug this whole file exists to prevent.
      const skipped = selected.slice(index).map((g) => g.name);
      results.push({
        name: '(skipped)',
        ok: false,
        detail:
          `${String(skipped.length)} row(s) were never evaluated because the run stopped: ` +
          `${skipped.join(', ')}. They are neither proved nor disproved.`,
      });
      break;
    }
    try {
      results.push(await evaluate(guard));
    } catch (e) {
      results.push({
        name: guard.name,
        ok: false,
        detail: `the runner threw while evaluating this row: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (restoreFailed) {
    // As its own row rather than a silent `ok: false`: every other failure here
    // names itself, and "0 of 6 failed" over a red exit code is the kind of
    // report that gets read as a flake and rerun.
    //
    // Two wordings, because the two give-ups leave different evidence. A
    // refusal printed its reason and wrote the sidecar; a give-up that THREW
    // did neither (or not both), so pointing that operator at "the message
    // above and the sidecar" sends them after things that may not exist. What
    // both paths do leave is the kept journal, which holds the original bytes.
    //
    // And what the row says about the journal comes from the journal write's
    // own outcome (`keptJournalClause`), not from assuming it landed: the
    // write that keeps a refusal is a give-up write, and can fail too.
    const journal = keptJournalClause(root, JOURNAL_UNWRITTEN.has(root));
    results.push({
      name: '(restore)',
      ok: false,
      detail:
        restoreThrew.length > 0
          ? `restoring ${restoreThrew.join(', ')} THREW before it could finish giving up — the ` +
            `error is on the row that was being evaluated, and there may be no ` +
            `${SIDECAR_SUFFIX} sidecar and no message for it. ${capitalise(journal)}. ` +
            `Reconcile before trusting anything else in this run.`
          : `a mutated file could not be put back safely — see the message above and the ` +
            `${SIDECAR_SUFFIX} sidecar; ${journal}. ` +
            `Reconcile before trusting anything else in this run.`,
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** What an argv asked for. `error` carries the message and means exit 2. */
export type CliPlan =
  | { readonly kind: 'list' }
  | { readonly kind: 'run'; readonly only?: string }
  | { readonly kind: 'error'; readonly message: string };

/** The usage-error exit code, as distinct from 1 = "a guard failed". */
export const CLI_USAGE_EXIT = 2;

/**
 * Read argv, or say why it cannot be read — never a third thing.
 *
 * The failure this replaces is the one shape of bug this whole file is about:
 * a parser that recognises `--guard` and ignores everything else answers
 * `--gaurd 'one row'` by running the WHOLE registry and exiting 0, and the
 * operator reads that green as an answer to the narrow question they asked.
 * The same goes for a stray positional — `mutation-guards 'one row'`, the
 * likeliest typo of all, since the name is the part you remember. So every
 * argv entry must be claimed by a spelling this function knows, and an
 * unclaimed one is an error naming itself rather than a silent default.
 *
 * Separated from the `import.meta.main` block so it can be tested as a
 * function: argv parsing that only exists inside a top-level `if` is reachable
 * from a test only by spawning the CLI, which is why it had no coverage at all.
 */
export function parseCliArgs(argv: readonly string[]): CliPlan {
  const usage = '--list, --guard <name>, or --guard=<name>';
  let only: string | undefined;
  let list = false;
  // Every entry is read before anything is dispatched. Returning from inside
  // the loop on the first thing recognised would make the promise above
  // order-dependent: `--list --gaurd x` would print the list and drop the typo
  // silently, which is the failure this function exists to remove.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--list') {
      // Rejected twice over for the same reason `--guard` is: `--list` carries
      // no value to last-win over, so a repeat is harmless — but "the parser
      // ignored one of the things you typed" is the shape being removed here,
      // and an exception for the harmless case is the one a later reader
      // copies.
      if (list) {
        return { kind: 'error', message: 'mutation-guards: --list given twice. One is enough.' };
      }
      list = true;
      continue;
    }
    if (arg === '--guard' || arg.startsWith('--guard=')) {
      const inline = arg.startsWith('--guard=');
      const value = inline ? arg.slice('--guard='.length) : argv[i + 1];
      // A name that starts with `--` is a missing name, not a guard: no row is
      // spelled that way, and treating the next flag as the value would run
      // one nonexistent row instead of reporting the mistake.
      if (value === undefined || value === '' || value.startsWith('--')) {
        return {
          kind: 'error',
          message: 'mutation-guards: --guard needs a name. `--list` prints them.',
        };
      }
      if (only !== undefined) {
        return {
          kind: 'error',
          message:
            `mutation-guards: --guard given twice ("${safe(only)}" then "${safe(value)}"). ` +
            `This runs one row; last-wins would silently answer for the second and leave ` +
            `the first unasked.`,
        };
      }
      only = value;
      if (!inline) i++;
      continue;
    }
    return {
      kind: 'error',
      // `safe()` because the offender is echoed to a terminal, and argv reaches
      // this script from wrappers (npm scripts, CI) as well as a human shell —
      // the same reason the journal's own strings are scrubbed before printing.
      message:
        `mutation-guards: unrecognised argument "${safe(arg)}". Usage: ${usage}. ` +
        `Refusing rather than running the whole registry, which would answer a question ` +
        `you did not ask — with a green.`,
    };
  }
  if (list && only !== undefined) {
    return {
      kind: 'error',
      message:
        `mutation-guards: --list and --guard "${safe(only)}" ask different questions. ` +
        `Answering one of them and dropping the other is how a narrower question gets a ` +
        `wider answer; pass one.`,
    };
  }
  if (list) return { kind: 'list' };
  return { kind: 'run', only };
}

if (import.meta.main) {
  const plan = parseCliArgs(process.argv.slice(2));
  if (plan.kind === 'error') {
    console.error(plan.message);
    process.exit(CLI_USAGE_EXIT);
  }
  if (plan.kind === 'list') {
    for (const guard of MUTATION_GUARDS) {
      console.log(`${guard.name}\n  ${guard.file} → ${guard.expectFails}\n  ${guard.invariant}\n`);
    }
    process.exit(0);
  }

  const { ok, results } = await runGuards({ only: plan.only });
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
