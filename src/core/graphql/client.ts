/**
 * Transport + auth + error classification for Copilot Money's GraphQL API.
 *
 * Single-op requests (object body, not array). Reuses the existing
 * FirebaseAuth class to mint JWTs. All failure modes surface as a
 * typed GraphQLError with a discriminated `code` field.
 *
 * Retry policy (issue #443): bounded exponential backoff for
 * TRANSPORT-level failures only — never for GraphQL-level errors.
 *  - Queries are idempotent → retry fetch rejections, timeouts, and 5xx
 *    responses that carry no GraphQL error body.
 *  - Mutations retry ONLY when the request provably never reached the
 *    server (connection refused / DNS failure before send). A timeout or
 *    mid-flight reset after send is ambiguous — the write may have
 *    executed — so it surfaces immediately with `writeMayHaveApplied`.
 */

import type { FirebaseAuth } from '../auth/firebase-auth.js';
import { validateMutationResponse } from './response-validation.js';

const ENDPOINT = 'https://app.copilot.money/api/graphql';

export type GraphQLErrorCode =
  | 'AUTH_FAILED'
  | 'SCHEMA_ERROR'
  | 'USER_ACTION_REQUIRED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'UNKNOWN';

/** Cap on how much raw server text we embed in error messages. */
const MAX_SERVER_TEXT = 600;

