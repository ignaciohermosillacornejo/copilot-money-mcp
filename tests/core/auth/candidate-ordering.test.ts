/**
 * Candidate ordering and exchange budget (issue #722).
 *
 * These tests span both auth modules on purpose. The bug lived in neither one:
 * `browser-token.ts` produced a candidate list in disk-discovery order, and
 * `firebase-auth.ts` capped that list at ten. Each half is defensible alone;
 * together they let a real Copilot session be discarded unseen, and the user
 * was then told to log in at app.copilot.money while already logged in.
 *
 * So the reproduction runs the REAL extractor over a REAL temp profile layout
 * and feeds it to a REAL FirebaseAuth. Only `fetch` is faked, and it decides
 * accept-vs-reject by looking at which token the request actually carries —
 * the same thing Google's endpoint does, and the one part of the loop that
 * cannot be exercised locally.
 *
 * No token value is ever logged, asserted on, or put in a failure message:
 * every string here is obviously synthetic, and the fetch fake records a
 * provenance label ('session' / 'foreign'), never the bytes it was given.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import ts from 'typescript';
import { scriptKindFor } from '../../helpers/ts-files.js';
import {
  extractRefreshTokenCandidates,
  getChromiumProfileStoragePaths,
  isCopilotScopedPath,
  type BrowserConfig,
  type TokenResult,
} from '../../../src/core/auth/browser-token.js';
import {
  DEAD_TOKEN_CODES,
  ENDPOINT_LEVEL_ERROR_CODES,
  ENDPOINT_LEVEL_STATUSES,
  FirebaseAuth,
  MAX_EXCHANGE_CANDIDATES,
  TOKEN_EXCHANGE_TIMEOUT_MS,
} from '../../../src/core/auth/firebase-auth.js';

/**
 * A synthetic `AMf-`-shaped string long enough to match the extractor's regex
 * (100+ URL-safe chars after the prefix). Every token is the same LENGTH, so
 * the extractor's longest-first within-file preference cannot silently supply
 * the ordering this test is about; only the label differs.
 */
function syntheticToken(label: string): string {
  return `AMf-${label.padEnd(20, 'z')}${'q'.repeat(110)}`;
}

const REAL_SESSION = syntheticToken('session');
const ID_TOKEN = 'synthetic-id-token';

/** Names a token without revealing it — the only form tokens take in output. */
function labelFor(body: string): 'session' | 'foreign' {
  return body.includes(REAL_SESSION) ? 'session' : 'foreign';
}

const originalFetch = globalThis.fetch;

/** How the endpoint turns down a token from another Firebase project. */
const FOREIGN_REJECTION: [object, number] = [
  { error: { message: 'PROJECT_NUMBER_MISMATCH' } },
  400,
];

/**
 * Fake securetoken: accepts exactly the one synthetic token standing in for
 * the user's Copilot session and rejects everything else the way the real
 * endpoint rejects a foreign project. Records only provenance labels.
 */
function mockExchange(attempts: string[], foreign: [object, number] = FOREIGN_REJECTION) {
  globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
    const body = String(options?.body ?? '');
    const label = labelFor(body);
    attempts.push(label);
    if (label === 'session') {
      return Promise.resolve(
        Response.json({
          id_token: ID_TOKEN,
          refresh_token: REAL_SESSION,
          expires_in: '3600',
          token_type: 'Bearer',
          user_id: 'synthetic-user',
        })
      );
    }
    const [errorBody, status] = foreign;
    return Promise.resolve(Response.json(errorBody, { status }));
  }) as unknown as typeof fetch;
}

describe('candidate ordering across the extractor and the exchange budget (#722)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'candidate-ordering-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  /**
   * Build the exact layout from the issue: profile A's browser-wide store is
   * full of other sites' tokens, and the genuine Copilot session lives in
   * profile B's origin-scoped IndexedDB — behind all of them in disk order.
   *
   * Paths come from the production `getChromiumProfileStoragePaths`, so the
   * per-profile interleave the bug depends on is the real one, not a
   * hand-written approximation of it.
   */
  function chromeProfilesWithForeignTokensFirst(foreignCount: number): BrowserConfig[] {
    const chromeDir = join(tempDir, 'Chrome');
    mkdirSync(join(chromeDir, 'Default'), { recursive: true });
    mkdirSync(join(chromeDir, 'Profile 1'), { recursive: true });

    const paths = getChromiumProfileStoragePaths(chromeDir);
    const browserWide = paths.find((p) => p.includes('Default') && !isCopilotScopedPath(p));
    const copilotScoped = paths.find((p) => p.includes('Profile 1') && isCopilotScopedPath(p));
    // If either lookup misses, the fixture no longer models the bug.
    expect(browserWide, 'expected a browser-wide path under Default').toBeDefined();
    expect(copilotScoped, 'expected a Copilot-scoped path under Profile 1').toBeDefined();

    mkdirSync(browserWide!, { recursive: true });
    writeFileSync(
      join(browserWide!, '000001.ldb'),
      Array.from({ length: foreignCount }, (_, i) => syntheticToken(`foreign${i}`)).join('\n')
    );

    mkdirSync(copilotScoped!, { recursive: true });
    writeFileSync(join(copilotScoped!, '000001.ldb'), REAL_SESSION);

    return [{ name: 'Chrome', paths, type: 'chromium' }];
  }

  test('a real session behind more than ten foreign tokens is still exchanged', async () => {
    const overrides = chromeProfilesWithForeignTokensFirst(MAX_EXCHANGE_CANDIDATES + 2);

    // Precondition: the fixture really does over-fill the budget with tokens
    // from the store every site writes to. Without this the test could pass
    // for the trivial reason that there was nothing to crowd it out.
    const { candidates } = await extractRefreshTokenCandidates(overrides);
    expect(candidates.filter((c) => !c.scoped).length).toBeGreaterThan(MAX_EXCHANGE_CANDIDATES);
    expect(candidates.filter((c) => c.scoped)).toHaveLength(1);

    const attempts: string[] = [];
    mockExchange(attempts);
    const auth = new FirebaseAuth(() => extractRefreshTokenCandidates(overrides));

    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    // Not merely "reached": reached FIRST. The budget is spent on the
    // origin-scoped store before a single foreign token is sent to Google.
    expect(attempts).toEqual(['session']);
  });

  test('the origin-scoped store is preferred across profiles, not just within one', async () => {
    const overrides = chromeProfilesWithForeignTokensFirst(3);
    const { candidates } = await extractRefreshTokenCandidates(overrides);

    // Three foreign tokens fit inside the cap, so the old code would have
    // found the session eventually. Ordering is still the property under
    // test: scoped first, and discovery order kept within each group.
    expect(candidates[0]?.scoped).toBe(true);
    expect(candidates.slice(1).every((c) => !c.scoped)).toBe(true);
  });

  test('duplicates of one foreign token cannot spend the budget more than once', async () => {
    const chromeDir = join(tempDir, 'Chrome');
    mkdirSync(join(chromeDir, 'Default'), { recursive: true });
    const paths = getChromiumProfileStoragePaths(chromeDir);
    const browserWide = paths.find((p) => !isCopilotScopedPath(p))!;
    const copilotScoped = paths.find((p) => isCopilotScopedPath(p))!;

    // One foreign token, written many times over many files — exactly what a
    // LevelDB directory looks like after compaction rewrites the same record.
    const repeated = syntheticToken('repeated');
    mkdirSync(browserWide, { recursive: true });
    for (let i = 0; i < MAX_EXCHANGE_CANDIDATES + 5; i++) {
      writeFileSync(join(browserWide, `00000${i}.ldb`), repeated);
    }
    mkdirSync(copilotScoped, { recursive: true });
    writeFileSync(join(copilotScoped, '000001.ldb'), REAL_SESSION);

    const overrides: BrowserConfig[] = [{ name: 'Chrome', paths, type: 'chromium' }];
    const { candidates } = await extractRefreshTokenCandidates(overrides);
    expect(candidates).toHaveLength(2);
  });

  test('a token seen in both stores is ranked by its strongest provenance', async () => {
    // Safari's origin-blind walk runs BEFORE Firefox's origin-scoped one, so
    // a token present in both would be pinned to the low-probability pool if
    // de-duplication kept the first sighting's provenance.
    const safariDir = join(tempDir, 'safari-website-data');
    mkdirSync(safariDir, { recursive: true });
    const shared = syntheticToken('shared');
    writeFileSync(join(safariDir, 'storage.db'), shared);

    const firefoxProfiles = join(tempDir, 'firefox');
    const firefoxIdb = join(
      firefoxProfiles,
      'abcd1234.default-release/storage/default/https+++app.copilot.money/idb'
    );
    mkdirSync(firefoxIdb, { recursive: true });
    writeFileSync(join(firefoxIdb, '1234.sqlite'), shared);

    const overrides: BrowserConfig[] = [
      { name: 'Safari', paths: [safariDir], type: 'safari' },
      { name: 'Firefox', paths: [firefoxProfiles], type: 'firefox' },
    ];

    const { candidates } = await extractRefreshTokenCandidates(overrides);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.scoped).toBe(true);
  });
});

