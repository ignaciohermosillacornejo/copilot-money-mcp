#!/usr/bin/env bun
/**
 * Static invariants over `.github/workflows/*.yml`.
 *
 * Nothing in this repo read the workflow files until now, so two whole classes
 * of CI defect were invisible to every gate: a job that never declares how long
 * it is allowed to run, and an automation whose only trigger the platform can
 * decline to deliver. Both are mechanically checkable, which is rare for the
 * classes in `docs/bugs/README.md` — most need judgment. These do not.
 *
 * Invariant 1 — every step-running job declares `timeout-minutes` (#692).
 *   Without it a job inherits GitHub's 360-minute default. The slowest job in
 *   this repo finishes in about a minute, so the default is not a bound; it is
 *   the absence of one, and a hung job is indistinguishable from a working one
 *   for six hours while it holds a runner (and, for `npm-publish`, an
 *   `id-token: write` context).
 *
 *   The check is deliberately *structural*, not textual. `timeout-minutes` is
 *   valid YAML at step level too, where it bounds one step and does nothing for
 *   the job, and it is obviously valid inside a comment. So this asserts the key
 *   exists on the job mapping itself — the same mapping that carries `runs-on` —
 *   which a step-level key, a commented-out key, and a mention in prose all fail.
 *
 *   Jobs that call a LOCAL reusable workflow (`uses: ./…`) are SKIPPED, because
 *   `timeout-minutes` is not one of the keywords GitHub supports there
 *   (https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#supported-keywords-for-jobs-that-call-a-reusable-workflow).
 *   Demanding it would demand YAML that GitHub rejects. Those callers are bound
 *   transitively instead, by the jobs of the workflow they call — which this
 *   check does require, so the coverage is real rather than waived. That
 *   sentence is only true for a local callee, so a `uses:` pointing at another
 *   repository is reported rather than skipped: this gate never reads it, so
 *   nothing would bound that job. A `uses:` job that carries `timeout-minutes`
 *   anyway is reported too, since that is the mirror-image mistake and the skip
 *   would otherwise hide it.
 *
 * Invariant 2 — a `pull_request_review`-triggered workflow offers a manual
 *   trigger (#643).
 *   For a first-time fork contributor GitHub holds every workflow run at
 *   `action_required`. `pull_request` runs can be released through the approve
 *   endpoint; `pull_request_review` runs cannot — the endpoint answers 403
 *   ("This run is not from a fork pull request or queued by the Actions bot")
 *   and the run simply dies. An automation reachable only that way therefore has
 *   a standing condition under which it never fires and never reports failing.
 *   `workflow_dispatch` is the escape hatch: it requires repository write access,
 *   so it is maintainer-only by construction and adds no capability a maintainer
 *   lacks. Declaring the trigger is not enough — at least one job must be
 *   reachable under it, because a job whose `if:` excludes the event is skipped,
 *   and a skipped job reports success. Presence alone would be satisfiable
 *   without fixing anything, the same way `timeout-minutes: 360` satisfies
 *   invariant 1's presence without bounding anything.
 *
 * Run as part of `bun run check` and as a step in `.github/workflows/test.yml`.
 */

import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so tests can drive the real script against synthetic workflow
// trees, matching CHECK_DEPS_PINNED_PACKAGE_JSON / CHECK_TOOL_COUNTS_ROOT.
const WORKFLOW_DIR = process.env.CHECK_WORKFLOWS_DIR ?? join(__dirname, '../.github/workflows');

/**
 * Highest value that still counts as a bound.
 *
 * Without a ceiling the cheapest way to satisfy invariant 1 is `timeout-minutes:
 * 360` — the default, written down. That passes a presence check while changing
 * nothing, so presence alone is not the property worth gating. Every job here
 * runs in under a minute; the two AI jobs, whose runtime is dominated by an
 * external service, sit at 15 and 20. 60 leaves room for a genuinely long job
 * while making "the default wearing a hat" fail.
 */
const MAX_TIMEOUT_MINUTES = 60;

/** The trigger GitHub can withhold from a first-time fork contributor. */
const WITHHELD_TRIGGER = 'pull_request_review';
/** The maintainer-only manual trigger that gives such a workflow a way to run. */
const ESCAPE_HATCH_TRIGGER = 'workflow_dispatch';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The trigger names of a workflow's `on:` block, which YAML allows in three
 * shapes: `on: push`, `on: [push, pull_request]`, and the mapping form.
 */
