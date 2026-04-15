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
  | 'NETWORK'
  | 'UNKNOWN';

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

    // Classify HTTP-level failures BEFORE parsing body (body may not be JSON).
    if (response.status === 401) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'AUTH_FAILED', 401);
      throw new GraphQLError(
        'AUTH_FAILED',
        `401 Unauthorized: ${text || 'no body'}`,
        operationName,
        401
      );
    }
    if (response.status === 500) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'SCHEMA_ERROR', 500);
      throw new GraphQLError(
        'SCHEMA_ERROR',
        `500 Server Error: ${text || 'no body'}`,
        operationName,
        500
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logError(operationName, 'UNKNOWN', response.status);
      throw new GraphQLError(
        'UNKNOWN',
        `${response.status}: ${text || 'no body'}`,
        operationName,
        response.status
      );
    }

    const body = (await response.json()) as {
      data?: TResponse;
      errors?: Array<{ message: string }>;
    };

    if (body.errors && body.errors.length > 0) {
      const firstMessage = body.errors[0]?.message ?? 'GraphQL error (no message)';
      this.logError(operationName, 'USER_ACTION_REQUIRED', response.status);
      throw new GraphQLError(
        'USER_ACTION_REQUIRED',
        firstMessage,
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

  private logError(operationName: string, code: GraphQLErrorCode, httpStatus?: number): void {
    const statusPart = httpStatus !== undefined ? ` status=${httpStatus}` : '';
    console.error(`[graphql] ${operationName} failed: code=${code}${statusPart}`);
  }
}
