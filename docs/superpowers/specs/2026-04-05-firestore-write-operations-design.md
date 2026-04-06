# Firestore Write Operations Design

**Date:** 2026-04-05
**Status:** Draft
**Scope:** Add write capabilities to the MCP server via Firestore REST API, starting with `set_transaction_category`

## Context

The MCP server is currently 100% read-only, reading from Copilot Money's local LevelDB/Firestore cache. Three community CLI tools ([JaviSoto](https://github.com/JaviSoto/copilot-money-cli), [exiao](https://github.com/exiao/copilot-money-cli), [jayhickey](https://github.com/jayhickey/copilot-money-cli)) demonstrate that write operations are possible via Copilot Money's APIs.

The native macOS app communicates with Firestore directly (not GraphQL). The web app uses a GraphQL API at `app.copilot.money/api/graphql`. We target the Firestore REST API since it is the source of truth and aligns with how the native app works.

## Decision: Firestore REST API over GraphQL

**Why Firestore REST instead of the web GraphQL API:**

- Firestore is the source of truth — the native app writes here directly
- We already understand the document schema from our decoder
- Same auth token (Firebase ID token) works for both reads and writes
- No dependency on the web app's GraphQL layer, which could change independently
- Simpler HTTP calls (REST PATCH vs GraphQL mutations)

## Architecture

```
src/cli.ts (existing)
  --write flag (new) → passed to server

src/server.ts (existing)
  tools/list → read tools always; write tools only when --write enabled
  call_tool  → dispatches to read OR write method

Read Path (existing)          Write Path (new)
  LevelDB decoder               Firestore REST client
       │                              │
       └──────────┬───────────────────┘
                  │
     Shared Document Format Layer (new)
        Firestore ↔ TypeScript conversion

Auth Module (new, lazy)
  Browser token extraction → Firebase token exchange
  Initialized on first write call only
```

## 1. Server Modes: Read-Only vs Read+Write

**Pattern:** Conditional tool registration (same as GitHub MCP Server).

Default behavior is read-only. Write tools are only registered when `--write` is passed:

```
copilot-money-mcp                # read-only (default)
copilot-money-mcp --write        # read + write tools enabled
```

When `--write` is not set, write tools do not appear in `tools/list`. The LLM never sees them. This follows the MCP ecosystem convention established by the GitHub and Supabase MCP servers.

**Implementation:**
- `src/cli.ts` parses `--write` flag, passes `writeEnabled: boolean` to server
- `src/server.ts` conditionally includes write tool schemas in `handleListTools()`
- Write tool cases in the dispatch switch are unreachable without the flag (defense in depth)

## 2. Shared Document Format Layer

Today, the decoder has field-mapping knowledge embedded in its protobuf parsing logic. We extract this into an explicit, bidirectional format layer that both the decoder (reads) and the Firestore client (writes) consume.

**Location:** `src/core/format/`

```typescript
// src/core/format/transaction.ts (example)

const transactionFieldMap = {
  category_id: { tsKey: 'categoryId', type: 'string' },
  amount:      { tsKey: 'amount',     type: 'number' },
  date:        { tsKey: 'date',       type: 'timestamp' },
  is_reviewed: { tsKey: 'isReviewed', type: 'boolean' },
  // ...
};

// Read direction (decoder consumes):
function firestoreDocToTransaction(doc: FirestoreDocument): Transaction

// Write direction (Firestore client consumes):
function transactionFieldsToFirestore(fields: Partial<Transaction>): FirestoreDocumentFields
```

**Self-validating contract:** If our write format doesn't match what Firestore expects, we discover it immediately. This also validates that our read decoding has been correct.

**Incremental extraction:** For the first PR, we only extract the transaction format. Each subsequent write tool extracts another entity's format. The existing decoder is not rewritten — we extract mappings alongside it and validate they produce identical results for reads. Decoder refactor to consume these mappings can happen later.

## 3. Auth Module

Two components, both lazy-initialized on first write call.

### 3a. Browser Token Extractor

**Location:** `src/core/auth/browser-token.ts`

Searches for Firebase refresh tokens across four browsers:

| Browser | Storage Location | Extraction Method |
|---------|-----------------|-------------------|
| Chrome | `~/Library/Application Support/Google/Chrome/Default/Local Storage/leveldb/` | `strings` on `.ldb`/`.log` files, match `AMf-[A-Za-z0-9_-]{100,}` |
| Arc | `~/Library/Application Support/Arc/User Data/Default/Local Storage/leveldb/` | Same as Chrome (Chromium-based) |
| Safari | `~/Library/Safari/Databases/` (IndexedDB) | TBD — different storage format |
| Firefox | `~/Library/Application Support/Firefox/Profiles/*/storage/default/*/idb/` | TBD — different storage format |

Returns the first valid refresh token found, or a descriptive error listing which browsers were checked and why extraction failed.

### 3b. Firebase Auth

**Location:** `src/core/auth/firebase-auth.ts`

Exchanges the refresh token for a Firebase ID token:

```
POST https://securetoken.googleapis.com/v1/token
  ?key=AIzaSyBi2Ht5k9K94Yi6McMSGyKeOcHC7vEsN_I
Content-Type: application/x-www-form-urlencoded
Body: grant_type=refresh_token&refresh_token={token}

Response: { id_token, refresh_token, expires_in, token_type, user_id }
```

