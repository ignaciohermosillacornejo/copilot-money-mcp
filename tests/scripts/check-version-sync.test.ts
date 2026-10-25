/**
 * Behavioural tests for scripts/check-version-sync.ts — the `check:version-sync`
 * gate in `bun run check`.
 *
 * Besides the six version fields, the gate requires a non-empty CHANGELOG
 * section for the version, because build-mcpb.yml takes the GitHub release
 * notes from it and falls back to "Release v<version>" when there is none —
 * which is what v2.3.0 shipped with (#890).
 *
 * The script is driven end-to-end against a synthetic repo root via the
 * CHECK_VERSION_SYNC_ROOT override, matching tests/scripts/check-deps-pinned.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-version-sync.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

type Result = { code: number; stderr: string; stdout: string };

async function runCheck(root: string): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], {
    env: { ...process.env, CHECK_VERSION_SYNC_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

const NOTES = '## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- A fix.\n';

interface Repo {
  pkg: string;
  server: string;
  serverNpm: string;
  serverNpmIdentifier: string;
  manifest: string;
  lock: string;
  lockSelf: string;
  changelog: string;
}

const IN_SYNC: Repo = {
  pkg: '1.2.3',
  server: '1.2.3',
  serverNpm: '1.2.3',
  serverNpmIdentifier: 'synthetic-pkg',
  manifest: '1.2.3',
  lock: '1.2.3',
  lockSelf: '1.2.3',
  changelog: NOTES,
};

/** Write a synthetic repo root, run the gate against it, then clean up. */
async function withRepo(overrides: Partial<Repo>): Promise<Result> {
  const r = { ...IN_SYNC, ...overrides };
  const dir = await mkdtemp(join(tmpdir(), 'version-sync-'));
  try {
    const json = (v: unknown) => JSON.stringify(v, null, 2);
    await writeFile(join(dir, 'package.json'), json({ name: 'synthetic-pkg', version: r.pkg }));
    await writeFile(
      join(dir, 'server.json'),
      json({
        version: r.server,
        packages: [
          { registryType: 'npm', identifier: r.serverNpmIdentifier, version: r.serverNpm },
        ],
      })
    );
    await writeFile(join(dir, 'manifest.json'), json({ version: r.manifest }));
    await writeFile(
      join(dir, 'package-lock.json'),
      json({ version: r.lock, packages: { '': { version: r.lockSelf } } })
    );
    await writeFile(join(dir, 'CHANGELOG.md'), r.changelog);
    return await runCheck(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('check:version-sync', () => {
  test('passes on the real repo', async () => {
    const { code, stderr } = await runCheck(REPO_ROOT);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });

  test('passes when every field matches and the CHANGELOG section has notes', async () => {
    const { code, stdout } = await withRepo({});
    expect(code).toBe(0);
    expect(stdout).toContain('Versions in sync: 1.2.3');
  });

  const FIELDS: [keyof Repo, string][] = [
    ['server', 'server.json#version'],
    ['serverNpm', 'server.json#packages[npm].version'],
    ['manifest', 'manifest.json#version'],
    ['lock', 'package-lock.json#version'],
    ['lockSelf', "package-lock.json#packages[''].version"],
  ];
  for (const [field, label] of FIELDS) {
    test(`fails when ${label} differs from package.json`, async () => {
      const { code, stderr } = await withRepo({ [field]: '1.2.2' });
      expect(code).toBe(1);
      expect(stderr).toContain(`${label} (1.2.2) !== package.json#version (1.2.3)`);
    });
  }

  test("fails when server.json's npm identifier differs from package.json#name", async () => {
    // npm-publish.yml polls package.json's name; the registry validates this identifier.
    const { code, stderr } = await withRepo({ serverNpmIdentifier: 'other-pkg' });
    expect(code).toBe(1);
    expect(stderr).toContain(
      'server.json#packages[npm].identifier (other-pkg) !== package.json#name (synthetic-pkg)'
    );
  });

  test('fails when the CHANGELOG has no section for the version', async () => {
    const { code, stderr } = await withRepo({
      changelog: '## [Unreleased]\n\n- A fix.\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('CHANGELOG.md has no "## [1.2.3]" section');
  });

  test('fails when the section exists but is empty before the next heading', async () => {
    // The v2.3.0 failure one step later: a dated heading added above nothing.
    const { code, stderr } = await withRepo({
      changelog:
        '## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n\n## [1.2.2] - 2025-12-01\n\n- Older.\n',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('"## [1.2.3]" section is empty');
  });

  test('fails when the section is empty at the end of the file', async () => {
    const { code, stderr } = await withRepo({ changelog: '## [1.2.3] - 2026-01-01\n\n' });
    expect(code).toBe(1);
    expect(stderr).toContain('"## [1.2.3]" section is empty');
  });

  test('a section for a different version does not satisfy the gate', async () => {
    const { code, stderr } = await withRepo({
      changelog: '## [1.2.30] - 2026-01-01\n\n- A fix.\n',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('CHANGELOG.md has no "## [1.2.3]" section');
  });
});
