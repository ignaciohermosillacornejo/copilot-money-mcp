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
 * TWO WAYS TO KILL THE TRANSPORT, and this file covers both
 *
 * Exiting is the obvious one. Blocking is the other: an offline boot spends
 * four 30s attempts plus backoff in the probe, and a host whose startup
 * timeout fires during that wait shows the same closed transport for the same
 * reason. So `runServer` now connects the transport BEFORE probing, and the
 * ordering is pinned here rather than left to the next reader's judgement.
 *
 * THE CLASS, and why the structural tests are not about auth at all
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import ts from 'typescript';
import { tsFilesUnder, scriptKindFor } from '../helpers/ts-files.js';
import { CopilotMoneyServer, preflightLiveAuthOrWarn } from '../../src/server.js';
import { GraphQLClient, GraphQLError } from '../../src/core/graphql/client.js';
import { noCopilotSessionError } from '../../src/core/auth/browser-token.js';

const SRC_DIR = join(import.meta.dir, '../../src');
const SERVER_TS = join(SRC_DIR, 'server.ts');

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

  test('a SUCCEEDING probe says nothing at all', async () => {
    // The direction every other case in this file leaves open. Without it, a
    // refactor that logged `[live-reads] preflight failed` unconditionally —
    // or any scary line on a healthy boot — would pass the whole file, and
    // the user would be told to go log in while already logged in.
    const client = {
      query: () =>
        Promise.resolve({
          transactions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
        }),
      mutate: () => Promise.reject(new Error('preflight must not mutate')),
    } as unknown as GraphQLClient;
    const stderr = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(preflightLiveAuthOrWarn(client)).resolves.toBeUndefined();
      expect(
        stderr.mock.calls.flat().join('\n'),
        'a healthy boot must be silent — a diagnostic nobody needs trains people to ignore it'
      ).toBe('');
    } finally {
      stderr.mockRestore();
    }
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
        // The URL comes from the SECOND (static) line for a `GraphQLError`,
        // whose rendering says "Sign in to the Copilot web app" without one;
        // only `noCopilotSessionError` carries it in the message itself. This
        // asserts the pair, which is the thing a person reading the log sees
        // — not the rendering of any single error.
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

/** Parse a source file once, for the AST walks below. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file)
  );
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
 *
 * KNOWN LIMITS, so a green run is not over-read. It recognises the callee
 * written as a member of `process` — `process.exit(…)` and `process['exit'](…)`
 * — and nothing else. These evade it:
 *
 *   const { exit } = process; exit(1);
 *   import { exit } from 'node:process'; exit(1);
 *   const p = process; p.exit(1);
 *
 * Closing those needs binding resolution (a `ts.Program`, not a `SourceFile`),
 * which is more machinery than this gate earns — and none of the three is a
 * shape anyone in this repo writes. What is guarded is the spelling a person
 * reintroducing the bug would actually reach for.
 */
function processExitArgs(file: string): string[] {
  const sf = parse(file);
  const found: string[] = [];
  const isProcessExit = (callee: ts.Expression): boolean => {
    // `process.exit(…)`
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'process'
    ) {
      return callee.name.text === 'exit';
    }
    // `process['exit'](…)` — same call, different spelling.
    if (
      ts.isElementAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'process' &&
      ts.isStringLiteralLike(callee.argumentExpression)
    ) {
      return callee.argumentExpression.text === 'exit';
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isProcessExit(node.expression)) {
      found.push(node.arguments[0]?.getText(sf) ?? '');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

describe('class detector: only the argv layer may kill the process (#708)', () => {
  // `tsFilesUnder` rather than a local walk: it covers the whole TS extension
  // family (`'a.mts'.endsWith('.ts')` is false, so a `.ts`-only filter would
  // NEVER OPEN such a file and report zero offenders over it — under-collection
  // reported as success, this detector's own worst failure mode), skips
  // node_modules/dist/.git, and does not follow symlinks into a cycle.
  const files = tsFilesUnder(SRC_DIR);

  test('guards the gate: the walk found src/ and it found real exit calls', () => {
    // A discovery scan that collects nothing passes every "no offenders"
    // assertion. Pin both ends: src/ is non-trivial, and the walk does
    // recognise a `process.exit` — cli.ts has several, by design.
    expect(files.length).toBeGreaterThan(20);
    expect(processExitArgs(join(SRC_DIR, 'cli.ts')).length).toBeGreaterThan(0);
  });

  test('both spellings of the callee are recognised, and near-misses are not', () => {
    // The limits in `processExitArgs`' docblock are only honest if the forms
    // it DOES claim actually work. Written to a real file and run through
    // `processExitArgs` itself — a matcher reimplemented inline here would be
    // testing a copy, and the copy is the one thing that cannot drift from
    // the gate by being wrong.
    //
    // `process['exit']` appears nowhere in the tree, so without a fixture the
    // element-access branch would be uncovered by construction.
    const fixture = join(mkdtempSync(join(tmpdir(), 'exit-spellings-')), 'fixture.ts');
    writeFileSync(
      fixture,
      [
        'process.exit(1);',
        "process['exit'](2);",
        // Near-misses that must NOT be counted: an assignment, a different
        // method that merely mentions the word, and a comment.
        'process.exitCode = 3;',
        "process.emit('exit');",
        '// process.exit(4);',
        'export {};',
      ].join('\n')
    );
    try {
      expect(processExitArgs(fixture)).toEqual(['1', '2']);
    } finally {
      rmSync(fixture, { force: true });
    }
  });

  test('the walk ignores a `process.exit(1)` written in a comment', () => {
    // The #705 failure mode, asserted directly: `src/server.ts` documents the
    // removed call in prose, and a text scan would count it. If this ever
    // fails, the gate below has started reading documentation as code.
    //
    // The claim is about COMMENT PARSING, so the assertion is scoped to it:
    // `not.toContain('1')`, not an exact list. Pinning the exact multiset
    // would make a new SIGHUP handler fail a test about comments.
    const server = readFileSync(SERVER_TS, 'utf8');
    expect(
      server,
      'the rationale this assertion is about has moved — re-point it or delete it'
    ).toContain('`process.exit(1)`');
    expect(processExitArgs(SERVER_TS)).not.toContain('1');
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

describe('the transport connects before the probe runs (#708)', () => {
  /**
   * The OTHER way to reproduce #708's symptom, and the reason this is
   * structural rather than behavioural: `runServer` claims stdio, so calling
   * it in-process is not an option, and the invariant is about statement
   * ORDER inside it.
   *
   * WHAT THIS PROVES: in `runServer`'s body, the `server.run()` call — which
   * connects the stdio transport — precedes the `preflightLiveAuthOrWarn`
   * call, and the probe is not awaited.
   *
   * WHAT IT DOES NOT: that `server.run()` itself returns promptly, or that
   * any particular host tolerates any particular delay. A probe moved into a
   * helper that `runServer` awaits before `server.run()` would also evade it.
   * It pins the shape a person editing this function would actually change.
   */
  function runServerBody(): ts.FunctionDeclaration {
    const sf = parse(SERVER_TS);
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'runServer'
    );
    if (!fn?.body)
      throw new Error('runServer is no longer a function declaration in src/server.ts');
    return fn;
  }

  /** Position of the first call whose text starts with `prefix`, or -1. */
  function callPos(fn: ts.FunctionDeclaration, prefix: string): number {
    const sf = fn.getSourceFile();
    let pos = -1;
    const visit = (node: ts.Node): void => {
      if (pos === -1 && ts.isCallExpression(node) && node.expression.getText(sf).startsWith(prefix))
        pos = node.getStart(sf);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return pos;
  }

  test('guards the gate: both calls were actually found', () => {
    // Either one going missing (a rename, an extraction into a helper) would
    // make the ordering assertion below compare -1 against -1 and pass.
    const fn = runServerBody();
    expect(callPos(fn, 'server.run'), 'server.run() not found in runServer').toBeGreaterThan(-1);
    expect(
      callPos(fn, 'preflightLiveAuthOrWarn'),
      'preflightLiveAuthOrWarn not found in runServer'
    ).toBeGreaterThan(-1);
  });

  test('server.run() comes first, and the probe is not awaited', () => {
    const fn = runServerBody();
    expect(
      callPos(fn, 'preflightLiveAuthOrWarn'),
      'the boot probe must run AFTER the transport connects: an offline boot spends ~125s ' +
        'in it (four 30s attempts plus backoff), and a host whose startup timeout fires ' +
        'during that wait shows the same closed transport #708 is about'
    ).toBeGreaterThan(callPos(fn, 'server.run'));

    const sf = fn.getSourceFile();
    let awaited = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isAwaitExpression(node) &&
        node.expression.getText(sf).startsWith('preflightLiveAuthOrWarn')
      )
        awaited = true;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    expect(
      awaited,
      'awaiting the probe holds runServer open for the whole retry budget — it is ' +
        'fire-and-forget on purpose (it catches everything and never rejects)'
    ).toBe(false);
  });
});
