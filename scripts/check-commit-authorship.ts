#!/usr/bin/env bun
/**
 * Fail a fork PR that contains a commit forging a maintainer's identity.
 *
 * The bug class this catches: commit authorship is display metadata, and it is
 * attacker-controlled. `git commit --author` takes any name and address, and
 * GitHub renders the matching account's avatar and login next to it — so a
 * commit in a fork PR can appear, convincingly, to have been written by the
 * person reviewing it.
 *
 * better-auth PR #6003 did exactly this. The commit carrying the payload was
 * authored as a real maintainer, using their GitHub noreply address, with a
 * subject copied verbatim from an unrelated merged PR. In the commit list it
 * looked like a routine maintainer cherry-pick.
 *
 * The usual answer — require signed commits on the protected branch — does not
 * work here, and would not have helped anyway:
 *
 *   - GitHub creates new commit objects when it rebase-merges and does not sign
 *     them, so `required_signatures` refuses rebase merges outright. This repo
 *     is rebase-only.
 *   - Branch protection does not apply to forks. It constrains what can land,
 *     and the better-auth payload did its damage before any merge.
 *
 * So this checks the one field the forger cannot control: the committer.
 *
 *   legitimate maintainer push to a contributor's branch
 *     author = maintainer, committer = same maintainer
 *   contributor's own commit, rebased by a maintainer
 *     author = contributor, committer = maintainer
 *   forged identity (better-auth #6003)
 *     author = maintainer, committer = SOMEONE ELSE      <-- the tell
 *
 * Verified against this repo's own history: PR #587 carries three genuine
 * maintainer commits pushed to a contributor's fork branch, and every one has
 * author == committer. The better-auth payload commit has author ping-maxwell
 * and committer AntonVishal. The rule separates them with no false positives.
 *
 * Known limits:
 *
 *   - A maintainer who forges BOTH fields passes. That is not this threat model;
 *     an attacker with the maintainer's commit identity still cannot push to the
 *     base repo, and the payload gates (`check:concealment`) are independent.
 *   - A contributor who rebases a branch containing genuine maintainer commits
 *     rewrites the committer to themselves, which trips this. That is a real but
 *     rare shape, and "a maintainer's commit was rewritten by someone else" is
 *     worth a human look regardless.
 *   - Only fork PRs are checked. A same-repo branch already required push access.
 */

import { readFileSync } from 'fs';

/**
 * Identities whose authorship carries review weight, and which are therefore
 * worth forging. Both the GitHub login and every address that appears as a
 * commit author, since a forger can pick either.
 */
const MAINTAINERS = {
  logins: new Set(['ignaciohermosillacornejo']),
  emails: new Set(['hermosillaignacio@gmail.com']),
};

interface Commit {
  sha: string;
  commit: {
    author: { name?: string; email?: string };
    committer: { name?: string; email?: string };
    message: string;
  };
  author: { login?: string } | null;
  committer: { login?: string } | null;
}

function isMaintainer(login: string | undefined, email: string | undefined): boolean {
  if (login !== undefined && MAINTAINERS.logins.has(login)) return true;
  return email !== undefined && MAINTAINERS.emails.has(email);
}

/** Same human, whichever field GitHub managed to resolve. */
function sameIdentity(a: Commit['commit']['author'], b: Commit['commit']['author']): boolean {
  return a.email !== undefined && b.email !== undefined && a.email === b.email;
}

export interface Finding {
  sha: string;
  subject: string;
  author: string;
  committer: string;
}

export function findForgedAuthorship(commits: Commit[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of commits) {
    const author = c.commit.author;
    const committer = c.commit.committer;

    // Only maintainer-attributed commits are worth forging.
    if (!isMaintainer(c.author?.login, author.email)) continue;
    // A maintainer committing their own work is the normal case.
    if (sameIdentity(author, committer)) continue;
    // ...as is a maintainer committing someone else's work (a rebase we did).
    if (isMaintainer(c.committer?.login, committer.email)) continue;

    findings.push({
      sha: c.sha,
      subject: c.commit.message.split('\n')[0],
      author: `${author.name ?? '?'} <${author.email ?? '?'}>`,
      committer: `${committer.name ?? '?'} <${committer.email ?? '?'}>`,
    });
  }
  return findings;
}

// --- CLI ------------------------------------------------------------------
// Driven from a fixture in tests (CHECK_AUTHORSHIP_COMMITS) and from the real
// API payload in CI, so the parsing path under test is the one that ships.

if (import.meta.main) {
  const fixture = process.env.CHECK_AUTHORSHIP_COMMITS;
  let raw: string;
  if (fixture !== undefined) {
    raw = readFileSync(fixture, 'utf-8');
  } else {
    raw = readFileSync(0, 'utf-8'); // piped from `gh api .../pulls/N/commits`
  }

  let commits: Commit[];
  try {
    commits = JSON.parse(raw) as Commit[];
  } catch {
    console.error('check-commit-authorship: input is not valid JSON');
    process.exit(2);
  }
  if (!Array.isArray(commits)) {
    console.error('check-commit-authorship: expected a JSON array of commits');
    process.exit(2);
  }

  const findings = findForgedAuthorship(commits);
  if (findings.length === 0) {
    console.log(`check-commit-authorship: ${commits.length} commits, no forged authorship`);
    process.exit(0);
  }

  console.error('check-commit-authorship: commit(s) claim a maintainer as author but were');
  console.error('committed by someone else.\n');
  for (const f of findings) {
    console.error(`  ${f.sha.slice(0, 10)}  ${f.subject}`);
    console.error(`      author:    ${f.author}`);
    console.error(`      committer: ${f.committer}\n`);
  }
  console.error('  Commit authorship is attacker-controlled: `git commit --author` accepts');
  console.error('  any identity, and GitHub renders that account\'s avatar beside it. This is');
  console.error('  the shape used in better-auth PR #6003 to make a payload commit read as a');
  console.error('  routine maintainer change.\n');
  console.error('  If a maintainer really did write these, they pushed them and the committer');
  console.error('  would say so. Treat this as identity spoofing until proven otherwise, and');
  console.error('  read every line of those commits before merging.\n');
  process.exit(1);
}
