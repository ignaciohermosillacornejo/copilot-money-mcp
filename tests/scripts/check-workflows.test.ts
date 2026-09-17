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

  test('the ceiling itself passes, one minute over it fails', async () => {
    // Pins the comparison. Only testing 360 leaves a `>=`/`>` slip invisible.
    const at = (n: number) => `name: Boundary
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: ${n}
    steps:
      - run: echo hi
`;
    await withWorkflows({ 'at-ceiling.yml': at(60) }, ({ code }) => {
      expect(code).toBe(0);
    });
    await withWorkflows({ 'over-ceiling.yml': at(61) }, ({ code, stderr }) => {
      expect(code).toBe(1);
      expect(stderr).toContain('ceiling');
    });
  });

  test('zero and negative timeouts are rejected', async () => {
    for (const value of [0, -5]) {
      await withWorkflows(
        {
          'nonpositive.yml': `name: Nonpositive
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: ${value}
    steps:
      - run: echo hi
`,
        },
        ({ code, stderr }) => {
          expect(code).toBe(1);
          expect(stderr).toContain('positive number');
        }
      );
    }
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

  test('a uses: pointing outside this repository is reported, not skipped', async () => {
    // The skip is only a waiver-with-coverage while the callee is a workflow
    // this gate also reads. An external target is never parsed, so nothing
    // would bound the job — the skip's own justification does not hold.
    await withWorkflows(
      {
        'external.yml': `name: External caller
on: push
jobs:
  call:
    uses: some-org/actions/.github/workflows/build.yml@abc123
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('jobs.call');
        expect(stderr).toContain('outside this repository');
        // Deliberately NOT asserting that the summary omits this job from the
        // clean-skip count. The summary prints only when there are no problems,
        // and an external `uses:` is always a problem, so stdout is empty on
        // every path where the counter could be wrong — an assertion here would
        // pass with the fix reverted (verified by mutation). Keeping the
        // counter honest is defensive tidiness, not observable behaviour, and
        // claiming coverage it doesn't have would be worse than claiming none.
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

  test('workflow_dispatch that reaches no job is rejected', async () => {
    // Presence of the trigger is not the property worth gating: a job whose
    // `if:` still gates on the review payload is skipped under dispatch, and a
    // skipped job reports success — so the bug reopens with the gate green.
    await withWorkflows(
      {
        'unreachable.yml': `name: Unreachable dispatch
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
    if: github.event.review.state == 'approved'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('no job it can reach');
      }
    );
  });

  test('an if: that admits the dispatch event satisfies reachability', async () => {
    await withWorkflows(
      {
        'reachable.yml': `name: Reachable dispatch
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
jobs:
  act:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.review.state == 'approved'
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

  test('a negated mention of the event does not count as reachable', async () => {
    // The shape a substring test waves through while being exactly the
    // unreachable case: it names the event in order to EXCLUDE it.
    await withWorkflows(
      {
        'negated.yml': `name: Negated
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
jobs:
  act:
    if: github.event_name != 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('no job it can reach');
      }
    );
  });

  test('the reverse operand order is accepted', async () => {
    await withWorkflows(
      {
        'reversed.yml': `name: Reversed
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
jobs:
  act:
    if: "'workflow_dispatch' == github.event_name"
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

  test('a job with no if: at all is reachable', async () => {
    await withWorkflows(
      {
        'no-if.yml': `name: No if
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
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

  test('a nonexistent workflow directory reports why, not a raw stack', async () => {
    const { code, stderr } = await runCheck('/definitely/not/a/real/workflow/dir');
    expect(code).toBe(1);
    expect(stderr).toContain('cannot read');
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

describe('invariant 3 — a trust gate names the people it trusts (#741)', () => {
  /** The shape the bug had: an identity read off the account that holds the repo. */
  test('a job `if:` comparing a login against github.repository_owner fails', async () => {
    await withWorkflows(
      {
        'gate.yml': `name: Gate
on:
  pull_request_review:
    types: [submitted]
  workflow_dispatch:
jobs:
  merge:
    if: github.event_name == 'workflow_dispatch' || github.event.review.user.login == github.repository_owner
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gate.yml');
        expect(stderr).toContain('github.repository_owner');
        expect(stderr).toContain('HOLDS the repo');
      }
    );
  });

  test('laundering it through `env:` into a shell step fails too', async () => {
    // auto-merge.yml's actual shape before #741: the `if:` was only half of it,
    // and a rule that read `if:` expressions alone would have passed the `jq`
    // filter that did the real work.
    await withWorkflows(
      {
        'laundered.yml': `name: Laundered
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      OWNER: \${{ github.repository_owner }}
    steps:
      - run: test "$ACTOR" = "$OWNER"
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('laundered.yml');
        expect(stderr).toContain('github.repository_owner');
      }
    );
  });

  test('a comment mentioning it does not trip the rule', async () => {
    // The check parses YAML rather than scanning text, so prose about the
    // expression — including the paragraph in auto-merge.yml explaining why it
    // is not used — is not the expression. A file-wide grep would fail this.
    await withWorkflows(
      {
        'prose.yml': `name: Prose
on: push
jobs:
  build:
    # Deliberately NOT github.repository_owner — see #741.
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

  test('a login literal with no declaration fails', async () => {
    await withWorkflows(
      {
        'undeclared.yml': `name: Undeclared
on: push
jobs:
  publish:
    if: github.actor == 'octocat'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('undeclared.yml');
        expect(stderr).toContain("'octocat'");
        expect(stderr).toContain('env.APPROVERS');
      }
    );
  });

  test('a gate and a declaration that disagree fail, naming the direction', async () => {
    await withWorkflows(
      {
        'drift.yml': `name: Drift
on: push
env:
  APPROVERS: '["octocat"]'
jobs:
  publish:
    if: github.actor == 'someone-else'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gated but not declared: someone-else');
        expect(stderr).toContain('declared but not gated: octocat');
      }
    );
  });

  test('a declared approver missing from the cheap gate fails — the silent direction', async () => {
    // The whole reason set EQUALITY is the rule rather than membership. Adding
    // a second maintainer to the declaration and not to the job `if:` means
    // their approval never starts the job: no error, no run, nothing to notice.
    await withWorkflows(
      {
        'half-added.yml': `name: Half added
on: push
env:
  APPROVERS: '["octocat","hubot"]'
jobs:
  publish:
    if: github.actor == 'octocat'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('declared but not gated: hubot');
      }
    );
  });

  test('a gate that agrees with its declaration passes', async () => {
    await withWorkflows(
      {
        'agrees.yml': `name: Agrees
on: push
env:
  APPROVERS: '["octocat"]'
jobs:
  publish:
    if: github.event.review.user.login == 'octocat'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 approver gate(s)');
      }
    );
  });

  test('a step `if:` reading the declaration needs no literal at all', async () => {
    // claude-review.yml's shape. A STEP `if:` can read `env`, so there is one
    // copy and nothing to keep in agreement — the rule must not demand a
    // literal that the file correctly does not have.
    await withWorkflows(
      {
        'single-source.yml': `name: Single source
on: push
env:
  APPROVERS: '["octocat"]'
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - if: contains(fromJSON(env.APPROVERS), github.event.pull_request.user.login)
        run: echo approve
`,
      },
      ({ code, stdout }) => {
        expect(code).toBe(0);
        expect(stdout).toContain('1 approver gate(s)');
      }
    );
  });

  test('a literal in a STEP `if:` is held to the declaration too', async () => {
    // Step-level `if:` is where a login literal is least defensible — a step
    // CAN read `env` — and also where a scan that only walked job-level `if:`
    // would go quiet. Without this case, narrowing the walk to jobs passes the
    // whole suite (verified: it did).
    await withWorkflows(
      {
        'step-literal.yml': `name: Step literal
on: push
env:
  APPROVERS: '["octocat"]'
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - if: github.event.pull_request.user.login == 'stale-maintainer'
        run: echo approve
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('gated but not declared: stale-maintainer');
      }
    );
  });

  test('a declaration that is not a JSON array of logins fails', async () => {
    await withWorkflows(
      {
        'bare.yml': `name: Bare
on: push
env:
  APPROVERS: 'octocat'
jobs:
  publish:
    if: github.actor == 'octocat'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('must be a JSON array of logins');
      }
    );
  });

  test('an exclusion (`!=`) is not a declaration of trust', async () => {
    // `github.actor != 'dependabot[bot]'` is in claude-review.yml today.
    // Demanding that a DENIED login appear in the trust list would be exactly
    // backwards, so `==` is the only shape this reads.
    await withWorkflows(
      {
        'excludes.yml': `name: Excludes
on: push
jobs:
  review:
    if: github.actor != 'dependabot[bot]'
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

  test('two conflicting declarations in one workflow fail', async () => {
    await withWorkflows(
      {
        'two.yml': `name: Two
on: push
env:
  APPROVERS: '["octocat"]'
jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      APPROVERS: '["hubot"]'
    steps:
      - run: echo hi
`,
      },
      ({ code, stderr }) => {
        expect(code).toBe(1);
        expect(stderr).toContain('more than once with different values');
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