describe('what counts as Copilot-scoped (#722)', () => {
  test.each([
    [
      'Chromium IndexedDB',
      '/u/Chrome/Default/IndexedDB/https_app.copilot.money_0.indexeddb.leveldb',
    ],
    ['Firefox origin dir', '/u/Firefox/storage/default/https+++app.copilot.money/idb'],
    ['Firefox partitioned origin', '/u/Firefox/storage/default/https+++app.copilot.money^p=x/idb'],
  ])('%s is scoped', (_name, path) => {
    expect(isCopilotScopedPath(path)).toBe(true);
  });

  test.each([
    ['browser-wide Local Storage', '/u/Chrome/Default/Local Storage/leveldb'],
    [
      'a lookalike subdomain suffix',
      '/u/Firefox/storage/default/https+++app.copilot.money.example.com/idb',
    ],
    [
      'a lookalike prefix',
      '/u/Chrome/Default/IndexedDB/https_evil-app.copilot.money_0.indexeddb.leveldb',
    ],
    [
      'a genuine other host',
      '/u/Chrome/Default/IndexedDB/https_app.example.com_0.indexeddb.leveldb',
    ],
  ])('%s is not scoped', (_name, path) => {
    // A lookalike ranking as scoped would not be a vulnerability — the
    // exchange still rejects a foreign token — but it would hand an
    // attacker-controlled origin a slot in the high-priority pool.
    expect(isCopilotScopedPath(path)).toBe(false);
  });
});

/**
 * Class-level detector for `ambiguous-candidate-selection`: no single candidate
 * may end the search for a valid one behind it. The candidate list is handed
 * straight to FirebaseAuth — bypassing the extractor — because the cap and its
 * ordering live in FirebaseAuth, and a bound whose safety depends on the
 * producer having sorted first is not a bound.
 */
