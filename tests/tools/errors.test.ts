import { describe, test, expect } from 'bun:test';
import { graphQLErrorToMcpError } from '../../src/tools/errors.js';
import { GraphQLError } from '../../src/core/graphql/client.js';

describe('graphQLErrorToMcpError', () => {
  test('AUTH_FAILED → sign-in prompt', () => {
    const err = new GraphQLError('AUTH_FAILED', '401 bad token', 'EditTransaction', 401);
    expect(graphQLErrorToMcpError(err)).toBe(
      'Authentication with Copilot failed. Sign in to the Copilot web app and try again.'
    );
  });

  test('SCHEMA_ERROR → report-issue message', () => {
    const err = new GraphQLError('SCHEMA_ERROR', '500 bad schema', 'EditBudget', 500);
    expect(graphQLErrorToMcpError(err)).toBe(
      "Copilot's API changed in a way this tool doesn't handle yet. Please report this issue."
    );
  });

  test('USER_ACTION_REQUIRED → surfaces server message verbatim', () => {
    const err = new GraphQLError(
      'USER_ACTION_REQUIRED',
      'Budgeting is disabled. Enable it in Copilot settings.',
      'EditBudget',
      200
    );
    expect(graphQLErrorToMcpError(err)).toBe(
      'Budgeting is disabled. Enable it in Copilot settings.'
    );
  });

  test('NETWORK → network prefix + details', () => {
    const err = new GraphQLError('NETWORK', 'ECONNRESET', 'EditTag');
    expect(graphQLErrorToMcpError(err)).toBe('Network error contacting Copilot: ECONNRESET');
  });

  test('UNKNOWN → generic prefix + details', () => {
    const err = new GraphQLError('UNKNOWN', '418: teapot', 'EditTag', 418);
    expect(graphQLErrorToMcpError(err)).toBe('Copilot API request failed: 418: teapot');
  });
});
