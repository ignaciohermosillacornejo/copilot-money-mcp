# GraphQL Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete, reviewable documentation of every GraphQL query and mutation the Copilot Money web app issues, with scrubbed example request/response pairs, so we can rewrite our 18 write tools off direct Firestore onto the official API.

**Architecture:** A human operator runs copilot.money in their authenticated Chrome with a pasted fetch/XHR interceptor; an agent drives navigation via `claude-in-chrome`, periodically drains `window.__gqlLog`, persists raw JSONL locally, then runs a deterministic scrubber + doc generator to produce `docs/graphql-capture/`. Raw captures stay local and gitignored; scrubbed output is reviewed before any commit.

**Tech Stack:** TypeScript + Bun (scrubber, doc generator), browser JS (interceptor), `claude-in-chrome` MCP (navigation), existing repo tooling (ESLint/Prettier/bun test).

**Design reference:** `docs/superpowers/specs/2026-04-14-graphql-capture-design.md`

---

## File Structure

- **Create** `scripts/graphql-capture/interceptor.js` — DevTools-pasteable snippet that monkey-patches fetch/XHR and records GraphQL calls to `window.__gqlLog`.
- **Create** `scripts/graphql-capture/scrub.ts` — deterministic scrubber that transforms raw captured entries into PII-redacted entries (design spec § "Scrubbing", option B).
- **Create** `scripts/graphql-capture/generate-docs.ts` — reads scrubbed JSONL, groups by operation name, writes one markdown file per operation under `docs/graphql-capture/operations/{queries,mutations}/`, builds `schema/operations.md` index.
- **Create** `scripts/graphql-capture/drain.ts` — tiny helper the agent runs that reads `window.__gqlLog` via stdin (JSON pasted from browser), appends to `raw/captured-log.jsonl`, and clears the browser-side log via a companion snippet.
- **Create** `scripts/graphql-capture/README.md` — operator runbook: how to open DevTools, paste the interceptor, how the agent works, how to invoke scrub + generate-docs.
- **Create** `scripts/graphql-capture/crawl-prompt.md` — the SOP the subagent follows while crawling (per-area checkpoints, safety rules, autonomy upgrade).
- **Create** `tests/scripts/graphql-capture/scrub.test.ts` — covers scrub behavior per PII class.
- **Create** `tests/scripts/graphql-capture/generate-docs.test.ts` — covers grouping, markdown output shape, variable-schema inference.
- **Modify** `.gitignore` — add `docs/graphql-capture/` so nothing is accidentally committed until the operator green-lights it.

Each file has one responsibility. The scrubber and generator are pure functions over JSONL → easy to test. The interceptor is the only browser-side code. The prompt and README are prose.

---

## Task 1: Scaffolding and gitignore

**Files:**
- Modify: `.gitignore`
- Create: `scripts/graphql-capture/` (directory)
- Create: `tests/scripts/graphql-capture/` (directory)

- [ ] **Step 1: Add capture directory to gitignore**

Append to `.gitignore` (above the final `EOF`/last section, after the "Claude Code local state" block):

```
# GraphQL capture output — gitignored until operator personally reviews
docs/graphql-capture/
```

- [ ] **Step 2: Create empty directories with .gitkeep**

```bash
mkdir -p scripts/graphql-capture tests/scripts/graphql-capture
touch scripts/graphql-capture/.gitkeep tests/scripts/graphql-capture/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore scripts/graphql-capture/.gitkeep tests/scripts/graphql-capture/.gitkeep
git commit -m "chore(graphql-capture): scaffold directories and gitignore output"
```

---

## Task 2: Interceptor snippet

**Files:**
- Create: `scripts/graphql-capture/interceptor.js`

- [ ] **Step 1: Write the interceptor**

Create `scripts/graphql-capture/interceptor.js` with exactly this content:

