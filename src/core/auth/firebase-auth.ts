/**
 * Firebase Auth token exchange and caching.
 *
 * Exchanges a Firebase refresh token for an ID token using the
 * Firebase Auth REST API. Caches the token in memory and auto-refreshes
 * when expired (3600 second lifetime).
 */

import { noCopilotSessionError, type TokenCandidates } from './browser-token.js';

// Public client-side Firebase Web API key for copilot-production-22904 — intentionally
// not a secret. Scoped by Firebase security rules; safe to commit.
// Note: this is the *web platform* key (from app.copilot.money), not the iOS key.
const FIREBASE_API_KEY = 'AIzaSyAMgjkeOSkHj4J4rlswOkD16N3WQOoNPpk';
const TOKEN_ENDPOINT = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Upper bound on how many discovered refresh-token candidates we'll try to
 * exchange. A normal browser has a handful of Firebase-backed sites; this caps
 * the pathological case (many `AMf-` tokens in the Local Storage fallback) so a
 * logged-out user can't trigger an unbounded run of sequential token exchanges.
 */
const MAX_EXCHANGE_CANDIDATES = 10;

/**
 * Securetoken rejection code returned when a refresh token belongs to a
 * DIFFERENT Firebase project than copilot-production-22904. The browser-wide
 * Local Storage fallback surfaces other sites' `AMf-` tokens as candidates, so
 * this is the expected, benign signal that "this candidate is foreign — try
 * the next one," NOT an API/key drift. See issue #454.
 */
const PROJECT_NUMBER_MISMATCH = 'PROJECT_NUMBER_MISMATCH';

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

    // Cold path: try each discovered candidate, discarding foreign-project ones
    // (PROJECT_NUMBER_MISMATCH) and keeping the first that exchanges cleanly.
    const { candidates, checked } = await this.extractToken();
    for (const candidate of candidates.slice(0, MAX_EXCHANGE_CANDIDATES)) {
      try {
        await this.exchangeToken(candidate.token);
      } catch (err) {
        if (isForeignProjectError(err)) continue; // not Copilot's token — try next
        throw err; // a real exchange failure for a Copilot-project token
      }
      if (!this.idToken) throw new Error('Firebase token exchange returned no ID token');
      return this.idToken;
    }

    // No candidate belonged to Copilot's project (or none were found): the user
    // is logged out. Surface the actionable message, never a raw Firebase 400.
    throw noCopilotSessionError(checked);
  }

  getUserId(): string | null {
    return this.userId;
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
      throw new Error(`Firebase token exchange failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
      user_id: string;
    };

    this.idToken = data.id_token;
    this.refreshToken = data.refresh_token;
    this.userId = data.user_id;
    this.expiresAt = Date.now() + Number(data.expires_in) * 1000 - EXPIRY_MARGIN_MS;
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
