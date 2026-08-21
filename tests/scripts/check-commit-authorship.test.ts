/**
 * Behavioural tests for scripts/check-commit-authorship.ts.
 *
 * The fixtures are the real shapes, not invented ones: the legitimate cases are
 * taken from this repo's PR #587 (three genuine maintainer commits pushed to a
 * contributor's fork branch, plus two contributor commits rebased by a
 * maintainer), and the attack case is better-auth PR #6003 commit acf0a729,
 * authored as ping-maxwell and committed by AntonVishal.
 *
 * That pairing is the whole point of the check: both look identical in the
 * commit list, and only the committer field separates them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForgedAuthorship } from '../../scripts/check-commit-authorship.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-commit-authorship.ts', import.meta.url));

const MAINTAINER_EMAIL = 'hermosillaignacio@gmail.com';
const MAINTAINER_LOGIN = 'ignaciohermosillacornejo';
const CONTRIBUTOR_EMAIL = '307267272+gmhoward9289-ops@users.noreply.github.com';
const CONTRIBUTOR_LOGIN = 'gmhoward9289-ops';

interface CommitInput {
  sha: string;
  authorName: string;
  authorEmail: string;
  authorLogin: string | null;
  committerName: string;
  committerEmail: string;
  committerLogin: string | null;
  subject?: string;
}

function commit(c: CommitInput): Parameters<typeof findForgedAuthorship>[0][number] {
  return {
    sha: c.sha,
    commit: {
      author: { name: c.authorName, email: c.authorEmail },
      committer: { name: c.committerName, email: c.committerEmail },
      message: `${c.subject ?? 'some change'}\n\nbody`,
    },
    author: c.authorLogin === null ? null : { login: c.authorLogin },
    committer: c.committerLogin === null ? null : { login: c.committerLogin },
  };
}

/** PR #587: the maintainer pushed review fixes to a contributor's fork branch. */
const MAINTAINER_OWN_PUSH = commit({
  sha: '2f3a25c4c9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authorName: 'ignaciohermosillacornejo',
  authorEmail: MAINTAINER_EMAIL,
  authorLogin: MAINTAINER_LOGIN,
  committerName: 'ignaciohermosillacornejo',
  committerEmail: MAINTAINER_EMAIL,
  committerLogin: MAINTAINER_LOGIN,
  subject: 'chore: rebase onto bulk_edit_transactions',
});

/** PR #587: a contributor's own commit, rebased and committed by the maintainer. */
const CONTRIBUTOR_REBASED_BY_MAINTAINER = commit({
  sha: 'b917aece0cbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  authorName: 'gmhoward9289-ops',
  authorEmail: CONTRIBUTOR_EMAIL,
  authorLogin: CONTRIBUTOR_LOGIN,
  committerName: 'ignaciohermosillacornejo',
  committerEmail: MAINTAINER_EMAIL,
  committerLogin: MAINTAINER_LOGIN,
  subject: 'feat: bulk transaction edit tool',
});

/** An ordinary contributor commit on their own fork. */
const CONTRIBUTOR_OWN = commit({
  sha: 'cccccccccccccccccccccccccccccccccccccccc',
  authorName: 'gmhoward9289-ops',
  authorEmail: CONTRIBUTOR_EMAIL,
  authorLogin: CONTRIBUTOR_LOGIN,
  committerName: 'gmhoward9289-ops',
  committerEmail: CONTRIBUTOR_EMAIL,
  committerLogin: CONTRIBUTOR_LOGIN,
});

/** better-auth #6003 acf0a729 — maintainer identity, attacker's committer. */
const FORGED = commit({
  sha: 'acf0a7294366bf5b0d94d96e6a98e41e1c8f11aa',
  authorName: 'ignaciohermosillacornejo',
  authorEmail: MAINTAINER_EMAIL,
  authorLogin: MAINTAINER_LOGIN,
  committerName: 'Some Contributor',
  committerEmail: '166398166+attacker@users.noreply.github.com',
  committerLogin: 'attacker',
  subject: 'fix(organization): Certain parameters not showing in client types (#5214)',
});

describe('legitimate authorship', () => {
  test('allows a maintainer committing their own work to a fork branch', () => {
    expect(findForgedAuthorship([MAINTAINER_OWN_PUSH])).toEqual([]);
  });

  test('allows a maintainer rebasing a contributor commit', () => {
    expect(findForgedAuthorship([CONTRIBUTOR_REBASED_BY_MAINTAINER])).toEqual([]);
  });

  test('allows an ordinary contributor commit', () => {
    expect(findForgedAuthorship([CONTRIBUTOR_OWN])).toEqual([]);
  });

  test('allows the whole of PR #587, which is all three shapes together', () => {
    expect(
      findForgedAuthorship([
        MAINTAINER_OWN_PUSH,
        CONTRIBUTOR_REBASED_BY_MAINTAINER,
        CONTRIBUTOR_OWN,
      ])
    ).toEqual([]);
  });

  test('allows an empty commit list', () => {
    expect(findForgedAuthorship([])).toEqual([]);
  });
});

