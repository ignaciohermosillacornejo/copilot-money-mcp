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

const WORKFLOW_DIR = '.github/workflows';

/** `uses: owner/repo@<40-hex>` followed by a `# comment`, capturing all three. */
const PINNED = /uses:\s*([A-Za-z0-9/_.-]+)@([0-9a-f]{40})(?:\s*#\s*(\S+))?/g;

interface Pin {
  action: string;
  sha: string;
  comment: string | undefined;
  file: string;
  line: number;
}

function collectPins(): Pin[] {
  const pins: Pin[] = [];
  for (const name of readdirSync(WORKFLOW_DIR)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const path = join(WORKFLOW_DIR, name);
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

if (import.meta.main) {
  const pins = collectPins();
  if (pins.length === 0) {
    console.error('check-action-pins: found no SHA-pinned actions — the scan is broken.');
    process.exit(1);
  }
  const problems = findPinProblems(pins);
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error(`check-action-pins: ${problems.length} problem(s) across ${pins.length} pins.`);
    process.exit(1);
  }
  console.log(`check-action-pins: ${pins.length} pinned actions, all labelled consistently.`);
}
