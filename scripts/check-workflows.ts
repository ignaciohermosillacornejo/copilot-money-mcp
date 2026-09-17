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
 * Invariant 3 — a trust gate names the people it trusts (#741).
 *   `github.repository_owner` is the account that HOLDS the repository. On a
 *   personal repo it happens to spell a person's login, which is why it reads
 *   like an identity; transfer the repo to an organisation and the same
 *   expression yields the org login, which is not a reviewer and approves
 *   nothing. Every review then reads NONE and the automation refuses everything
 *   — the failure is safe, loud and total, and the guard has been deciding on a
 *   proxy the whole time. (`docs/bugs/README.md` → `proxy-for-authority`.)
 *
 *   So: no workflow may mention `github.repository_owner` at all. The rule is
 *   the whole context rather than "in an `if:`", because the same substitution
 *   survives being laundered through `env:` into a shell or a `jq` filter —
 *   which is exactly where `auto-merge.yml` had it. Addressing the repository
 *   is served by `github.repository`; identity has to be declared.
 *
 *   The declaration is `env.APPROVERS`, a JSON array of logins, and the second
 *   half of this invariant is that the declaration is the ONLY source. A
 *   job-level `if:` cannot read the `env` context (GitHub's context-availability
 *   table admits only `github`, `needs`, `vars` and `inputs` there), so a cheap
 *   pre-runner gate has no way to reference it and must repeat the login as a
 *   literal. That second copy is the thing that drifts, and drifts SILENTLY:
 *   add a maintainer to APPROVERS but not to the gate and their approval never
 *   starts the job — no error, no run, nothing to notice. Hence every login
 *   literal compared in an `if:` must match the declared set exactly, in both
 *   directions.
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
  `(?:==\\s*['"]?${ESCAPE_HATCH_TRIGGER}['"]?)|(?:['"]?${ESCAPE_HATCH_TRIGGER}['"]?\\s*==)`
);

/** The context expression that spells an account name and is read as a person. */
const OWNER_PROXY = /github\s*\.\s*repository_owner/;

/**
 * The env keys a workflow may declare its trusted logins under.
 *
 * A closed list, because the NAME is how this gate finds the declaration. It
 * cannot be evaded by inventing a third name: a workflow that compares logins
 * and declares none of these fails the "no declaration" branch below. Adding a
 * name here is the deliberate speed bump — one line, in the file that has to
 * understand it.
 */
const TRUST_LIST_KEYS: readonly string[] = ['APPROVERS', 'TRUSTED_PUBLISHERS'];

/**
 * A login compared against an actor in a GitHub expression, in either operand
 * order — `github.event.review.user.login == 'someone'` and its mirror.
 *
 * `.login` rather than the full path because the actor arrives under several of
 * them (`event.review.user`, `event.pull_request.user`, `event.release.author`),
 * and a new one should be covered the day it is written, not the day this regex
 * is extended; `github.actor` is spelled out because it carries no `.login`
 * suffix. Single quotes only: GitHub expressions have no other string form.
 *
 * `==` only. `github.actor != 'dependabot[bot]'` is an EXCLUSION, not a
 * declaration of trust, and demanding that a denied login appear in the trust
 * list would be exactly backwards.
 */
const ACTOR_EXPRESSION = String.raw`(?:\.login|github\s*\.\s*(?:actor|triggering_actor))`;
const LOGIN_COMPARISONS: readonly RegExp[] = [
  new RegExp(`${ACTOR_EXPRESSION}\\s*==\\s*'([^']*)'`, 'g'),
  new RegExp(`'([^']*)'\\s*==\\s*[\\w.[\\]']*${ACTOR_EXPRESSION}`, 'g'),
];

/** Every string anywhere in the parsed document — comments excluded by parsing. */
function* stringValues(node: unknown): Generator<string> {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const v of node) yield* stringValues(v);
  else if (isRecord(node)) for (const v of Object.values(node)) yield* stringValues(v);
}

