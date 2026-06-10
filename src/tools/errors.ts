import { GraphQLError } from '../core/graphql/client.js';

/**
 * Appended when a mutation failed in a way that does not prove the write
 * went unprocessed (timeout after send, mid-flight reset, 5xx). The client
 * never auto-retries these (issue #443); the caller must verify first.
 */
const WRITE_AMBIGUITY_WARNING =
  'WARNING: this was a write and it may or may not have applied on the server — ' +
  'verify the current state (re-read the entity) before retrying.';

/** "after N attempts" fragment when the client already retried (issue #443). */
function attemptsNote(e: GraphQLError): string {
  return e.attempts > 1 ? ` after ${e.attempts} attempts` : '';
}

/**
 * Map a classified GraphQLError to a user-facing message with the RIGHT
 * attribution (issue #441):
 *  - SCHEMA_ERROR        → this tool's model of the API may be outdated
 *  - USER_ACTION_REQUIRED → the server rejected the request (server's reason)
 *  - NETWORK             → transient, retry
 *
 * Every branch surfaces the server's raw error text (already truncated by the
 * GraphQL client) so failures are diagnosable without re-running with logging.
 */
export function graphQLErrorToMcpError(e: GraphQLError): string {
  switch (e.code) {
    case 'AUTH_FAILED':
      return `Authentication with Copilot failed. Sign in to the Copilot web app and try again. (server said: ${e.message})`;
    case 'SCHEMA_ERROR':
      return (
        "This tool's model of Copilot's API may be outdated — run `bun run smoke` " +
        `and report this issue with the text below.\nServer said: ${e.message}`
      );
    case 'USER_ACTION_REQUIRED':
      return `Copilot's server rejected the request: ${e.message}`;
    case 'SERVER_ERROR': {
      const base = `Copilot's server failed to process the request (HTTP ${e.httpStatus ?? 'unknown'})${attemptsNote(e)}.`;
      const advice = e.writeMayHaveApplied
        ? ` ${WRITE_AMBIGUITY_WARNING}`
        : ' This may be transient — retry.';
      return `${base}${advice} Server said: ${e.message}`;
    }
    case 'NETWORK':
      if (e.writeMayHaveApplied) {
        return `Network failure while sending a write to Copilot. ${WRITE_AMBIGUITY_WARNING} (${e.message})`;
      }
      return `Transient network problem contacting Copilot${attemptsNote(e)} — retry. (${e.message})`;
    case 'UNKNOWN':
    default:
      return `Copilot API request failed: ${e.message}`;
  }
}