describe('known limits', () => {
  test('a contributor rebasing a genuine maintainer commit IS flagged, by design', () => {
    // Rebasing rewrites the committer, so a genuine maintainer commit carried
    // through a contributor's rebase is indistinguishable from a forgery on the
    // wire. This pins that as intended rather than as an oversight: the obvious
    // "fix" — treating a maintainer author with any committer as legitimate —
    // deletes the detection entirely, which is exactly what an attacker would
    // want someone to do after hitting this false positive once.
    const rebasedByContributor = commit({
      sha: 'ffffffffffffffffffffffffffffffffffffffff',
      authorName: 'ignaciohermosillacornejo',
      authorEmail: MAINTAINER_EMAIL,
      authorLogin: MAINTAINER_LOGIN,
      committerName: 'gmhoward9289-ops',
      committerEmail: CONTRIBUTOR_EMAIL,
      committerLogin: CONTRIBUTOR_LOGIN,
      subject: 'fix: a genuine maintainer commit, rebased by the contributor',
    });
    expect(findForgedAuthorship([rebasedByContributor])).toHaveLength(1);
  });
});

describe('forged authorship', () => {
  test('flags a maintainer-authored commit committed by someone else', () => {
    const found = findForgedAuthorship([FORGED]);
    expect(found).toHaveLength(1);
    expect(found[0].sha).toBe(FORGED.sha);
    expect(found[0].committer).toContain('attacker');
  });

  test('flags it even when buried among legitimate commits', () => {
    const found = findForgedAuthorship([
      CONTRIBUTOR_OWN,
      MAINTAINER_OWN_PUSH,
      FORGED,
      CONTRIBUTOR_REBASED_BY_MAINTAINER,
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].sha).toBe(FORGED.sha);
  });

  test('reports the subject so a copied commit message is visible', () => {
    // #6003 reused a real merged PR's subject to make the commit look routine.
    expect(findForgedAuthorship([FORGED])[0].subject).toBe(
      'fix(organization): Certain parameters not showing in client types (#5214)'
    );
  });

  test('flags when the author email is a maintainer but GitHub resolved no account', () => {
    // An address GitHub cannot map to a login still renders as the name typed
    // into it, which is enough to mislead a reviewer scanning the list.
    const found = findForgedAuthorship([
      commit({
        sha: 'dddddddddddddddddddddddddddddddddddddddd',
        authorName: 'ignaciohermosillacornejo',
        authorEmail: MAINTAINER_EMAIL,
        authorLogin: null,
        committerName: 'attacker',
        committerEmail: 'attacker@example.com',
        committerLogin: null,
      }),
    ]);
    expect(found).toHaveLength(1);
  });

  test('flags when the maintainer login is claimed under a different address', () => {
    const found = findForgedAuthorship([
      commit({
        sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        authorName: 'ignaciohermosillacornejo',
        authorEmail: 'noreply@users.noreply.github.com',
        authorLogin: MAINTAINER_LOGIN,
        committerName: 'attacker',
        committerEmail: 'attacker@example.com',
        committerLogin: 'attacker',
      }),
    ]);
    expect(found).toHaveLength(1);
  });
});

/**
 * End-to-end tests for the CLI itself, driven through the same
 * CHECK_AUTHORSHIP_COMMITS seam CI uses. The exported predicate is covered
 * above; this covers what actually runs in the workflow — argument handling,
 * JSON parsing, exit codes, and the operator-facing output. A security gate
 * whose entry point is untested can fail open without anything noticing.
 */
describe('CLI', () => {
  async function runCli(
    payload: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'authorship-cli-'));
    try {
      const file = join(dir, 'commits.json');
      await writeFile(file, payload);
      const proc = Bun.spawn(['bun', 'run', SCRIPT], {
        env: { ...process.env, CHECK_AUTHORSHIP_COMMITS: file },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code: await proc.exited, stdout, stderr };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('exits 0 and reports the count on clean input', async () => {
    const { code, stdout } = await runCli(
      JSON.stringify([MAINTAINER_OWN_PUSH, CONTRIBUTOR_OWN, CONTRIBUTOR_REBASED_BY_MAINTAINER])
    );
    expect(code).toBe(0);
    expect(stdout).toContain('3 commits');
    expect(stdout).toContain('no forged authorship');
  });

  test('exits 1 and names the sha, author and committer on a forgery', async () => {
    const { code, stderr } = await runCli(JSON.stringify([CONTRIBUTOR_OWN, FORGED]));
    expect(code).toBe(1);
    expect(stderr).toContain(FORGED.sha.slice(0, 10));
    expect(stderr).toContain('attacker');
    expect(stderr).toContain(MAINTAINER_EMAIL);
  });

  test('surfaces the copied subject, which is how the commit passes as routine', async () => {
    const { stderr } = await runCli(JSON.stringify([FORGED]));
    expect(stderr).toContain('Certain parameters not showing in client types');
  });

  test('exits 2 on malformed JSON rather than passing silently', async () => {
    // Distinct from exit 1: a parse failure means the gate did not run, and
    // must not be mistaken for "no findings".
    const { code, stderr } = await runCli('{not json');
    expect(code).toBe(2);
    expect(stderr).toContain('not valid JSON');
  });

  test('exits 2 when the payload is not an array', async () => {
    const { code, stderr } = await runCli(JSON.stringify({ message: 'Not Found' }));
    expect(code).toBe(2);
    expect(stderr).toContain('expected a JSON array');
  });

  test('exits 0 on an empty array', async () => {
    const { code, stdout } = await runCli('[]');
    expect(code).toBe(0);
    expect(stdout).toContain('0 commits');
  });
});
