import { describe, it, expect } from 'bun:test';
import {
  groupByOperation,
  renderOperationMarkdown,
  inferVariableSchema,
} from '../../../scripts/graphql-capture/generate-docs';

const entry = (
  op: string,
  kind: 'query' | 'mutation',
  variables: Record<string, unknown>,
  response: unknown
) => ({
  ts: 1,
  kind: 'fetch' as const,
  url: 'https://api.copilot.money/graphql',
  method: 'POST',
  headers: {},
  requestBody: JSON.stringify({
    operationName: op,
    query: `${kind} ${op} { __typename }`,
    variables,
  }),
  response,
});

describe('groupByOperation', () => {
  it('groups entries by operation name', () => {
    const entries = [
      entry('GetAccounts', 'query', {}, { data: { accounts: [] } }),
      entry('GetAccounts', 'query', {}, { data: { accounts: [{ id: '<id>' }] } }),
      entry(
        'UpdateBudget',
        'mutation',
        { id: '<id>', amount: '<amount>' },
        { data: { updateBudget: {} } }
      ),
    ];
    const grouped = groupByOperation(entries);
    expect(grouped.size).toBe(2);
    expect(grouped.get('GetAccounts')?.entries.length).toBe(2);
    expect(grouped.get('UpdateBudget')?.kind).toBe('mutation');
  });
});

describe('inferVariableSchema', () => {
  it('produces a table of variable names and types from observed calls', () => {
    const entries = [
      entry('Q', 'query', { id: '<id>', limit: 25 }, null),
      entry('Q', 'query', { id: '<id>', limit: 50, cursor: 'abc' }, null),
    ];
    const schema = inferVariableSchema(entries);
    expect(schema.find((v) => v.name === 'id')?.type).toBe('string');
    expect(schema.find((v) => v.name === 'limit')?.type).toBe('number');
    expect(schema.find((v) => v.name === 'cursor')?.required).toBe(false);
    expect(schema.find((v) => v.name === 'id')?.required).toBe(true);
  });
});

describe('renderOperationMarkdown', () => {
  it('includes operation name, type, query, variable table, and example pair', () => {
    const entries = [entry('GetAccounts', 'query', { limit: 25 }, { data: { accounts: [] } })];
    const md = renderOperationMarkdown('GetAccounts', 'query', entries);
    expect(md).toContain('# GetAccounts');
    expect(md).toContain('**Type:** query');
    expect(md).toContain('```graphql');
    expect(md).toContain('query GetAccounts { __typename }');
    expect(md).toContain('| limit | number |');
    expect(md).toContain('## Example request');
    expect(md).toContain('## Example response');
  });
});