/** Every `if:` expression in the document — job-level and step-level alike. */
function* ifExpressions(jobs: Record<string, unknown>): Generator<string> {
  for (const job of Object.values(jobs)) {
    if (!isRecord(job)) continue;
    if (job.if !== undefined) yield String(job.if);
    if (!Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (isRecord(step) && step.if !== undefined) yield String(step.if);
    }
  }
}

/** `env:` mappings that can carry the declaration: workflow-level and per job. */
function* envBlocks(
  doc: Record<string, unknown>,
  jobs: Record<string, unknown>
): Generator<unknown> {
  yield doc.env;
  for (const job of Object.values(jobs)) {
    if (isRecord(job)) yield job.env;
  }
}

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
 *   - and it is too strict in the other direction: an `if:` that admits the
 *     event without naming it — `contains(fromJSON('[…]'), github.event_name)`,
 *     or admission by excluding the other trigger — is reachable but fails.
 *     That is the intended trade. The remedy is to write the `==` form, which
 *     the failure message hands you, not to loosen this back into a test a
 *     `!=` can satisfy.
 */
function reachableUnderDispatch(job: unknown): boolean {
  if (!isRecord(job)) return false;
  if (job.if === undefined) return true;
  return POSITIVE_DISPATCH_TEST.test(String(job.if));
}

const problems: string[] = [];
let jobsChecked = 0;
let callerJobsSkipped = 0;
let approverGatesChecked = 0;

// `Bun.YAML` is a recent addition and the only use of it in this repo. Without
// this guard an older bun throws inside the per-file try/catch below, and the
// gate reports a toolchain problem as one "is not valid YAML" per workflow —
// the opposite of the actionable messages that are the point of this script.
// The `typeof Bun` half is not redundant: `typeof` suppresses a ReferenceError
// only for a bare identifier, so `typeof Bun.YAML` still throws under a runtime
// with no `Bun` at all — which is the raw stack this guard exists to replace.
if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
  console.error(
    'Workflow check failed — this gate parses YAML with `Bun.YAML`, so it must run under ' +
      'bun 1.2.21 or newer (`bun run check:workflows`). If you are on an older bun, run ' +
      '`bun upgrade`.'
  );
  process.exit(1);
}

