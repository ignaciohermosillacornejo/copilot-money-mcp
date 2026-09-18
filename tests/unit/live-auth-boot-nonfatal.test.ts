/**
 * A live-reads boot failure reaches the AGENT, not just the host log (#708).
 *
 * THE BUG
 *
 * `--live-reads` ran a boot probe and, on any failure, printed two stderr
 * lines and called `process.exit(1)`. The MCP host then shows a closed
 * transport and nothing else: no tools are listed, so the model has nothing
 * to call and no error text to relay. The single actionable fact — "log into
 * app.copilot.money in your browser" — existed only in a log file the person
 * asking the question does not know to open. That is how #708 was reported:
 * an external user dug it out of the logs themselves.
 *
 * The docs fix for #708 (README prerequisite line) told people the rule in
 * advance. It did nothing for the person who gets it wrong anyway, which is
 * the case that generated the report.
 *
 * THE CLASS, and why the second test is not about auth at all
 *
 * Instance: "boot auth failure exits". Class: **a failure inside the server
 * reported by terminating the process rather than through an MCP result.**
 * Every member is invisible in the same way — the transport that would have
 * carried the explanation is the thing being destroyed — and the class is
 * open: a future cache-load guard, schema check or config validation could
 * each reach for `process.exit(1)` in `src/server.ts` and reintroduce it.
 *
 * So the detector is structural: no module under `src/` except `src/cli.ts`
 * may exit non-zero. `cli.ts` is the argv layer and runs before any transport
 * exists, so a bad flag there has no client to be reported to — that is the
 * one place where exiting IS the report.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';
import { CopilotMoneyServer, preflightLiveAuthOrWarn } from '../../src/server.js';
import { GraphQLClient, GraphQLError } from '../../src/core/graphql/client.js';
import { noCopilotSessionError } from '../../src/core/auth/browser-token.js';

const SRC_DIR = join(import.meta.dir, '../../src');

/** A client whose every request fails the way boot/tool calls would. */
function failingClient(err: unknown): GraphQLClient {
  return {
    query: () => Promise.reject(err),
    mutate: () => Promise.reject(err),
  } as unknown as GraphQLClient;
}

/**
 * The failures a boot probe can actually hit, each an independent case.
 *
 * `noCopilotSessionError` is the one that matters most and the one a
 * hand-written `GraphQLError` would NOT stand in for: it is thrown by token
 * extraction before any request is sent, so it never becomes a
 * `GraphQLError` and never passes through the client's classifier. It is
 * imported from the module that produces it rather than retyped, so a
 * reworded message cannot leave this file testing a string nobody throws.
 */
const BOOT_FAILURES = [
  { label: 'no browser session', err: noCopilotSessionError(['Chrome', 'Safari']) },
  { label: 'auth rejected', err: new GraphQLError('AUTH_FAILED', '401', 'Transactions') },
  { label: 'network down', err: new GraphQLError('NETWORK', 'ECONNREFUSED', 'Transactions') },
  { label: 'schema drift', err: new GraphQLError('SCHEMA_ERROR', 'no field', 'Transactions') },
] as const;

describe('preflightLiveAuthOrWarn survives every boot failure (#708)', () => {
  test('guards the gate: it still awaits the probe and sees the rejection', async () => {
    // Without this, a body that had been gutted to `return;` would satisfy
    // every "resolves" assertion below by never probing at all — the server
    // would come up, but the stderr diagnostic that host-log debugging still
    // relies on would be gone with no test noticing.
    const err = new GraphQLError('AUTH_FAILED', '401', 'Transactions');
    const query = spyOn({ q: () => Promise.reject(err) }, 'q');
    const client = { query, mutate: () => Promise.reject(err) } as unknown as GraphQLClient;
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await preflightLiveAuthOrWarn(client);
    } finally {
      stderr.mockRestore();
    }
    expect(query).toHaveBeenCalled();
  });

  for (const { label, err } of BOOT_FAILURES) {
    test(`${label}: resolves instead of exiting, and names the remedy on stderr`, async () => {
      // `process.exit` is typed as returning `never`, so a stub that returns
      // must be cast. If the production code calls it, the function keeps
      // running past a point it believes is unreachable — which is fine here
      // (there is nothing after it) and is why the assertion is on the spy.
      const exit = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const stderr = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(preflightLiveAuthOrWarn(failingClient(err))).resolves.toBeUndefined();
        expect(exit, 'a boot failure must not terminate the server').not.toHaveBeenCalled();
        const logged = stderr.mock.calls.flat().join('\n');
        expect(logged).toContain('[live-reads] preflight failed');
        expect(
          logged,
          'the host log must still name the browser login, for the person reading logs'
        ).toContain('app.copilot.money');
      } finally {
        stderr.mockRestore();
        exit.mockRestore();
      }
    });
  }
});