- Single public method: `getIdToken(): Promise<string>`
- Caches ID token in memory, auto-refreshes when expired (Firebase ID tokens have a fixed 3600-second lifetime, returned in the `expires_in` response field)
- If refresh token becomes invalid, re-extracts from browser automatically
- Tokens are in-memory only — no disk persistence. Server restart = re-extract (sub-second)

### 3c. Error UX

If no browser has a valid Copilot Money session:

```
Authentication required. Please log into Copilot Money at
https://app.copilot.money in Chrome, Arc, Safari, or Firefox,
then try again.
```

## 4. Firestore REST Client

**Location:** `src/core/firestore-client.ts`

Thin wrapper around the Firestore REST API using native `fetch`:

```typescript
class FirestoreClient {
  private projectId = 'copilot-production-22904';

  constructor(private auth: FirebaseAuth) {}

  async updateDocument(
    collectionPath: string,
    documentId: string,
    fields: Record<string, FirestoreValue>,
    updateMask: string[]
  ): Promise<void>
}
```

**Endpoint:** `PATCH https://firestore.googleapis.com/v1/projects/copilot-production-22904/databases/(default)/documents/{collectionPath}/{documentId}?updateMask.fieldPaths={field1}&updateMask.fieldPaths={field2}`

The `updateMask` ensures only specified fields are modified — everything else on the document is untouched. This is critical for safety.

## 5. First Write Tool: `set_transaction_category`

### Input Schema

```typescript
{
  transaction_id: string,  // required — ID from get_transactions
  category_id: string      // required — ID from get_categories
}
```

### Behavior

1. Validate `category_id` exists via read path (`get_categories`)
2. Validate `transaction_id` exists via read path (`get_transactions`)
3. Convert `{ categoryId }` to Firestore document fields via shared format layer
4. `PATCH` the transaction document with `updateMask=category_id`
5. Optimistic cache update (patch in-memory, no full DB re-read)
6. Return `{ success, transaction_id, old_category, new_category }`

### Tool Annotations

```typescript
{
  readOnlyHint: false,
  destructiveHint: false,   // update, not delete
  idempotentHint: true      // same call twice = same result
}
```

## 6. Optimistic Cache Patching

After a successful Firestore write, we patch the specific object in the cached array rather than reloading the entire database.

```typescript
// After PATCH succeeds:
const cached = this.db.getCachedTransactions();
const txn = cached.find(t => t.id === transactionId);
if (txn) txn.categoryId = newCategoryId;
```

**Why not invalidate the full cache:**
- `loadAllCollections()` iterates the entire LevelDB — can take many seconds for large databases
- Optimistic update is instant and provides immediate read consistency
- On server restart, the cache rebuilds naturally from LevelDB (which Firestore will have synced)

`CopilotDatabase` exposes targeted update methods like `patchCachedTransaction(id, fields)` rather than relying on the all-or-nothing `clearCache()`.

## 7. Future Write Tools (Phased Rollout)

Each added as a separate PR, one at a time:

| Phase | Tool | Firestore Operation |
|-------|------|-------------------|
| 1 | `set_transaction_category` | PATCH transaction `category_id` |
| 2 | `review_transactions` | PATCH transaction `is_reviewed` |
| 3 | `set_transaction_notes` | PATCH transaction `user_notes` |
| 4 | `set_transaction_tags` | PATCH transaction `tag_ids` |
| 5 | `create_tag` | POST to tags collection |
| 6 | `delete_tag` | DELETE tag document |
| 7 | `create_category` | POST to categories collection |
| 8 | `assign_recurring` | PATCH transaction recurring fields |
| 9 | `create_recurring` | POST to recurrings collection |
| 10 | `edit_recurring` | PATCH recurring document |
| 11 | `refresh_connections` | TBD — may need backend endpoint, not Firestore |

Each PR follows the same pattern: add format mapping, add write tool method, add schema, add optimistic cache patch, add tests.

## 8. New Dependencies

- None required. Native `fetch` is available in Node.js 18+ and Bun. No new npm packages needed.

## 9. Testing Strategy

- **Auth module:** Mock `strings` output and HTTP responses. Test token extraction regex against real-world token formats. Test auto-refresh and error paths.
- **Firestore client:** Mock `fetch` responses. Validate request format matches Firestore REST API spec (especially `updateMask` and document field encoding).
- **Shared format layer:** Round-trip tests — encode a TypeScript object to Firestore format, decode it back, assert equality. Run against existing test fixtures to validate read compatibility.
- **Write tools:** Integration tests with mocked Firestore client. Verify input validation, cache patching, and return format.
- **No real Firestore writes in CI.** All external calls are mocked.
- **Coverage target:** 100% line coverage ideally, 95%+ minimum for all new modules.

## 10. Security Considerations

- **Read-only by default.** Write tools are invisible unless `--write` is explicitly passed.
- **No credentials on disk.** Tokens are in-memory only, extracted fresh each server lifecycle.
- **`updateMask` on all writes.** Prevents accidentally overwriting unrelated fields.
- **Input validation before write.** Category/transaction IDs are verified against the read cache before any API call.
- **User's own credentials.** The Firebase refresh token belongs to the user's browser session — no service accounts, no shared secrets.