```js
// Copilot Money GraphQL capture interceptor.
// Paste into the DevTools console on copilot.money, then reload the page.
// All GraphQL calls land in window.__gqlLog. Drain with JSON.stringify(window.__gqlLog).
(() => {
  if (window.__gqlLogInstalled) {
    console.warn('[gql-capture] already installed');
    return;
  }
  window.__gqlLogInstalled = true;
  window.__gqlLog = window.__gqlLog || [];

  const isGraphQLUrl = (u) => typeof u === 'string' && /graphql/i.test(u);
  const bodyLooksLikeGraphQL = (b) => {
    if (!b) return false;
    const s = typeof b === 'string' ? b : '';
    return s.includes('"query"') || s.includes('"operationName"');
  };

  const headersToObject = (h) => {
    if (!h) return {};
    if (h instanceof Headers) {
      const o = {};
      h.forEach((v, k) => { o[k] = v; });
      return o;
    }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h };
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    const body = init && init.body;
    const shouldCapture = isGraphQLUrl(url) || bodyLooksLikeGraphQL(body);
    const entry = {
      ts: Date.now(),
      kind: 'fetch',
      url,
      method,
      headers: headersToObject(init && init.headers),
      requestBody: typeof body === 'string' ? body : null,
    };
    const res = await origFetch(input, init);
    if (shouldCapture) {
      try {
        const clone = res.clone();
        const text = await clone.text();
        try { entry.response = JSON.parse(text); } catch { entry.response = text; }
        entry.status = res.status;
        window.__gqlLog.push(entry);
      } catch (e) {
        entry.error = String(e);
        window.__gqlLog.push(entry);
      }
    }
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    const meta = { ts: Date.now(), kind: 'xhr', headers: {} };
    const origOpen = xhr.open;
    xhr.open = function (method, url, ...rest) {
      meta.method = method;
      meta.url = url;
      return origOpen.call(this, method, url, ...rest);
    };
    const origSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function (k, v) {
      meta.headers[k] = v;
      return origSetHeader.call(this, k, v);
    };
    const origSend = xhr.send;
    xhr.send = function (body) {
      meta.requestBody = typeof body === 'string' ? body : null;
      xhr.addEventListener('loadend', () => {
        if (isGraphQLUrl(meta.url) || bodyLooksLikeGraphQL(meta.requestBody)) {
          meta.status = xhr.status;
          try { meta.response = JSON.parse(xhr.responseText); } catch { meta.response = xhr.responseText; }
          window.__gqlLog.push(meta);
        }
      });
      return origSend.call(this, body);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  console.log('[gql-capture] installed. Reload page to capture initial queries.');
})();
```

- [ ] **Step 2: Commit**

```bash
git add scripts/graphql-capture/interceptor.js
git commit -m "feat(graphql-capture): add DevTools interceptor snippet"
```

---

## Task 3: Scrubber (TDD)

The scrubber reads raw JSONL entries and produces a scrubbed copy. Each entry has shape:

```ts
interface RawEntry {
  ts: number;
  kind: 'fetch' | 'xhr';
  url: string;
  method: string;
  headers: Record<string, string>;
  requestBody: string | null; // JSON string of GraphQL request
  response?: unknown;         // parsed JSON response or string
  status?: number;
  error?: string;
}
```

**Scrubbing rules** (from design spec):

1. Headers: `authorization`, `cookie`, `x-firebase-*`, `x-api-key` → `<redacted-header>`. Case-insensitive.
2. Response/request field values are traversed recursively and replaced by field name:
   - `merchant`, `description`, `name`, `displayName`, `merchantName`, `payee`, `counterparty` → `<merchant>` (or `<name>` for generic name fields — use `<merchant>` if the sibling context includes amount-like fields, else `<name>`; simplest rule: `<merchant>` for those six, `<name>` for generic `name`/`displayName`)
   - `email`, `emailAddress` → `<email>`
   - `phone`, `phoneNumber` → `<phone>`
   - `amount`, `amountCents`, `balance`, `value`, `cost`, `price`, `total` → replace with a literal `"<amount>"` string
   - `accountNumber`, `routingNumber`, `institutionId`, `plaidItemId`, `plaidAccountId` → `<account-id>`
   - `userId`, `uid`, `householdId`, `id` when the value is a UUID-shaped string (`/^[0-9a-f-]{20,}$/i` or long base64-ish) → `<id>`
   - Dates (ISO 8601) → keep as-is
   - Enums (SCREAMING_SNAKE_CASE strings with no spaces) → keep as-is
   - Other strings and numbers → keep as-is
3. Query strings, operation names, variable **keys** are preserved exactly; only variable **values** are scrubbed by the same rules.

**Files:**
- Create: `scripts/graphql-capture/scrub.ts`
- Create: `tests/scripts/graphql-capture/scrub.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/scripts/graphql-capture/scrub.test.ts`:

