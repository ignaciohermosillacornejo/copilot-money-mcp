# Firestore Write Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add write capabilities to the MCP server via Firestore REST API, starting with `set_transaction_category` as the first write tool.

**Architecture:** Read-only by default, opt-in `--write` flag conditionally registers write tools. Writes go to Firestore REST API authenticated via Firebase tokens extracted from the user's browser. A shared format layer converts between TypeScript objects and Firestore REST JSON, validating our read decoding in the process.

**Tech Stack:** TypeScript, Bun test runner, native `fetch` (no new dependencies), Firestore REST API, Firebase Auth REST API

**Spec:** `docs/superpowers/specs/2026-04-05-firestore-write-operations-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/core/format/firestore-rest.ts` | Convert TS values → Firestore REST JSON and back |
| `src/core/auth/browser-token.ts` | Extract Firebase refresh token from browser LevelDB files |
| `src/core/auth/firebase-auth.ts` | Exchange refresh token for ID token, cache, auto-refresh |
| `src/core/firestore-client.ts` | Thin wrapper for Firestore REST API PATCH calls |
| `tests/core/format/firestore-rest.test.ts` | Tests for Firestore REST value encoding/decoding |
| `tests/core/auth/browser-token.test.ts` | Tests for browser token extraction |
| `tests/core/auth/firebase-auth.test.ts` | Tests for Firebase auth token exchange |
| `tests/core/firestore-client.test.ts` | Tests for Firestore REST client |

### Modified Files
| File | Changes |
|------|---------|
| `src/cli.ts` | Add `--write` flag parsing |
| `src/server.ts` | Accept `writeEnabled`, conditional tool registration, wire write tool dispatch |
| `src/tools/tools.ts` | Extend `ToolSchema` annotations, add `createWriteToolSchemas()`, add `setTransactionCategory()` method |
| `src/tools/index.ts` | Export `createWriteToolSchemas` |
| `src/core/database.ts` | Add `patchCachedTransaction()` method |
| `manifest.json` | Add `set_transaction_category` tool entry |
| `tests/tools/tools.test.ts` | Add tests for `setTransactionCategory` |
| `tests/server.test.ts` | Add tests for `--write` mode conditional registration |

---

### Task 1: Firestore REST Value Encoding

**Files:**
- Create: `src/core/format/firestore-rest.ts`
- Create: `tests/core/format/firestore-rest.test.ts`

This module converts TypeScript values to Firestore REST API JSON format and back. The Firestore REST API uses a typed-value envelope like `{ stringValue: "hello" }` rather than bare values.

- [ ] **Step 1: Write failing tests for value encoding**

Create `tests/core/format/firestore-rest.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import {
  toFirestoreValue,
  fromFirestoreValue,
  toFirestoreFields,
  type FirestoreRestValue,
} from '../../src/core/format/firestore-rest.js';

describe('toFirestoreValue', () => {
  test('encodes string', () => {
    expect(toFirestoreValue('hello')).toEqual({ stringValue: 'hello' });
  });

  test('encodes integer number', () => {
    expect(toFirestoreValue(42)).toEqual({ integerValue: '42' });
  });

  test('encodes float number', () => {
    expect(toFirestoreValue(3.14)).toEqual({ doubleValue: 3.14 });
  });

  test('encodes boolean', () => {
    expect(toFirestoreValue(true)).toEqual({ booleanValue: true });
    expect(toFirestoreValue(false)).toEqual({ booleanValue: false });
  });

  test('encodes null', () => {
    expect(toFirestoreValue(null)).toEqual({ nullValue: null });
  });

  test('encodes string array', () => {
    expect(toFirestoreValue(['a', 'b'])).toEqual({
      arrayValue: {
        values: [{ stringValue: 'a' }, { stringValue: 'b' }],
      },
    });
  });

  test('encodes empty array', () => {
    expect(toFirestoreValue([])).toEqual({
      arrayValue: { values: [] },
    });
  });

  test('encodes nested map', () => {
    expect(toFirestoreValue({ key: 'val' })).toEqual({
      mapValue: {
        fields: { key: { stringValue: 'val' } },
      },
    });
  });
});

describe('fromFirestoreValue', () => {
  test('decodes string', () => {
    expect(fromFirestoreValue({ stringValue: 'hello' })).toBe('hello');
  });

  test('decodes integerValue', () => {
    expect(fromFirestoreValue({ integerValue: '42' })).toBe(42);
  });

  test('decodes doubleValue', () => {
    expect(fromFirestoreValue({ doubleValue: 3.14 })).toBe(3.14);
  });

  test('decodes boolean', () => {
    expect(fromFirestoreValue({ booleanValue: true })).toBe(true);
  });

  test('decodes null', () => {
    expect(fromFirestoreValue({ nullValue: null })).toBeNull();
  });

  test('decodes array', () => {
    const val: FirestoreRestValue = {
      arrayValue: { values: [{ stringValue: 'a' }, { integerValue: '1' }] },
    };
    expect(fromFirestoreValue(val)).toEqual(['a', 1]);
  });

  test('decodes map', () => {
    const val: FirestoreRestValue = {
      mapValue: { fields: { name: { stringValue: 'test' } } },
    };
    expect(fromFirestoreValue(val)).toEqual({ name: 'test' });
  });
});

describe('toFirestoreFields', () => {
  test('converts flat object to Firestore fields', () => {
    const result = toFirestoreFields({ category_id: 'food', amount: 42.5 });
    expect(result).toEqual({
      category_id: { stringValue: 'food' },
      amount: { doubleValue: 42.5 },
    });
  });

  test('skips undefined values', () => {
    const result = toFirestoreFields({ a: 'yes', b: undefined });
    expect(result).toEqual({ a: { stringValue: 'yes' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/format/firestore-rest.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement Firestore REST value encoding**

Create `src/core/format/firestore-rest.ts`:

```typescript
/**
 * Firestore REST API value encoding/decoding.
 *
 * Converts between TypeScript values and the Firestore REST API's
 * typed-value envelope format (e.g., { stringValue: "hello" }).
 *
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/Value
 */

