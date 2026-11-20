import { describe, it, expect } from 'bun:test';
import { scrubEntry, type RawEntry } from '../../../scripts/graphql-capture/scrub.js';

/**
 * Walk a scrubbed response by key path. The scrubber returns `unknown`, and a
 * path that is not there reads `undefined` here and fails the `toBe` beside
 * it, rather than every test casting the response to `any` (#919).
 */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

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
    const t = at(out.response, 'data', 'transactions', 0) as Record<string, unknown>;
    expect(t.merchant).toBe('<merchant>');
    expect(t.amount).toBe('<amount>');
  });

  it('replaces email addresses', () => {
    const out = scrubEntry(baseEntry({ response: { data: { user: { email: 'a@b.com' } } } }));
    expect(at(out.response, 'data', 'user', 'email')).toBe('<email>');
  });

  it('replaces UUID-shaped ids with <id>', () => {
    const out = scrubEntry(
      baseEntry({
        response: { data: { user: { id: '550e8400-e29b-41d4-a716-446655440000' } } },
      })
    );
    expect(at(out.response, 'data', 'user', 'id')).toBe('<id>');
  });

  it('preserves ISO dates', () => {
    const date = '2026-04-14T12:00:00.000Z';
    const out = scrubEntry(baseEntry({ response: { data: { tx: { date } } } }));
    expect(at(out.response, 'data', 'tx', 'date')).toBe(date);
  });

  it('preserves enum-shaped strings', () => {
    const out = scrubEntry(baseEntry({ response: { data: { tx: { status: 'PENDING' } } } }));
    expect(at(out.response, 'data', 'tx', 'status')).toBe('PENDING');
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
    const parsed = JSON.parse(out.requestBody!) as {
      operationName: string;
      query: string;
      variables: Record<string, unknown>;
    };
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

describe('scrubEntry - amount-suffixed fields', () => {
  it('scrubs camelCase fields ending in Amount/Balance/Spent/etc', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            budget: {
              unassignedRolloverAmount: 100,
              childRolloverAmount: 200,
              goalAmount: 50,
              totalSpent: 1234.56,
              netIncome: 5000,
              averageCost: 12.5,
            },
          },
        },
      })
    );
    const b = at(out.response, 'data', 'budget') as Record<string, unknown>;
    expect(b.unassignedRolloverAmount).toBe('<amount>');
    expect(b.childRolloverAmount).toBe('<amount>');
    expect(b.goalAmount).toBe('<amount>');
    expect(b.totalSpent).toBe('<amount>');
    expect(b.netIncome).toBe('<amount>');
    expect(b.averageCost).toBe('<amount>');
  });
});

describe('scrubEntry - base64-padded ids', () => {
  it('scrubs base64-padded id values', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: { row: { id: 'cHRCcGplS096bVpiSGVxaWM2blBZQm45aU04MjoyMDI2LTA0OmJ1ZGdldA==' } },
        },
      })
    );
    expect(at(out.response, 'data', 'row', 'id')).toBe('<id>');
  });
});

describe('scrubEntry - *Id suffix fields', () => {
  it('scrubs categoryId, accountId, itemId, recurringId when value is id-shaped', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            row: {
              categoryId: '5Qqr8qs3GHNCj8H6fIKd',
              accountId: '09O3QdvbJ8TnZBMMVJL9f01V9zLPE9CVEqzbB',
              itemId: 'DjR9O8dneNcD04qq1dwzt1wR3qy0qzIZBvep4',
              recurringId: 'sbH3Q48B4nlvAwzHx2QC',
              shortId: 'abc',
            },
          },
        },
      })
    );
    const r = at(out.response, 'data', 'row') as Record<string, unknown>;
    expect(r.categoryId).toBe('<id>');
    expect(r.accountId).toBe('<id>');
    expect(r.itemId).toBe('<id>');
    expect(r.recurringId).toBe('<id>');
    expect(r.shortId).toBe('abc');
  });
});

describe('scrubEntry - opaque tokens', () => {
  it('scrubs cursor, hash, and token-suffixed fields', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            cursor: 'eyJkYXRlIjoiMjAyNi0wNC0xNCJ9',
            intercomUserHash: '9bff521b349888619a463debf9af2f65296576c8',
            accessToken: 'Bearer abc123xyz',
          },
        },
      })
    );
    const d = at(out.response, 'data') as Record<string, unknown>;
    expect(d.cursor).toBe('<id>');
    expect(d.intercomUserHash).toBe('<id>');
    expect(d.accessToken).toBe('<id>');
  });
});

describe('scrubEntry - preserves GraphQL schema metadata', () => {
  it('does not scrub __typename even when value looks id-shaped', () => {
    const out = scrubEntry(
      baseEntry({
        response: { data: { x: { __typename: 'TransactionPagination', id: 'abc-short' } } },
      })
    );
    expect(at(out.response, 'data', 'x', '__typename')).toBe('TransactionPagination');
  });
});

describe('scrubEntry - search filter variables', () => {
  it('scrubs nameContains and descriptionContains as merchant-like PII', () => {
    const body = JSON.stringify({
      operationName: 'Transactions',
      query: 'query Transactions($nameContains: String) { ... }',
      variables: { nameContains: 'STRATECHERY-DITHERING' },
    });
    const out = scrubEntry(baseEntry({ requestBody: body }));
    const parsed = JSON.parse(out.requestBody!) as {
      operationName: string;
      query: string;
      variables: Record<string, unknown>;
    };
    expect(parsed.variables.nameContains).toBe('<merchant>');
  });
});

describe('scrubEntry - finance-specific numeric fields', () => {
  it('scrubs credit limit, debt, assets, equity as amounts', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            account: {
              limit: 21000,
              debt: 48.81,
              assets: 16710.1,
              equity: 5000,
            },
          },
        },
      })
    );
    const a = at(out.response, 'data', 'account') as Record<string, unknown>;
    expect(a.limit).toBe('<amount>');
    expect(a.debt).toBe('<amount>');
    expect(a.assets).toBe('<amount>');
    expect(a.equity).toBe('<amount>');
  });

  it('does not scrub boolean *Balance fields as amount', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            account: {
              hasLiveBalance: true,
              hasHistoricalBalance: false,
            },
          },
        },
      })
    );
    const a = at(out.response, 'data', 'account') as Record<string, unknown>;
    expect(a.hasLiveBalance).toBe(true);
    expect(a.hasHistoricalBalance).toBe(false);
  });
});

describe('scrubEntry - card/account mask', () => {
  it('scrubs mask (last-4 digits) as an account-id', () => {
    const out = scrubEntry(
      baseEntry({
        response: { data: { account: { mask: '8100' } } },
      })
    );
    expect(at(out.response, 'data', 'account', 'mask')).toBe('<account-id>');
  });
});

describe('scrubEntry - plural *Ids suffix', () => {
  it('scrubs array elements of suggestedCategoryIds', () => {
    const out = scrubEntry(
      baseEntry({
        response: {
          data: {
            transaction: {
              suggestedCategoryIds: ['uVmmgq7OK76xt5HUqHfe', '5Qqr8qs3GHNCj8H6fIKd'],
            },
          },
        },
      })
    );
    const ids = at(out.response, 'data', 'transaction', 'suggestedCategoryIds');
    expect(ids).toEqual(['<id>', '<id>']);
  });
});
