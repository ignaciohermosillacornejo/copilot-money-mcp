/**
 * The classified error every GraphQL failure surfaces as, and
 * {@link committedPayload}, the read every mutation wrapper makes of its
 * payload. Dependency-free on purpose: client.ts re-exports all of it, and the
 * wrappers import it from here, because client.ts's response validation
 * imports the wrappers' modules (an import cycle otherwise).
 */

export type GraphQLErrorCode =
  'AUTH_FAILED' | 'SCHEMA_ERROR' | 'USER_ACTION_REQUIRED' | 'SERVER_ERROR' | 'NETWORK' | 'UNKNOWN';

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
  /**
   * Set when the write should be TREATED AS POSSIBLY APPLIED, more strongly
   * than `writeMayHaveApplied` alone: the server answered the mutation with no
   * `errors`, and only the payload it returned was unusable (see
   * {@link committedPayload}). That this means the write landed is an
   * unverified inference (ledger: {@link MUTATION_NULL_PAYLOAD_SURFACE}) —
   * GraphQL can null a field for other reasons. Implies `writeMayHaveApplied`.
   * Callers act as if it landed wherever that is the safe direction: record
   * what the write would make true (a split parent, so a delete is refused)
   * and drop the caches it touched rather than patch them from a row they do
   * not have — both harmless if it did not land.
   */
  writeApplied?: boolean;
  /** Total attempts made before this error surfaced (≥ 1). */
  attempts?: number;
  /**
   * The transport error this one replaces, kept as the standard `Error.cause`
   * (a timeout's `TimeoutError`, a socket reset). The message is rewritten for
   * the caller; the original is what someone debugging needs, and the auth
   * side's timeout already keeps it (#805).
   */
  cause?: unknown;
}

export class GraphQLError extends Error {
  public readonly requestReachedServer?: boolean;
  public readonly writeMayHaveApplied: boolean;
  public readonly writeApplied: boolean;
  public readonly attempts: number;

  constructor(
    public readonly code: GraphQLErrorCode,
    message: string,
    public readonly operationName?: string,
    public readonly httpStatus?: number,
    public readonly serverErrors?: unknown,
    meta: GraphQLErrorMeta = {}
  ) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
    this.name = 'GraphQLError';
    this.requestReachedServer = meta.requestReachedServer;
    this.writeApplied = meta.writeApplied ?? false;
    this.writeMayHaveApplied = this.writeApplied || (meta.writeMayHaveApplied ?? false);
    this.attempts = meta.attempts ?? 1;
  }
}

/**
 * Ledger surface for the assumption {@link committedPayload} rests on: a
 * mutation answered with no `errors` but a null or non-object payload has
 * probably been applied.
 */
export const MUTATION_NULL_PAYLOAD_SURFACE = 'Mutation.*:null-payload-means-applied' as const;

/**
 * The object a mutation returned at `path`, or a classified error saying the
 * write has probably landed (#875).
 *
 * By the time a wrapper reads its payload the server has answered without
 * `errors`, so the write has most likely committed — an inference, not an
 * observation ({@link MUTATION_NULL_PAYLOAD_SURFACE}, `unverified`): GraphQL
 * can also null a field for reasons that do not imply a commit. Response
 * validation is warn-only, so a drifted response can carry `null` (or
 * nothing) where the payload belongs; a wrapper that dereferenced it would
 * throw a bare TypeError, which says nothing about the write and skips
 * whatever the caller does on a classified failure. Every mutation wrapper
 * that reads into its payload goes through here instead
 * (tests/core/graphql/mutation-payload.test.ts walks them). The error is
 * marked `writeApplied` — treat as possibly applied — and its message asks
 * the user to confirm before retrying. It names the path and the kind of
 * value, never the value.
 */
export function committedPayload<T>(operationName: string, value: unknown, path: string): T {
  // mutation-guard: a committed write's unusable payload is classified as applied
  if (value !== null && typeof value === 'object') return value as T;
  const got = value === null ? 'null' : value === undefined ? 'missing' : `a ${typeof value}`;
  throw new GraphQLError(
    'UNKNOWN',
    `Copilot accepted ${operationName} without errors but returned no ${path} (it was ` +
      `${got}), so the write has PROBABLY landed. Re-read the entity to confirm before ` +
      'retrying — retrying a create could duplicate it.',
    operationName,
    undefined,
    undefined,
    { requestReachedServer: true, writeApplied: true }
  );
}
