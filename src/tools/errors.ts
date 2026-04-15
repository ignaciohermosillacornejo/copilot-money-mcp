import { GraphQLError } from '../core/graphql/client.js';

export function graphQLErrorToMcpError(e: GraphQLError): string {
  switch (e.code) {
    case 'AUTH_FAILED':
      return 'Authentication with Copilot failed. Sign in to the Copilot web app and try again.';
    case 'SCHEMA_ERROR':
      return "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue.";
    case 'USER_ACTION_REQUIRED':
      return e.message;
    case 'NETWORK':
      return `Network error contacting Copilot: ${e.message}`;
    case 'UNKNOWN':
    default:
      return `Copilot API request failed: ${e.message}`;
  }
}
