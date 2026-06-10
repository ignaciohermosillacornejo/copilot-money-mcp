/**
 * Transport + auth + error classification for Copilot Money's GraphQL API.
 *
 * Single-op requests (object body, not array). Reuses the existing
 * FirebaseAuth class to mint JWTs. All failure modes surface as a
 * typed GraphQLError with a discriminated `code` field.
 */

import type { FirebaseAuth } from '../auth/firebase-auth.js';

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
  const codes = parsed?.extensionCodes ?? new Set<string>();
  if (status === 401 || codes.has('UNAUTHENTICATED')) return 'AUTH_FAILED';
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
  if (status >= 500) return 'SERVER_ERROR';
  // A 400 without a recognizable extension code is still a parse-time
  // rejection of our request shape.
  if (status === 400) return 'SCHEMA_ERROR';
  return 'UNKNOWN';
}

export class GraphQLError extends Error {
  constructor(
    public readonly code: GraphQLErrorCode,
    message: string,
    public readonly operationName?: string,
    public readonly httpStatus?: number,
    public readonly serverErrors?: unknown
  ) {
    super(message);
    this.name = 'GraphQLError';
  }
}

export class GraphQLClient {
  constructor(private auth: FirebaseAuth) {}

  async mutate<TVariables, TResponse>(
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
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logError(operationName, 'NETWORK', undefined);
      throw new GraphQLError('NETWORK', msg, operationName);
    }

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
        parsed?.raw
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
        response.status
      );
    }

    if (body.errors && body.errors.length > 0) {
      // 2xx + errors[] = a resolver-level rejection (input/ownership/domain).
      // Auth expiry can also surface here as UNAUTHENTICATED with HTTP 200.
      const isAuth = body.errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED');
      const code: GraphQLErrorCode = isAuth ? 'AUTH_FAILED' : 'USER_ACTION_REQUIRED';
      const firstMessage = body.errors[0]?.message ?? 'GraphQL error (no message)';
      this.logError(operationName, code, response.status);
      throw new GraphQLError(
        code,
        truncate(firstMessage),
        operationName,
        response.status,
        body.errors
      );
    }

    if (!body.data) {
      this.logError(operationName, 'UNKNOWN', response.status);
      throw new GraphQLError(
        'UNKNOWN',
        'Response missing data field',
        operationName,
        response.status
      );
    }

    return body.data;
  }

  /**
   * Send a GraphQL query. Same transport, auth, and error classification
   * as mutate(). Semantic alias kept separate so call sites and logs
   * distinguish reads from writes.
   */
  async query<TVariables, TResponse>(
    operationName: string,
    query: string,
    variables: TVariables
  ): Promise<TResponse> {
    return this.mutate<TVariables, TResponse>(operationName, query, variables);
  }

  private logError(operationName: string, code: GraphQLErrorCode, httpStatus?: number): void {
    const statusPart = httpStatus !== undefined ? ` status=${httpStatus}` : '';
    console.error(`[graphql] ${operationName} failed: code=${code}${statusPart}`);
  }
}
