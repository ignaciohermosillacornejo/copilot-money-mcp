/**
 * Behavioural tests for scripts/check-workflows.ts — the `check:workflows` gate
 * in `bun run check` and in `.github/workflows/test.yml`.
 *
 * Context: before this gate nothing in the repo read the workflow files, so two
 * classes of CI defect were invisible to every check — a job with no
 * `timeout-minutes` (#692, ten of twelve jobs) and an automation reachable only
 * through a trigger GitHub can decline to deliver (#643, `auto-merge.yml`).
 *
 * The script is driven end-to-end against synthetic workflow trees via the
 * CHECK_WORKFLOWS_DIR override, matching how tests/scripts/check-deps-pinned.test.ts
 * drives its gate.
 *
 * Two of these tests are the deletion-mutants for the gate itself: `timeout-minutes`
 * removed from a runs-on job must FAIL and must name the job, and a `uses:` job
 * without one must PASS. A gate that got either backwards would be worse than no
 * gate — the second would demand YAML that GitHub rejects.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-workflows.ts', import.meta.url));
const REAL_WORKFLOW_DIR = fileURLToPath(new URL('../../.github/workflows', import.meta.url));

type Result = { code: number; stderr: string; stdout: string };

async function runCheck(dir: string): Promise<Result> {
  const proc = Bun.spawn(['bun', 'run', SCRIPT], {
    env: { ...process.env, CHECK_WORKFLOWS_DIR: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

/** Run the gate against a synthetic `<name>.yml → contents` tree, then clean up. */
async function withWorkflows(
  files: Record<string, string>,
  assertions: (result: Result) => void
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'check-workflows-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body);
    }
    assertions(await runCheck(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A minimal well-formed workflow: one bounded job, a trigger that is never withheld. */
const OK = `name: Fine
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo hi
`;

describe('invariant 1 — every step-running job is bounded', () => {
  test('a runs-on job with no timeout-minutes fails, and the message names it', async () => {
    // The deletion-mutant: this is OK with the key removed.
    await withWorkflows(
      {
        'one.yml': `name: One
on: push
jobs:
  unbounded-job:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('one.yml');
        expect(stderr).toContain('unbounded-job');
        expect(stderr).toContain('timeout-minutes');
      }
    );
  });

  test('a bounded job passes', async () => {
    await withWorkflows({ 'ok.yml': OK }, ({ code, stdout }) => {
      expect(code).toBe(0);
      expect(stdout).toContain('1 job(s) bounded');
    });
  });

  test('a step-level timeout-minutes does not satisfy the job-level requirement', async () => {
    // The failure mode the gate exists to avoid: `timeout-minutes` is valid YAML
    // at step level, where it bounds one step and leaves the job on the
    // 360-minute default. A substring check over the file would pass this.
    await withWorkflows(
      {
        'step-level.yml': `name: Step level
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        timeout-minutes: 5
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('jobs.build');
        expect(stderr).toContain('sibling of');
      }
    );
  });

  test('a commented-out timeout-minutes does not satisfy it either', async () => {
    await withWorkflows(
      {
        'commented.yml': `name: Commented
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    # timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('jobs.build');
      }
    );
  });

  test('a non-numeric timeout-minutes is rejected', async () => {
    // e.g. `timeout-minutes: ${{ inputs.t }}` — parses as a string, and the
    // bound has to be readable without running the workflow.
    await withWorkflows(
      {
        'expr.yml': `name: Expression
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: "\${{ inputs.t }}"
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('positive number');
      }
    );
  });

  test('a timeout so large it is not a bound is rejected', async () => {
    // The cheapest way to make a presence-only gate pass wrongly: write down
    // GitHub's own 360-minute default.
    await withWorkflows(
      {
        'huge.yml': `name: Huge
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('ceiling');
      }
    );
  });

  test('every offending job is named, not just the first', async () => {
    await withWorkflows(
      {
        'a.yml': `name: A
on: push
jobs:
  alpha:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`,
        'b.yml': `name: B
on: push
jobs:
  beta:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('alpha');
        expect(stderr).toContain('beta');
      }
    );
  });

  test('a job with neither uses: nor runs-on: is flagged rather than quietly skipped', async () => {
    await withWorkflows(
      {
        'malformed.yml': `name: Malformed
on: push
jobs:
  ghost:
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('ghost');
        expect(stderr).toContain('runnable job');
      }
    );
  });
});

describe('invariant 1 — reusable-workflow callers are skipped, not demanded of', () => {
  test('a uses: job with no timeout-minutes passes', async () => {
    // The other deletion-mutant. `timeout-minutes` is not a supported keyword on
    // a job that calls a reusable workflow, so a gate that demanded it here would
    // demand YAML GitHub rejects. Such callers are bound by the called
    // workflow's own jobs instead.
    await withWorkflows(
      {
        'caller.yml': `name: Caller
on: push
jobs:
  call:
    uses: ./.github/workflows/called.yml
    with:
      dry_run: false
`,
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 reusable-workflow caller job(s) skipped');
      }
    );
  });

  test('a uses: job that sets timeout-minutes anyway is reported', async () => {
    // The mirror-image mistake. Without this, the skip above would be a place to
    // hide an unsupported key.
    await withWorkflows(
      {
        'caller.yml': `name: Caller
on: push
jobs:
  call:
    uses: ./.github/workflows/called.yml
    timeout-minutes: 10
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('jobs.call');
        expect(stderr).toContain('not a supported keyword');
      }
    );
  });

  test('a mixed workflow bounds the runs-on job and skips the caller', async () => {
    await withWorkflows(
      {
        'mixed.yml': `name: Mixed
on: push
jobs:
  detect:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo hi
  release:
    needs: detect
    uses: ./.github/workflows/called.yml
`,
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 job(s) bounded');
        expect(stdout).toContain('1 reusable-workflow caller job(s) skipped');
      }
    );
  });
});

describe('invariant 2 — a withheld trigger needs a manual escape hatch', () => {
  test('a pull_request_review-only workflow fails', async () => {
    await withWorkflows(
      {
        'review-only.yml': `name: Review only
on:
  pull_request_review:
    types: [submitted]
jobs:
  act:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('review-only.yml');
        expect(stderr).toContain('workflow_dispatch');
      }
    );
  });

  test('adding workflow_dispatch satisfies it', async () => {
    await withWorkflows(
      {
        'review-plus.yml': `name: Review plus dispatch
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: string
jobs:
  act:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code }) => {
        expect(code).toBe(0);
      }
    );
  });

  test('the list form of on: is understood', async () => {
    await withWorkflows(
      {
        'list-form.yml': `name: List form
on: [pull_request_review]
jobs:
  act:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('workflow_dispatch');
      }
    );
  });

  test('a workflow with no recognizable on: block is flagged, not silently passed', async () => {
    // Guards the parser assumption. If `on:` ever stopped landing under that key
    // — a YAML 1.1 parser reads a bare `on` as the boolean true — invariant 2
    // would find no triggers anywhere and pass every workflow.
    await withWorkflows(
      {
        'no-on.yml': `name: No triggers
jobs:
  act:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('no recognizable');
      }
    );
  });
});

describe('malformed input', () => {
  test('a file that is not valid YAML fails loudly', async () => {
    await withWorkflows({ 'broken.yml': 'name: [unterminated\n' }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('broken.yml');
    });
  });

  test('an empty workflow directory fails rather than passing vacuously', async () => {
    await withWorkflows({}, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('no workflow files found');
    });
  });

  test('.yaml files are checked too, not just .yml', async () => {
    await withWorkflows(
      {
        'other.yaml': `name: Other
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('other.yaml');
      }
    );
  });
});

describe('the real repository', () => {
  test('every workflow satisfies both invariants', async () => {
    const { code, stdout } = await runCheck(REAL_WORKFLOW_DIR);
    expect(code).toBe(0);
    expect(stdout).toContain('Workflow check passed');
  });
});