describe('the live tool surface still reports the failure to the client (#708)', () => {
  /**
   * The half that actually fixes the report: with the server up, a live call
   * comes back as an `isError` MCP result whose text carries the remedy. That
   * is the only channel the model can read.
   */
  test('a live read with no session returns an actionable isError result', async () => {
    const err = noCopilotSessionError(['Chrome', 'Safari']);
    const server = new CopilotMoneyServer(
      '/nonexistent/live-auth-boot',
      undefined,
      false,
      true,
      failingClient(err)
    );

    const listed = server.handleListTools().tools.map((t) => t.name);
    // Guards the gate twice over: the tool must be LISTED (the old behaviour
    // listed nothing because the process was gone) and it must be the live
    // variant, so the assertion below is about the GraphQL path.
    expect(listed).toContain('get_transactions_live');
    expect(listed).not.toContain('get_transactions');

    // Real arguments on purpose: an argument-validation error is returned
    // before any GraphQL request is made, so a bare `{}` would assert nothing
    // about the auth path.
    const result = await server.handleCallTool('get_transactions_live', {
      period: 'this_month',
    });
    expect(result.isError, 'a failed live read must be flagged as an error').toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)
      .map((c) => c.text)
      .join('\n');
    expect(
      text,
      'the model can only relay what is in the result — the login URL must be in it'
    ).toContain('https://app.copilot.money');
    expect(text.toLowerCase()).toContain('log into');
  });
});

/** Every `.ts` file under src/, repo-relative. */
function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return srcFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Locate `process.exit(<arg>)` calls via the parser, reporting each argument's
 * source text (empty string for `process.exit()`).
 *
 * An AST walk rather than a regex over source, for the reason #705 documented
 * from the other side: a pattern that merely CONTAINS `process.exit(1)` counts
 * the JSDoc in `src/server.ts` that explains why the call was removed, so the
 * gate would fail on its own rationale. The parser never sees comments as
 * calls, so no stripping pass is needed either.
 */
function processExitArgs(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'exit'
    ) {
      found.push(node.arguments[0]?.getText(sf) ?? '');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

describe('class detector: only the argv layer may kill the process (#708)', () => {
  const files = srcFiles(SRC_DIR);

  test('guards the gate: the walk found src/ and it found real exit calls', () => {
    // A discovery scan that collects nothing passes every "no offenders"
    // assertion. Pin both ends: src/ is non-trivial, and the walk does
    // recognise a `process.exit` — cli.ts has several, by design.
    expect(files.length).toBeGreaterThan(20);
    expect(processExitArgs(join(SRC_DIR, 'cli.ts')).length).toBeGreaterThan(0);
  });

  test('the walk ignores a `process.exit(1)` written in a comment', () => {
    // The #705 failure mode, asserted directly: `src/server.ts` documents the
    // removed call in prose, and a text scan would count it. If this ever
    // fails, the gate below has started reading documentation as code.
    const server = readFileSync(join(SRC_DIR, 'server.ts'), 'utf8');
    expect(
      server,
      'the rationale this assertion is about has moved — re-point it or delete it'
    ).toContain('`process.exit(1)`');
    expect(processExitArgs(join(SRC_DIR, 'server.ts'))).toEqual(['0', '0']);
  });

  test('no module outside src/cli.ts exits non-zero', () => {
    const offenders = files
      .filter((f) => relative(SRC_DIR, f) !== 'cli.ts')
      .flatMap((f) =>
        processExitArgs(f)
          // `process.exit(0)` is a clean shutdown, not a swallowed failure:
          // src/server.ts uses it in its SIGINT/SIGTERM handlers, where the
          // client has already asked to be disconnected.
          .filter((arg) => arg !== '0')
          .map((arg) => `${relative(SRC_DIR, f)}: process.exit(${arg})`)
      );
    expect(
      offenders,
      'a failure inside the server must be returned to the client as an isError result — ' +
        'exiting destroys the only channel that could explain it (#708). Only src/cli.ts, ' +
        'which runs before any transport exists, may exit non-zero.'
    ).toEqual([]);
  });
});
