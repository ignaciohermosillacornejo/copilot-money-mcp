#!/usr/bin/env bun
/**
 * Assert PRIVACY.md names exactly the network destinations the code contacts.
 *
 * The bug class this catches: a privacy document that describes an architecture
 * the code no longer has. PRIVACY.md stated in five places that network traffic
 * went to `firestore.googleapis.com` and only in `--write` mode. Both were
 * false — the GraphQL client has posted to `app.copilot.money/api/graphql`
 * since the Firestore-REST design was replaced, and `--live-reads` (a
 * *read-only* flag) enables the same traffic. `firestore.googleapis.com`
 * appeared nowhere in src/.
 *
 * That drift is invisible to every other check in this repo: tests exercise
 * behaviour, lint reads syntax, and neither opens a Markdown file. Nothing
 * fails when the endpoint changes and the document does not follow — which is
 * the worst place to be silently wrong, because a reader chooses what to run on
 * a shared machine based on it.
 *
 * So this compares two sets rather than asserting any particular endpoint:
 *
 *   code — every http(s):// host reachable at runtime in src/ (comments and
 *          @see links excluded; they document Plaid/protobuf/GitHub and are not
 *          requests)
 *   doc  — every host named in PRIVACY.md
 *
 * A host in code but not the doc is undisclosed traffic. A host in the doc but
 * not the code is a stale claim. Both fail. Adding a genuinely new destination
 * means saying so in the privacy policy, in the same PR, which is the point.
 *
 * Known limits — this matches URL *literals*, so it cannot see:
 *
 *   - a host assembled at runtime (`` `https://${region}.example.com` ``, a base
 *     URL from config or an environment variable, string concatenation). Only the
 *     literal prefix is visible, and a fully dynamic URL is invisible.
 *   - a request whose destination comes from fetched data rather than source.
 *
 * So a green run means "no new destination was hardcoded in src/", not "the
 * server contacts nothing else". That is the drift class actually observed here
 * (a literal endpoint changed and the doc did not follow); closing the dynamic
 * case needs runtime interception, not a source scan. Any future change that
 * builds a URL dynamically must be disclosed by hand — this checker will not
 * catch it, and reviewers should treat a constructed URL as a doc change.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// CHECK_PRIVACY_ENDPOINTS_ROOT lets tests point the checker at a synthetic
// src/ + PRIVACY.md tree (same pattern as CHECK_TOOL_COUNTS_ROOT and
// CHECK_DEPS_PINNED_PACKAGE_JSON in the sibling gates).
const ROOT = process.env.CHECK_PRIVACY_ENDPOINTS_ROOT ?? join(__dirname, '..');

/**
 * Hosts that appear in src/ as documentation rather than as requests. Keep this
 * list short and justify additions: every entry is a host the checker will stop
 * noticing.
 *
 * Deliberately only one entry. `plaid.com` and `protobuf.dev` were here too,
 * but both occur exclusively inside block comments that stripComments() already
 * removes, so they never reached this set — they were blind spots that bought
 * nothing. Add a host here only after confirming it survives stripComments().
 */
const DOC_ONLY_HOSTS = new Set([
  'github.com', // issue-filing URL in an error message (src/core/database.ts)
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Strip // and block comments so @see links don't read as live destinations. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Matches http:// as well as https://. Nothing in src/ uses plain http today,
// so this catches nothing now — it exists so that a future cleartext endpoint
// (the case most worth disclosing) cannot slip past a scanner that only looked
// for TLS URLs.
const HOST_RE = /https?:\/\/([a-zA-Z0-9.-]+)/g;

const codeHosts = new Set<string>();
for (const file of sourceFiles(join(ROOT, 'src'))) {
  const src = stripComments(readFileSync(file, 'utf-8'));
  for (const m of src.matchAll(HOST_RE)) {
    const host = m[1].replace(/[.,)]+$/, '');
    if (!DOC_ONLY_HOSTS.has(host)) codeHosts.add(host);
  }
}

const privacy = readFileSync(join(ROOT, 'PRIVACY.md'), 'utf-8');
const docHosts = new Set<string>();
for (const m of privacy.matchAll(HOST_RE)) {
  const host = m[1].replace(/[.,)]+$/, '');
  if (!DOC_ONLY_HOSTS.has(host)) docHosts.add(host);
}
// PRIVACY.md links out to policies and to this repo; those are references, not
// destinations the server contacts.
for (const ref of ['policies.google.com', 'www.anthropic.com', 'openai.com', 'github.com']) {
  docHosts.delete(ref);
}

const undisclosed = [...codeHosts].filter((h) => !docHosts.has(h)).sort();
const stale = [...docHosts].filter((h) => !codeHosts.has(h)).sort();

if (undisclosed.length === 0 && stale.length === 0) {
  console.log(
    `check-privacy-endpoints: PRIVACY.md matches src/ (${[...codeHosts].sort().join(', ')})`
  );
  process.exit(0);
}

console.error('check-privacy-endpoints: PRIVACY.md disagrees with the code.\n');
if (undisclosed.length > 0) {
  console.error('  Contacted by src/ but NOT named in PRIVACY.md:');
  for (const h of undisclosed) console.error(`    ${h}`);
  console.error('  This is undisclosed network traffic. Document it.\n');
}
if (stale.length > 0) {
  console.error('  Named in PRIVACY.md but NOT contacted by src/:');
  for (const h of stale) console.error(`    ${h}`);
  console.error('  This is a stale claim. Remove it, or add the host to');
  console.error('  DOC_ONLY_HOSTS if it is a reference rather than a destination.\n');
}
process.exit(1);
