---
date: 2026-04-14
status: approved
topic: graphql-capture
---

# GraphQL API Capture — Design

## Motivation

Our 18 write tools currently hit Firestore directly via `src/core/firestore-client.ts`. This couples us to Copilot's internal data layer, risks breakage whenever they change schemas, and bypasses whatever server-side validation / side effects their official API runs. Before we can rewrite the write tools against Copilot's GraphQL API, we need a complete picture of that API's surface.

No public documentation exists. The only source of truth is what the copilot.money web app actually sends. This spec covers the **capture and documentation phase only** — not the rewrite itself. The rewrite is a separate project that will consume the output of this one.

## Goals

- Document every GraphQL **query** and **mutation** the web app issues across its entire surface
- Capture at least one realistic example request/response pair per operation
- Record which screens / interactions trigger which operations
- Produce a reference that can be used to design the replacement implementation of our 18 write tools (and, later, inform read-tool work)

## Non-goals

- Implementing the GraphQL-based write tools (future project)
- Reverse-engineering authentication (we reuse the existing authenticated browser session)
- Full schema introspection — the GraphQL endpoint likely has introspection disabled in production; we work from observed traffic only
- 100% variant coverage for queries (one realistic example per query is enough); mutations require full variant coverage

## Approach

### Capture method

Use the existing authenticated Chrome session via the `claude-in-chrome` MCP extension. Playwright was considered and rejected because Copilot has shipped anti-bot hardening; reusing the user's real logged-in session avoids that entirely.

Since `claude-in-chrome` exposes DOM/click/screenshot primitives but not raw network traffic, we intercept calls inside the page:

1. **Primary capture — injected interceptor.** The user pastes a small JS snippet into the DevTools console once at the start of the session, which monkey-patches `window.fetch` and `XMLHttpRequest` to push every GraphQL call (URL, headers, body, variables, response, timestamp) into a global array `window.__gqlLog`. The agent reads this array back via `claude-in-chrome`'s DOM/eval capabilities between navigations and appends entries to disk.

2. **Backup capture — HAR export.** The user opens DevTools → Network → "Preserve log" before the session starts and exports a HAR file at the end. Belt-and-suspenders in case the interceptor drops anything (e.g. `sendBeacon`, WebSocket frames).

The interceptor must be injected **before** the first GraphQL call fires. Since an SPA page load issues many queries immediately, the workflow is: user opens copilot.money, opens DevTools, pastes snippet, reloads the page. From that point forward every call is captured until the tab is closed.

### Interceptor snippet (reference)

The exact snippet will live in the implementation plan. Rough shape:

```js
(() => {
  window.__gqlLog = window.__gqlLog || [];
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input.url;
    const req = { url, method: init?.method || 'GET', headers: init?.headers, body: init?.body, ts: Date.now() };
    const res = await origFetch(...args);
    if (url.includes('/graphql') || (init?.body && String(init.body).includes('"query"'))) {
      const clone = res.clone();
      try { req.response = await clone.json(); } catch { req.response = await clone.text(); }
      window.__gqlLog.push(req);
    }
    return res;
  };
  // (similar XHR patch)
})();
```

### Crawl plan

The agent works **one top-level area at a time**, checking in with the user between areas. Tentative top-level areas (agent refines as it discovers the real information architecture):

1. Dashboard / home
2. Accounts (list, detail, connection management, manual accounts)
3. Transactions (list, filters, detail, splits, tags, notes, attachments, review queue)
4. Categories (list, create, edit, delete, hierarchy / groups, budgets inline)
5. Budgets (list, create, edit, delete, rollovers, category budgets)
6. Goals (list, create, edit, delete, contributions)
7. Recurring (list, create, edit, delete, pause/resume, detection queue)
8. Investments (holdings, performance, securities detail, allocations)
9. Cash flow / trends / reports
10. Tags (list, create, edit, delete, assignment)
11. Rules (if present — auto-categorization etc.)
12. Settings (profile, household, notifications, integrations, export, subscription)
13. Search
14. Any modal-only surfaces discovered while crawling the above

For each area the agent:
- Navigates to every screen and sub-screen in that area
- Triggers every state-changing action it can safely trigger (see "Safety" below)
- Drains `window.__gqlLog` between screens and appends to `raw/captured-log.jsonl`
- Produces the per-screen flow doc and updates per-operation docs

At the end of each area the agent reports: operations captured (queries/mutations by name), screens visited, anything it skipped and why. User approves before moving to the next area.

### Safety — what the agent will and will not trigger

