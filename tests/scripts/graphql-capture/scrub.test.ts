import { describe, it, expect } from 'bun:test';
import { scrubEntry, type RawEntry } from '../../../scripts/graphql-capture/scrub';

const baseEntry = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  ts: 1700000000000,
  kind: 'fetch',
  url: 'https://api.copilot.money/graphql',
  method: 'POST',
  headers: {},
  requestBody: null,
  ...overrides,
});

describe('scrubEntry - headers', () => {
  it('redacts authorization header regardless of case', () => {
    const out = scrubEntry(baseEntry({ headers: { Authorization: 'Bearer abc' } }));
    expect(out.headers.Authorization).toBe('<redacted-header>');
  });

  it('redacts cookie header', () => {
    const out = scrubEntry(baseEntry({ headers: { cookie: 'session=xyz' } }));
    expect(out.headers.cookie).toBe('<redacted-header>');
  });

  it('leaves content-type alone', () => {
    const out = scrubEntry(baseEntry({ headers: { 'content-type': 'application/json' } }));
    expect(out.headers['content-type']).toBe('application/json');
  });
});

describe('scrubEntry - response values', () => {
  it('replaces merchant name with placeholder', () => {
    const out = scrubEntry(
      baseEntry({
        response: { data: { transactions: [{ merchant: 'Starbucks', amount: 4.5 }] } },
      })
    );
    const t = (out.response as any).data.transactions[0];
    expect(t.merchant).toBe('<merchant>');
    expect(t.amount).toBe('<amount>');
  });

  it('replaces email addresses', () => {
    const out = scrubEntry(baseEntry({ response: { data: { user: { email: 'a@b.com' } } } }));
    expect((out.response as any).data.user.email).toBe('<email>');
  });

  it('replaces UUID-shaped ids with <id>', () => {
    const out = scrubEntry(
      baseEntry({
        response: { data: { user: { id: '550e8400-e29b-41d4-a716-446655440000' } } },
      })
    );
    expect((out.response as any).data.user.id).toBe('<id>');
  });

  it('preserves ISO dates', () => {
    const date = '2026-04-14T12:00:00.000Z';
    const out = scrubEntry(baseEntry({ response: { data: { tx: { date } } } }));
    expect((out.response as any).data.tx.date).toBe(date);
  });

  it('preserves enum-shaped strings', () => {
    const out = scrubEntry(baseEntry({ response: { data: { tx: { status: 'PENDING' } } } }));
    expect((out.response as any).data.tx.status).toBe('PENDING');
  });
});

describe('scrubEntry - request body', () => {
  it('scrubs variable values but preserves the query string and operation name', () => {
    const body = JSON.stringify({
      operationName: 'UpdateTransaction',
      query: 'mutation UpdateTransaction($id: ID!, $merchant: String) { ... }',
      variables: { id: '550e8400-e29b-41d4-a716-446655440000', merchant: 'Starbucks' },
    });
    const out = scrubEntry(baseEntry({ requestBody: body }));
    const parsed = JSON.parse(out.requestBody!);
    expect(parsed.operationName).toBe('UpdateTransaction');
    expect(parsed.query).toBe('mutation UpdateTransaction($id: ID!, $merchant: String) { ... }');
    expect(parsed.variables.id).toBe('<id>');
    expect(parsed.variables.merchant).toBe('<merchant>');
  });

  it('handles non-GraphQL-shaped bodies without crashing', () => {
    const out = scrubEntry(baseEntry({ requestBody: 'plain text' }));
    expect(out.requestBody).toBe('plain text');
  });
});
