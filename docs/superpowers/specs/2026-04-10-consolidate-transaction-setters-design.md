# Consolidate transaction setters into `update_transaction`

**Status:** Design approved (2026-04-10)
**Author:** nach
**Scope:** Refactor — collapse 7 single-field transaction write tools into one multi-field tool.

## Motivation

The MCP server currently exposes 8 transaction-mutating tools:

- `set_transaction_category`
- `set_transaction_note`
- `set_transaction_tags`
- `set_transaction_excluded`
- `set_transaction_name`
- `set_internal_transfer`
- `set_transaction_goal`
- `review_transactions`

The first 7 are single-field setters that all target the same Firestore path
(`items/{item_id}/accounts/{account_id}/transactions/{transaction_id}`) and all route
through the same internal helpers (`resolveTransaction` + `writeTransactionFields`).
Each one is a thin wrapper that populates a single key in an object that the helper
already knows how to handle as a multi-field patch.

This fragmentation has concrete costs:

1. **Tool-list bloat.** Every tool schema lives in the system prompt on every request.
   41 tools is already a lot of context tax; 7 of them are nearly identical.
2. **Poor multi-field ergonomics.** The LLM cannot express "recategorize this and add
   a note" in one call. It has to chain two tool calls, each of which re-resolves the
   transaction, re-validates, and issues its own Firestore round-trip.
3. **Tool-selection friction.** Eight near-identical `set_transaction_*` names force
   disambiguation work on the LLM for no semantic gain.

`review_transactions` is intentionally **not** consolidated: it operates over a batch
of transaction IDs with distinct permission/UX semantics in the app, and folding it
into `update_transaction` would require a bulk-variant schema that would reintroduce
the complexity we are trying to remove.

## Scope

**In scope:**
- Remove 7 transaction setter tools listed above.
- Add one `update_transaction` tool with a multi-field patch schema.
- Preserve all per-field validation that the removed tools did.
- Update tests, manifest, changelog, and version.

**Out of scope:**
- `review_transactions` (stays as-is).
- Other entity consolidations (`update_tag`, `update_category`, `update_budget`,
  `update_goal`, `update_recurring`). Those already have distinct create/update/delete
  schemas that are correctly split — their update variants take partial patches and
  their create/delete variants have genuinely different shapes.
- A bulk `update_transaction` over multiple IDs. If that becomes desirable later, it
  is a separate tool with its own schema.
- Backward-compatible aliases or deprecation shims. The write tools are unpublished,
  so there is no published API to preserve.

## Backward compatibility

None required. The write tools are not yet published to npm — the latest published
version (1.5.0) is read-only. Anyone consuming the write tools is necessarily doing
so from a local clone of an unreleased working branch, and the user has stated they
only maintain backward compatibility on published versions.

This is a **minor version bump (1.5.0 → 1.6.0)**, not a major one.

## Design

### Tool schema

Flat args (no `patch` wrapper key — it would add one level of nesting with zero
information):

```ts
{
  transaction_id:    string,             // required
  category_id?:      string,
  note?:             string,             // "" clears user_note (matches existing setTransactionNote)
  tag_ids?:          string[],           // [] clears all tags
  excluded?:         boolean,
  name?:             string,             // trimmed, must be non-empty if present
  internal_transfer?: boolean,
  goal_id?:          string | null,      // null unlinks goal (special Firestore/cache handling)
}
```