**Will trigger** (reversible / read-only):
- Opening every screen, sub-screen, modal
- Applying filters, changing views, sorting
- Clicking into detail views
- Opening create/edit forms and **filling them** to observe draft-time queries, then **cancelling** without submitting (if the app uses optimistic saves this may still fire mutations — agent will flag before proceeding)

**Will NOT trigger without explicit per-action user confirmation** (destructive / money-moving / shared-state):
- Submitting create/edit/delete forms that persist changes
- Connecting or disconnecting bank accounts
- Triggering account sync / refresh
- Anything that sends email, notifications, or reaches third parties
- Anything involving the subscription / billing surface

For mutations specifically, we need real submissions to capture real payloads — so the agent asks the user to either (a) perform the action manually while the agent watches, or (b) approve each category of mutation (e.g. "creating a test budget named 'GQL-TEST'") up front. Dry-run form-filling alone will miss actual mutation traffic.

### Output structure

Everything under `docs/graphql-capture/`, **entirely gitignored** until the user personally reviews and green-lights committing:

```
docs/graphql-capture/
├── README.md                     # Index, capture methodology, session metadata
├── schema/
│   ├── operations.md             # Every operation name → link to file (searchable index)
│   └── types.md                  # Observed types/fields inferred from responses
├── operations/
│   ├── queries/
│   │   └── <OperationName>.md    # One file per query
│   └── mutations/
│       └── <OperationName>.md    # One file per mutation
├── flows/
│   ├── 01-dashboard.md           # Per-area narrative: what fired, in what order
│   ├── 02-accounts.md
│   └── ...
└── raw/
    ├── session-YYYY-MM-DD.har    # HAR backup
    └── captured-log.jsonl        # Raw interceptor dump (append-only)
```

**Per-operation file template:**

```markdown
# <OperationName>

- **Type:** query | mutation
- **Endpoint:** <URL>
- **Fires on:** <screens/actions>
- **Auth:** <headers observed, e.g. Authorization: Bearer ..., Cookie: ...>

## Query

```graphql
<full query string>
```

## Variables (inferred schema)

| Name | Type | Required | Notes |
|------|------|----------|-------|
| ...  | ...  | ...      | ...   |

## Example request

```json
{ "operationName": "...", "variables": { ... }, "query": "..." }
```

## Example response

```json
{ "data": { ... } }
```

## Notes

<ordering, dependencies, quirks, error shapes observed>
```

### Scrubbing

Option B from brainstorming — **realistic placeholders, structure preserved**:

- Merchants / descriptions → `"<merchant>"`, `"<description>"`
- Amounts → `<amount>` (keep sign and decimal shape if semantically meaningful, e.g. for refund vs charge distinction)
- Account numbers, institution IDs, routing numbers → `<account-id>` etc.
- User IDs, household IDs, document IDs → `<user-id>`, `<household-id>`, `<doc-id>`
- Auth tokens, session cookies → `<redacted-bearer>`, `<redacted-cookie>`
- Emails, names, phone numbers → `<email>`, `<name>`, `<phone>`
- Dates → keep real (not PII, and useful for debugging ordering)
- Enum values, booleans, category names from Plaid taxonomy → keep real (not PII, semantically load-bearing)

Scrubbing happens when writing to `operations/` and `flows/`. The raw log in `raw/` keeps real values (gitignored, local only).

### Session metadata

`README.md` records: capture date(s), Copilot web app version (from build hash in JS bundle if discoverable), browser/OS, whose account was used, anything about the account shape that affects what surfaces were available (e.g. "no investment accounts connected, so investments area was partially inaccessible").

## Success criteria

1. Every top-level area in the crawl plan has a flow doc
2. Every GraphQL operation observed has a dedicated file under `operations/`
3. All 18 operations corresponding to our existing write tools have at least one fully-captured example request/response pair with variable documentation
4. `schema/operations.md` index lists every captured operation with one-line description
5. User can read the output and know, for a given write tool rewrite, what GraphQL call to make and what payload shape to send

## Risks and open questions

- **Introspection may be off.** We can only document what we observe. Some edge-case operations (e.g. error recovery flows, admin surfaces) may never be triggered from the normal UI.
- **Operations may be user-state dependent.** If the user's account doesn't have connected investment accounts, investment operations can't be captured. README documents these gaps.
- **Interceptor may miss non-JSON traffic.** Multipart uploads (e.g. transaction attachments) won't deserialize cleanly — they'll be logged as text and flagged.
- **Anti-bot heuristics.** Even driving an authenticated Chrome, unusually fast or scripted navigation patterns could trip defenses. The per-area check-in cadence is partly to keep pacing human-ish.
- **Capture completeness vs. destructive action risk.** We cannot document a `deleteBudget` mutation without actually deleting a budget. We mitigate by creating a test budget first, then deleting that.