function triggerNames(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((t): t is string => typeof t === 'string');
  if (isRecord(on)) return Object.keys(on);
  return [];
}

/**
 * A positive comparison against the dispatch event, e.g.
 * `github.event_name == 'workflow_dispatch'` in either operand order.
 *
 * Deliberately `==` and not "mentions the event name": `github.event_name !=
 * 'workflow_dispatch'` mentions it too, while being exactly the unreachable
 * case this is here to catch. `!=` cannot match, because it carries one `=`.
 */
const POSITIVE_DISPATCH_TEST = new RegExp(
  `(?:==\\s*['"]?${ESCAPE_HATCH_TRIGGER}['"]?)|(?:['"]?${ESCAPE_HATCH_TRIGGER}['"]?\\s*==)`,
);

/**
 * Whether a manual run could actually execute this job.
 *
 * A job with no `if:` runs on every trigger the workflow declares. One with an
 * `if:` runs only when that expression is true, so it must positively admit the
 * event. This reads the expression as text and does not evaluate it, which
 * bounds the claim in two ways worth knowing:
 *
 *   - a deliberately negated positive (`!(github.event_name == '…')`) would
 *     still pass. Nothing short of an expression evaluator catches that, and it
 *     is not a shape anyone writes by accident — unlike the plain `!=`, which
 *     is exactly what a maintainer excluding the event would reach for.
 *   - reachability is judged per job. A job that `needs:` a review-gated job is
 *     skipped when its dependency skips, and this does not walk that graph.
 *     Moot while the only such workflow has one job; say so here rather than
 *     build the walk for a case that does not exist yet.
 */
function reachableUnderDispatch(job: unknown): boolean {
  if (!isRecord(job)) return false;
  if (job.if === undefined) return true;
  return POSITIVE_DISPATCH_TEST.test(String(job.if));
}

const problems: string[] = [];
let jobsChecked = 0;
let callerJobsSkipped = 0;

// `Bun.YAML` is a recent addition and the only use of it in this repo. Without
// this guard an older bun throws inside the per-file try/catch below, and the
// gate reports a toolchain problem as one "is not valid YAML" per workflow —
// the opposite of the actionable messages that are the point of this script.
if (typeof Bun.YAML?.parse !== 'function') {
  console.error(
    'Workflow check failed — this gate parses YAML with `Bun.YAML`, which this bun does ' +
      'not have (added in bun 1.2.21). Run `bun upgrade`.',
  );
  process.exit(1);
}

