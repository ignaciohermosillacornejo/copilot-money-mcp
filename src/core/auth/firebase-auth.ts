/**
 * Firebase Auth token exchange and caching.
 *
 * Exchanges a Firebase refresh token for an ID token using the
 * Firebase Auth REST API. Caches the token in memory and auto-refreshes
 * when expired (3600 second lifetime).
 */

import {
  dedupeByToken,
  noCopilotSessionError,
  orderByProvenance,
  type TokenCandidates,
  type TokenResult,
} from './browser-token.js';

// Public client-side Firebase Web API key for copilot-production-22904 — intentionally
// not a secret. Scoped by Firebase security rules; safe to commit.
// Note: this is the *web platform* key (from app.copilot.money), not the iOS key.
const FIREBASE_API_KEY = 'AIzaSyAMgjkeOSkHj4J4rlswOkD16N3WQOoNPpk';
const TOKEN_ENDPOINT = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Upper bound on how many discovered refresh-token candidates we'll try to
 * exchange. A normal browser has a handful of Firebase-backed sites; this caps
 * the pathological case (many `AMf-` tokens in the browser-wide Local Storage
 * read) so a logged-out user can't trigger an unbounded run of sequential
 * token exchanges.
 *
 * The bound is only SAFE because `selectExchangeCandidates` spends it
 * Copilot-scoped-first (issue #722). A cap applied to an arbitrarily-ordered
 * list is finite but not safe: it can discard the one candidate that would
 * have worked, and the user is then told to log in while already logged in.
 * Ordering is what makes discarding harmless — everything the cap drops came
 * from a store every site writes to.
 */
export const MAX_EXCHANGE_CANDIDATES = 10;

/**
 * Securetoken rejection code returned when a refresh token belongs to a
 * DIFFERENT Firebase project than copilot-production-22904. The browser-wide
 * Local Storage read surfaces other sites' `AMf-` tokens as candidates, so
 * this is the expected, benign signal that "this candidate is foreign — try
 * the next one," NOT an API/key drift. See issue #454.
 */
const PROJECT_NUMBER_MISMATCH = 'PROJECT_NUMBER_MISMATCH';

/**
 * A securetoken exchange that came back non-OK, carrying the HTTP status so
 * the candidate loop can tell "this CANDIDATE is no good" from "the ENDPOINT
 * is no good". `isCandidateRejection` below draws that line — not simply at
 * 4xx, because 429 sits on the endpoint's side of it — and anything that never
 * produced a response at all (DNS, TLS, offline) never becomes one of these.
 * The message is byte-identical to what the previous plain Error threw, so
 * callers matching on it are unaffected.
 */
class TokenExchangeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TokenExchangeError';
    this.status = status;
  }
}

/**
 * Order the discovered candidates the way the budget must be spent, then cap.
 *
 * Why the ordering AND the de-duplication are re-applied here rather than
 * trusted from the extractor: the cap lives in THIS file, `TokenExtractor` is
 * an injected function, and a bound whose safety depends on a collaborator
 * having sorted — or collapsed duplicates — first is a bound that silently
 * stops being safe the day someone writes a second extractor. Ten sightings of
 * one token starve a valid candidate behind them exactly the way ten foreign
 * tokens did; it is the same class with a cheaper cause. The extractor applies
 * both too, because its own single-candidate wrapper needs them; calling the
 * same two helpers is what keeps the definitions from drifting apart while
 * staying independently applied.
 *
 * The cap stays GLOBAL rather than per-source on purpose (issue #722). With
 * scoped candidates already holding the first slots, a per-source budget could
 * not improve their chances — its only effect would be to let more browser-wide
 * tokens, i.e. other sites' tokens, reach Google's endpoint. See PRIVACY.md.
 */
function selectExchangeCandidates(candidates: readonly TokenResult[]): TokenResult[] {
  return orderByProvenance(dedupeByToken(candidates)).slice(0, MAX_EXCHANGE_CANDIDATES);
}

