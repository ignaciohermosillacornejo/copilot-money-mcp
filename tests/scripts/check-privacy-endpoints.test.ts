/**
 * Behavioural tests for scripts/check-privacy-endpoints.ts — the
 * `check:privacy-endpoints` gate in `bun run check`.
 *
 * Context: PRIVACY.md stated in five places that network traffic went to
 * `firestore.googleapis.com`, and only under `--write`. Both were false — the
 * GraphQL client has posted to `app.copilot.money/api/graphql` since the
 * Firestore-REST design was replaced, and `--live-reads` enables the same
 * traffic. No test, lint rule, or type check opens a Markdown file, so the
 * document drifted silently. This gate compares the hosts in src/ against the
 * hosts in PRIVACY.md and fails in both directions.
 *
 * The script is driven end-to-end against synthetic trees via the
 * CHECK_PRIVACY_ENDPOINTS_ROOT override, matching how
 * tests/scripts/check-deps-pinned.test.ts drives its gate.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-privacy-endpoints.ts', import.meta.url));
const REAL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function runCheck(root: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], {
    env: { ...process.env, CHECK_PRIVACY_ENDPOINTS_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

/**
 * Build a synthetic repo root — `src/` holding the given files, plus a
 * PRIVACY.md — run the gate against it, then clean up.
 */
async function withTree(
  sources: Record<string, string>,
  privacy: string,
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-endpoints-'));
  try {
    for (const [name, contents] of Object.entries(sources)) {
      const path = join(dir, 'src', name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, contents);
    }
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'PRIVACY.md'), privacy);
    assertions(await runCheck(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('agreement between src/ and PRIVACY.md', () => {
  test('passes when the doc names exactly the hosts the code contacts', async () => {
    await withTree(
      { 'client.ts': `fetch('https://api.example.com/graphql');` },
      'We contact https://api.example.com and nothing else.',
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('api.example.com');
      }
    );
  });

  test('passes with several hosts in any order', async () => {
    await withTree(
      {
        'a.ts': `fetch('https://api.example.com/graphql');`,
        'nested/b.ts': `fetch('https://auth.example.org/token');`,
      },
      'Destinations: https://auth.example.org and https://api.example.com.',
      ({ code }) => expect(code).toBe(0)
    );
  });
});

describe('undisclosed traffic fails', () => {
  test('a host in code but not the doc is reported', async () => {
    await withTree(
      {
        'client.ts': `fetch('https://api.example.com/graphql');`,
        'tracker.ts': `fetch('https://telemetry.example.net/collect');`,
      },
      'We contact https://api.example.com and nothing else.',
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('NOT named in PRIVACY.md');
        expect(stderr).toContain('telemetry.example.net');
        expect(stderr).toContain('undisclosed network traffic');
      }
    );
  });
});

describe('stale claims fail', () => {
  test('a host in the doc but not the code is reported', async () => {
    await withTree(
      { 'client.ts': `fetch('https://api.example.com/graphql');` },
      'We contact https://api.example.com and https://firestore.googleapis.com.',
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('NOT contacted by src/');
        expect(stderr).toContain('firestore.googleapis.com');
        expect(stderr).toContain('stale claim');
      }
    );
  });

  test('reports both directions at once, not just the first', async () => {
    await withTree(
      { 'client.ts': `fetch('https://new.example.com/graphql');` },
      'We contact https://old.example.com.',
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('new.example.com');
        expect(stderr).toContain('old.example.com');
      }
    );
  });
});

describe('comments are not destinations', () => {
  test('a host in a block comment does not count as traffic', async () => {
    await withTree(
      {
        'decoder.ts': [
          '/**',
          ' * Wire format reference: https://protobuf.dev/programming-guides/encoding/',
          ' */',
          `fetch('https://api.example.com/graphql');`,
        ].join('\n'),
      },
      'We contact https://api.example.com.',
      ({ code }) => expect(code).toBe(0)
    );
  });

  test('a host in a line comment does not count as traffic', async () => {
    await withTree(
      {
        'notes.ts': [
          '// See https://plaid.com/docs/errors/ for the taxonomy',
          `fetch('https://api.example.com/graphql');`,
        ].join('\n'),
      },
      'We contact https://api.example.com.',
      ({ code }) => expect(code).toBe(0)
    );
  });
});

describe('cleartext endpoints are caught', () => {
  // The regex matches http:// as well as https://. A plain-http destination is
  // the case most worth disclosing, so it must not slip past a TLS-only scan.
  test('an undisclosed http:// host fails like an https:// one', async () => {
    await withTree(
      {
        'client.ts': `fetch('https://api.example.com/graphql');`,
        'legacy.ts': `fetch('http://insecure.example.net/ping');`,
      },
      'We contact https://api.example.com.',
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('insecure.example.net');
      }
    );
  });
});

describe('documented blind spot: dynamically built URLs', () => {
  // Not a bug to fix here — a source scan cannot see a host assembled at
  // runtime. This test pins the limitation so it stays a known, documented
  // gap rather than being mistaken for coverage. Closing it needs runtime
  // interception, not a wider regex.
  test('a host built by interpolation is invisible to the scan', async () => {
    await withTree(
      {
        'client.ts': [
          'const region = process.env.REGION;',
          'fetch(`https://${region}.hidden.example.net/graphql`);',
        ].join('\n'),
      },
      'We contact nothing.',
      ({ code }) => {
        // Passes despite an undisclosed destination: the literal prefix carries
        // no host. If this ever starts failing, the scanner got stronger and
        // the "Known limits" comment in the script should be revisited.
        expect(code).toBe(0);
      }
    );
  });
});

describe('the real repository', () => {
  test('PRIVACY.md matches the hosts in src/', async () => {
    const { code, stdout } = await runCheck(REAL_ROOT);
    expect(code).toBe(0);
    expect(stdout).toContain('app.copilot.money');
    expect(stdout).toContain('securetoken.googleapis.com');
  });
});
