/**
 * Behavioural tests for scripts/check-pr-sections.sh — the logic behind the
 * "Required PR Sections" CI gate (.github/workflows/required-sections.yml,
 * issue #463).
 *
 * The workflow can't be run as a real `pull_request` event locally, so we test
 * the matching logic directly: feed sample PR bodies to the script via stdin
 * and assert on its exit code. This is the same script the workflow invokes,
 * so green here means the gate's decision logic is covered.
 */
import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-pr-sections.sh', import.meta.url));

async function runCheck(
  body: string,
  title = 'feat: something'
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(['bash', SCRIPT, '-'], {
    stdin: new TextEncoder().encode(body),
    env: { ...process.env, PR_TITLE: title },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stderr, stdout };
}

const FILLED_ASSUMPTIONS = `# Summary

Does a thing. Closes #1.

## External assumptions

None
`;

describe('External assumptions gate', () => {
  test('passes when the section has a non-empty answer', async () => {
    const { code } = await runCheck(FILLED_ASSUMPTIONS);
    expect(code).toBe(0);
  });

  test('passes with substantive prose under the header', async () => {
    const body = `## External assumptions

Assumes RecurringFrequency includes WEEKLY (probe transcript, PR #123).
`;
    const { code } = await runCheck(body);
    expect(code).toBe(0);
  });

  test('fails when the header is missing entirely', async () => {
    const body = `# Summary

No required section here.
`;
    const { code, stderr } = await runCheck(body);
    expect(code).not.toBe(0);
    expect(stderr).toContain('External assumptions');
  });

  test('fails when the section is present but empty', async () => {
    const body = `## External assumptions

## Next section
`;
    const { code, stderr } = await runCheck(body);
    expect(code).not.toBe(0);
    expect(stderr).toContain('empty');
  });

  test('fails when the only content is an HTML comment (deleted answer)', async () => {
    const body = `## External assumptions

<!-- forgot to fill this in -->
`;
    const { code } = await runCheck(body);
    expect(code).not.toBe(0);
  });

  test('header match is case-insensitive', async () => {
    const body = `## EXTERNAL ASSUMPTIONS

None
`;
    const { code } = await runCheck(body);
    expect(code).toBe(0);
  });

  test('stops capturing at the next ## header', async () => {
    // Empty assumptions section followed by a populated later section must fail
    // (later content must not leak into the assumptions check).
    const body = `## External assumptions

## Bug fix?

Root cause: x
`;
    const { code, stderr } = await runCheck(body);
    expect(code).not.toBe(0);
    expect(stderr).toContain('empty');
  });

  test('shell metacharacters in the body are not interpreted', async () => {
    const body = '## External assumptions\n\n`rm -rf /` $(whoami) "quotes" \'more\'\n';
    const { code } = await runCheck(body);
    expect(code).toBe(0);
  });
});

const RITUAL = `Root cause: a
Bug class: b
Detector added: c
Siblings checked: d
Ledger updated: e`;

describe('Bug Response Ritual gate (fix: PRs)', () => {
  test('fix: PR with all ritual fields passes', async () => {
    const body = `## External assumptions

None

## Bug fix?

${RITUAL}
`;
    const { code } = await runCheck(body, 'fix: correct enum mapping');
    expect(code).toBe(0);
  });

  test('fix: PR missing a ritual field fails', async () => {
    const body = `## External assumptions

None

## Bug fix?

Root cause: a
Bug class: b
`;
    const { code, stderr } = await runCheck(body, 'fix: correct enum mapping');
    expect(code).not.toBe(0);
    expect(stderr).toContain('Bug Response Ritual');
  });

  test('fix: PR with ritual fields only inside an HTML comment fails', async () => {
    const body = `## External assumptions

None

<!--
${RITUAL}
-->
`;
    const { code } = await runCheck(body, 'fix: stale comment template');
    expect(code).not.toBe(0);
  });

  test('non-fix PR is not held to the ritual', async () => {
    const { code } = await runCheck(FILLED_ASSUMPTIONS, 'chore: tidy');
    expect(code).toBe(0);
  });

  test('scoped fix(scope): prefix is recognized', async () => {
    const body = `## External assumptions

None

${RITUAL}
`;
    const { code } = await runCheck(body, 'fix(decoder): handle null');
    expect(code).toBe(0);
  });

  test('breaking fix!: prefix is recognized', async () => {
    const body = `## External assumptions

None
`;
    const { code, stderr } = await runCheck(body, 'fix!: drop legacy field');
    expect(code).not.toBe(0);
    expect(stderr).toContain('Bug Response Ritual');
  });

  test('"fix" not used as a conventional-commit prefix is ignored', async () => {
    // "fixture" should not trip the ritual check.
    const { code } = await runCheck(FILLED_ASSUMPTIONS, 'test: add fixture');
    expect(code).toBe(0);
  });
});
