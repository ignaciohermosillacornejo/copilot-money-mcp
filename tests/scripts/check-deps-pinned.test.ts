/**
 * Behavioural tests for scripts/check-deps-pinned.ts — the `check:deps-pinned`
 * gate in `bun run check`.
 *
 * Context: `@anthropic-ai/mcpb` was pinned to `"latest"` (issue #585), the only
 * floating specifier in the repo, sitting on the packaging/release path that
 * `pack-mcpb.ts` and the CI license job exist to keep reproducible. Pinning it
 * fixes the instance; this gate fixes the class, so the next `"latest"` cannot
 * land unnoticed.
 *
 * The script is driven end-to-end against synthetic manifests via the
 * CHECK_DEPS_PINNED_PACKAGE_JSON override, matching how
 * tests/scripts/check-skills.test.ts drives its linter.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-deps-pinned.ts', import.meta.url));
const REAL_PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

async function runCheck(
  packageJsonPath: string
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], {
    env: { ...process.env, CHECK_DEPS_PINNED_PACKAGE_JSON: packageJsonPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

/** Run the gate against a synthetic package.json, then clean up. */
async function withManifest(
  manifest: Record<string, unknown>,
  assertions: (result: { code: number; stderr: string; stdout: string }) => void
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'deps-pinned-'));
  const path = join(dir, 'package.json');
  try {
    await writeFile(path, JSON.stringify(manifest, null, 2));
    assertions(await runCheck(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('floating specifiers are rejected', () => {
  // Every form that carries no version information at all.
  for (const spec of ['latest', '*', 'x', '', '  LATEST  ']) {
    test(`rejects ${JSON.stringify(spec)}`, async () => {
      await withManifest(
        { devDependencies: { '@anthropic-ai/mcpb': spec } },
        ({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr).toContain('Dependency pinning check failed');
          expect(stderr).toContain('@anthropic-ai/mcpb');
        }
      );
    });
  }

  test('names every offender, not just the first', async () => {
    await withManifest(
      {
        dependencies: { alpha: 'latest' },
        devDependencies: { beta: '*' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('dependencies.alpha');
        expect(stderr).toContain('devDependencies.beta');
      }
    );
  });

  test('checks optional and peer dependencies too', async () => {
    await withManifest(
      {
        optionalDependencies: { gamma: 'latest' },
        peerDependencies: { delta: '*' },
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('optionalDependencies.gamma');
        expect(stderr).toContain('peerDependencies.delta');
      }
    );
  });
});

describe('real specifiers are accepted', () => {
  test('accepts ranges and exact pins', async () => {
    // Ranges are fine: package-lock.json records the resolution, so the install
    // stays reproducible and upgrades arrive as reviewable dependabot PRs.
    await withManifest(
      {
        dependencies: { caret: '^2.1.2', tilde: '~1.0.0', exact: '3.2.1', gte: '>=1.2.0' },
        devDependencies: { scoped: '^17.8.0' },
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('5 dependency specifiers');
      }
    );
  });

  test('a manifest with no dependency fields at all passes', async () => {
    await withManifest({ name: 'empty' }, ({ code }) => {
      expect(code).toBe(0);
    });
  });
});

describe('the real repository', () => {
  test('package.json has no floating specifiers', async () => {
    const { code, stdout } = await runCheck(REAL_PACKAGE_JSON);
    expect(code).toBe(0);
    expect(stdout).toContain('pinned or ranged');
  });
});