describe('no single candidate can starve a valid one behind it (#722)', () => {
  const candidate = (token: string, scoped: boolean): TokenResult => ({
    token,
    browser: 'Chrome',
    scoped,
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('an unsorted extractor result does not defeat the budget', async () => {
    // Scoped candidate last, far past the cap: FirebaseAuth must re-establish
    // the ordering itself rather than inherit it.
    const candidates = [
      ...Array.from({ length: 20 }, (_, i) => candidate(syntheticToken(`foreign${i}`), false)),
      candidate(REAL_SESSION, true),
    ];
    const attempts: string[] = [];
    mockExchange(attempts);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(attempts).toEqual(['session']);
  });

  test.each([
    ['a foreign-project rejection', { error: { message: 'PROJECT_NUMBER_MISMATCH' } }, 400],
    ['a truncated/garbage token', { error: { message: 'INVALID_REFRESH_TOKEN' } }, 400],
    ['an expired token', { error: { message: 'TOKEN_EXPIRED' } }, 400],
    ['a disabled account', { error: { message: 'USER_DISABLED' } }, 400],
  ])('%s on an earlier candidate does not end the search', async (_name, body, status) => {
    // Every candidate here is browser-wide, so ordering cannot help: this is
    // purely about a 4xx verdict on one candidate not being read as a verdict
    // on the run. A token scraped out of raw LevelDB bytes can be truncated,
    // so a non-mismatch 400 is not evidence the token was Copilot's.
    const candidates = [
      candidate(syntheticToken('other-site'), false),
      candidate(REAL_SESSION, false),
    ];
    const attempts: string[] = [];
    mockExchange(attempts, [body, status as number]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(attempts).toEqual(['foreign', 'session']);
  });

  test('an endpoint failure stops immediately instead of replaying the whole list', async () => {
    // The inverse guard. A 5xx says nothing about the candidate, so skipping
    // past it would turn one outage into ten requests and bury the cause.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(syntheticToken(`foreign${i}`), false)
    );
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'UNAVAILABLE' } }, 503]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (503)');
    expect(attempts).toHaveLength(1);
  });

  test.each([
    // Probed for #722: no API key at all returns 403 PERMISSION_DENIED, and an
    // invalid key returns 400 API_KEY_INVALID — the SAME status a bad refresh
    // token uses. The key is hardcoded in src/, so "the key stopped working"
    // is an operational state, and every candidate would fail identically.
    // Continuing would send ten tokens for nothing and then report "log in"
    // for an outage logging in cannot fix.
    ['a blocked API identity', { error: { message: 'PERMISSION_DENIED' } }, 403],
    [
      'a rotated API key',
      // Verbatim shape from the #722 probe — Google puts the reason in
      // error.details[].reason with error.status "INVALID_ARGUMENT", so this
      // pins what production returns rather than a hand-shaped body.
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
              domain: 'googleapis.com',
              metadata: { service: 'securetoken.googleapis.com' },
            },
          ],
        },
      },
      400,
    ],
    ['a disabled API', { error: { message: 'SERVICE_DISABLED' } }, 403],
  ])('%s stops the run instead of spending the budget', async (_name, body, status) => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(syntheticToken(`foreign${i}`), false)
    );
    const attempts: string[] = [];
    mockExchange(attempts, [body, status as number]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed');
    await expect(auth.getIdToken()).rejects.not.toThrow('No Copilot Money session found');
    expect(attempts).toHaveLength(2); // one per getIdToken call, not one per candidate
  });

  test('duplicate sightings of one token cannot spend the budget more than once', async () => {
    // The budget refuses to trust its collaborator to ORDER; it must equally
    // refuse to trust it to DE-DUPLICATE. Ten copies of one token starve a
    // valid candidate behind them exactly the way ten foreign tokens did.
    const repeated = syntheticToken('repeated');
    const candidates = [
      ...Array.from({ length: MAX_EXCHANGE_CANDIDATES + 5 }, () => candidate(repeated, false)),
      candidate(REAL_SESSION, false),
    ];
    const attempts: string[] = [];
    mockExchange(attempts);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(attempts).toEqual(['foreign', 'session']);
  });

  test('a rate limit stops immediately, even though 429 is a 4xx', async () => {
    // 429 is a 4xx by number and a statement about the endpoint by meaning.
    // Replaying the list against a server that just said "back off" is the
    // same harm the 5xx guard prevents, so it must not count as a verdict on
    // the candidate.
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(syntheticToken(`foreign${i}`), false)
    );
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'RESOURCE_EXHAUSTED' } }, 429]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (429)');
    expect(attempts).toHaveLength(1);
  });

  test("a SCOPED candidate's unexplained rejection is surfaced rather than flattened", async () => {
    // The token came from Copilot's own store and the endpoint refused it for
    // a reason "you are logged out" does not cover. Telling this user to log
    // in would contradict evidence we hold, so surface it raw.
    const candidates = [
      candidate(syntheticToken('copilot-disabled'), true),
      candidate(syntheticToken('other-site'), false),
    ];
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'USER_DISABLED' } }, 400]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (400)');
    expect(attempts).toHaveLength(2);
  });

  test('an UNRECOGNISED rejection on a scoped candidate is still surfaced raw', async () => {
    // The allowlist's second, load-bearing claim: only codes we have actually
    // reasoned about count as explained. Without this case the predicate can be
    // mutated into a denylist (`!message.includes('USER_DISABLED')`) and the
    // whole suite still passes — verified, it did — while every future
    // securetoken code silently resolves to "log in".
    const candidates = [candidate(syntheticToken('copilot-unknown'), true)];
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'SOME_CODE_GOOGLE_HAS_NOT_SHIPPED_YET' } }, 400]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (400)');
  });

  test.each([['INVALID_REFRESH_TOKEN'], ['TOKEN_EXPIRED']])(
    'a scoped candidate rejected %s still says "log in", because that is the remedy',
    async (code) => {
      // Residue: the user logged out, but Copilot's own IndexedDB still holds
      // the dead token until compaction. Scoped, so it reaches the raw-error
      // branch — and a Firebase 400 here would name no action the actionable
      // message doesn't already name, which is #722's symptom once more.
      const candidates = [candidate(syntheticToken('copilot-dead'), true)];
      const attempts: string[] = [];
      mockExchange(attempts, [{ error: { message: code } }, 400]);
      const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

      await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
      expect(attempts).toHaveLength(1);
    }
  );

  test('the same rejection from browser-wide candidates only still says "log in"', async () => {
    // Mirror image, and the one that matters for a logged-out user: a
    // truncated `AMf-` fragment from some other site's storage is not evidence
    // about Copilot. Reporting it raw would swap the one actionable message
    // for a Firebase 400 — #722's symptom, reached from the other side.
    const candidates = [
      candidate(syntheticToken('other-site-0'), false),
      candidate(syntheticToken('other-site-1'), false),
    ];
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
    expect(attempts).toHaveLength(2);
  });

  test.each([
    ['nothing else works', false, 'No Copilot Money session found'],
    ['another profile has a live session', true, null],
  ])(
    'a dead CACHED token falls through to a cold re-extract when %s',
    async (_name, coldSessionExists, expectedError) => {
      // The fast path refreshes a token the server itself issued — known-good
      // until the user logs out, and dead afterwards. Throwing its raw 400 at
      // the caller is #722's symptom on the one path the cold-path fix cannot
      // reach, so it falls through instead.
      const cold = coldSessionExists
        ? [candidate(REAL_SESSION, true)]
        : [candidate(syntheticToken('other-site'), false)];
      const attempts: string[] = [];
      let issued = false;
      globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
        const body = String(options?.body ?? '');
        if (!issued) {
          // First call: a normal cold exchange that hands back a server token
          // and expires immediately, so the next call takes the fast path.
          issued = true;
          attempts.push('bootstrap');
          return Promise.resolve(
            Response.json({
              id_token: 'bootstrap-id-token',
              refresh_token: syntheticToken('server-issued'),
              expires_in: '0',
              token_type: 'Bearer',
              user_id: 'synthetic-user',
            })
          );
        }
        if (body.includes(syntheticToken('server-issued'))) {
          attempts.push('fast-path');
          return Promise.resolve(
            Response.json({ error: { message: 'INVALID_REFRESH_TOKEN' } }, { status: 400 })
          );
        }
        return Promise.resolve(
          body.includes(REAL_SESSION)
            ? Response.json({
                id_token: ID_TOKEN,
                refresh_token: REAL_SESSION,
                expires_in: '3600',
                token_type: 'Bearer',
                user_id: 'synthetic-user',
              })
            : Response.json({ error: { message: 'PROJECT_NUMBER_MISMATCH' } }, { status: 400 })
        );
      }) as unknown as typeof fetch;

      let candidates = [candidate(syntheticToken('bootstrap'), true)];
      const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));
      expect(await auth.getIdToken()).toBe('bootstrap-id-token');

      // The session the cold re-extract will find on the second call.
      candidates = cold;
      if (expectedError === null) {
        expect(await auth.getIdToken()).toBe(ID_TOKEN);
      } else {
        // One call, not two. A third `getIdToken()` asserting `.not.toThrow`
        // used to sit here: by then `refreshToken` is already null (the failed
        // exchange cleared it), so it never entered the fast path and pinned
        // the cold path a second time under a fast-path test's name.
        await expect(auth.getIdToken()).rejects.toThrow(expectedError);
      }
      expect(attempts).toContain('fast-path');
    }
  );

  test.each([
    // Both rows send an ENDPOINT-level failure through the fast path, where
    // the token is not the thing at fault, so the raw error is the whole
    // message a caller can act on. They pin the two halves of that guard
    // independently:
    ['a plain endpoint failure', 'PERMISSION_DENIED'],
    // ...and one whose body happens to quote a dead-token code. The
    // "explained by logged out" predicate is a substring test over the error
    // message, so on its own it reads this as a verdict on the token and
    // swallows a 403 into a cold re-extract that reports "log in" for an
    // outage logging in cannot fix. Only the `isCandidateRejection` gate in
    // front of it — the same one the cold path applies first — keeps it raw.
    ['an endpoint failure quoting a dead-token code', 'PERMISSION_DENIED (TOKEN_EXPIRED)'],
  ])('%s on the fast path is rethrown, not swallowed into a cold re-extract', async (_n, msg) => {
    // The direction the fast-path fall-through test above does NOT cover:
    // it pins fall-through on a dead token, and nothing pinned rethrow on
    // anything else — so `catch {}` (swallow everything) passed the suite.
    let issued = false;
    const attempts: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      if (!issued) {
        issued = true;
        attempts.push('bootstrap');
        return Promise.resolve(
          Response.json({
            id_token: 'bootstrap-id-token',
            refresh_token: syntheticToken('server-issued'),
            expires_in: '0',
            token_type: 'Bearer',
            user_id: 'synthetic-user',
          })
        );
      }
      attempts.push(
        String(options?.body ?? '').includes(syntheticToken('server-issued'))
          ? 'fast-path'
          : 'cold-path'
      );
      return Promise.resolve(Response.json({ error: { message: msg } }, { status: 403 }));
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(() => {
      extractions++;
      return Promise.resolve({
        candidates: [candidate(syntheticToken('bootstrap'), true)],
        checked: ['Chrome'],
      });
    });
    expect(await auth.getIdToken()).toBe('bootstrap-id-token');
    expect(extractions).toBe(1);

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (403)');
    // The raw error came FROM the fast path, not from a cold path that
    // happened to fail the same way: no second extraction ran, and no
    // cold-path exchange was attempted.
    expect(extractions).toBe(1);
    expect(attempts).toEqual(['bootstrap', 'fast-path']);
  });

  test('all-foreign candidates still yield the actionable "no session" error', async () => {
    const candidates = Array.from({ length: 3 }, (_, i) =>
      candidate(syntheticToken(`foreign${i}`), false)
    );
    const attempts: string[] = [];
    mockExchange(attempts);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
    expect(attempts).toHaveLength(3);
  });
});