let entries: string[];
try {
  entries = readdirSync(WORKFLOW_DIR);
} catch (err) {
  console.error(
    `Workflow check failed — cannot read ${WORKFLOW_DIR}: ` +
      `${err instanceof Error ? err.message : String(err)}`
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
    problems.push(
      `${file}: is not valid YAML — ${err instanceof Error ? err.message : String(err)}`
    );
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
          `requires repository write access, so it stays maintainer-only.`
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
          `\`github.event_name == '${ESCAPE_HATCH_TRIGGER}' || <the existing condition>\`.`
      );
    }
  }

  // --- invariant 3: a trust gate names the people it trusts ----------------
  for (const value of stringValues(doc)) {
    if (!OWNER_PROXY.test(value)) continue;
    problems.push(
      `${file}: uses \`github.repository_owner\`. That is the account that HOLDS the repo — a ` +
        `person only while the repo is personal, and an organisation login (which reviews ` +
        `nothing) the moment it is transferred. To address the repository use ` +
        `\`github.repository\`; to name who is trusted, declare one of ` +
        `${TRUST_LIST_KEYS.map((k) => `\`env.${k}\``).join(' / ')} as a JSON array of logins ` +
        `and read that.`
    );
    break; // One report per file; the remedy is the same for every occurrence.
  }

  const declarations: string[] = [];
  let declarationKey = TRUST_LIST_KEYS[0];
  for (const env of envBlocks(doc, jobs)) {
    if (!isRecord(env)) continue;
    for (const key of TRUST_LIST_KEYS) {
      if (env[key] === undefined) continue;
      declarationKey = key;
      declarations.push(String(env[key]));
    }
  }
  let declared: Set<string> | null = null;
  if (declarations.length > 0) {
    const unique = [...new Set(declarations)];
    if (unique.length > 1) {
      problems.push(
        `${file}: declares a trust list more than once with different values ` +
          `(${unique.join(' vs ')}). One declaration per workflow — a second one is the drift ` +
          `this invariant exists to prevent.`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(unique[0]);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.every((l) => typeof l === 'string' && l.length > 0)) {
      problems.push(
        `${file}: \`env.${declarationKey}\` must be a JSON array of logins, e.g. ` +
          `\`'["octocat"]'\`, so both \`fromJSON()\` and \`jq\` can read the same bytes. Got ` +
          `${JSON.stringify(unique[0])}.`
      );
    } else {
      declared = new Set(parsed as string[]);
    }
  }

  const compared = new Set<string>();
  for (const expression of ifExpressions(jobs)) {
    for (const pattern of LOGIN_COMPARISONS) {
      pattern.lastIndex = 0;
      for (const match of expression.matchAll(pattern)) compared.add(match[1]);
    }
  }

  if (compared.size > 0) {
    approverGatesChecked++;
    if (declared === null) {
      if (declarations.length === 0) {
        problems.push(
          `${file}: an \`if:\` compares a login against the literal(s) ` +
            `${[...compared].map((l) => `'${l}'`).join(', ')} with no ` +
            `${TRUST_LIST_KEYS.map((k) => `\`env.${k}\``).join(' / ')} declaring who is ` +
            `trusted. A job-level \`if:\` cannot read \`env\`, so the literal ` +
            `is allowed — but only as a second copy of a declaration this gate can compare it ` +
            `against.`
        );
      }
    } else {
      const missing = [...compared].filter((l) => !declared.has(l));
      const unused = [...declared].filter((l) => !compared.has(l));
      if (missing.length > 0 || unused.length > 0) {
        problems.push(
          `${file}: the login literals in \`if:\` and \`env.${declarationKey}\` disagree` +
            (missing.length > 0 ? ` — gated but not declared: ${missing.join(', ')}` : '') +
            (unused.length > 0 ? ` — declared but not gated: ${unused.join(', ')}` : '') +
            `. A declared approver missing from the cheap gate never starts the job at all: no ` +
            `error, no run, nothing to notice.`
        );
      }
    }
  } else if (declared !== null) {
    approverGatesChecked++;
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
            `\`${job.uses}\` instead — that covers every caller.`
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
            `the work into a \`runs-on\` job that can carry its own \`timeout-minutes\`.`
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
      problems.push(
        `${where}: has neither \`uses:\` nor \`runs-on:\`, so it is not a runnable job`
      );
      continue;
    }

    jobsChecked++;

    if (timeout === undefined) {
      problems.push(
        `${where}: no \`timeout-minutes\`. Add it as a sibling of \`runs-on\` (a step-level ` +
          `\`timeout-minutes\` bounds one step, not the job). Without it the job inherits ` +
          `GitHub's 360-minute default. Pick a value from the job's observed runtime.`
      );
    } else if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      problems.push(
        `${where}: \`timeout-minutes\` must be a positive number, got ${JSON.stringify(timeout)}. ` +
          `An expression is not accepted here — the bound has to be readable without running ` +
          `the workflow.`
      );
    } else if (timeout > MAX_TIMEOUT_MINUTES) {
      problems.push(
        `${where}: \`timeout-minutes: ${timeout}\` is above the ${MAX_TIMEOUT_MINUTES}-minute ` +
          `ceiling. A number that large is GitHub's default wearing a hat, not a bound. If the ` +
          `job genuinely needs longer, raise MAX_TIMEOUT_MINUTES in this script and say why.`
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
    `(the keyword is not supported there); ${approverGatesChecked} approver gate(s) read their ` +
    `identity from a declared list.`
);
