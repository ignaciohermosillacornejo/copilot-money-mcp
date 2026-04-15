export interface RawEntry {
  ts: number;
  kind: 'fetch' | 'xhr';
  url: string;
  method: string;
  headers: Record<string, string>;
  requestBody: string | null;
  response?: unknown;
  status?: number;
  error?: string;
}

const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-firebase-gmpid',
  'x-firebase-appcheck',
  'x-api-key',
  'x-goog-api-key',
]);

const MERCHANT_FIELDS = new Set([
  'merchant',
  'description',
  'merchantName',
  'payee',
  'counterparty',
  'nameContains',
  'descriptionContains',
  'searchText',
  'searchQuery',
  'note',
  'notes',
  'memo',
]);

// Fields that must never be scrubbed — they're schema/metadata, not PII.
const NEVER_SCRUB = new Set(['__typename', 'type', 'kind', 'status']);
const NAME_FIELDS = new Set(['name', 'displayName']);
const EMAIL_FIELDS = new Set(['email', 'emailAddress']);
const PHONE_FIELDS = new Set(['phone', 'phoneNumber']);
const AMOUNT_FIELDS = new Set([
  'amount', 'amountCents', 'balance', 'value', 'cost', 'price', 'total',
  'limit', 'debt', 'debts', 'assets', 'equity', 'net', 'spend', 'earned',
  'income', 'expense', 'savings',
]);
const ACCOUNT_ID_FIELDS = new Set([
  'accountNumber', 'routingNumber', 'institutionId', 'plaidItemId', 'plaidAccountId',
  'mask', // Plaid/Firebase shorthand for card/account last-4 digits
]);
const ID_FIELDS = new Set(['userId', 'uid', 'householdId', 'id', 'documentId']);
const OPAQUE_TOKEN_FIELDS = new Set([
  'cursor', 'nextCursor', 'previousCursor', 'hash', 'token', 'refreshToken',
  'accessToken', 'sessionToken', 'intercomUserHash',
]);

// camelCase fields whose suffix indicates a money value are scrubbed, e.g.
// unassignedRolloverAmount, childBalance, totalSpent, averageCost, netIncome.
const AMOUNT_SUFFIX_RE =
  /[a-z](Amount|Balance|Cost|Price|Total|Value|Spent|Earned|Paid|Contributed|Saved|Income|Expense|Debt|Asset|Cash|Deposit|Withdrawal|Transfer|Fee|Interest|Principal|Limit|Equity)$/;
// Any camelCase field ending in Id or Ids and holding an id-shaped value.
// Plural catches e.g. suggestedCategoryIds[]; each array element is visited
// with the array's key, so the regex applies to the plural form too.
const ID_SUFFIX_RE = /[a-z]Ids?$/;
// Fields holding opaque tokens (hashes, cursors, bearer tokens).
const TOKEN_SUFFIX_RE = /(Hash|Token|Cursor)$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long token: alphanumeric plus base64/url-safe-base64 characters, with optional = padding.
const LONG_ID_RE = /^[A-Za-z0-9_+/=-]{20,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ENUM_RE = /^[A-Z][A-Z0-9_]{1,}$/;

function isIdShaped(v: unknown): boolean {
  return typeof v === 'string' && (UUID_RE.test(v) || LONG_ID_RE.test(v));
}

function scrubValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(key, item));
  if (typeof value === 'object') return scrubObject(value as Record<string, unknown>);

  if (NEVER_SCRUB.has(key)) return value;
  if (MERCHANT_FIELDS.has(key)) return '<merchant>';
  if (NAME_FIELDS.has(key)) return '<name>';
  if (EMAIL_FIELDS.has(key)) return '<email>';
  if (PHONE_FIELDS.has(key)) return '<phone>';
  if (
    (AMOUNT_FIELDS.has(key) || AMOUNT_SUFFIX_RE.test(key)) &&
    typeof value !== 'boolean'
  ) {
    return '<amount>';
  }
  if (ACCOUNT_ID_FIELDS.has(key)) return '<account-id>';
  if (OPAQUE_TOKEN_FIELDS.has(key) || TOKEN_SUFFIX_RE.test(key)) return '<id>';
  if (ID_FIELDS.has(key) && isIdShaped(value)) return '<id>';
  if (ID_SUFFIX_RE.test(key) && isIdShaped(value)) return '<id>';

  if (typeof value === 'string') {
    if (ISO_DATE_RE.test(value)) return value;
    if (ENUM_RE.test(value)) return value;
  }
  return value;
}

function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = scrubValue(k, v);
  }
  return out;
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '<redacted-header>' : v;
  }
  return out;
}

function scrubRequestBody(body: string | null): string | null {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null) return body;
  const p = parsed as Record<string, unknown>;
  if (!('query' in p) && !('operationName' in p)) return body;
  const out = { ...p };
  if ('variables' in p && typeof p.variables === 'object' && p.variables !== null) {
    out.variables = scrubObject(p.variables as Record<string, unknown>);
  }
  return JSON.stringify(out);
}

export function scrubEntry(entry: RawEntry): RawEntry {
  return {
    ...entry,
    headers: scrubHeaders(entry.headers),
    requestBody: scrubRequestBody(entry.requestBody),
    response:
      typeof entry.response === 'object' && entry.response !== null
        ? scrubObject(entry.response as Record<string, unknown>)
        : entry.response,
  };
}

// CLI: read JSONL from argv[2], write scrubbed JSONL to argv[3]
if (import.meta.main) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error('usage: bun scripts/graphql-capture/scrub.ts <in.jsonl> <out.jsonl>');
    process.exit(1);
  }
  const input = await Bun.file(inPath).text();
  const lines = input.split('\n').filter((l) => l.trim());
  const scrubbed = lines.map((l) => JSON.stringify(scrubEntry(JSON.parse(l)))).join('\n');
  await Bun.write(outPath, scrubbed + '\n');
  console.log(`scrubbed ${lines.length} entries → ${outPath}`);
}