/**
 * Class-level detector for `proxy-for-authority` on the auth side (#751).
 *
 * The cached refresh token is the one credential this module holds that a
 * browser read cannot cheaply replace. Discarding it is a verdict — "this token
 * is finished" — and the only signal entitled to deliver that verdict is one
 * the endpoint made ABOUT THE TOKEN. "The request failed" is a proxy for it:
 * true whenever the verdict is true, and also true during a rate limit, a
 * blocked API identity, and a rotated key, none of which know anything about
 * the token that was sent.
 *
 * So this does not enumerate "429 and 403". It walks the two lists the
 * production classifier itself branches on — `ENDPOINT_LEVEL_STATUSES` and
 * `ENDPOINT_LEVEL_ERROR_CODES` — so a signal added there tomorrow is asserted
 * here the same day, and asserts the mirror image over `DEAD_TOKEN_CODES`:
 * a real verdict MUST discard the token, or the fast path would retry a dead
 * credential forever. Both directions are mutation-verified; an
 * unconditional clear and a clear that never fires each turn one of them red.
 */
describe('an endpoint-level failure does not discard a known-good cached token (#751)', () => {
  const candidate = (token: string, scoped: boolean): TokenResult => ({
    token,
    browser: 'Chrome',
    scoped,
  });

  /** What the browser read finds; stands in for the user's live session. */
  const BOOTSTRAP = syntheticToken('bootstrap');
  /** What securetoken hands back in exchange for it — the CACHED token. */
  const SERVER_ISSUED = syntheticToken('server-issued');

  /**
   * A successful exchange response. `expiresIn: '0'` makes the ID token
   * useless immediately, so the very next `getIdToken()` has to refresh —
   * which is how the fast path gets exercised at all.
   */
  const issued = (expiresIn: string) =>
    Response.json({
      id_token: ID_TOKEN,
      refresh_token: SERVER_ISSUED,
      expires_in: expiresIn,
      token_type: 'Bearer',
      user_id: 'synthetic-user',
    });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Realistic bodies for the statuses in `ENDPOINT_LEVEL_STATUSES`, with a
   * fallback so a status added to that list still produces a row rather than
   * silently dropping out of the matrix.
   */
  const BODY_FOR_STATUS: Record<number, string> = {
    403: 'PERMISSION_DENIED',
    429: 'RESOURCE_EXHAUSTED',
  };

  const ENDPOINT_FAILURES: [string, string, number][] = [
    ...ENDPOINT_LEVEL_STATUSES.map((status): [string, string, number] => [
      `HTTP ${status}`,
      BODY_FOR_STATUS[status] ?? 'ENDPOINT_LEVEL_FAILURE',
      status,
    ]),
    // The body-classified half: securetoken reports a dead API key with the
    // same 400 a dead refresh token uses, so status alone cannot separate them.
    ...ENDPOINT_LEVEL_ERROR_CODES.map((code): [string, string, number] => [code, code, 400]),
    // Not derived from either list, because the predicate reaches it by a third
    // route (`status >= 500`), and an outage is the case the whole guard is for.
    ['HTTP 503', 'UNAVAILABLE', 503],
    // Candidate-level, and still not a verdict that the token is FINISHED.
    // These close the too-loose mutation of the shared predicate — dropping its
    // `isExplainedByLoggedOut` half, so that any 400 about the token discards
    // it. A disabled account is not fixed by scraping the browser again, and an
    // unrecognised code is not evidence of anything; both leave the credential
    // alone and are surfaced raw.
    ['a disabled account', 'USER_DISABLED', 400],
    ['an unrecognised code', 'SOME_CODE_GOOGLE_HAS_NOT_SHIPPED_YET', 400],
  ];

  test.each(ENDPOINT_FAILURES)(
    '%s on the fast path leaves the cached token usable on the next call',
    async (_label, message, status) => {
      const attempts: string[] = [];
      let extractions = 0;
      let stage: 'bootstrap' | 'outage' | 'recovered' = 'bootstrap';

      globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
        const sent = String(options?.body ?? '');
        if (stage === 'bootstrap') {
          stage = 'outage';
          attempts.push('bootstrap');
          return Promise.resolve(issued('0'));
        }
        attempts.push(sent.includes(SERVER_ISSUED) ? 'fast-path' : 'cold-path');
        if (stage === 'outage') {
          stage = 'recovered';
          return Promise.resolve(Response.json({ error: { message } }, { status }));
        }
        return Promise.resolve(issued('3600'));
      }) as unknown as typeof fetch;

      const auth = new FirebaseAuth(() => {
        extractions++;
        return Promise.resolve({ candidates: [candidate(BOOTSTRAP, true)], checked: ['Chrome'] });
      });

      expect(await auth.getIdToken()).toBe(ID_TOKEN);
      await expect(auth.getIdToken()).rejects.toThrow(`Firebase token exchange failed (${status})`);
      expect(await auth.getIdToken()).toBe(ID_TOKEN);

      // The claim: the retry refreshed the SAME cached token. No second browser
      // read — which, for a rate limit, would mean answering "slow down" with a
      // browser-wide scrape and up to ten more exchanges against the endpoint
      // that just said it (PRIVACY.md, "Browser Profile Storage").
      expect(extractions).toBe(1);
      expect(attempts).toEqual(['bootstrap', 'fast-path', 'fast-path']);
    }
  );

  test('concurrent fast-path callers whose cached token is dead share one re-extract, and keep its replacement', async () => {
    // Restated for #796, replacing two cases ("a verdict on a token that is no
    // longer the cached one leaves the cache alone" and "a still-valid idToken
    // installed mid-flight is returned without another exchange"). Both started two
    // fast-path callers on the same expired credential and hold the SECOND
    // caller's own rejection until the first had cold-extracted and installed a
    // replacement. They pinned two things that scenario needed: that the late
    // verdict, about a token nobody held any more, did not null the
    // replacement (the identity check in exchangeToken), and that the second
    // caller returned the replacement instead of reporting "No Copilot Money
    // session found" (#765). Since #796 the second caller joins the first
    // caller's attempt and never sends an exchange of its own, so neither
    // late verdict exists to hold. What is left to pin is the cost: one
    // exchange of the dead token, one browser read, and a replacement that is
    // still cached for the call after.
    const attempts: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const sent = String(options?.body ?? '');
      if (sent.includes(syntheticToken('server-issued'))) {
        attempts.push('expired-token');
        return Promise.resolve(
          Response.json({ error: { message: 'INVALID_REFRESH_TOKEN' } }, { status: 400 })
        );
      }
      attempts.push(sent.includes(REAL_SESSION) ? 'session-token' : 'bootstrap');
      return Promise.resolve(
        Response.json({
          id_token: ID_TOKEN,
          refresh_token: sent.includes(REAL_SESSION)
            ? REAL_SESSION
            : syntheticToken('server-issued'),
          // Every exchange expires immediately, so each call has to refresh and
          // the cached refresh token is what the next one depends on.
          expires_in: '0',
          token_type: 'Bearer',
          user_id: 'synthetic-user',
        })
      );
    }) as unknown as typeof fetch;

    // Extraction 1 seeds the cache, extraction 2 is the shared cold re-extract
    // and finds the live session; anything after that finds nothing, so a
    // needless third extraction is fatal rather than merely wasteful.
    const found: TokenResult[][] = [
      [candidate(syntheticToken('bootstrap'), true)],
      [candidate(REAL_SESSION, true)],
    ];
    let extractions = 0;
    const auth = new FirebaseAuth(() => {
      const candidates = found[extractions] ?? [];
      extractions += 1;
      return Promise.resolve({ candidates, checked: ['Chrome'] });
    });

    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(extractions).toBe(1);

    const first = auth.getIdToken();
    const second = auth.getIdToken();
    expect(await first).toBe(ID_TOKEN);
    expect(await second).toBe(ID_TOKEN);
    expect(extractions).toBe(2);

    // The replacement is still cached, so this refreshes it rather than
    // re-reading every browser profile.
    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(extractions).toBe(2);
    expect(attempts).toEqual(['bootstrap', 'expired-token', 'session-token', 'session-token']);
  });

  test.each([...DEAD_TOKEN_CODES])(
    'a %s verdict on the fast path does discard the cached token',
    async (code) => {
      // The mirror image, and the reason the gate is a predicate rather than
      // `never clear`: these codes ARE about the token we sent. Without the
      // clear, the fall-through to a cold re-extract would leave a dead
      // credential cached, and every later call would spend a request on it
      // before doing the same cold read anyway.
      const attempts: string[] = [];
      let extractions = 0;
      let bootstrapped = false;

      globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
        const sent = String(options?.body ?? '');
        if (!bootstrapped) {
          bootstrapped = true;
          attempts.push('bootstrap');
          return Promise.resolve(issued('0'));
        }
        attempts.push(sent.includes(SERVER_ISSUED) ? 'fast-path' : 'cold-path');
        return Promise.resolve(Response.json({ error: { message: code } }, { status: 400 }));
      }) as unknown as typeof fetch;

      const auth = new FirebaseAuth(() => {
        extractions++;
        return Promise.resolve({ candidates: [candidate(BOOTSTRAP, true)], checked: ['Chrome'] });
      });

      expect(await auth.getIdToken()).toBe(ID_TOKEN);
      // Second call: the fast path gets the verdict and falls through to a cold
      // re-extract, which finds only the same dead session.
      await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');
      await expect(auth.getIdToken()).rejects.toThrow('No Copilot Money session found');

      // Exactly one fast-path attempt across all three calls: the token was
      // discarded when the verdict arrived, so nothing retried it.
      expect(attempts).toEqual(['bootstrap', 'fast-path', 'cold-path', 'cold-path']);
      expect(extractions).toBe(3);
    }
  );
});