/**
 * Yields the discovered refresh-token candidates (each potentially from a
 * foreign Firebase project) plus the browsers searched, so the caller can try
 * each in turn and build the actionable "no session" error if all fail.
 */
export type TokenExtractor = () => Promise<TokenCandidates>;

export class FirebaseAuth {
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;
  private expiresAt: number = 0;
  private extractToken: TokenExtractor;
  private uidTransitionListener: ((prevUid: string, newUid: string) => void) | null = null;

  constructor(extractToken: TokenExtractor) {
    this.extractToken = extractToken;
  }

  async getIdToken(): Promise<string> {
    if (this.idToken && Date.now() < this.expiresAt) {
      return this.idToken;
    }
    // Fast path: we already hold a Copilot-project refresh token (from a prior
    // successful exchange) — just refresh it. The server-returned refresh token
    // is known-good, so any failure here is a genuine error, not a foreign one.
    if (this.refreshToken) {
      await this.exchangeToken(this.refreshToken);
      if (!this.idToken) throw new Error('Firebase token exchange returned no ID token');
      return this.idToken;
    }

    // Cold path: try each discovered candidate, discarding the ones the
    // endpoint rejects and keeping the first that exchanges cleanly.
    const { candidates, checked } = await this.extractToken();
    // A rejection that was NOT "this token is foreign" — kept so it can be
    // surfaced if nothing else works, instead of being flattened into the
    // "you are logged out" message it may well contradict.
    let firstUnexplainedRejection: TokenExchangeError | null = null;

    for (const candidate of selectExchangeCandidates(candidates)) {
      try {
        await this.exchangeToken(candidate.token);
      } catch (err) {
        // The endpoint, our API key, or the network is the problem — not this
        // candidate. Retrying nine more times would only hammer it and bury
        // the cause behind an unactionable message.
        if (!isCandidateRejection(err)) throw err;
        // Any 4xx is about THIS candidate, so keep going. A non-mismatch code
        // does not mean the token was Copilot's: candidates are scraped out of
        // raw LevelDB bytes, so a truncated `AMf-…` match is INVALID_REFRESH_TOKEN
        // no matter whose storage it came from (probed for #722 — see the
        // `Securetoken.v1Token:invalidCandidate` ledger entry). Letting one of
        // those abort the run is the same crowding-out bug by another door — a
        // foreign candidate ending the search for a real session.
        //
        // And by the same argument such a rejection is only worth REPORTING
        // when the candidate was Copilot-scoped. From a browser-wide store it
        // says nothing about Copilot, so surfacing it would swap the
        // actionable "log in" message for a raw Firebase 400 — #722's symptom
        // again, arrived at from the other side.
        if (candidate.scoped && !isForeignProjectError(err) && firstUnexplainedRejection === null) {
          firstUnexplainedRejection = err;
        }
        continue;
      }
      if (!this.idToken) throw new Error('Firebase token exchange returned no ID token');
      return this.idToken;
    }

    // Nothing exchanged. If a candidate from COPILOT'S OWN store failed for a
    // reason we cannot explain as "that one was foreign" — expired, revoked —
    // that reason is the more informative error, and telling the user to log
    // in would contradict evidence we hold. Surface it raw.
    if (firstUnexplainedRejection) throw firstUnexplainedRejection;

    // Every candidate was foreign-project (or none were found): the user is
    // logged out. Surface the actionable message, never a raw Firebase 400.
    throw noCopilotSessionError(checked);
  }

  getUserId(): string | null {
    return this.userId;
  }

  /**
   * Register the single subscriber fired when a token exchange lands on a
   * DIFFERENT non-null uid than the previous one — a mid-session re-auth as
   * another account (refresh failure → cold re-extract picking up another
   * browser login, #521). Fires AFTER the new auth state is fully installed.
   * Listener exceptions are swallowed: a subscriber must never be able to
   * break the token exchange.
   */
  setUidTransitionListener(listener: (prevUid: string, newUid: string) => void): void {
    this.uidTransitionListener = listener;
  }

