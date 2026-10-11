/**
 * One definition of what a transport timeout or abort looks like, shared by
 * the GraphQL client and the Firebase token exchange (#802).
 *
 * Its own module because of the import direction: `graphql/client.ts` imports
 * `auth/`, so auth cannot import this from the client without a cycle. Two
 * copies coupled only by a comment is the `path-divergence` shape: the next
 * runtime quirk would be fixed in one of them.
 *
 * `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`,
 * and an explicit abort with one named `AbortError`. `DOMException` inherits
 * from `Error`, so the `instanceof` holds for both.
 */
export function isAbortOrTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
