import { describe, test, expect } from 'bun:test';
import { graphQLErrorToMcpError } from '../../src/tools/errors.js';
import { GraphQLError } from '../../src/core/graphql/client.js';

// Assertions here check attribution fragments + raw-server-text inclusion,
// not full message strings (issue #441: codes over message fragility).
describe('graphQLErrorToMcpError', () => {
  test('AUTH_FAILED → sign-in prompt, includes server text', () => {
    const err = new GraphQLError('AUTH_FAILED', '401: bad token', 'EditTransaction', 401);
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain('Sign in to the Copilot web app');
    expect(msg).toContain('401: bad token');
  });

  test('SCHEMA_ERROR → attributes to this tool, points at smoke, includes server text', () => {
    const err = new GraphQLError(
      'SCHEMA_ERROR',
      '400: Value "YEARLY" does not exist in "RecurringFrequency" enum.',
      'CreateRecurring',
      400
    );
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain("This tool's model of Copilot's API may be outdated");
    expect(msg).toContain('bun run smoke');
    expect(msg).toContain('Value "YEARLY" does not exist in "RecurringFrequency" enum.');
    // The old blanket message blamed the server for client-side bugs (#419).
    expect(msg).not.toContain("Copilot's API changed");
  });

  test('USER_ACTION_REQUIRED → server-rejected attribution + server reason', () => {
    const err = new GraphQLError(
      'USER_ACTION_REQUIRED',
      'Budgeting is disabled. Enable it in Copilot settings.',
      'EditBudget',
      200
    );
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain("Copilot's server rejected the request");
    expect(msg).toContain('Budgeting is disabled. Enable it in Copilot settings.');
  });

  test('SERVER_ERROR → transient attribution with status + server text', () => {
    const err = new GraphQLError('SERVER_ERROR', '500: internal error', 'EditTag', 500);
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain('HTTP 500');
    expect(msg).toContain('transient');
    expect(msg).toContain('retry');
    expect(msg).toContain('500: internal error');
    expect(msg).not.toContain("Copilot's API changed");
  });

  test('NETWORK → transient retry attribution + details', () => {
    const err = new GraphQLError('NETWORK', 'ECONNRESET', 'EditTag');
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain('Transient network problem');
    expect(msg).toContain('retry');
    expect(msg).toContain('ECONNRESET');
  });

  test('UNKNOWN → generic prefix + details', () => {
    const err = new GraphQLError('UNKNOWN', '418: teapot', 'EditTag', 418);
    const msg = graphQLErrorToMcpError(err);
    expect(msg).toContain('Copilot API request failed');
    expect(msg).toContain('418: teapot');
  });

  test('no branch emits the old misleading blanket message', () => {
    const codes = [
      'AUTH_FAILED',
      'SCHEMA_ERROR',
      'USER_ACTION_REQUIRED',
      'SERVER_ERROR',
      'NETWORK',
      'UNKNOWN',
    ] as const;
    for (const code of codes) {
      const msg = graphQLErrorToMcpError(new GraphQLError(code, 'detail', 'Op', 200));
      expect(msg).not.toContain("Copilot's API changed in a way this tool doesn't handle yet");
      // Every branch surfaces the underlying error text.
      expect(msg).toContain('detail');
    }
  });
});