  private async exchangeToken(refreshToken: string): Promise<void> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.refreshToken = null;
      throw new TokenExchangeError(
        response.status,
        `Firebase token exchange failed (${response.status}): ${errorBody}`
      );
    }

    const data = (await response.json()) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
      user_id: string;
    };

    const prevUid = this.userId;
    this.idToken = data.id_token;
    this.refreshToken = data.refresh_token;
    this.userId = data.user_id;
    this.expiresAt = Date.now() + Number(data.expires_in) * 1000 - EXPIRY_MARGIN_MS;

    // Identity can only change here — userId is assigned nowhere else — so
    // this is THE chokepoint for the mid-session re-auth sweep (#521).
    // `data.user_id &&` is an empty-string drift guard, not type noise: a
    // drifted "" must not fire the listener with a bogus uid pair.
    if (prevUid !== null && data.user_id && prevUid !== data.user_id) {
      try {
        this.uidTransitionListener?.(prevUid, data.user_id);
      } catch {
        // Subscriber failures must not break the exchange.
      }
    }
  }
}

/**
 * True when a token-exchange error is a PROJECT_NUMBER_MISMATCH — i.e. the
 * refresh token belongs to a foreign Firebase project, not
 * copilot-production-22904. Such a candidate should be discarded so the loop
 * can try the next one, rather than failing the whole exchange.
 */
function isForeignProjectError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(PROJECT_NUMBER_MISMATCH);
}

/**
 * 4xx statuses that are about the CALLER or the API, never about the candidate.
 *
 * - `429` — rate limit / quota. Google returns it for `RESOURCE_EXHAUSTED`,
 *   Firebase Auth for `TOO_MANY_ATTEMPTS_TRY_LATER`.
 * - `403` — no usable API identity. Probed for #722: a request with no key at
 *   all returns `403 PERMISSION_DENIED`, and key restrictions (referrer, IP,
 *   service-disabled) land here too. Securetoken's per-token verdicts —
 *   `INVALID_REFRESH_TOKEN`, `TOKEN_EXPIRED`, `USER_DISABLED`,
 *   `PROJECT_NUMBER_MISMATCH` — are all 400s, so nothing about a candidate
 *   arrives as a 403.
 */
const ENDPOINT_LEVEL_STATUSES: readonly number[] = [403, 429];

/**
 * Error reasons that make a **400** a statement about our own API key rather
 * than about the token we sent with it.
 *
 * `FIREBASE_API_KEY` is hardcoded in this file, so "the key stopped working"
 * is a real operational state, not a hypothetical — and probed for #722, an
 * invalid key comes back `400` with `"reason": "API_KEY_INVALID"`, the same
 * status a bad refresh token uses. Status alone therefore cannot separate
 * them; the body has to. Same shape as `isForeignProjectError`, for the same
 * reason: securetoken encodes the distinction we need in the message, not the
 * status line.
 *
 * Rejected alternative: infer it from every candidate having failed with the
 * byte-identical message. That misfires on the population this whole change
 * exists to protect — a genuinely logged-out user's candidates are ALL
 * `INVALID_REFRESH_TOKEN` with identical bodies, and they would then be shown
 * a raw 400 instead of "log in".
 */
const ENDPOINT_LEVEL_ERROR_CODES: readonly string[] = [
  'API_KEY_INVALID',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
  'SERVICE_DISABLED',
];

/**
 * True when an exchange failure is a verdict on the CANDIDATE rather than on
 * the endpoint, our API key, or the network. Only these are safe to skip past:
 * everything else says nothing about the token, and trying the rest of the
 * list would turn one outage into ten requests and bury the real error behind
 * "No Copilot Money session found" — a message naming an action that cannot
 * help.
 */
function isCandidateRejection(err: unknown): err is TokenExchangeError {
  if (!(err instanceof TokenExchangeError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  if (ENDPOINT_LEVEL_STATUSES.includes(err.status)) return false;
  return !ENDPOINT_LEVEL_ERROR_CODES.some((code) => err.message.includes(code));
}