```ts
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
    const out = scrubEntry(baseEntry({
      response: { data: { transactions: [{ merchant: 'Starbucks', amount: 4.5 }] } },
    }));
    const t = (out.response as any).data.transactions[0];
    expect(t.merchant).toBe('<merchant>');
    expect(t.amount).toBe('<amount>');
  });

  it('replaces email addresses', () => {
    const out = scrubEntry(baseEntry({ response: { data: { user: { email: 'a@b.com' } } } }));
    expect((out.response as any).data.user.email).toBe('<email>');
  });

  it('replaces UUID-shaped ids with <id>', () => {
    const out = scrubEntry(baseEntry({
      response: { data: { user: { id: '550e8400-e29b-41d4-a716-446655440000' } } },
    }));
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scripts/graphql-capture/scrub.test.ts`
Expected: FAIL with "cannot find module scrub"

- [ ] **Step 3: Implement the scrubber**

Create `scripts/graphql-capture/scrub.ts`:

```ts
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
]);
const NAME_FIELDS = new Set(['name', 'displayName']);
const EMAIL_FIELDS = new Set(['email', 'emailAddress']);
const PHONE_FIELDS = new Set(['phone', 'phoneNumber']);
const AMOUNT_FIELDS = new Set([
  'amount', 'amountCents', 'balance', 'value', 'cost', 'price', 'total',
]);
const ACCOUNT_ID_FIELDS = new Set([
  'accountNumber', 'routingNumber', 'institutionId', 'plaidItemId', 'plaidAccountId',
]);
const ID_FIELDS = new Set(['userId', 'uid', 'householdId', 'id', 'documentId']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ENUM_RE = /^[A-Z][A-Z0-9_]{1,}$/;

function isIdShaped(v: unknown): boolean {
  return typeof v === 'string' && (UUID_RE.test(v) || LONG_ID_RE.test(v));
}

function scrubValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(key, item));
  if (typeof value === 'object') return scrubObject(value as Record<string, unknown>);

  if (MERCHANT_FIELDS.has(key)) return '<merchant>';
  if (NAME_FIELDS.has(key)) return '<name>';
  if (EMAIL_FIELDS.has(key)) return '<email>';
  if (PHONE_FIELDS.has(key)) return '<phone>';
  if (AMOUNT_FIELDS.has(key)) return '<amount>';
  if (ACCOUNT_ID_FIELDS.has(key)) return '<account-id>';
  if (ID_FIELDS.has(key) && isIdShaped(value)) return '<id>';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scripts/graphql-capture/scrub.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `bun run typecheck && bun run lint scripts/graphql-capture/ tests/scripts/graphql-capture/`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/graphql-capture/scrub.ts tests/scripts/graphql-capture/scrub.test.ts
git commit -m "feat(graphql-capture): add scrubber with per-field redaction rules"
```

---

## Task 4: Doc generator (TDD)

Reads scrubbed JSONL, groups by `operationName`, writes one `.md` per operation.

**Files:**
- Create: `scripts/graphql-capture/generate-docs.ts`
- Create: `tests/scripts/graphql-capture/generate-docs.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/scripts/graphql-capture/generate-docs.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { groupByOperation, renderOperationMarkdown, inferVariableSchema } from '../../../scripts/graphql-capture/generate-docs';

const entry = (op: string, kind: 'query' | 'mutation', variables: Record<string, unknown>, response: unknown) => ({
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
      entry('UpdateBudget', 'mutation', { id: '<id>', amount: '<amount>' }, { data: { updateBudget: {} } }),
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scripts/graphql-capture/generate-docs.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the generator**

Create `scripts/graphql-capture/generate-docs.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RawEntry } from './scrub';

export interface OperationGroup {
  kind: 'query' | 'mutation';
  entries: RawEntry[];
}

export interface VariableSchema {
  name: string;
  type: string;
  required: boolean;
  example: unknown;
}

interface ParsedBody {
  operationName?: string;
  query?: string;
  variables?: Record<string, unknown>;
}

function parseBody(entry: RawEntry): ParsedBody | null {
  if (!entry.requestBody) return null;
  try {
    return JSON.parse(entry.requestBody) as ParsedBody;
  } catch {
    return null;
  }
}

function detectKind(query: string | undefined): 'query' | 'mutation' {
  if (!query) return 'query';
  const trimmed = query.trimStart();
  return trimmed.startsWith('mutation') ? 'mutation' : 'query';
}