let entries: string[];
try {
  entries = readdirSync(WORKFLOW_DIR);
} catch (err) {
  console.error(
    `Workflow check failed — cannot read ${WORKFLOW_DIR}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const files = entries.filter((f) => /\.ya?ml$/.test(f)).sort();

if (files.length === 0) {
  console.error(`Workflow check failed — no workflow files found in ${WORKFLOW_DIR}`);
  process.exit(1);
}

for (const file of files) {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf-8'));
  } catch (err) {
    problems.push(`${file}: is not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!isRecord(doc)) {
    problems.push(`${file}: top level is not a mapping, so it is not a workflow`);
    continue;
  }

  const jobs = doc.jobs;
  if (!isRecord(jobs)) {
    problems.push(`${file}: no \`jobs:\` mapping`);
    continue;
  }

  // --- invariant 2: manual escape hatch for a withheld trigger --------------
  // YAML 1.1 reads a bare `on` as the boolean true; Bun's parser follows the
  // 1.2 core schema and keeps it a string. Accept either rather than silently
  // finding no triggers and passing every workflow, and complain loudly if
  // neither is present — a workflow with no `on:` is not a thing.
  const on = doc.on ?? doc.true;
  const triggers = triggerNames(on);
  if (triggers.length === 0) {
    problems.push(`${file}: no recognizable \`on:\` trigger block`);
  } else if (triggers.includes(WITHHELD_TRIGGER)) {
    if (!triggers.includes(ESCAPE_HATCH_TRIGGER)) {
      problems.push(
        `${file}: triggers on \`${WITHHELD_TRIGGER}\` with no \`${ESCAPE_HATCH_TRIGGER}\`. ` +
          `For a first-time fork contributor GitHub parks the run at \`action_required\` and ` +
          `refuses to release it (the approve endpoint answers 403 for this event), so the ` +
          `workflow never fires and never reports failing. Add \`${ESCAPE_HATCH_TRIGGER}\` — it ` +
          `requires repository write access, so it stays maintainer-only.`,
      );
    } else if (!Object.values(jobs).some(reachableUnderDispatch)) {
      // Declaring the trigger is not the same as having a job it can reach. A
      // job whose `if:` still gates on the review payload is *skipped* under
      // dispatch, and a skipped job reports success — so narrowing that `if:`
      // later would silently reopen the bug while leaving this gate green.
      // That is the same failure shape the trigger rule exists to prevent, so
      // presence alone is not the property worth gating here either.
      problems.push(
        `${file}: declares \`${ESCAPE_HATCH_TRIGGER}\` but no job it can reach — every job's ` +
          `\`if:\` gates on something else, so a manual run would skip them all and still ` +
          `report success. Admit the event in at least one job's \`if:\`, e.g. ` +
          `\`github.event_name == '${ESCAPE_HATCH_TRIGGER}' || <the existing condition>\`.`,
      );
    }
  }

  // --- invariant 1: every step-running job is bounded ----------------------
  for (const [jobId, job] of Object.entries(jobs)) {
    const where = `${file} → jobs.${jobId}`;
    if (!isRecord(job)) {
      problems.push(`${where}: job is not a mapping`);
      continue;
    }
    const timeout = job['timeout-minutes'];

    if (typeof job.uses === 'string') {
      if (timeout !== undefined) {
        problems.push(
          `${where}: calls a reusable workflow and also sets \`timeout-minutes\`, which is not ` +
            `a supported keyword on a \`uses:\` job. Remove it and bound the jobs inside ` +
            `\`${job.uses}\` instead — that covers every caller.`,
        );
      }
      // The skip is only a waiver-with-coverage while the callee is a workflow
      // this gate also reads. A `uses:` pointing at another repository is never
      // parsed here, so nothing would bound that job at all — which is exactly
      // the hole the skip is not supposed to be.
      if (!job.uses.startsWith('./')) {
        problems.push(
          `${where}: calls a reusable workflow outside this repository (\`${job.uses}\`). ` +
            `\`timeout-minutes\` is unsupported on a \`uses:\` job and this gate cannot read ` +
            `the called workflow's jobs either, so nothing would bound this job. Either call a ` +
            `local \`./.github/workflows/*.yml\` (whose jobs this gate does bound) or inline ` +
            `the work into a \`runs-on\` job that can carry its own \`timeout-minutes\`.`,
        );
      } else {
        // Only a clean local skip counts — otherwise the summary line would
        // report a job it just flagged as covered.
        callerJobsSkipped++;
      }
      continue;
    }

    // A job with neither `uses:` nor `runs-on:` cannot run; flag it rather than
    // letting a malformed job slip through the gate as "nothing to check".
    if (job['runs-on'] === undefined) {
      problems.push(`${where}: has neither \`uses:\` nor \`runs-on:\`, so it is not a runnable job`);
      continue;
    }

    jobsChecked++;

    if (timeout === undefined) {
      problems.push(
        `${where}: no \`timeout-minutes\`. Add it as a sibling of \`runs-on\` (a step-level ` +
          `\`timeout-minutes\` bounds one step, not the job). Without it the job inherits ` +
          `GitHub's 360-minute default. Pick a value from the job's observed runtime.`,
      );
    } else if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      problems.push(
        `${where}: \`timeout-minutes\` must be a positive number, got ${JSON.stringify(timeout)}. ` +
          `An expression is not accepted here — the bound has to be readable without running ` +
          `the workflow.`,
      );
    } else if (timeout > MAX_TIMEOUT_MINUTES) {
      problems.push(
        `${where}: \`timeout-minutes: ${timeout}\` is above the ${MAX_TIMEOUT_MINUTES}-minute ` +
          `ceiling. A number that large is GitHub's default wearing a hat, not a bound. If the ` +
          `job genuinely needs longer, raise MAX_TIMEOUT_MINUTES in this script and say why.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('Workflow check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `Workflow check passed — ${jobsChecked} job(s) bounded by \`timeout-minutes\` across ` +
    `${files.length} workflow(s); ${callerJobsSkipped} reusable-workflow caller job(s) skipped ` +
    `(the keyword is not supported there).`,
);
