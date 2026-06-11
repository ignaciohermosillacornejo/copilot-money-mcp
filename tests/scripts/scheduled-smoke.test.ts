/**
 * Outcome classification for the scheduled drift check (#440). The critical
 * property: auth failures classify as `auth-missing`, never `pass` (absence
 * of auth is not absence of drift) and never `fail` (logged-out is not
 * drift).
 */
import { describe, expect, test } from 'bun:test';
import { classifySmokeOutcome, summarizeSmokeOutput } from '../../scripts/scheduled-smoke.js';

describe('classifySmokeOutcome', () => {
  test('exit 0 is a pass', () => {
    expect(classifySmokeOutcome(0, '[smoke] PASS — all good')).toBe('pass');
  });

  test('nonzero exit with a conformance failure is a fail', () => {
    expect(classifySmokeOutcome(1, '[smoke] FAIL: bogus_value REJECTED by server')).toBe('fail');
  });

  test('no-browser-session output is auth-missing, not fail', () => {
    expect(
      classifySmokeOutcome(1, 'error: No Copilot Money session found. Searched: Chrome, Safari')
    ).toBe('auth-missing');
  });

  test('token-exchange failures are auth-missing (incl. foreign-token #454 case)', () => {
    expect(
      classifySmokeOutcome(
        1,
        'error: Firebase token exchange failed (400): {"error":{"message":"PROJECT_NUMBER_MISMATCH"}}'
      )
    ).toBe('auth-missing');
  });

  test('mid-run session expiry (non-JSON probe response) is auth-missing', () => {
    expect(
      classifySmokeOutcome(
        1,
        'error: validation probe got a non-JSON response (HTTP 401) — likely an expired or unauthenticated session'
      )
    ).toBe('auth-missing');
  });
});

describe('summarizeSmokeOutput', () => {
  test('uses the last [smoke] marker line', () => {
    const out = '[smoke] value ...\n[ledger] distribution ...\n[smoke] PASS — all 3 enums match.';
    expect(summarizeSmokeOutput('pass', out)).toBe('[smoke] PASS — all 3 enums match.');
  });

  test('auth-missing has a fixed actionable summary', () => {
    expect(summarizeSmokeOutput('auth-missing', 'whatever')).toContain('drift NOT checked');
  });
});