export function groupByOperation(entries: RawEntry[]): Map<string, OperationGroup> {
  const groups = new Map<string, OperationGroup>();
  for (const e of entries) {
    const body = parseBody(e);
    if (!body?.operationName) continue;
    const kind = detectKind(body.query);
    const existing = groups.get(body.operationName);
    if (existing) {
      existing.entries.push(e);
    } else {
      groups.set(body.operationName, { kind, entries: [e] });
    }
  }
  return groups;
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function inferVariableSchema(entries: RawEntry[]): VariableSchema[] {
  const seenInAll = new Map<string, { types: Set<string>; example: unknown; seenCount: number }>();
  for (const e of entries) {
    const body = parseBody(e);
    const vars = body?.variables ?? {};
    for (const [k, v] of Object.entries(vars)) {
      const entry = seenInAll.get(k) ?? { types: new Set(), example: v, seenCount: 0 };
      entry.types.add(jsType(v));
      entry.seenCount += 1;
      seenInAll.set(k, entry);
    }
  }
  const total = entries.length;
  return [...seenInAll.entries()].map(([name, info]) => ({
    name,
    type: [...info.types].join(' | '),
    required: info.seenCount === total,
    example: info.example,
  }));
}

export function renderOperationMarkdown(
  opName: string,
  kind: 'query' | 'mutation',
  entries: RawEntry[],
): string {
  const first = entries[0];
  const body = parseBody(first);
  const query = body?.query ?? '';
  const vars = inferVariableSchema(entries);
  const screens = '<fill in from flow docs>';
  const endpoint = first.url;

  const varTable = vars.length
    ? [
        '| Name | Type | Required | Example |',
        '|------|------|----------|---------|',
        ...vars.map((v) => `| ${v.name} | ${v.type} | ${v.required} | \`${JSON.stringify(v.example)}\` |`),
      ].join('\n')
    : '_(no variables)_';

  const exampleRequest = first.requestBody ?? '';
  const exampleResponse = JSON.stringify(first.response, null, 2);

  return [
    `# ${opName}`,
    '',
    `- **Type:** ${kind}`,
    `- **Endpoint:** ${endpoint}`,
    `- **Fires on:** ${screens}`,
    `- **Observations:** ${entries.length}`,
    '',
    '## Query',
    '',
    '```graphql',
    query,
    '```',
    '',
    '## Variables',
    '',
    varTable,
    '',
    '## Example request',
    '',
    '```json',
    exampleRequest,
    '```',
    '',
    '## Example response',
    '',
    '```json',
    exampleResponse,
    '```',
    '',
  ].join('\n');
}

export async function generateAll(scrubbedPath: string, outDir: string): Promise<void> {
  const text = await Bun.file(scrubbedPath).text();
  const entries: RawEntry[] = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const groups = groupByOperation(entries);

  const queriesDir = path.join(outDir, 'operations', 'queries');
  const mutationsDir = path.join(outDir, 'operations', 'mutations');
  const schemaDir = path.join(outDir, 'schema');
  await mkdir(queriesDir, { recursive: true });
  await mkdir(mutationsDir, { recursive: true });
  await mkdir(schemaDir, { recursive: true });

  const indexLines = ['# Operations Index', ''];
  for (const [opName, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dir = group.kind === 'mutation' ? mutationsDir : queriesDir;
    const file = path.join(dir, `${opName}.md`);
    await Bun.write(file, renderOperationMarkdown(opName, group.kind, group.entries));
    const rel = path.relative(outDir, file);
    indexLines.push(`- [${opName}](${rel}) — ${group.kind}, ${group.entries.length} observation(s)`);
  }
  await Bun.write(path.join(schemaDir, 'operations.md'), indexLines.join('\n') + '\n');
}

if (import.meta.main) {
  const [, , scrubbedPath, outDir] = process.argv;
  if (!scrubbedPath || !outDir) {
    console.error('usage: bun scripts/graphql-capture/generate-docs.ts <scrubbed.jsonl> <outDir>');
    process.exit(1);
  }
  await generateAll(scrubbedPath, outDir);
  console.log(`generated docs → ${outDir}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scripts/graphql-capture/generate-docs.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run full check**

Run: `bun run check`
Expected: clean (typecheck + lint + format + all tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/graphql-capture/generate-docs.ts tests/scripts/graphql-capture/generate-docs.test.ts
git commit -m "feat(graphql-capture): add per-operation markdown generator"
```

---

## Task 5: Operator README

**Files:**
- Create: `scripts/graphql-capture/README.md`

- [ ] **Step 1: Write the README**

Create `scripts/graphql-capture/README.md`:

```markdown
# GraphQL Capture — Operator Runbook

Captures every GraphQL query and mutation the Copilot Money web app issues, so we can rewrite our write tools off direct Firestore onto the official API. See design spec: `docs/superpowers/specs/2026-04-14-graphql-capture-design.md`.

## One-time setup

1. Open Chrome and sign into https://copilot.money.
2. Open DevTools (Cmd+Opt+I). Go to the **Network** tab. Enable **Preserve log**. This is the HAR backup.
3. Go to the **Console** tab. Paste the entire contents of `scripts/graphql-capture/interceptor.js` and press Enter. You should see `[gql-capture] installed`.
4. **Reload the page** so initial queries go through the interceptor.
5. Leave this tab and DevTools open for the entire session.

## During the session

The agent navigates the app via the `claude-in-chrome` extension. Periodically the agent will need to drain the browser-side log. To drain:

1. In the DevTools console, run: `copy(JSON.stringify(window.__gqlLog)); window.__gqlLog = []`
2. Paste the copied JSON into a file the agent reads (or let the agent prompt you — the agent will tell you when it needs a drain).
3. The agent runs `bun scripts/graphql-capture/scrub.ts <raw> <scrubbed>` and then `bun scripts/graphql-capture/generate-docs.ts <scrubbed> docs/graphql-capture/`.

All output under `docs/graphql-capture/` is gitignored. Review it personally before committing anything.

## End of session

1. In DevTools Network tab, right-click → **Save all as HAR with content**. Save to `docs/graphql-capture/raw/session-YYYY-MM-DD.har`.
2. Final drain of `window.__gqlLog`.
3. Run scrub + generate-docs one final time.
4. Review `docs/graphql-capture/` end-to-end. If satisfied, remove the gitignore entry and commit.

## Safety rules (do not skip)

- Do not connect or disconnect bank accounts.
- Do not trigger account sync.
- Do not submit real money-moving actions.
- For destructive mutations (delete budget/category/goal/tag/recurring), create a test entity first named `GQL-TEST` and delete that.
- If the agent asks before a mutation, the answer is yes only for `GQL-TEST` entities.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/graphql-capture/README.md
git commit -m "docs(graphql-capture): add operator runbook"
```

---

## Task 6: Crawl prompt (agent SOP)

**Files:**
- Create: `scripts/graphql-capture/crawl-prompt.md`

- [ ] **Step 1: Write the crawl prompt**

Create `scripts/graphql-capture/crawl-prompt.md`:

````markdown
# Copilot Money GraphQL Crawl — Agent SOP

You are a research subagent. Your job is to systematically navigate https://copilot.money via the `claude-in-chrome` MCP extension, observe what GraphQL operations fire, and produce complete documentation under `docs/graphql-capture/`.

**Design reference:** `docs/superpowers/specs/2026-04-14-graphql-capture-design.md`
**Operator runbook:** `scripts/graphql-capture/README.md`

## Preconditions you must verify before starting

- The operator has pasted `scripts/graphql-capture/interceptor.js` into DevTools console and reloaded the page. Confirm by asking them, or by evaluating `window.__gqlLogInstalled` via the extension if available.
- `docs/graphql-capture/` directory exists and is gitignored.
- `raw/captured-log.jsonl` starts empty.

## Crawl plan

Work **one top-level area at a time**, in this order:

1. Dashboard / home
2. Accounts (list, detail, connection management, manual accounts)
3. Transactions (list, filters, detail, splits, tags, notes, attachments, review queue)
4. Categories (list, create, edit, delete, hierarchy / groups)
5. Budgets (list, create, edit, delete, rollovers)
6. Goals (list, create, edit, delete, contributions)
7. Recurring (list, create, edit, delete, pause/resume, detection queue)
8. Investments (holdings, performance, securities detail, allocations)
9. Cash flow / trends / reports
10. Tags (list, create, edit, delete, assignment)
11. Rules (auto-categorization, if present)
12. Settings (profile, household, notifications, integrations, export, subscription)
13. Search
14. Modal-only surfaces discovered while crawling 1–13

## Per-area loop

For each area:

1. Navigate to every screen and sub-screen using `claude-in-chrome` click/scroll/type.
2. Exercise read-only interactions: filters, sort, detail views, opening modals, filling (but NOT submitting) create/edit forms.
3. Drain the log: ask the operator to run `copy(JSON.stringify(window.__gqlLog)); window.__gqlLog = []` and paste the result to a temp file, OR read `window.__gqlLog` directly via the extension's eval capability and clear it.
4. Append the drained entries to `docs/graphql-capture/raw/captured-log.jsonl` (one JSON object per line).
5. Run scrub: `bun scripts/graphql-capture/scrub.ts docs/graphql-capture/raw/captured-log.jsonl docs/graphql-capture/raw/scrubbed.jsonl`.
6. Run doc generator: `bun scripts/graphql-capture/generate-docs.ts docs/graphql-capture/raw/scrubbed.jsonl docs/graphql-capture/`.
7. Write a flow doc at `docs/graphql-capture/flows/NN-<area>.md` describing the narrative: screens visited, operations observed per screen in order, dependencies between operations, quirks.
8. Report to the operator:
   - Operations captured in this area (query names, mutation names).
   - Screens visited.
   - Anything skipped and why.
   - Anything unexpected.

## Mutation capture

Most mutations cannot be observed without actually submitting a form. For each mutation category:

- Create a test entity: name it `GQL-TEST` (budget, category, goal, tag) or use a small value (transaction amount near zero, recurring with a clearly-fake merchant).
- Update that entity to observe update mutations.
- Delete that entity to observe delete mutations.
- Ask the operator for approval **before** each destructive action. The operator may approve a category up front ("go ahead with all the budget mutations on GQL-TEST entities").

**Never:**
- Connect/disconnect bank accounts.
- Trigger sync on real accounts.
- Submit real money-moving actions (transfers, payments).
- Touch the subscription/billing surface beyond read-only browsing.

## Autonomy upgrade

After area 1 the operator reviews your output. If they approve continuing autonomously, proceed through areas 2–14 without per-area approval, BUT:

- Still stop and ask before each destructive mutation category.
- Still stop if you encounter a new top-level surface not in the crawl plan.
- Still stop on any auth error, rate-limit-looking response, or suspected anti-bot signal.

## End of crawl

1. Have the operator export the HAR file to `docs/graphql-capture/raw/session-YYYY-MM-DD.har`.
2. Write the top-level `docs/graphql-capture/README.md` with: capture date(s), Copilot web app version (grep `build` / version strings from an observed response if visible), browser/OS, account shape (which account types were connected, which surfaces were empty/unavailable), any gaps in coverage.
3. Write `docs/graphql-capture/schema/types.md` with observed GraphQL types and fields inferred from responses. Group by top-level type name when discoverable from `__typename` fields.
4. Report final statistics: total unique operations (queries + mutations), total observations, total screens covered, gaps.

## What a good output looks like

- Every file in `operations/queries/` and `operations/mutations/` has a fully filled template (no `<fill in from flow docs>` remaining).
- Every operation file links back to the flow(s) where it was observed.
- `schema/operations.md` is a complete index.
- `flows/NN-*.md` describes WHY operations fire in the order they do (e.g. "account detail fires GetAccount then GetAccountTransactions then GetAccountBalanceHistory in parallel — balance history waits for GetAccount's currency field").
- `raw/captured-log.jsonl` has one entry per GraphQL call and is the canonical source.
- `raw/session-*.har` is the belt-and-suspenders backup.
````

- [ ] **Step 2: Commit**

```bash
git add scripts/graphql-capture/crawl-prompt.md
git commit -m "docs(graphql-capture): add agent crawl SOP"
```

---

## Task 7: Execute area 1 (dashboard) — pilot run

This task is executed by the operator + a dispatched subagent following `scripts/graphql-capture/crawl-prompt.md`. It is NOT a code task. Its purpose is to validate the entire pipeline end-to-end before committing to the full crawl.

- [ ] **Step 1: Confirm preconditions**

- [ ] `docs/graphql-capture/` is gitignored (`git check-ignore -v docs/graphql-capture/` should show a match).
- [ ] `docs/graphql-capture/raw/captured-log.jsonl` exists and is empty (or create it empty).
- [ ] Operator confirms DevTools open, interceptor installed, page reloaded.

- [ ] **Step 2: Dispatch the pilot subagent**

Dispatch a subagent with the prompt: "Follow `scripts/graphql-capture/crawl-prompt.md`. Execute area 1 (Dashboard) only. Stop at the end-of-area report. Do NOT continue to area 2."

- [ ] **Step 3: Review area 1 output**

Inspect:
- `docs/graphql-capture/raw/captured-log.jsonl` — does it have entries? Do headers look properly captured?
- `docs/graphql-capture/raw/scrubbed.jsonl` — are PII fields replaced with `<merchant>`, `<amount>`, `<id>`, etc? Spot-check a few entries against the raw.
- `docs/graphql-capture/operations/` — do operation files exist for what the dashboard fires?
- `docs/graphql-capture/flows/01-dashboard.md` — is the narrative useful?

If anything is wrong, fix the scrubber/generator/prompt before continuing.

- [ ] **Step 4: Decide on autonomy**

If area 1 looks good, grant the agent permission to continue through areas 2–14 autonomously (per the design's autonomy clause). Otherwise, keep per-area approval for the next area and reassess.

- [ ] **Step 5: Commit progress markers (optional)**

Do NOT commit anything under `docs/graphql-capture/` yet — it's gitignored by design. If you want a progress marker, create `docs/superpowers/plans/2026-04-14-graphql-capture-progress.md` and update it.

---

## Task 8: Execute areas 2–14

- [ ] **Step 1: Dispatch the full-crawl subagent**

With operator permission, dispatch a subagent: "Follow `scripts/graphql-capture/crawl-prompt.md`. Areas 1 is already complete. Continue through areas 2 to 14. You have autonomy to proceed between areas without approval, but retain the safety gates (no destructive actions without approval, stop on unexpected surfaces or anti-bot signals)."

- [ ] **Step 2: Monitor and spot-check**

During the crawl the operator periodically spot-checks flow docs as they're produced. If a flow doc is thin or misses something, the operator can pause the agent and have it re-capture that specific flow.

- [ ] **Step 3: Final drain and HAR export**

At end of crawl:
- Operator exports HAR to `docs/graphql-capture/raw/session-YYYY-MM-DD.har`.
- Agent does final log drain, scrub, doc regen.

---

## Task 9: Final index and review

- [ ] **Step 1: Agent produces final README and schema types doc**

Per the "End of crawl" section of the crawl prompt.

- [ ] **Step 2: Operator reviews end-to-end**

- [ ] Skim every file under `docs/graphql-capture/operations/` for residual PII.
- [ ] Read `docs/graphql-capture/README.md` — does it accurately describe what was captured and any gaps?
- [ ] Check `schema/operations.md` — is the index complete?
- [ ] Grep for suspicious patterns: `grep -rE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' docs/graphql-capture/operations/` should return nothing (no leaked emails). Similar for phone patterns, real-looking account numbers.

- [ ] **Step 3: Decide on committing**

If everything looks good, decide whether to commit `docs/graphql-capture/` to the repo. If yes: remove the gitignore entry, `git add docs/graphql-capture/`, commit with `docs(graphql-capture): add captured API documentation`. **Do not commit `docs/graphql-capture/raw/`** — that stays local only, add a separate gitignore rule for `docs/graphql-capture/raw/`.

- [ ] **Step 4: Create PR**

```bash
git push -u origin <branch>
gh pr create --title "docs: capture copilot graphql api surface" --body "$(cat <<'EOF'
## Summary
- Captures every GraphQL query and mutation the Copilot Money web app issues
- Produces per-operation markdown docs with scrubbed example request/response pairs
- Unblocks rewriting our 18 write tools off direct Firestore onto the official API

## Test plan
- [x] Scrubber unit tests
- [x] Doc generator unit tests
- [x] End-to-end capture session reviewed manually for residual PII
- [ ] Follow-up: implementation plan for write-tool rewrite (separate PR)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes on sequencing

- Tasks 1–6 are pure code/docs and can be completed in a single session with TDD and commits between each.
- Task 7 requires the operator to be present (DevTools, pasting interceptor, reviewing area 1).
- Task 8 can run autonomously once area 1 is approved.
- Task 9 is operator review + PR.

The natural breakpoint is after Task 6: everything needed to drive the crawl is in place, reviewed, and on disk. Task 7 onward is "actually running the capture."