Zod schema uses `.strict()` so unknown fields throw a clear error instead of being
silently dropped. `goal_id` is the only nullable field — it uses `.nullable().optional()`
to distinguish three states: absent (don't touch), explicit null (unlink), and a
string (link to goal). All other fields are plain `.optional()`: absent means "don't
touch," present means "overwrite with this value." This matches existing behavior
across all 7 current setters — none of them support a separate null semantic except
`setTransactionGoal`.

The schema also enforces that **at least one** mutable field is present besides
`transaction_id`. An empty patch errors with:

> `update_transaction requires at least one field to update`

### Omitted-vs-present semantics

This is the most subtle part of the design. Every field has two states that matter
to the caller:

| LLM sends | Firestore `updateMask` | Effect on stored document |
|---|---|---|
| `{transaction_id, tag_ids: [...]}` | `["tag_ids"]` | Only `tag_ids` updated. Every other field (including `user_note`) is **untouched** — existing value preserved |
| `{transaction_id, note: "hi"}` | `["user_note"]` | `user_note` overwritten with `"hi"` |
| `{transaction_id, note: ""}` | `["user_note"]`, value `""` | `user_note` cleared (same wire behavior as current `setTransactionNote`) |
| `{transaction_id, goal_id: "abc"}` | `["goal_id"]`, value `"abc"` | `goal_id` linked to goal `"abc"` |
| `{transaction_id, goal_id: null}` | `["goal_id"]`, value `""` at Firestore, `undefined` in cache | `goal_id` unlinked |

The key invariant: **any field not present in the patch object is entirely excluded
from the wire call and the stored document is untouched.** This is what makes
multi-field editing safe — sending `{id, tag_ids: [...]}` cannot accidentally erase
the note.

**Consequence:** if the LLM calls `update_transaction({id, tag_ids: [...]})` without
mentioning `note`, the note stays exactly as it was. No erasure. This is a natural
consequence of JSON object semantics — an absent key is not the same as `key: ""`.

### The `goal_id` null quirk

`goal_id` is the only field with a three-way semantic (absent / value / unlink), and
it requires special handling because the Firestore wire format and the cache model
disagree on how to represent "unlinked":

- **Firestore wire:** write the empty string `""`. Firestore proto doesn't store
  a sentinel "deleted" value for string fields; the app's convention is empty string
  = unlinked. Confirmed by inspecting `setTransactionGoal` at `tools.ts:2640-2653`
  which does `const firestoreGoalId = goal_id ?? '';`.
- **Cache:** patch with `undefined` so the model matches the Zod schema
  (`goal_id: z.string().optional()`). A cache value of `""` would be technically
  valid but semantically wrong — the transaction isn't linked to a goal named "".

This means `updateTransaction` **cannot** use `writeTransactionFields` directly when
`goal_id: null` is in the patch, because that helper uses the same `fields` object
for both the wire write and the cache patch. See the implementation section for how
we handle this while preserving multi-field atomicity.

The other fields (`category_id`, `tag_ids`, `excluded`, `name`, `internal_transfer`,
`note`) have no clear semantics that differ from wire to cache. For `note`, "clear"
means writing `""` at both layers — the existing `setTransactionNote` tool already
does this and it round-trips correctly. For the rest, there is no such thing as an
uncategorized, unnamed, or un-booleanable transaction in this data model, and
`tag_ids: []` already expresses "no tags."

### Method implementation

Single method on `CopilotMoneyTools`:

```ts
async updateTransaction(args: {
  transaction_id: string;
  category_id?: string;
  note?: string;
  tag_ids?: string[];
  excluded?: boolean;
  name?: string;
  internal_transfer?: boolean;
  goal_id?: string | null;
}): Promise<{
  success: true;
  transaction_id: string;
  updated: string[];
}>
```

Flow:

1. Validate `args` with the Zod strict schema. Zod rejects unknown fields and catches
   type mismatches before any work happens.
2. Assert at least one mutable field is present (see schema section above).
3. Resolve the transaction via the existing `resolveTransaction(transaction_id)` helper
   → gets `{ txn, collectionPath }`. This already handles "transaction not found" and
   "missing item_id/account_id" errors.
4. **Build two parallel field maps by key presence:** `firestoreFields` (what goes
   over the wire) and `cacheFields` (what patches the in-memory model). They are
   identical for every field except `goal_id: null`, which maps to `""` in
   `firestoreFields` and `undefined` in `cacheFields`. See the pitfall below.
5. Per-field validation on present fields:
   - `name`: trim; if the trimmed result is empty, throw `"name must be non-empty"`.
     Use the trimmed value in both field maps.
   - `goal_id`: if non-null, call `validateDocId(goal_id, 'goal_id')` and verify the
     goal exists in the local cache (mirrors the existing check in
     `setTransactionGoal` at `tools.ts:2627-2638`). If null, skip both — null is the
     unlink signal.
   - Other fields: no extra validation beyond what Zod already did.
6. Inline the wire write and cache patch (do **not** call `writeTransactionFields`):

   ```ts
   const client = this.getFirestoreClient();
   const firestoreValue = toFirestoreFields(firestoreFields);
   const updateMask = Object.keys(firestoreFields);
   await client.updateDocument(collectionPath, transaction_id, firestoreValue, updateMask);

   if (!this.db.patchCachedTransaction(transaction_id, cacheFields)) {
     this.db.clearCache();
   }
   ```

   This is effectively an inlined, generalized version of `writeTransactionFields`
   that supports the Firestore/cache asymmetry. It issues exactly **one**
   `updateDocument` call regardless of how many fields are in the patch, so
   multi-field updates remain atomic on the Firestore side.
7. Return `{ success: true, transaction_id, updated: Object.keys(firestoreFields) }`.

After the refactor, `writeTransactionFields` has zero callers — its existing 6
callers are all among the 7 setters being deleted, and `setTransactionGoal` /
`reviewTransactions` both inline their own `updateDocument` calls. The helper should
be **deleted** as part of this change. The inline block in `updateTransaction` is a
~6-line adaptation that does the same job with the added Firestore/cache split; a
shared helper for a single caller would be worse than the inline.

### Critical pitfall: building field maps by key presence

The method MUST build both field maps by checking key presence on the parsed args,
not by destructuring and spreading. Destructuring normalizes absent keys into
`undefined`, and a naive spread like `{ category_id, user_note: note, ... }` would
introduce keys with `undefined` values, which in turn would leak into
`Object.keys(firestoreFields)` and corrupt the `updateMask` — potentially writing
`null` into fields the LLM never asked to modify.

**Wrong:**
```ts
const { category_id, note, tag_ids, ... } = args;
const fields = { category_id, user_note: note, tag_ids, ... }; // ❌ undefined leaks
```

**Right:**
```ts
const firestoreFields: Record<string, unknown> = {};
const cacheFields: Partial<Transaction> = {};

if ('category_id' in args) {
  firestoreFields.category_id = args.category_id;
  cacheFields.category_id = args.category_id;
}
if ('note' in args) {
  firestoreFields.user_note = args.note;
  cacheFields.user_note = args.note;
}
if ('tag_ids' in args) {
  firestoreFields.tag_ids = args.tag_ids;
  cacheFields.tag_ids = args.tag_ids;
}
if ('excluded' in args) {
  firestoreFields.excluded = args.excluded;
  cacheFields.excluded = args.excluded;
}
if ('name' in args) {
  firestoreFields.name = trimmedName; // validated above
  cacheFields.name = trimmedName;
}
if ('internal_transfer' in args) {
  firestoreFields.internal_transfer = args.internal_transfer;
  cacheFields.internal_transfer = args.internal_transfer;
}
if ('goal_id' in args) {
  // Firestore wants empty string to unlink; cache wants undefined (matches Zod model).
  firestoreFields.goal_id = args.goal_id ?? '';
  cacheFields.goal_id = args.goal_id ?? undefined;
}
```

The `'key' in args` check is the reliable primitive because Zod's optional fields
produce objects where the key is either present (with value or explicit null) or
entirely absent.

The repetition is deliberate — a loop over a config array would have to special-case
`note → user_note`, `goal_id → ''|undefined`, and `name → trimmedName`, which makes
the straight-line version shorter and easier to audit. If a 5th field gains special
handling later, consider refactoring to a config array at that point.

### Field name mapping

One ergonomic rename between the tool schema and the Firestore document:

| Tool arg | Firestore field |
|---|---|
| `note` | `user_note` |

All other field names pass through unchanged. This matches the existing behavior of
`set_transaction_note`, which also exposes the field as `note` and maps to `user_note`
internally.

## Files touched

### Source

- `src/tools/tools.ts`
  - Delete methods: `setTransactionCategory`, `setTransactionNote`, `setTransactionTags`,
    `setTransactionExcluded`, `setTransactionName`, `setInternalTransfer`,
    `setTransactionGoal`.
  - Delete the private helper `writeTransactionFields` — after the setters are
    removed it has zero callers (`setTransactionGoal` and `reviewTransactions` both
    inline their own `updateDocument` calls, and the 6 callers among the deleted
    setters are the only other references).
  - Delete the 7 corresponding schema entries in `createWriteToolSchemas()`.
  - Add `updateTransaction` method + schema entry.
  - Keep `resolveTransaction` and `reviewTransactions` untouched.

- `src/server.ts`
  - Delete 7 cases from the tool handler switch (`set_transaction_category`,
    `set_transaction_note`, `set_transaction_tags`, `set_transaction_excluded`,
    `set_transaction_name`, `set_internal_transfer`, `set_transaction_goal`).
  - Delete 7 entries from `WRITE_TOOLS`.
  - Add `case 'update_transaction':` dispatching to `this.tools.updateTransaction(...)`.
  - Add `'update_transaction'` to `WRITE_TOOLS`.

### Metadata

- `manifest.json` — regenerate via `bun run sync-manifest`. The description string
  currently says "41 tools for transactions, investments, budgets, goals, and more"
  and needs updating to **35**.
- `package.json` — version 1.5.0 → 1.6.0, update tool-count in description if present.
- `package-lock.json` — version 1.5.0 → 1.6.0 (both top-level and packages[""]).
- `CHANGELOG.md` — new `[1.6.0] - 2026-04-10` section documenting the consolidation
  and the net tool-count change (41 → 35). Not flagged as breaking since write tools
  are unpublished.

### Tests

- Delete the existing per-setter test suites (wherever they live — at minimum in
  `tests/tools/tools.test.ts` and any E2E tests in `tests/e2e/server.test.ts`
  covering those specific tool names).
- Add a new test file (or section) for `update_transaction` with the coverage
  outlined in the "Testing strategy" section below.
- Update `tests/unit/server-write-dispatch.test.ts` to route `update_transaction`
  and drop the old setter cases.

### Docs

- `README.md` — search for any mention of the removed tool names; replace with
  references to `update_transaction`. Update the "41 tools" count if mentioned.
- `docs/EXAMPLE_QUERIES.md` — update examples that show old setter calls.
- Any other `docs/*.md` that reference the removed tool names.

## Testing strategy

Replace the existing per-setter test suites wholesale. New tests for
`update_transaction`:

1. **Single-field updates** — one test per supported field, verifying the correct
   `updateMask` and Firestore value:
   - `category_id`
   - `note` (non-empty string)
   - `note: ""` (clear — matches existing `setTransactionNote` behavior)
   - `tag_ids` (non-empty)
   - `tag_ids: []` (clear all)
   - `excluded: true` / `excluded: false`
   - `name` (trimmed, e.g. `"  groceries  "` → `"groceries"`)
   - `internal_transfer: true` / `false`
   - `goal_id` (linked to an existing goal)
   - `goal_id: null` (unlink — asserts `updateMask = ["goal_id"]` with Firestore
     value `""` **and** cache value `undefined`)

2. **Multi-field atomic** — passing three fields together (e.g.,
   `{category_id, note, tag_ids}`) produces **one** `updateDocument` call with all
   three in the mask. Mock the Firestore client and assert `updateDocument` was
   called exactly once.

3. **Multi-field with goal_id unlink** — `{category_id, goal_id: null}` produces
   one `updateDocument` call with `updateMask = ["category_id", "goal_id"]`, Firestore
   values `{category_id: "...", goal_id: ""}`, and a single `patchCachedTransaction`
   call with cache values `{category_id: "...", goal_id: undefined}`. This is the
   core test for the Firestore/cache asymmetry.

4. **Omitted-key preservation** — set up a transaction with an existing `user_note`,
   send `update_transaction({id, tag_ids: [...]})`, assert `user_note` is NOT in the
   updateMask passed to Firestore (so the stored note is untouched).

5. **Validation errors** (each expected to throw without issuing a Firestore call):
   - Empty patch (`{transaction_id}` only).
   - Unknown field (via Zod `.strict()`).
   - Empty/whitespace-only `name`.
   - Non-existent `goal_id` (when `goal_id` is non-null).
   - Non-existent `transaction_id`.
   - Transaction missing `item_id` or `account_id`.

6. **Atomicity on validation failure** — mirrors the existing `reviewTransactions`
   atomicity test: if any validation step fails, **no Firestore write** is issued
   and **no cache patch** is applied. Specifically: send a patch with a valid
   `category_id` and an invalid `goal_id`; assert neither change is persisted.

7. **Cache patching** — verify `patchCachedTransaction` is called exactly once with
   the `cacheFields` object (not `firestoreFields`) so the in-memory view stays
   consistent with the Zod model. Important for the `goal_id: null` case where the
   two objects diverge.

## Version and changelog

`1.5.0 → 1.6.0` (minor bump).

CHANGELOG entry under `[1.6.0] - 2026-04-10`:

```markdown
### Changed
- **Consolidated 7 transaction setter tools into one `update_transaction` tool.**
  The new tool accepts a partial patch with any combination of: `category_id`,
  `note`, `tag_ids`, `excluded`, `name`, `internal_transfer`, `goal_id`. Multi-field
  updates are atomic (single Firestore call). Omitted fields are preserved — sending
  `{id, tag_ids: [...]}` cannot accidentally erase the note. `goal_id: null` unlinks
  the goal. Net tool count: 41 → 35.

### Removed
- `set_transaction_category`, `set_transaction_note`, `set_transaction_tags`,
  `set_transaction_excluded`, `set_transaction_name`, `set_internal_transfer`,
  `set_transaction_goal`. Use `update_transaction` instead. Not marked as breaking
  because the write tools have never been published.
```

## Open questions

None.

## Success criteria

- `update_transaction` exists and handles all 7 fields the removed tools handled.
- Multi-field calls issue exactly one `updateDocument` call (one Firestore round trip).
- Omitted fields are preserved across writes. `note: ""` clears the user note.
  `goal_id: null` unlinks the goal (Firestore gets `""`, cache gets `undefined`).
- All validation from the removed tools is preserved (per-field, not global).
- `writeTransactionFields` is deleted (zero remaining callers).
- `bun run check` passes (typecheck + lint + format + tests).
- `bun run sync-manifest` reports 35 tools, no drift.
- No references to the 7 removed tool names remain in source, tests, or docs.
- Tool count in `manifest.json` description, `package.json` description, and
  `README.md` all say 35.
