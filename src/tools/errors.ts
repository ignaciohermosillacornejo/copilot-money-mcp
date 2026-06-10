import { GraphQLError } from '../core/graphql/client.js';

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
    case 'SERVER_ERROR':
      return `Copilot's server failed to process the request (HTTP ${e.httpStatus ?? 'unknown'}). This may be transient — retry. Server said: ${e.message}`;
    case 'NETWORK':
      return `Transient network problem contacting Copilot — retry. (${e.message})`;
    case 'UNKNOWN':
    default:
      return `Copilot API request failed: ${e.message}`;
  }
}