/**
 * One shared refresh attempt per instance (#796).
 *
 * `getIdToken` used to run a separate refresh for every caller, and the GraphQL
 * client calls it once per request. So concurrent callers raced on the same
 * `idToken` / `refreshToken` / `expiresAt`. #765 and #770 answered that with a
 * re-check at every resume point, which stops a resumed caller from reporting a
 * failure while its object holds a working token, but cannot stop a WRITE: a
 * cold-path candidate that succeeds after a sibling installed a session
 * overwrites it, possibly with another account's. And every caller still paid
 * for its own browser read and exchanges.
 *
 * Now the first caller starts the attempt and every caller that arrives while
 * it runs awaits the same promise. The cases below park the attempt at each
 * await it has (the fast-path exchange, the browser read, a cold-path candidate
 * exchange), let more callers arrive, and then let the parked await settle each
 * way it can. Every caller must get the same outcome, at the cost of ONE
 * caller's reads and exchanges.
 */
describe('concurrent callers share one refresh attempt (#796)', () => {
  const candidate = (token: string, scoped: boolean): TokenResult => ({
    token,
    browser: 'Chrome',
    scoped,
  });

  const BOOT = syntheticToken('boot');
  const CACHED = syntheticToken('cached');
  const LIVE = syntheticToken('live');
  const DEAD = syntheticToken('dead');
  const PARKED = syntheticToken('parked');
  const CALLERS = 5;

  const session = (
    refreshToken: string,
    expiresIn: string,
    idToken: string = ID_TOKEN,
    userId = 'synthetic-user'
  ) =>
    Response.json({
      id_token: idToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: 'Bearer',
      user_id: userId,
    });

  const deadVerdict = () =>
    Response.json({ error: { message: 'INVALID_REFRESH_TOKEN' } }, { status: 400 });
  const rateLimit = () =>
    Response.json({ error: { message: 'RESOURCE_EXHAUSTED' } }, { status: 429 });

  function gate(): { opened: Promise<void>; open: () => void } {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  /** Every caller's outcome, as 'ok:<id token>' or 'err:<message>'. */
  const settle = (calls: Promise<string>[]) =>
    Promise.all(
      calls.map((c) =>
        c.then(
          (id) => `ok:${id}`,
          (err: unknown) => `err:${err instanceof Error ? err.message : String(err)}`
        )
      )
    );

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('concurrent cold callers share one browser read and one exchange', async () => {
    let exchanges = 0;
    globalThis.fetch = mock(() => {
      exchanges += 1;
      return Promise.resolve(session(LIVE, '3600'));
    }) as unknown as typeof fetch;

    // The read is held until every caller has arrived, so none of them can be
    // served from a session the first one finished installing.
    const read = gate();
    let extractions = 0;
    const auth = new FirebaseAuth(async () => {
      extractions += 1;
      await read.opened;
      return { candidates: [candidate(LIVE, true)], checked: ['Chrome'] };
    });

    const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
    read.open();

    expect(await settle(calls)).toEqual(Array(CALLERS).fill(`ok:${ID_TOKEN}`));
    expect(extractions).toBe(1);
    expect(exchanges).toBe(1);
  });

  test('concurrent fast-path callers share one exchange and read no browser', async () => {
    const answered = gate();
    let cachedExchanges = 0;
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const sent = String(options?.body ?? '');
      if (sent.includes(BOOT)) return Promise.resolve(session(CACHED, '0'));
      cachedExchanges += 1;
      return answered.opened.then(() => session(CACHED, '3600'));
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(() => {
      extractions += 1;
      return Promise.resolve({ candidates: [candidate(BOOT, true)], checked: ['Chrome'] });
    });
    expect(await auth.getIdToken()).toBe(ID_TOKEN);

    const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
    answered.open();

    expect(await settle(calls)).toEqual(Array(CALLERS).fill(`ok:${ID_TOKEN}`));
    expect(cachedExchanges).toBe(1);
    expect(extractions).toBe(1);
  });

  test('callers joining a fast-path exchange that hits a dead-token verdict share the cold read', async () => {
    const answered = gate();
    const sent: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const body = String(options?.body ?? '');
      if (body.includes(BOOT)) return Promise.resolve(session(CACHED, '0'));
      if (body.includes(CACHED)) {
        sent.push('cached');
        return answered.opened.then(deadVerdict);
      }
      sent.push('live');
      return Promise.resolve(session(LIVE, '3600'));
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(() => {
      extractions += 1;
      const found = extractions === 1 ? BOOT : LIVE;
      return Promise.resolve({ candidates: [candidate(found, true)], checked: ['Chrome'] });
    });
    expect(await auth.getIdToken()).toBe(ID_TOKEN);

    const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
    answered.open();

    expect(await settle(calls)).toEqual(Array(CALLERS).fill(`ok:${ID_TOKEN}`));
    // One fast-path exchange, one cold read, one candidate exchange: what a
    // single caller costs.
    expect(sent).toEqual(['cached', 'live']);
    expect(extractions).toBe(2);
  });

  test('callers joining a fast-path exchange that hits a rate limit all get it, and the cached token survives (#751)', async () => {
    const answered = gate();
    let cachedExchanges = 0;
    let limited = true;
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const body = String(options?.body ?? '');
      if (body.includes(BOOT)) return Promise.resolve(session(CACHED, '0'));
      if (body.includes(CACHED)) {
        cachedExchanges += 1;
        if (!limited) return Promise.resolve(session(CACHED, '3600'));
        return answered.opened.then(rateLimit);
      }
      throw new Error('unexpected token in the exchange fake');
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(() => {
      extractions += 1;
      return Promise.resolve({ candidates: [candidate(BOOT, true)], checked: ['Chrome'] });
    });
    expect(await auth.getIdToken()).toBe(ID_TOKEN);

    const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
    answered.open();

    const outcomes = await settle(calls);
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toContain('err:Firebase token exchange failed (429)');
    // One request against the endpoint that said "slow down", not one per caller.
    expect(cachedExchanges).toBe(1);
    expect(extractions).toBe(1);

    // The shared failure was endpoint-level, so the cached token is still held
    // and the next call refreshes it without touching the browser.
    limited = false;
    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(cachedExchanges).toBe(2);
    expect(extractions).toBe(1);
  });

  test.each([
    ['a dead-token verdict', deadVerdict, `ok:${ID_TOKEN}`, ['parked', 'live']],
    ['a rate limit', rateLimit, 'err:Firebase token exchange failed (429)', ['parked']],
  ] as [string, () => Response, string, string[]][])(
    'callers joining a cold-path candidate exchange that hits %s share its outcome',
    async (_label, parkedFailure, expected, expectedSent) => {
      const answered = gate();
      const sent: string[] = [];
      globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
        const body = String(options?.body ?? '');
        if (body.includes(PARKED)) {
          sent.push('parked');
          return answered.opened.then(parkedFailure);
        }
        sent.push('live');
        return Promise.resolve(session(LIVE, '3600'));
      }) as unknown as typeof fetch;

      let extractions = 0;
      const auth = new FirebaseAuth(() => {
        extractions += 1;
        return Promise.resolve({
          candidates: [candidate(PARKED, true), candidate(LIVE, true)],
          checked: ['Chrome'],
        });
      });

      const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
      answered.open();

      const outcomes = await settle(calls);
      expect(new Set(outcomes).size).toBe(1);
      expect(outcomes[0]).toContain(expected);
      expect(sent).toEqual(expectedSent);
      expect(extractions).toBe(1);
    }
  );

  test('a cold-path candidate can no longer overwrite a session a sibling installed', async () => {
    // The overwrite named in #796. Caller 1's read finds a dead candidate and
    // then candidate B, and B's exchange is held. While it is in flight, caller
    // 2's read finds S and installs it. Before the fix B then succeeded and
    // exchangeToken overwrote S, another account's session, with B's: the two
    // callers were handed two different accounts' ID tokens, and the instance
    // kept the one caller 2 did not get. No re-check can stop that, because the
    // write happens inside exchangeToken. One shared attempt removes the
    // sibling.
    const B = syntheticToken('account-b');
    const S = syntheticToken('account-s');
    const bSent = gate();
    const bAnswered = gate();
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const body = String(options?.body ?? '');
      if (body.includes(DEAD)) return Promise.resolve(deadVerdict());
      if (body.includes(B)) {
        bSent.open();
        return bAnswered.opened.then(() => session(B, '3600', 'id-token-b', 'user-b'));
      }
      if (body.includes(S)) return Promise.resolve(session(S, '3600', 'id-token-s', 'user-s'));
      throw new Error('unexpected token in the exchange fake');
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(async () => {
      extractions += 1;
      if (extractions === 1) {
        return {
          candidates: [candidate(DEAD, true), candidate(B, true)],
          checked: ['Chrome'],
        };
      }
      // A second read (only possible without the dedupe) comes back once B's
      // exchange is in flight, which is the window the overwrite needs.
      await bSent.opened;
      return { candidates: [candidate(S, true)], checked: ['Chrome'] };
    });
    const transitions: string[] = [];
    auth.setUidTransitionListener((prev, next) => transitions.push(`${prev}->${next}`));

    const first = auth.getIdToken();
    const second = auth.getIdToken();
    await bSent.opened;
    // Let a sibling, if there is one, finish installing S before B answers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    bAnswered.open();

    const outcomes = await settle([first, second]);
    // Both callers hold the same account's token, it is the one still
    // installed, and the identity never changed underneath them.
    expect(outcomes).toEqual(['ok:id-token-b', 'ok:id-token-b']);
    expect(await auth.getIdToken()).toBe('id-token-b');
    expect(transitions).toEqual([]);
    expect(extractions).toBe(1);
  });

  test.each([
    ['a rejected browser read', 'reject'],
    ['a browser read that throws before it returns a promise', 'throw'],
  ] as const)('after %s, the next call starts a fresh attempt', async (_label, failure) => {
    let exchanges = 0;
    globalThis.fetch = mock(() => {
      exchanges += 1;
      return Promise.resolve(session(LIVE, '3600'));
    }) as unknown as typeof fetch;

    let extractions = 0;
    const read = gate();
    const auth = new FirebaseAuth(() => {
      extractions += 1;
      if (extractions === 1) {
        if (failure === 'throw') throw new Error('synthetic read failure');
        return read.opened.then(() => Promise.reject(new Error('synthetic read failure')));
      }
      return Promise.resolve({ candidates: [candidate(LIVE, true)], checked: ['Chrome'] });
    });

    const calls = Array.from({ length: CALLERS }, () => auth.getIdToken());
    read.open();
    expect(await settle(calls)).toEqual(Array(CALLERS).fill('err:synthetic read failure'));
    expect(extractions).toBe(1);

    // The failed attempt was cleared when it settled: this is a new one, not
    // the old rejection replayed.
    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    expect(extractions).toBe(2);
    expect(exchanges).toBe(1);
  });

  test('an exchange that never answers times out instead of hanging every later caller', async () => {
    // The shared attempt makes a hung exchange everyone's problem: without a
    // timeout its promise never settles, the clear never runs, and every
    // later call on the instance joins it (#802 review). The fake fetch here
    // answers only by honouring the abort signal, the way a half-open socket
    // would. The cached token must survive the timeout (#751), and the next
    // call must start a fresh attempt that can succeed.
    let hung = true;
    let cachedExchanges = 0;
    let unsignalled = 0;
    globalThis.fetch = mock((_url: string | URL | Request, options?: RequestInit) => {
      const body = String(options?.body ?? '');
      if (body.includes(BOOT)) return Promise.resolve(session(CACHED, '0'));
      cachedExchanges += 1;
      if (!hung) return Promise.resolve(session(CACHED, '3600'));
      const signal = options?.signal;
      if (!signal) {
        // Without a signal the real request would hang for good. Fail fast
        // and countably instead of waiting for the test runner's timeout.
        unsignalled += 1;
        return Promise.reject(new Error('exchange sent without an abort signal'));
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }) as unknown as typeof fetch;

    let extractions = 0;
    const auth = new FirebaseAuth(
      () => {
        extractions += 1;
        return Promise.resolve({ candidates: [candidate(BOOT, true)], checked: ['Chrome'] });
      },
      { exchangeTimeoutMs: 20 }
    );
    expect(await auth.getIdToken()).toBe(ID_TOKEN);

    const outcomes = await settle(Array.from({ length: CALLERS }, () => auth.getIdToken()));
    expect(unsignalled, 'the exchange must carry an abort signal').toBe(0);
    expect(outcomes).toEqual(
      Array(CALLERS).fill('err:Firebase token exchange timed out after 20ms')
    );
    expect(cachedExchanges).toBe(1);

    hung = false;
    expect(await auth.getIdToken()).toBe(ID_TOKEN);
    // A fresh fast-path exchange of the same cached token, no browser read.
    expect(cachedExchanges).toBe(2);
    expect(extractions).toBe(1);
  });

  test('a default-constructed instance bounds each exchange by TOKEN_EXCHANGE_TIMEOUT_MS', async () => {
    // The production path never passes the option, so pin that the default
    // is what reaches AbortSignal.timeout.
    const timeouts: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return realTimeout(ms);
    });
    try {
      globalThis.fetch = mock(() =>
        Promise.resolve(session(LIVE, '3600'))
      ) as unknown as typeof fetch;
      const auth = new FirebaseAuth(() =>
        Promise.resolve({ candidates: [candidate(LIVE, true)], checked: ['Chrome'] })
      );
      expect(await auth.getIdToken()).toBe(ID_TOKEN);
      expect(timeouts).toEqual([TOKEN_EXCHANGE_TIMEOUT_MS]);
    } finally {
      spy.mockRestore();
    }
  });

  test('every write to the session happens inside the one shared refresh attempt', () => {
    // The class-level half, and the replacement for #770's count test. That
    // test required one freshIdToken() re-check per await in getIdToken,
    // because any await could be overtaken by a sibling call. The re-checks
    // are gone because the sibling is: refreshSession runs only as the shared
    // promise, so nothing else on this instance writes the session while it
    // is suspended. That holds only while this chain holds, so the chain is
    // what is asserted:
    //
    //   1. getIdToken never suspends (`await`, `for await`, `await using`),
    //      so it has no resume point of its own.
    //   2. refreshSession is referenced once, from getIdToken, inside the
    //      `this.refreshInFlight ??=` that shares it.
    //   3. exchangeToken is referenced only from refreshSession.
    //   4. idToken / refreshToken / expiresAt / userId are written only in
    //      exchangeToken (field initialisers aside).
    //   5. refreshInFlight is set and cleared only in getIdToken, so nothing
    //      can clear it while an attempt is suspended and let a second start.
    //
    // A new await, a second caller of exchangeToken, a new writer of the
    // session, or a stray clear of refreshInFlight brings the #770 race back,
    // and fails here first. A write is `=`, a compound `op=`, or `++`/`--`.
    // Limits, stated rather than coded around: it reads `this.<name>` property
    // accesses, so a bracket access, an aliased `this`, a destructuring
    // assignment, or `Object.assign(this, …)` would slip past. The behavioural
    // cases above are what pin the dedupe itself. Link 5 pins WHERE the shared
    // promise is written, not how often: an extra clear inside getIdToken
    // passes it. A synchronous one is caught behaviourally (the concurrent
    // cases would see a second read); a deferred one would pass both.
    const path = fileURLToPath(new URL('../../../src/core/auth/firebase-auth.ts', import.meta.url));
    // The whole file, not a method-body fragment, so nothing is parsed by
    // error recovery; and with an explicit ScriptKind, like every other
    // direct createSourceFile call in the suite (#799).
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(path)
    );
    let cls: ts.ClassDeclaration | undefined;
    ts.forEachChild(file, (node) => {
      if (ts.isClassDeclaration(node) && node.name?.text === 'FirebaseAuth') cls = node;
    });
    if (cls === undefined) throw new Error('expected a FirebaseAuth class; update this detector');

    /** The class member a node sits in, by name. */
    const memberOf = (node: ts.Node): string => {
      for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
        if (n.parent !== cls) continue;
        if (ts.isConstructorDeclaration(n)) return 'constructor';
        if (ts.isClassElement(n) && n.name !== undefined && ts.isIdentifier(n.name)) {
          return n.name.text;
        }
      }
      // Unreachable while the walk starts at the class: a label for the
      // failure message, not a guard against a real case.
      return '(outside a member)';
    };
    const isThisMember = (node: ts.Node, name?: string): node is ts.PropertyAccessExpression =>
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      (name === undefined || node.name.text === name);
    const isSharedBy = (node: ts.Node): boolean => {
      for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
        const p: ts.Node | undefined = n.parent;
        if (
          p !== undefined &&
          ts.isBinaryExpression(p) &&
          p.right === n &&
          p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken &&
          isThisMember(p.left, 'refreshInFlight')
        ) {
          return true;
        }
      }
      return false;
    };

    const SESSION = new Set(['idToken', 'refreshToken', 'expiresAt', 'userId']);
    const sessionWriters: string[] = [];
    const exchangeRefs: string[] = [];
    const refreshRefs: { member: string; shared: boolean }[] = [];
    const inFlightWriters: string[] = [];
    let getIdTokenAwaits = 0;
    /**
     * Every suspension form, not only `await x`: a `for await` loop and an
     * `await using` declaration suspend too, and neither is an AwaitExpression
     * (#802 review). Checked against a specimen below.
     */
    const suspendsNode = (node: ts.Node): boolean =>
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined) ||
      (ts.isVariableDeclarationList(node) &&
        (node.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.AwaitUsing);
    /** The `this.<field>` a node writes: `=`, compound `op=`, or `++`/`--`. */
    const writtenField = (node: ts.Node): string | undefined => {
      let target: ts.Node | undefined;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        target = node.left;
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        target = node.operand;
      }
      return target !== undefined && isThisMember(target) ? target.name.text : undefined;
    };
    const visit = (node: ts.Node): void => {
      const field = writtenField(node);
      if (field !== undefined && SESSION.has(field)) sessionWriters.push(memberOf(node));
      if (field === 'refreshInFlight') inFlightWriters.push(memberOf(node));
      if (isThisMember(node, 'exchangeToken')) exchangeRefs.push(memberOf(node));
      if (isThisMember(node, 'refreshSession')) {
        refreshRefs.push({ member: memberOf(node), shared: isSharedBy(node) });
      }
      if (suspendsNode(node) && memberOf(node) === 'getIdToken') getIdTokenAwaits += 1;
      ts.forEachChild(node, visit);
    };
    visit(cls);

    // The await count is asserted to be ZERO, so it can have no anti-vacuity
    // partner of its own: a predicate that stopped recognising a form (say
    // `ts.NodeFlags.AwaitUsing` reading undefined after a typescript bump)
    // would look exactly like a method with no suspension points. So the
    // predicate is checked against a specimen: exactly the three suspending
    // forms, and none of their non-suspending look-alikes (#802 review).
    const specimen = ts.createSourceFile(
      'suspension-specimen.ts',
      [
        'async function f(xs: AsyncIterable<number>, r: () => AsyncDisposable & Disposable) {',
        '  await 1;',
        '  for await (const x of xs) void x;',
        '  await using a = r();',
        '  using b = r();',
        '  const c = 1;',
        '  for (const y of [c]) void y;',
        '}',
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    // Recorded by specimen LINE as well as kind: `await using` and `using` are
    // both a VariableDeclarationList, so kind alone could not tell a predicate
    // that tests the AwaitUsing flag from one that tests Using — swapping them
    // stayed green (#805). The line is what names which declaration it saw.
    const recognised: string[] = [];
    const scan = (node: ts.Node): void => {
      if (suspendsNode(node)) {
        const { line } = specimen.getLineAndCharacterOfPosition(node.getStart(specimen));
        recognised.push(`${ts.SyntaxKind[node.kind]}@${String(line + 1)}`);
      }
      ts.forEachChild(node, scan);
    };
    scan(specimen);
    expect(
      recognised.sort(),
      'the suspension predicate must see await (line 2), for await (3) and await using (4), ' +
        'and nothing else — not `using` (5), not a plain for-of (7)'
    ).toEqual(['AwaitExpression@2', 'ForOfStatement@3', 'VariableDeclarationList@4']);

    expect(getIdTokenAwaits, 'getIdToken must not await: join the shared attempt instead').toBe(0);
    expect(refreshRefs, 'refreshSession must only run as the shared refreshInFlight').toEqual([
      { member: 'getIdToken', shared: true },
    ]);
    // Anti-vacuity on both: a rename would otherwise leave nothing to check.
    expect(exchangeRefs.length).toBeGreaterThan(0);
    expect(
      [...new Set(exchangeRefs)],
      'exchangeToken writes the session, so only the shared attempt may call it'
    ).toEqual(['refreshSession']);
    expect(sessionWriters.length).toBeGreaterThan(0);
    expect(
      [...new Set(sessionWriters)],
      'the session is written only by exchangeToken, inside the shared attempt'
    ).toEqual(['exchangeToken']);
    // Both the `??=` and the `.finally` clear sit in getIdToken. A clear
    // anywhere else (a reset(), a logout()) could run while an attempt is
    // suspended and let a second one start beside it.
    expect(inFlightWriters.length).toBeGreaterThan(0);
    expect(
      [...new Set(inFlightWriters)],
      'refreshInFlight may be set and cleared only by getIdToken'
    ).toEqual(['getIdToken']);
  });
});