function truncate(text: string): string {
  return text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)}… [truncated]` : text;
}

interface ParsedErrorBody {
  messages: string[];
  extensionCodes: Set<string>;
  raw: unknown;
}

/**
 * Parse a GraphQL error response body (`{ errors: [...] }`) if possible.
 * Returns undefined for non-JSON bodies or bodies without an errors array.
 */
function parseErrorBody(text: string): ParsedErrorBody | undefined {
  try {
    const json = JSON.parse(text) as {
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
    };
    if (!json || !Array.isArray(json.errors) || json.errors.length === 0) return undefined;
    return {
      messages: json.errors
        .map((e) => e?.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
      extensionCodes: new Set(
        json.errors
          .map((e) => e?.extensions?.code)
          .filter((c): c is string => typeof c === 'string')
      ),
      raw: json.errors,
    };
  } catch {
    return undefined;
  }
}

/**
 * Classify by Apollo `errors[].extensions.code` alone (shared by the non-2xx
 * and 2xx-with-errors[] paths). Returns undefined when no recognizable code
 * is present so callers can apply their own status-based fallback.
 *
 * Priority is intentional: auth first, then ownership/resource errors
 * (USER_ACTION_REQUIRED) BEFORE schema codes — if a response carries both,
 * the ownership error is the one the user/agent can act on, while the schema
 * code on the same response is usually downstream noise. Don't reorder.
 */
function classifyExtensionCodes(codes: Set<string>): GraphQLErrorCode | undefined {
  if (codes.has('UNAUTHENTICATED')) return 'AUTH_FAILED';
  if (codes.has('FORBIDDEN') || codes.has('NOT_FOUND')) return 'USER_ACTION_REQUIRED';
  if (
    codes.has('GRAPHQL_PARSE_FAILED') ||
    codes.has('GRAPHQL_VALIDATION_FAILED') ||
    codes.has('BAD_USER_INPUT') ||
    codes.has('PERSISTED_QUERY_NOT_FOUND') ||
    codes.has('PERSISTED_QUERY_NOT_SUPPORTED') ||
    codes.has('OPERATION_RESOLUTION_FAILURE')
  ) {
    return 'SCHEMA_ERROR';
  }
  return undefined;
}

/**
 * Classify a non-2xx response by CONTENT (Apollo `errors[].extensions.code`)
 * first, falling back to HTTP status. This is what attributes failures
 * correctly:
 *  - parse/validation/coercion rejections → SCHEMA_ERROR (OUR request shape
 *    or enum model doesn't match the server schema — a client-side bug)
 *  - ownership / resource errors → USER_ACTION_REQUIRED (server rejected
 *    the request for reasons the user/agent can act on)
 *  - auth → AUTH_FAILED; 5xx → SERVER_ERROR (possibly transient)
 */
function classifyHttpError(status: number, parsed?: ParsedErrorBody): GraphQLErrorCode {
  if (status === 401) return 'AUTH_FAILED';
  const fromCodes = classifyExtensionCodes(parsed?.extensionCodes ?? new Set<string>());
  if (fromCodes) return fromCodes;
  if (status >= 500) return 'SERVER_ERROR';
  // A 400 without a recognizable extension code is still a parse-time
  // rejection of our request shape.
  if (status === 400) return 'SCHEMA_ERROR';
  return 'UNKNOWN';
}

export interface GraphQLErrorMeta {
  /**
   * Three-state delivery evidence:
   *  - true       → an HTTP response arrived, so the request definitely
   *                 reached the server
   *  - false      → the failure provably happened before send (connection
   *                 refused, DNS failure) — the server never saw it
   *  - undefined  → ambiguous (timeout, mid-flight reset); the request may
   *                 or may not have been processed
   * This is what makes mutation retries safe: only `false` is retryable.
   */
  requestReachedServer?: boolean;
  /**
   * Set on mutation failures where the write may have executed server-side
   * (ambiguous transport failure or 5xx). Callers must verify state before
   * retrying.
   */
  writeMayHaveApplied?: boolean;
  /** Total attempts made before this error surfaced (≥ 1). */
  attempts?: number;
}

export class GraphQLError extends Error {
  public readonly requestReachedServer?: boolean;
  public readonly writeMayHaveApplied: boolean;
  public readonly attempts: number;

  constructor(
    public readonly code: GraphQLErrorCode,
    message: string,
    public readonly operationName?: string,
    public readonly httpStatus?: number,
    public readonly serverErrors?: unknown,
    meta: GraphQLErrorMeta = {}
  ) {
    super(message);
    this.name = 'GraphQLError';
    this.requestReachedServer = meta.requestReachedServer;
    this.writeMayHaveApplied = meta.writeMayHaveApplied ?? false;
    this.attempts = meta.attempts ?? 1;
  }
}

// ── Retry / timeout configuration ───────────────────────────────────────────

export interface GraphQLClientOptions {
  /**
   * Per-attempt timeout in ms (default 30s). Pass 0 or Infinity to disable.
   * A timed-out QUERY is retried; a timed-out MUTATION is NOT (ambiguous —
   * the request may have been sent).
   */
  timeoutMs?: number;
  /**
   * Backoff delays between attempts in ms. Length = max retries, so the
   * default allows 4 total attempts. Pass [] to disable retries.
   */
  retryDelaysMs?: readonly number[];
  /** Max random jitter in ms added to each backoff delay (default 250). */
  jitterMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 4_000];
export const DEFAULT_JITTER_MS = 250;

/**
 * Error codes (anywhere in the fetch rejection's `cause` chain) that prove
 * the request never reached the server: TCP connect refused, DNS resolution
 * failure, or no network route. Deliberately EXCLUDES ambiguous codes like
 * ECONNRESET / EPIPE / ETIMEDOUT, which can fire after the request bytes
 * were already on the wire. Unknown codes default to "not provably unsent"
 * (the conservative direction for mutation safety).
 */
const PROVABLY_UNSENT_CODES: ReadonlySet<string> = new Set([
  // Node / undici system error codes
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  // Bun fetch error codes
  'ConnectionRefused',
  'FailedToOpenSocket',
  'DNSResolveFailed',
]);

function isProvablyUnsent(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && PROVABLY_UNSENT_CODES.has(code)) return true;
    const cause = (current as Error & { cause?: unknown }).cause;
    // Some runtimes only embed the errno string in the message
    // (e.g. "connect ECONNREFUSED 127.0.0.1:443"). Scan only the INNERMOST
    // error: a wrapper whose message merely quotes a code string (log
    // fragment, stringified cause) must not flag an ambiguous mutation
    // failure as provably unsent — a false positive here re-sends a write.
    if (cause == null) {
      for (const known of PROVABLY_UNSENT_CODES) {
        if (current.message.includes(known)) return true;
      }
    }
    current = cause;
  }
  return false;
}

function isAbortOrTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RequestKind = 'query' | 'mutation';

/**
 * Whether a failed attempt is safe to retry.
 *  - Queries are idempotent: any transport-level failure (fetch rejection,
 *    timeout, 5xx with no GraphQL error body) is retryable. GraphQL-level
 *    errors (schema/auth/ownership, or 5xx that carries an errors[] body)
 *    are deterministic — never retried.
 *  - Mutations: only when the request provably never reached the server.
 */
function isRetryable(e: GraphQLError, kind: RequestKind): boolean {
  if (kind === 'mutation') return e.requestReachedServer === false;
  if (e.code === 'NETWORK') return true;
  if (e.code === 'SERVER_ERROR' && e.serverErrors === undefined) return true;
  return false;
}

export class GraphQLClient {
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly jitterMs: number;

  constructor(
    private auth: FirebaseAuth,
    opts: GraphQLClientOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;
  }

  async mutate<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    return this.request<TVariables, TResponse>('mutation', operationName, query, variables);
  }

  /**
   * Send a GraphQL query. Same transport, auth, and error classification
   * as mutate(), but with the broader (idempotent-safe) retry policy.
   */
  async query<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    return this.request<TVariables, TResponse>('query', operationName, query, variables);
  }

  private async request<TVariables, TResponse>(
    kind: RequestKind,
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    const maxAttempts = this.retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await this.requestOnce<TVariables, TResponse>(operationName, query, variables);
        // Warn-mode response-shape validation (issue #437): logs + counts
        // drift against the registered Zod schema, never throws, never
        // alters the payload. Mutations only — live-read queries have their
        // own response handling.
        if (kind === 'mutation') validateMutationResponse(operationName, data);
        return data;
      } catch (e) {
        if (!(e instanceof GraphQLError)) throw e;
        if (attempt >= maxAttempts || !isRetryable(e, kind)) {
          throw this.finalize(e, kind, attempt);
        }
        const delayMs =
          (this.retryDelaysMs[attempt - 1] ?? 0) + Math.floor(Math.random() * this.jitterMs);
        console.error(
          `[graphql] ${operationName} attempt ${attempt}/${maxAttempts} failed (code=${e.code}) — retrying in ${delayMs}ms`
        );
        await sleep(delayMs);
      }
    }
  }

  /**
   * Annotate the final error with attempt count and — for mutations whose
   * failure does not prove the request went unprocessed — the
   * `writeMayHaveApplied` flag so callers verify state before retrying.
   */
  private finalize(e: GraphQLError, kind: RequestKind, attempts: number): GraphQLError {
    const writeMayHaveApplied =
      kind === 'mutation' &&
      e.requestReachedServer !== false &&
      (e.code === 'NETWORK' || e.code === 'SERVER_ERROR');
    if (attempts === e.attempts && writeMayHaveApplied === e.writeMayHaveApplied) return e;
    return new GraphQLError(e.code, e.message, e.operationName, e.httpStatus, e.serverErrors, {
      requestReachedServer: e.requestReachedServer,
      writeMayHaveApplied,
      attempts,
    });
  }

  private async requestOnce<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    const idToken = await this.auth.getIdToken();

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operationName, query, variables }),
        signal:
          Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
            ? AbortSignal.timeout(this.timeoutMs)
            : undefined,
      });
    } catch (e) {
      const timedOut = isAbortOrTimeout(e);
      const msg = timedOut
        ? `request timed out after ${this.timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
      this.logError(operationName, 'NETWORK', undefined);
      throw new GraphQLError('NETWORK', msg, operationName, undefined, undefined, {
        // A timeout may have fired after the request was sent → ambiguous
        // (undefined). Only pre-connection failures are provably unsent.
        requestReachedServer: !timedOut && isProvablyUnsent(e) ? false : undefined,
      });
    }

    // From here on an HTTP response exists, so the request reached the server.
    const reached: GraphQLErrorMeta = { requestReachedServer: true };

    // Classify HTTP-level failures by body CONTENT first, status as fallback,
    // and always carry the server's raw error text (truncated) in the message.
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const parsed = parseErrorBody(text);
      const code = classifyHttpError(response.status, parsed);
      const serverSaid =
        parsed && parsed.messages.length > 0 ? parsed.messages.join(' | ') : text || 'no body';
      this.logError(operationName, code, response.status);
      throw new GraphQLError(
        code,
        `${response.status}: ${truncate(serverSaid)}`,
        operationName,
        response.status,
        parsed?.raw,
        reached
      );
    }

    let body: {
      data?: TResponse;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(operationName, 'UNKNOWN', response.status);
      throw new GraphQLError(
        'UNKNOWN',
        `Invalid JSON response: ${msg}`,
        operationName,
        response.status,
        undefined,
        reached
      );
    }

    if (body.errors && body.errors.length > 0) {
      // 2xx + errors[] is usually a resolver-level rejection
      // (input/ownership/domain) → USER_ACTION_REQUIRED, but extension codes
      // still win when present: auth expiry surfaces as UNAUTHENTICATED with
      // HTTP 200, and a spec-legal 200 + GRAPHQL_VALIDATION_FAILED is still
      // a schema mismatch on our side.
      const extensionCodes = new Set(
        body.errors.map((e) => e.extensions?.code).filter((c): c is string => typeof c === 'string')
      );
      const code: GraphQLErrorCode =
        classifyExtensionCodes(extensionCodes) ?? 'USER_ACTION_REQUIRED';
      const firstMessage = body.errors[0]?.message ?? 'GraphQL error (no message)';
      this.logError(operationName, code, response.status);
      throw new GraphQLError(
        code,
        truncate(firstMessage),
        operationName,
        response.status,
        body.errors,
        reached
      );
    }

    if (!body.data) {
      this.logError(operationName, 'UNKNOWN', response.status);
      throw new GraphQLError(
        'UNKNOWN',
        'Response missing data field',
        operationName,
        response.status,
        undefined,
        reached
      );
    }

    return body.data;
  }

  private logError(operationName: string, code: GraphQLErrorCode, httpStatus?: number): void {
    const statusPart = httpStatus !== undefined ? ` status=${httpStatus}` : '';
    console.error(`[graphql] ${operationName} failed: code=${code}${statusPart}`);
  }
}