/** Firestore REST API value types. */
export type FirestoreRestValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values: FirestoreRestValue[] } }
  | { mapValue: { fields: Record<string, FirestoreRestValue> } };

/** A set of Firestore document fields. */
export type FirestoreFields = Record<string, FirestoreRestValue>;

/**
 * Convert a TypeScript value to Firestore REST API format.
 */
export function toFirestoreValue(value: unknown): FirestoreRestValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toFirestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

/**
 * Decode a Firestore REST API value back to a TypeScript value.
 */
export function fromFirestoreValue(val: FirestoreRestValue): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return val.arrayValue.values.map(fromFirestoreValue);
  if ('mapValue' in val) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields)) {
      result[k] = fromFirestoreValue(v);
    }
    return result;
  }
  throw new Error(`Unknown Firestore value type: ${JSON.stringify(val)}`);
}

/**
 * Convert a flat TypeScript object to Firestore REST document fields.
 * Skips undefined values.
 */
export function toFirestoreFields(obj: Record<string, unknown>): FirestoreFields {
  const fields: FirestoreFields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      fields[key] = toFirestoreValue(value);
    }
  }
  return fields;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/format/firestore-rest.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/format/firestore-rest.ts tests/core/format/firestore-rest.test.ts
git commit -m "feat: add Firestore REST API value encoding/decoding layer"
```

---

### Task 2: Browser Token Extraction

**Files:**
- Create: `src/core/auth/browser-token.ts`
- Create: `tests/core/auth/browser-token.test.ts`

Extracts Firebase refresh tokens from browser LevelDB files. Searches Chrome, Arc, Safari, and Firefox in order. Uses `strings` command on `.ldb`/`.log` files and matches the regex `AMf-[A-Za-z0-9_-]{100,}`.

- [ ] **Step 1: Write failing tests for browser token extraction**

Create `tests/core/auth/browser-token.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { extractRefreshToken, BROWSER_CONFIGS, type BrowserConfig } from '../../src/core/auth/browser-token.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('BROWSER_CONFIGS', () => {
  test('defines configs for Chrome, Arc, Safari, and Firefox', () => {
    const names = BROWSER_CONFIGS.map((b) => b.name);
    expect(names).toContain('Chrome');
    expect(names).toContain('Arc');
    expect(names).toContain('Safari');
    expect(names).toContain('Firefox');
    expect(names).toHaveLength(4);
  });
});

