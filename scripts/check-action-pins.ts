/**
 * Every SHA-pinned GitHub Action must carry a version comment, and the SAME
 * `action@sha` must carry the SAME comment everywhere.
 *
 * WHY THIS EXISTS: this repo pins every action by SHA for supply-chain reasons
 * (#654). The pin is the security control; the trailing `# vN` comment is the
 * only human-readable half of it — it is what a reviewer reads when asking "is
 * this the version we meant?". A comment that disagrees with its SHA defeats
 * that half silently, because nothing executes a comment.
 *
 * It really drifted: `actions/checkout` was pinned to v7.0.0's SHA in eight
 * places, six commented `# v7` and two `# v6`. Dependabot then bumped the SHA to
 * v7.0.1 and faithfully preserved both comments — so the same SHA carried two
 * contradictory labels in one repo, and the stale one had been wrong across a
 * major version for some time.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not resolve the SHA against
 * GitHub's tag API. That would make `bun run check` require network and a token,
 * and would fail offline for reasons unrelated to the change under test. So this
 * is an INTERNAL CONSISTENCY check: it cannot tell you the comment is right, only
 * that the repo does not contradict itself about it. Catching "v6 vs v7 for one
 * SHA" is the achievable half and is what actually happened. Resolving a pin
 * against upstream stays a manual step when adding a NEW action.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Relative, because every path this gate prints is a `file:line` a reviewer
// has to find in the repo, and an absolute one from a CI runner is noise.
// `bun run` sets the cwd to the package root, which is the only way it runs.
// Overridable so tests can drive the real script — exit code, annotations and
// all — against a synthetic workflow tree, matching CHECK_WORKFLOWS_DIR /
// CHECK_DEPS_PINNED_PACKAGE_JSON.
const WORKFLOW_DIR = process.env.CHECK_ACTION_PINS_DIR ?? '.github/workflows';

/** `uses: owner/repo@<40-hex>` followed by a `# comment`, capturing all three. */
const PINNED = /uses:\s*([A-Za-z0-9/_.-]+)@([0-9a-f]{40})(?:\s*#\s*(\S+))?/g;

export interface Pin {
  action: string;
  sha: string;
  comment: string | undefined;
  file: string;
  line: number;
}

export function collectPins(dir: string = WORKFLOW_DIR): Pin[] {
  const pins: Pin[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    const lines = readFileSync(path, 'utf-8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(PINNED)) {
        pins.push({ action: m[1]!, sha: m[2]!, comment: m[3], file: path, line: i + 1 });
      }
    });
  }
  return pins;
}

export function findPinProblems(pins: Pin[]): string[] {
  const problems: string[] = [];

  // 1. A pin with no version comment at all — the reviewer has nothing to read.
  for (const p of pins) {
    if (!p.comment) {
      problems.push(
        `${p.file}:${p.line} — ${p.action} is SHA-pinned with no version comment. ` +
          `Add a trailing '# vN' so a reviewer can tell what is pinned without resolving the SHA.`
      );
    }
  }

  // 2. The same action@sha labelled two different ways. This is the drift that
  //    actually happened, and the only half checkable without network.
  const byPin = new Map<string, Map<string, Pin[]>>();
  for (const p of pins) {
    if (!p.comment) continue;
    const key = `${p.action}@${p.sha}`;
    const byComment = byPin.get(key) ?? new Map<string, Pin[]>();
    byComment.set(p.comment, [...(byComment.get(p.comment) ?? []), p]);
    byPin.set(key, byComment);
  }
  for (const [key, byComment] of byPin) {
    if (byComment.size <= 1) continue;
    const detail = [...byComment.entries()]
      .map(([c, ps]) => `  '# ${c}' at ${ps.map((p) => `${p.file}:${p.line}`).join(', ')}`)
      .join('\n');
    problems.push(
      `${key} is labelled ${byComment.size} different ways:\n${detail}\n` +
        `  One SHA is one version. Resolve which is correct against the upstream tags and make them agree.`
    );
  }

  return problems;
}

/** What the CLI would exit with and print, without exiting or printing. */
export interface CheckResult {
  /** Process exit code: 0 clean, 1 problems. */
  code: number;
  stdout: string[];
  /** `::error::`-prefixed where GitHub should annotate the offending line. */
  stderr: string[];
}

/**
 * The whole CLI except the exiting. Split out so the decisions below — which
 * of them exits non-zero, and what a reader is told — are asserted by tests
 * rather than only by someone running the gate and looking.
 *
 * The zero-pins branch is the vacuity floor: a scan that matched nothing would
 * otherwise satisfy the consistency check trivially and print "all labelled
 * consistently" over an empty set, which is the most confident way this file
 * could be wrong.
 */
export function runCheck(dir: string = WORKFLOW_DIR): CheckResult {
  const pins = collectPins(dir);
  if (pins.length === 0) {
    return {
      code: 1,
      stdout: [],
      stderr: ['check-action-pins: found no SHA-pinned actions — the scan is broken.'],
    };
  }
  const problems = findPinProblems(pins);
  if (problems.length > 0) {
    return {
      code: 1,
      stdout: [],
      stderr: [
        ...problems.map((p) => `::error::${p}`),
        `check-action-pins: ${problems.length} problem(s) across ${pins.length} pins.`,
      ],
    };
  }
  return {
    code: 0,
    stdout: [`check-action-pins: ${pins.length} pinned actions, all labelled consistently.`],
    stderr: [],
  };
}

if (import.meta.main) {
  const result = runCheck();
  for (const line of result.stderr) console.error(line);
  for (const line of result.stdout) console.log(line);
  process.exit(result.code);
}
