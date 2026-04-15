# Flow 01 — Web Session (2026-04-14)

## Source

Two captures from a live authenticated session on `app.copilot.money`, driven by the Claude-in-Chrome extension with an Apollo-layer `client.mutate` / `queryManager` interceptor (`window.fetch` monkey-patch doesn't work because Copilot serves through a service worker).

- `raw/apollo-capture-2026-04-14-full.json` — 178 read operations, 23 unique query names, all with verbatim GraphQL strings including fragments
- `raw/mutations-2026-04-14.json` — 41 mutation observations, 9 unique mutation names, 22/41 with verbatim strings (rest inferred from response shape)

## Client

- Apollo Client v3.13.8 with `BatchHttpLink` (30ms debounce, 10 ops/batch)
- Endpoint: `https://app.copilot.money/api/graphql` (POST)
- Auth: `Authorization: Bearer <Firebase RS256 JWT>` from IndexedDB — details in `wire-protocol.md`.

## Surfaces exercised

**Queries (triggered by navigation):**
- Dashboard home — Networth, MonthlySpend, Spends, NetworthSettings, Announcement, Consent, Subscription, User, CheckUser
- Accounts pane — Accounts, AccountLiveBalance, NetworthLiveBalance
- Transactions list — Transactions, Transaction, TransactionSummary, Categories, Tags
- Recurrings — Recurrings, Recurring, UpcomingRecurrings
- Settings — InvestmentSettings, RefreshAllConnections
- Budgets — Budgets (read only — CRUD is mobile-only, see "Gaps")

**Mutations (triggered by UI interactions):**
- Transaction edits: category change, note add/clear, tag add/remove, `isReviewed` toggle
- Category: create `GQL-TEST`, rename, color/emoji change, isExcluded toggle, parent category change, delete
- Tag: create `GQL-TEST`, delete (no edit path captured)
- Recurring: pause/resume, rule min/max amount edits
- Account: rename, hide/unhide
- User: toggle `budgetingConfig.isEnabled`

## Gaps from this session

**Web write surfaces missed in this session (reachable, but not exercised):**
- ~~Budget CRUD~~ — captured in follow-up session (2026-04-15). Two mutations: `EditBudget` for the "same budget every month" mode, `EditBudgetMonthly` for the "different per month" mode. There is no separate `CreateBudget` / `DeleteBudget` — setting amount to `0` deletes. A budget row exists implicitly for every user-defined category; there is no per-category enable/disable toggle (budgeting is a global user setting in Settings → General).

**Mobile-only write surfaces (out of scope for the GraphQL rewrite):**
- Goal CRUD — `/goals` returns 404 in web; goal screens are mobile-only. User has decided to **exclude** `create_goal` / `update_goal` / `delete_goal` from the GraphQL write-tool rewrite. Those three tools will either stay on Firestore or be removed — separate decision.

**Operations fully captured in follow-up sessions:**
- `EditTag` — tag rename path lives at Settings → Manage tags → hover row → `...` → inline name field.
- `CreateRecurring` / `DeleteRecurring` — `+` button in Recurrings opens "New recurring" dialog (picks an existing transaction, prompts for frequency). Delete is at `...` → Delete recurring → confirm. Both exist on web. Note: the Apollo document dump ran BEFORE these mutations fired, so verbatim query strings for CreateRecurring and DeleteRecurring are NOT available — their docs contain inferred selection sets.

**Un-review path via bulk select** (user flagged) — went through a different code path that didn't go through `client.mutate`, so the wire shape wasn't captured. Probably uses the same `EditTransaction` mutation but batched.

## Operation → write-tool mapping

For the rewrite of our 18 write tools off Firestore onto GraphQL:

| Our tool | GraphQL operation | Captured? |
|---|---|---|
| `update_transaction` | `EditTransaction` | ✅ verbatim |
| `review_transactions` | `EditTransaction` (isReviewed) | ✅ verbatim |
| `create_category` | `CreateCategory` | ✅ verbatim |
| `update_category` | `EditCategory` | ✅ verbatim |
| `delete_category` | `DeleteCategory` | ✅ verbatim |
| `create_tag` | `CreateTag` | ✅ verbatim |
| `update_tag` | `EditTag` | ✅ verbatim |
| `delete_tag` | `DeleteTag` | ✅ verbatim |
| `create_recurring` | `CreateRecurring` | ⚠️ inferred only |
| `update_recurring` | `EditRecurring` | ✅ verbatim |
| `delete_recurring` | `DeleteRecurring` | ⚠️ inferred only |
| `set_recurring_state` | `EditRecurring` (state arg) | ✅ inferred |
| `create_budget` | `EditBudget` / `EditBudgetMonthly` (amount > 0) | ✅ verbatim |
| `update_budget` | `EditBudget` / `EditBudgetMonthly` | ✅ verbatim |
| `delete_budget` | `EditBudget` (amount = 0) | ✅ verbatim |
| `create_goal` | — | **out of scope** (mobile-only, excluded) |
| `update_goal` | — | **out of scope** (mobile-only, excluded) |
| `delete_goal` | — | **out of scope** (mobile-only, excluded) |

**All 15 in-scope write tools have captured GraphQL.** 13 have verbatim query strings from the Apollo document dump; 2 (`CreateRecurring`, `DeleteRecurring`) have only inferred shapes — their verbatim docs can be collected in a single 2-minute follow-up session if needed. 3 goal tools excluded from rewrite (mobile-only).

## Design note for the rewrite

Budget CRUD does NOT map 1:1 to separate create/update/delete mutations. Consider consolidating the three budget tools into a single `set_budget` tool (categoryId, amount, month?) — matches how the API actually works. `amount: 0` is "no budget" semantically; `month` is optional (present for monthly-override mode, absent for all-months mode).

Similarly, `set_recurring_state` is a special case of `update_recurring` (the state arg of `EditRecurring`). Could be merged, but the current split is also fine — it's just a param set.

## Next steps (optional polish)

- **Fill verbatim for `CreateRecurring` / `DeleteRecurring`.** The in-browser Claude's `documentTransform` hook captures docs AT COMPILE TIME. Any mutation triggered AFTER the dump is cached by Apollo but not written to the dump file. Rerunning the dump snippet (same code as before) in a session where those two have already fired would capture them.
- **Wire-send normalization.** Before using captured queries directly, run them through Apollo's document-transform equivalent (add `__typename` to every selection set). Apollo's pre-transform query text gets HTTP 500 when sent to the server verbatim. See `wire-protocol.md` for details and mitigation options.
- **Error shape verification.** Capture one intentional 400/500 from the server during the rewrite implementation to document the GraphQL error response shape (we only have happy-path responses in this capture).