describe('extractRefreshToken', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browser-token-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('extracts token from .ldb file containing refresh token', async () => {
    // Create a fake LevelDB directory with a .ldb file containing a token
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const fakeToken = 'AMf-' + 'a'.repeat(200);
    writeFileSync(join(ldbDir, '000001.ldb'), `some data ${fakeToken} more data`);

    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: [ldbDir], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
    expect(result.browser).toBe('TestBrowser');
  });

  test('extracts token from .log file', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const fakeToken = 'AMf-' + 'B'.repeat(150);
    writeFileSync(join(ldbDir, '000001.log'), `prefix ${fakeToken} suffix`);

    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: [ldbDir], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
  });

  test('returns error when no token found in any browser', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    writeFileSync(join(ldbDir, '000001.ldb'), 'no tokens here');

    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: [ldbDir], type: 'chromium' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow(
      'No Copilot Money session found'
    );
  });

  test('returns error when directory does not exist', async () => {
    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: ['/nonexistent/path'], type: 'chromium' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow(
      'No Copilot Money session found'
    );
  });

  test('skips invalid tokens that are too short', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    // Token with AMf- prefix but too short (< 100 chars after prefix)
    const shortToken = 'AMf-' + 'a'.repeat(50);
    writeFileSync(join(ldbDir, '000001.ldb'), shortToken);

    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: [ldbDir], type: 'chromium' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow(
      'No Copilot Money session found'
    );
  });

  test('tries multiple browsers in order, returns first match', async () => {
    const dir1 = join(tempDir, 'browser1');
    const dir2 = join(tempDir, 'browser2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const token1 = 'AMf-' + 'X'.repeat(200);
    const token2 = 'AMf-' + 'Y'.repeat(200);
    writeFileSync(join(dir1, '000001.ldb'), token1);
    writeFileSync(join(dir2, '000001.ldb'), token2);

    const overrides: BrowserConfig[] = [
      { name: 'FirstBrowser', paths: [dir1], type: 'chromium' },
      { name: 'SecondBrowser', paths: [dir2], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(token1);
    expect(result.browser).toBe('FirstBrowser');
  });

  test('skips first browser if no token, finds in second', async () => {
    const dir1 = join(tempDir, 'browser1');
    const dir2 = join(tempDir, 'browser2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    writeFileSync(join(dir1, '000001.ldb'), 'no tokens');
    const token2 = 'AMf-' + 'Z'.repeat(200);
    writeFileSync(join(dir2, '000001.ldb'), token2);

    const overrides: BrowserConfig[] = [
      { name: 'EmptyBrowser', paths: [dir1], type: 'chromium' },
      { name: 'HasToken', paths: [dir2], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(token2);
    expect(result.browser).toBe('HasToken');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/auth/browser-token.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement browser token extraction**

Create `src/core/auth/browser-token.ts`:

```typescript
/**
 * Browser token extractor for Firebase refresh tokens.
 *
 * Searches Chrome, Arc, Safari, and Firefox LevelDB/IndexedDB storage
 * for Copilot Money Firebase refresh tokens (prefixed with "AMf-").
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Configuration for a browser's token storage location. */
export interface BrowserConfig {
  name: string;
  paths: string[];
  type: 'chromium' | 'safari' | 'firefox';
}

/** Result of a successful token extraction. */
export interface TokenResult {
  token: string;
  browser: string;
}

/** Firebase refresh token regex: AMf- followed by 100+ URL-safe base64 chars. */
const REFRESH_TOKEN_REGEX = /AMf-[A-Za-z0-9_-]{100,}/g;

/** Default browser configurations for macOS. */
export const BROWSER_CONFIGS: BrowserConfig[] = [
  {
    name: 'Chrome',
    paths: [
      join(
        homedir(),
        'Library/Application Support/Google/Chrome/Default/Local Storage/leveldb'
      ),
      join(
        homedir(),
        'Library/Application Support/Google/Chrome/Profile 1/Local Storage/leveldb'
      ),
    ],
    type: 'chromium',
  },
  {
    name: 'Arc',
    paths: [
      join(
        homedir(),
        'Library/Application Support/Arc/User Data/Default/Local Storage/leveldb'
      ),
    ],
    type: 'chromium',
  },
  {
    name: 'Safari',
    paths: [join(homedir(), 'Library/Safari/Databases')],
    type: 'safari',
  },
  {
    name: 'Firefox',
    paths: [join(homedir(), 'Library/Application Support/Firefox/Profiles')],
    type: 'firefox',
  },
];

/**
 * Search a directory for .ldb and .log files containing refresh tokens.
 * Uses direct file reading and regex matching.
 */
function searchLevelDBDir(dirPath: string): string | undefined {
  if (!existsSync(dirPath)) return undefined;

  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return undefined;
  }

  const targetFiles = files.filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));

  for (const file of targetFiles) {
    try {
      const content = readFileSync(join(dirPath, file), 'latin1');
      const matches = content.match(REFRESH_TOKEN_REGEX);
      if (matches && matches.length > 0) {
        // Return the longest match (most likely to be complete)
        return matches.reduce((a, b) => (a.length >= b.length ? a : b));
      }
    } catch {
      // Skip unreadable files
    }
  }
  return undefined;
}

/**
 * Search Firefox profiles for refresh tokens.
 * Firefox stores IndexedDB data in .sqlite files under profile directories.
 */
function searchFirefoxProfiles(profilesDir: string): string | undefined {
  if (!existsSync(profilesDir)) return undefined;

  try {
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const profile of profiles) {
      // Firefox stores IndexedDB under storage/default/
      const idbBase = join(profilesDir, profile, 'storage/default');
      if (!existsSync(idbBase)) continue;

      const origins = readdirSync(idbBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.includes('copilot'))
        .map((d) => d.name);

      for (const origin of origins) {
        const idbDir = join(idbBase, origin, 'idb');
        if (!existsSync(idbDir)) continue;

        // Search .sqlite and other files for tokens
        const files = readdirSync(idbDir);
        for (const file of files) {
          try {
            const content = readFileSync(join(idbDir, file), 'latin1');
            const matches = content.match(REFRESH_TOKEN_REGEX);
            if (matches && matches.length > 0) {
              return matches.reduce((a, b) => (a.length >= b.length ? a : b));
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  } catch {
    // Skip if profiles directory is unreadable
  }
  return undefined;
}

/**
 * Search Safari databases for refresh tokens.
 * Safari stores IndexedDB data under ~/Library/Safari/Databases/.
 */
function searchSafariDatabases(dbDir: string): string | undefined {
  if (!existsSync(dbDir)) return undefined;

  try {
    // Recursively search for files that might contain tokens
    const searchDir = (dir: string, depth: number): string | undefined => {
      if (depth > 4) return undefined;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = searchDir(fullPath, depth + 1);
          if (found) return found;
        } else if (entry.isFile()) {
          try {
            const content = readFileSync(fullPath, 'latin1');
            const matches = content.match(REFRESH_TOKEN_REGEX);
            if (matches && matches.length > 0) {
              return matches.reduce((a, b) => (a.length >= b.length ? a : b));
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
      return undefined;
    };

    return searchDir(dbDir, 0);
  } catch {
    return undefined;
  }
}

/**
 * Extract a Firebase refresh token from browser local storage.
 *
 * Searches browsers in order: Chrome, Arc, Safari, Firefox.
 * Returns the first valid token found.
 *
 * @param browserOverrides - Override browser configs for testing
 * @throws Error if no token is found in any browser
 */
export async function extractRefreshToken(
  browserOverrides?: BrowserConfig[]
): Promise<TokenResult> {
  const browsers = browserOverrides ?? BROWSER_CONFIGS;
  const checked: string[] = [];

  for (const browser of browsers) {
    checked.push(browser.name);

    for (const searchPath of browser.paths) {
      let token: string | undefined;

      switch (browser.type) {
        case 'chromium':
          token = searchLevelDBDir(searchPath);
          break;
        case 'firefox':
          token = searchFirefoxProfiles(searchPath);
          break;
        case 'safari':
          token = searchSafariDatabases(searchPath);
          break;
      }

      if (token) {
        return { token, browser: browser.name };
      }
    }
  }

  throw new Error(
    `No Copilot Money session found. Searched: ${checked.join(', ')}. ` +
      'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/auth/browser-token.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/auth/browser-token.ts tests/core/auth/browser-token.test.ts
git commit -m "feat: add browser token extraction for Firebase refresh tokens"
```

---

### Task 3: Firebase Auth Token Exchange

**Files:**
- Create: `src/core/auth/firebase-auth.ts`
- Create: `tests/core/auth/firebase-auth.test.ts`

Exchanges a Firebase refresh token for an ID token via the Firebase Auth REST API. Caches the ID token in memory and auto-refreshes when expired.

- [ ] **Step 1: Write failing tests for Firebase auth**

Create `tests/core/auth/firebase-auth.test.ts`:

```typescript
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';

// Mock token extractor
const mockExtractor = mock(() =>
  Promise.resolve({ token: 'AMf-fake-refresh-token', browser: 'Chrome' })
);

// Capture fetch calls
let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(response: object, status = 200) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe('FirebaseAuth', () => {
  let auth: FirebaseAuth;

  beforeEach(() => {
    mockExtractor.mockClear();
    auth = new FirebaseAuth(mockExtractor);
  });

  test('exchanges refresh token for ID token', async () => {
    mockFetch({
      id_token: 'fake-id-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token = await auth.getIdToken();

    expect(token).toBe('fake-id-token');
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('securetoken.googleapis.com');

    restoreFetch();
  });

  test('caches token on subsequent calls', async () => {
    mockFetch({
      id_token: 'cached-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token1 = await auth.getIdToken();
    const token2 = await auth.getIdToken();

    expect(token1).toBe('cached-token');
    expect(token2).toBe('cached-token');
    // Should only call extract + fetch once
    expect(mockExtractor).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    restoreFetch();
  });

  test('returns userId from token exchange', async () => {
    mockFetch({
      id_token: 'fake-id-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    await auth.getIdToken();
    expect(auth.getUserId()).toBe('user123');

    restoreFetch();
  });

  test('throws on failed token exchange', async () => {
    mockFetch({ error: { message: 'INVALID_REFRESH_TOKEN' } }, 400);

    await expect(auth.getIdToken()).rejects.toThrow('Firebase token exchange failed');

    restoreFetch();
  });

  test('refreshes expired token', async () => {
    // First call returns a token that "expires" immediately
    mockFetch({
      id_token: 'first-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '0', // expires immediately
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token1 = await auth.getIdToken();
    expect(token1).toBe('first-token');

    // Second call should trigger refresh
    mockFetch({
      id_token: 'refreshed-token',
      refresh_token: 'AMf-fake-refresh-token',
      expires_in: '3600',
      token_type: 'Bearer',
      user_id: 'user123',
    });

    const token2 = await auth.getIdToken();
    expect(token2).toBe('refreshed-token');
    expect(fetchCalls).toHaveLength(2);

    restoreFetch();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/auth/firebase-auth.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement Firebase auth**

Create `src/core/auth/firebase-auth.ts`:

```typescript
/**
 * Firebase Auth token exchange and caching.
 *
 * Exchanges a Firebase refresh token for an ID token using the
 * Firebase Auth REST API. Caches the token in memory and auto-refreshes
 * when expired (3600 second lifetime).
 */

import type { TokenResult } from './browser-token.js';

/** Firebase API key for Copilot Money (public, same as in the web app). */
const FIREBASE_API_KEY = 'AIzaSyBi2Ht5k9K94Yi6McMSGyKeOcHC7vEsN_I';

/** Firebase token exchange endpoint. */
const TOKEN_ENDPOINT = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

/** Safety margin before token expiry (refresh 60s early). */
const EXPIRY_MARGIN_MS = 60_000;

/** Type for the token extractor function (allows dependency injection for testing). */
export type TokenExtractor = () => Promise<TokenResult>;

/**
 * Firebase Auth client.
 *
 * Handles token exchange and in-memory caching with auto-refresh.
 */
export class FirebaseAuth {
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;
  private expiresAt: number = 0;
  private extractToken: TokenExtractor;

  constructor(extractToken: TokenExtractor) {
    this.extractToken = extractToken;
  }

  /**
   * Get a valid Firebase ID token.
   *
   * On first call, extracts refresh token from browser and exchanges it.
   * On subsequent calls, returns cached token or refreshes if expired.
   */
  async getIdToken(): Promise<string> {
    if (this.idToken && Date.now() < this.expiresAt) {
      return this.idToken;
    }

    // Extract refresh token from browser if we don't have one
    if (!this.refreshToken) {
      const result = await this.extractToken();
      this.refreshToken = result.token;
    }

    await this.exchangeToken();
    return this.idToken!;
  }

  /** Get the authenticated user's Firebase UID (available after first getIdToken call). */
  getUserId(): string | null {
    return this.userId;
  }

  /** Exchange the refresh token for a new ID token. */
  private async exchangeToken(): Promise<void> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshToken!)}`,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Clear stale refresh token so next attempt re-extracts from browser
      this.refreshToken = null;
      throw new Error(`Firebase token exchange failed (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
      user_id: string;
    };

    this.idToken = data.id_token;
    this.refreshToken = data.refresh_token;
    this.userId = data.user_id;
    this.expiresAt = Date.now() + Number(data.expires_in) * 1000 - EXPIRY_MARGIN_MS;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/auth/firebase-auth.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/auth/firebase-auth.ts tests/core/auth/firebase-auth.test.ts
git commit -m "feat: add Firebase auth token exchange with in-memory caching"
```

---

### Task 4: Firestore REST Client

**Files:**
- Create: `src/core/firestore-client.ts`
- Create: `tests/core/firestore-client.test.ts`

Thin wrapper around the Firestore REST API for document updates using `PATCH` with `updateMask`.

- [ ] **Step 1: Write failing tests for Firestore client**

Create `tests/core/firestore-client.test.ts`:

```typescript
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { FirestoreClient } from '../../src/core/firestore-client.js';
import type { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';

// Capture fetch calls
let fetchCalls: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

function mockFetch(responseBody: object, status = 200) {
  fetchCalls = [];
  globalThis.fetch = mock((url: string | URL | Request, options?: RequestInit) => {
    fetchCalls.push({ url: String(url), options: options ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Mock FirebaseAuth
function createMockAuth(idToken = 'test-id-token', userId = 'user123'): FirebaseAuth {
  return {
    getIdToken: mock(() => Promise.resolve(idToken)),
    getUserId: () => userId,
  } as unknown as FirebaseAuth;
}

describe('FirestoreClient', () => {
  let client: FirestoreClient;
  let mockAuth: FirebaseAuth;

  beforeEach(() => {
    mockAuth = createMockAuth();
    client = new FirestoreClient(mockAuth);
  });

  test('sends PATCH request with correct URL and updateMask', async () => {
    mockFetch({ name: 'projects/copilot-production-22904/databases/(default)/documents/transactions/txn1', fields: {} });

    await client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, ['category_id']);

    expect(fetchCalls).toHaveLength(1);
    const url = new URL(fetchCalls[0].url);
    expect(url.pathname).toBe(
      '/v1/projects/copilot-production-22904/databases/(default)/documents/transactions/txn1'
    );
    expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual(['category_id']);

    restoreFetch();
  });

  test('sends Authorization header with Bearer token', async () => {
    mockFetch({ name: 'doc', fields: {} });

    await client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, ['category_id']);

    const headers = fetchCalls[0].options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-id-token');

    restoreFetch();
  });

  test('sends correct JSON body with fields', async () => {
    mockFetch({ name: 'doc', fields: {} });

    await client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'new_cat' } }, ['category_id']);

    const body = JSON.parse(fetchCalls[0].options.body as string);
    expect(body).toEqual({
      fields: { category_id: { stringValue: 'new_cat' } },
    });

    restoreFetch();
  });

  test('supports multiple updateMask fields', async () => {
    mockFetch({ name: 'doc', fields: {} });

    await client.updateDocument(
      'transactions',
      'txn1',
      {
        category_id: { stringValue: 'food' },
        user_reviewed: { booleanValue: true },
      },
      ['category_id', 'user_reviewed']
    );

    const url = new URL(fetchCalls[0].url);
    expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual([
      'category_id',
      'user_reviewed',
    ]);

    restoreFetch();
  });

  test('throws on non-OK response', async () => {
    mockFetch(
      { error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } },
      404
    );

    await expect(
      client.updateDocument('transactions', 'txn1', { category_id: { stringValue: 'food' } }, ['category_id'])
    ).rejects.toThrow('Firestore update failed');

    restoreFetch();
  });

  test('throws on permission denied', async () => {
    mockFetch(
      { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } },
      403
    );

    await expect(
      client.updateDocument('transactions', 'bad', { category_id: { stringValue: 'x' } }, ['category_id'])
    ).rejects.toThrow('Firestore update failed');

    restoreFetch();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/firestore-client.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement Firestore REST client**

Create `src/core/firestore-client.ts`:

```typescript
/**
 * Firestore REST API client for document writes.
 *
 * Thin wrapper around the Firestore REST API using native fetch.
 * Uses PATCH with updateMask for partial document updates.
 *
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch
 */

import type { FirebaseAuth } from './auth/firebase-auth.js';
import type { FirestoreFields } from './format/firestore-rest.js';

/** Firestore project configuration. */
const FIRESTORE_PROJECT_ID = 'copilot-production-22904';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';

/**
 * Client for Firestore REST API document operations.
 */
export class FirestoreClient {
  constructor(private auth: FirebaseAuth) {}

  /**
   * Update specific fields on a Firestore document.
   *
   * Uses PATCH with updateMask to only modify the specified fields,
   * leaving all other fields on the document untouched.
   *
   * @param collectionPath - Firestore collection path (e.g., "transactions")
   * @param documentId - Document ID within the collection
   * @param fields - Fields to update in Firestore REST format
   * @param updateMask - List of field paths to update
   */
  async updateDocument(
    collectionPath: string,
    documentId: string,
    fields: FirestoreFields,
    updateMask: string[]
  ): Promise<void> {
    const idToken = await this.auth.getIdToken();

    const docPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collectionPath}/${documentId}`;
    const url = new URL(`${FIRESTORE_BASE_URL}/${docPath}`);
    for (const field of updateMask) {
      url.searchParams.append('updateMask.fieldPaths', field);
    }

    const response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore update failed (${response.status}): ${errorBody}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/firestore-client.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/firestore-client.ts tests/core/firestore-client.test.ts
git commit -m "feat: add Firestore REST client for document updates"
```

---

### Task 5: --write Flag and Conditional Tool Registration

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/server.ts`
- Modify: `src/tools/tools.ts:2166-2178` (extend `ToolSchema` annotations)
- Modify: `src/tools/tools.ts` (add `createWriteToolSchemas()`)
- Modify: `src/tools/index.ts`
- Modify: `tests/server.test.ts`

- [ ] **Step 1: Write failing tests for --write mode**

Add to `tests/server.test.ts` (the test for conditional tool listing). First read the existing file to find the right insertion point, then add:

```typescript
import { describe, test, expect } from 'bun:test';
import { CopilotMoneyServer } from '../src/server.js';
import { createToolSchemas, createWriteToolSchemas } from '../src/tools/index.js';

describe('CopilotMoneyServer tool registration', () => {
  test('handleListTools returns only read tools by default', () => {
    const server = new CopilotMoneyServer();
    const result = server.handleListTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain('get_transactions');
    expect(toolNames).not.toContain('set_transaction_category');
  });

  test('handleListTools returns read + write tools when writeEnabled', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const toolNames = result.tools.map((t) => t.name);

    expect(toolNames).toContain('get_transactions');
    expect(toolNames).toContain('set_transaction_category');
  });

  test('write tool has correct annotations', () => {
    const server = new CopilotMoneyServer(undefined, undefined, true);
    const result = server.handleListTools();
    const writeTool = result.tools.find((t) => t.name === 'set_transaction_category');

    expect(writeTool).toBeDefined();
    expect(writeTool!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  test('handleCallTool rejects write tool when not in write mode', async () => {
    const server = new CopilotMoneyServer();
    const result = await server.handleCallTool('set_transaction_category', {
      transaction_id: 'txn1',
      category_id: 'food',
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Unknown tool');
  });
});

describe('createWriteToolSchemas', () => {
  test('returns write tool schemas with proper annotations', () => {
    const schemas = createWriteToolSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(1);

    const setCat = schemas.find((s) => s.name === 'set_transaction_category');
    expect(setCat).toBeDefined();
    expect(setCat!.annotations?.readOnlyHint).toBe(false);
    expect(setCat!.inputSchema.required).toContain('transaction_id');
    expect(setCat!.inputSchema.required).toContain('category_id');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server.test.ts`
Expected: FAIL — `createWriteToolSchemas` does not exist, `CopilotMoneyServer` constructor does not accept 3rd arg

- [ ] **Step 3: Extend ToolSchema annotations type**

In `src/tools/tools.ts`, update the `ToolSchema` interface (around line 2166):

```typescript
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema properties require flexible typing
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}
```

- [ ] **Step 4: Add createWriteToolSchemas function**

In `src/tools/tools.ts`, after the `createToolSchemas()` function (after the closing of the return array), add:

```typescript
/**
 * Create MCP tool schemas for write tools.
 *
 * These are only registered when the server is started with --write flag.
 *
 * @returns List of write tool schema definitions
 */
export function createWriteToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'set_transaction_category',
      description:
        'Change the category of a transaction. Requires transaction_id (from get_transactions) ' +
        'and category_id (from get_categories). Writes directly to Copilot Money via Firestore.',
      inputSchema: {
        type: 'object',
        properties: {
          transaction_id: {
            type: 'string',
            description: 'Transaction ID to update (from get_transactions results)',
          },
          category_id: {
            type: 'string',
            description: 'New category ID to assign (from get_categories results)',
          },
        },
        required: ['transaction_id', 'category_id'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
  ];
}
```

- [ ] **Step 5: Export createWriteToolSchemas from index**

In `src/tools/index.ts`, update:

```typescript
export { CopilotMoneyTools, createToolSchemas, createWriteToolSchemas, type ToolSchema } from './tools.js';
```

- [ ] **Step 6: Add --write flag to CLI**

In `src/cli.ts`, update `parseArgs` to return `writeEnabled`:

Change the return type to include `writeEnabled: boolean`:
```typescript
function parseArgs(): { dbPath?: string; verbose: boolean; timeoutMs?: number; writeEnabled: boolean }
```

Add `let writeEnabled = false;` alongside the other variable declarations.

Add this case in the arg parsing loop:
```typescript
} else if (arg === '--write') {
  writeEnabled = true;
}
```

Update the help text to include `--write`:
```
  --write             Enable write tools (read-only by default)
```

Update the return: `return { dbPath, verbose, timeoutMs, writeEnabled };`

Update `main()` to pass `writeEnabled`:
```typescript
const { dbPath, verbose, timeoutMs, writeEnabled } = parseArgs();
// ...
await runServer(dbPath, timeoutMs, writeEnabled);
```

Add verbose logging for write mode:
```typescript
if (writeEnabled) {
  console.log('Write mode ENABLED — write tools will be available');
}
```

- [ ] **Step 7: Update server constructor and handleListTools**

In `src/server.ts`, update the constructor to accept `writeEnabled`:

```typescript
private writeEnabled: boolean;

constructor(dbPath?: string, decodeTimeoutMs?: number, writeEnabled = false) {
  this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
  this.tools = new CopilotMoneyTools(this.db);
  this.writeEnabled = writeEnabled;
  // ... rest unchanged
}
```

Update `handleListTools()`:

```typescript
import { CopilotMoneyTools, createToolSchemas, createWriteToolSchemas } from './tools/index.js';

handleListTools(): { tools: Tool[] } {
  const readSchemas = createToolSchemas();
  const allSchemas = this.writeEnabled
    ? [...readSchemas, ...createWriteToolSchemas()]
    : readSchemas;

  const tools: Tool[] = allSchemas.map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
    annotations: schema.annotations,
  }));

  return { tools };
}
```

Update `runServer`:

```typescript
export async function runServer(
  dbPath?: string,
  decodeTimeoutMs?: number,
  writeEnabled = false
): Promise<void> {
  const server = new CopilotMoneyServer(dbPath, decodeTimeoutMs, writeEnabled);
  await server.run();
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test tests/server.test.ts`
Expected: all PASS

- [ ] **Step 9: Run full test suite and checks**

Run: `bun run check`
Expected: typecheck + lint + format + tests all pass

- [ ] **Step 10: Commit**

```bash
git add src/cli.ts src/server.ts src/tools/tools.ts src/tools/index.ts tests/server.test.ts
git commit -m "feat: add --write flag with conditional write tool registration"
```

---

### Task 6: Optimistic Cache Patching

**Files:**
- Modify: `src/core/database.ts`
- Modify: `tests/core/database.test.ts`

Add `patchCachedTransaction()` method to `CopilotDatabase` that updates a specific transaction in the in-memory cache without reloading the entire database.

- [ ] **Step 1: Write failing tests for cache patching**

Add to `tests/core/database.test.ts`:

```typescript
describe('patchCachedTransaction', () => {
  test('updates category_id on cached transaction', async () => {
    // Pre-populate cache
    (db as any)._transactions = [
      { transaction_id: 'txn1', amount: 50, date: '2024-01-15', category_id: 'old_cat' },
      { transaction_id: 'txn2', amount: 30, date: '2024-01-16', category_id: 'other' },
    ];

    const result = db.patchCachedTransaction('txn1', { category_id: 'new_cat' });

    expect(result).toBe(true);
    const txns = await db.getAllTransactions();
    const txn1 = txns.find((t) => t.transaction_id === 'txn1');
    expect(txn1?.category_id).toBe('new_cat');
  });

  test('returns false when transaction not in cache', () => {
    (db as any)._transactions = [
      { transaction_id: 'txn1', amount: 50, date: '2024-01-15' },
    ];

    const result = db.patchCachedTransaction('nonexistent', { category_id: 'x' });
    expect(result).toBe(false);
  });

  test('returns false when cache is empty', () => {
    (db as any)._transactions = null;

    const result = db.patchCachedTransaction('txn1', { category_id: 'x' });
    expect(result).toBe(false);
  });

  test('does not affect other transactions', () => {
    (db as any)._transactions = [
      { transaction_id: 'txn1', amount: 50, date: '2024-01-15', category_id: 'old' },
      { transaction_id: 'txn2', amount: 30, date: '2024-01-16', category_id: 'keep' },
    ];

    db.patchCachedTransaction('txn1', { category_id: 'new' });

    const txn2 = ((db as any)._transactions as any[]).find(
      (t) => t.transaction_id === 'txn2'
    );
    expect(txn2?.category_id).toBe('keep');
  });

  test('can patch multiple fields at once', () => {
    (db as any)._transactions = [
      {
        transaction_id: 'txn1',
        amount: 50,
        date: '2024-01-15',
        category_id: 'old',
        user_reviewed: false,
      },
    ];

    db.patchCachedTransaction('txn1', { category_id: 'new', user_reviewed: true });

    const txn = ((db as any)._transactions as any[])[0];
    expect(txn.category_id).toBe('new');
    expect(txn.user_reviewed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/database.test.ts`
Expected: FAIL — `patchCachedTransaction` method does not exist

- [ ] **Step 3: Implement patchCachedTransaction**

In `src/core/database.ts`, add this method to the `CopilotDatabase` class (after the `clearCache` method, around line 290):

```typescript
/**
 * Patch a specific transaction in the in-memory cache.
 *
 * Used after a successful Firestore write to keep the cache consistent
 * without reloading the entire database from LevelDB.
 *
 * @param transactionId - The transaction_id to update
 * @param fields - Partial transaction fields to merge
 * @returns true if the transaction was found and patched, false otherwise
 */
patchCachedTransaction(
  transactionId: string,
  fields: Partial<Transaction>
): boolean {
  if (!this._transactions) return false;

  const txn = this._transactions.find((t) => t.transaction_id === transactionId);
  if (!txn) return false;

  Object.assign(txn, fields);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/database.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: all existing tests still pass

- [ ] **Step 6: Commit**

```bash
git add src/core/database.ts tests/core/database.test.ts
git commit -m "feat: add optimistic cache patching for transactions"
```

---

### Task 7: set_transaction_category Write Tool

**Files:**
- Modify: `src/tools/tools.ts` (add `setTransactionCategory()` method)
- Modify: `src/server.ts` (add write tool dispatch)
- Modify: `tests/tools/tools.test.ts` (add tests)

This is the end-to-end write tool that validates inputs, calls Firestore, and patches the cache.

- [ ] **Step 1: Write failing tests for setTransactionCategory**

Add to `tests/tools/tools.test.ts`:

```typescript
import { FirestoreClient } from '../../src/core/firestore-client.js';
import type { FirebaseAuth } from '../../src/core/auth/firebase-auth.js';

describe('setTransactionCategory', () => {
  let tools: CopilotMoneyTools;
  let mockDb: CopilotDatabase;
  let mockFirestoreClient: FirestoreClient;
  let updateCalls: { collection: string; docId: string; fields: any; mask: string[] }[];

  beforeEach(() => {
    // Set up mock database with cached data
    mockDb = new CopilotDatabase('/nonexistent');
    (mockDb as any).dbPath = '/fake';
    (mockDb as any)._transactions = [
      {
        transaction_id: 'txn1',
        amount: 50,
        date: '2024-01-15',
        name: 'Coffee Shop',
        category_id: 'food_and_drink_coffee',
        user_id: 'user123',
      },
      {
        transaction_id: 'txn2',
        amount: 100,
        date: '2024-01-16',
        name: 'Gas Station',
        category_id: 'transportation_gas',
        user_id: 'user123',
      },
    ];
    (mockDb as any)._userCategories = [
      { category_id: 'food_and_drink_coffee', name: 'Coffee', excluded: false },
      { category_id: 'transportation_gas', name: 'Gas', excluded: false },
      { category_id: 'shopping_groceries', name: 'Groceries', excluded: false },
    ];
    (mockDb as any)._allCollectionsLoaded = true;

    // Mock Firestore client
    updateCalls = [];
    mockFirestoreClient = {
      updateDocument: async (collection: string, docId: string, fields: any, mask: string[]) => {
        updateCalls.push({ collection, docId, fields, mask });
      },
    } as unknown as FirestoreClient;

    tools = new CopilotMoneyTools(mockDb, mockFirestoreClient);
  });

  test('updates transaction category successfully', async () => {
    const result = await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping_groceries',
    });

    expect(result.success).toBe(true);
    expect(result.transaction_id).toBe('txn1');
    expect(result.old_category_id).toBe('food_and_drink_coffee');
    expect(result.new_category_id).toBe('shopping_groceries');
  });

  test('calls Firestore with correct parameters', async () => {
    await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping_groceries',
    });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].collection).toBe('transactions');
    expect(updateCalls[0].docId).toBe('txn1');
    expect(updateCalls[0].mask).toEqual(['category_id']);
    expect(updateCalls[0].fields).toEqual({
      category_id: { stringValue: 'shopping_groceries' },
    });
  });

  test('patches cache after successful write', async () => {
    await tools.setTransactionCategory({
      transaction_id: 'txn1',
      category_id: 'shopping_groceries',
    });

    const txn = (mockDb as any)._transactions.find(
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(txn.category_id).toBe('shopping_groceries');
  });

  test('throws when transaction_id not found', async () => {
    await expect(
      tools.setTransactionCategory({
        transaction_id: 'nonexistent',
        category_id: 'shopping_groceries',
      })
    ).rejects.toThrow('Transaction not found: nonexistent');
  });

  test('throws when category_id not found', async () => {
    await expect(
      tools.setTransactionCategory({
        transaction_id: 'txn1',
        category_id: 'nonexistent_category',
      })
    ).rejects.toThrow('Category not found: nonexistent_category');
  });

  test('does not modify cache on Firestore error', async () => {
    mockFirestoreClient.updateDocument = async () => {
      throw new Error('Firestore update failed (500)');
    };
    tools = new CopilotMoneyTools(mockDb, mockFirestoreClient);

    await expect(
      tools.setTransactionCategory({
        transaction_id: 'txn1',
        category_id: 'shopping_groceries',
      })
    ).rejects.toThrow('Firestore update failed');

    // Cache should be unchanged
    const txn = (mockDb as any)._transactions.find(
      (t: any) => t.transaction_id === 'txn1'
    );
    expect(txn.category_id).toBe('food_and_drink_coffee');
  });

  test('throws when no Firestore client configured (read-only mode)', async () => {
    const readOnlyTools = new CopilotMoneyTools(mockDb);

    await expect(
      readOnlyTools.setTransactionCategory({
        transaction_id: 'txn1',
        category_id: 'shopping_groceries',
      })
    ).rejects.toThrow('Write operations require --write mode');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/tools/tools.test.ts`
Expected: FAIL — `setTransactionCategory` does not exist, constructor doesn't accept `FirestoreClient`

- [ ] **Step 3: Update CopilotMoneyTools constructor**

In `src/tools/tools.ts`, update the constructor (around line 266):

```typescript
import { FirestoreClient } from '../core/firestore-client.js';
import { toFirestoreFields } from '../core/format/firestore-rest.js';

export class CopilotMoneyTools {
  private db: CopilotDatabase;
  private firestoreClient: FirestoreClient | null;
  private _userCategoryMap: Map<string, string> | null = null;
  private _excludedCategoryIds: Set<string> | null = null;

  constructor(database: CopilotDatabase, firestoreClient?: FirestoreClient) {
    this.db = database;
    this.firestoreClient = firestoreClient ?? null;
  }
```

- [ ] **Step 4: Implement setTransactionCategory method**

In `src/tools/tools.ts`, add this method to the `CopilotMoneyTools` class (before the closing `}` of the class, around line 2160):

```typescript
/**
 * Change the category of a transaction.
 *
 * Validates both IDs exist, writes to Firestore, then patches the cache.
 */
async setTransactionCategory(args: {
  transaction_id: string;
  category_id: string;
}): Promise<{
  success: boolean;
  transaction_id: string;
  old_category_id: string | undefined;
  new_category_id: string;
  old_category_name: string;
  new_category_name: string;
}> {
  if (!this.firestoreClient) {
    throw new Error('Write operations require --write mode. Restart the server with --write flag.');
  }

  const { transaction_id, category_id } = args;

  // Validate transaction exists
  const transactions = await this.db.getAllTransactions();
  const txn = transactions.find((t) => t.transaction_id === transaction_id);
  if (!txn) {
    throw new Error(`Transaction not found: ${transaction_id}`);
  }

  // Validate category exists
  const categories = await this.db.getUserCategories();
  const category = categories.find((c) => c.category_id === category_id);
  if (!category) {
    throw new Error(`Category not found: ${category_id}`);
  }

  const oldCategoryId = txn.category_id;
  const userCategoryMap = await this.getUserCategoryMap();
  const oldCategoryName = oldCategoryId
    ? getCategoryName(oldCategoryId, userCategoryMap)
    : 'Uncategorized';
  const newCategoryName = getCategoryName(category_id, userCategoryMap);

  // Write to Firestore
  const firestoreFields = toFirestoreFields({ category_id });
  await this.firestoreClient.updateDocument(
    'transactions',
    transaction_id,
    firestoreFields,
    ['category_id']
  );

  // Optimistic cache update
  this.db.patchCachedTransaction(transaction_id, { category_id });

  return {
    success: true,
    transaction_id,
    old_category_id: oldCategoryId,
    new_category_id: category_id,
    old_category_name: oldCategoryName,
    new_category_name: newCategoryName,
  };
}
```

- [ ] **Step 5: Wire up write tool dispatch in server.ts**

In `src/server.ts`, add the write tool case in the `handleCallTool` switch statement (before the `default:` case):

```typescript
case 'set_transaction_category':
  result = await this.tools.setTransactionCategory(
    typedArgs as Parameters<typeof this.tools.setTransactionCategory>[0]
  );
  break;
```

Also update the server constructor to create and inject the `FirestoreClient` when write mode is enabled:

```typescript
import { FirestoreClient } from './core/firestore-client.js';
import { FirebaseAuth } from './core/auth/firebase-auth.js';
import { extractRefreshToken } from './core/auth/browser-token.js';

constructor(dbPath?: string, decodeTimeoutMs?: number, writeEnabled = false) {
  this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
  this.writeEnabled = writeEnabled;

  if (writeEnabled) {
    const auth = new FirebaseAuth(extractRefreshToken);
    const firestoreClient = new FirestoreClient(auth);
    this.tools = new CopilotMoneyTools(this.db, firestoreClient);
  } else {
    this.tools = new CopilotMoneyTools(this.db);
  }

  this.server = new Server(
    { name: 'copilot-money-mcp', version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  this.registerHandlers();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/tools/tools.test.ts`
Expected: all PASS (including new setTransactionCategory tests)

- [ ] **Step 7: Run full test suite and checks**

Run: `bun run check`
Expected: typecheck + lint + format + tests all pass

- [ ] **Step 8: Commit**

```bash
git add src/tools/tools.ts src/server.ts tests/tools/tools.test.ts
git commit -m "feat: add set_transaction_category write tool with Firestore integration"
```

---

### Task 8: Manifest Update and Final Verification

**Files:**
- Modify: `manifest.json`
- Run: integration verification

- [ ] **Step 1: Update manifest.json**

Add the new tool to the `tools` array in `manifest.json`:

```json
{
  "name": "set_transaction_category",
  "description": "Change the category of a transaction. Requires transaction_id (from get_transactions) and category_id (from get_categories). Writes directly to Copilot Money via Firestore. Only available when server is started with --write flag."
}
```

- [ ] **Step 2: Run manifest sync check**

Run: `bun run sync-manifest`
Expected: manifest matches code (or update as needed)

- [ ] **Step 3: Run full check suite**

Run: `bun run check`
Expected: typecheck + lint + format + tests all pass

- [ ] **Step 4: Verify build**

Run: `bun run build`
Expected: builds successfully

- [ ] **Step 5: Verify CLI help includes --write**

Run: `node dist/cli.js --help`
Expected: help output shows `--write` flag

- [ ] **Step 6: Commit**

```bash
git add manifest.json
git commit -m "chore: add set_transaction_category to manifest"
```

- [ ] **Step 7: Verify test coverage for new modules**

Run: `bun test --coverage`
Expected: all new files at 95%+ line coverage (100% ideal)

If coverage is below target, add tests for uncovered paths and commit:

```bash
git add tests/
git commit -m "test: add coverage for uncovered paths in write modules"
```
