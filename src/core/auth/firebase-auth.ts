/**
 * Firebase Auth token exchange and caching.
 *
 * Exchanges a Firebase refresh token for an ID token using the
 * Firebase Auth REST API. Caches the token in memory and auto-refreshes
 * when expired (3600 second lifetime).
 */

import type { TokenResult } from './browser-token.js';

const FIREBASE_API_KEY = 'AIzaSyBi2Ht5k9K94Yi6McMSGyKeOcHC7vEsN_I';
const TOKEN_ENDPOINT = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;
const EXPIRY_MARGIN_MS = 60_000;

export type TokenExtractor = () => Promise<TokenResult>;

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
    if (!this.refreshToken) {
      const result = await this.extractToken();
      this.refreshToken = result.token;
    }
    await this.exchangeToken();
    if (!this.idToken) throw new Error('Firebase token exchange returned no ID token');
    return this.idToken;
  }

  getUserId(): string | null {
    return this.userId;
  }

  private async exchangeToken(): Promise<void> {
    const refreshToken = this.refreshToken ?? '';
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
