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

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractRefreshTokenCandidates,
  getChromiumProfileStoragePaths,
  isCopilotScopedPath,
  type BrowserConfig,
  type TokenResult,
} from '../../../src/core/auth/browser-token.js';
import { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

/** The cap under test, mirrored from src/core/auth/firebase-auth.ts. */
const MAX_EXCHANGE_CANDIDATES = 10;

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
  }) as typeof fetch;
}

const FOREIGN_REJECTION: [object, number] = [
  { error: { message: 'PROJECT_NUMBER_MISMATCH' } },
  400,
];

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
    ['a refused request', { error: { message: 'PERMISSION_DENIED' } }, 403],
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

  test('an unexplained rejection is surfaced rather than flattened into "log in"', async () => {
    // Nothing worked and one candidate failed for a reason we cannot explain
    // as "that one was foreign" — asserting the user is logged out would be a
    // guess that contradicts the evidence.
    const candidates = [
      candidate(syntheticToken('foreign0'), false),
      candidate(syntheticToken('foreign1'), false),
    ];
    const attempts: string[] = [];
    mockExchange(attempts, [{ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400]);
    const auth = new FirebaseAuth(() => Promise.resolve({ candidates, checked: ['Chrome'] }));

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed (400)');
    expect(attempts).toHaveLength(2);
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
