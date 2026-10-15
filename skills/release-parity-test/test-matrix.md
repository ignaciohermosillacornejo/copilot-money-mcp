# Release parity test matrix

The case list for `skills/release-parity-test/SKILL.md`. Each case compares up to
three sources for the same fact:

- **cache**: cache-mode tools, run through `scripts/parity/cache-call.ts`
  (the cache-mode read tools are hidden while `--live-reads` is on)
- **live**: the `copilot-money` MCP tools, through the real MCP client
- **web**: `app.copilot.money` in Chrome, the ground truth (SKILL.md Guardrail 1)

**Committed file, PII rules apply.** Record outcomes as PASS / FAIL #issue / SKIP
with a reason. Never write a real balance, amount, account, merchant or place
name here; the per-run figures go in the local report under `docs/superpowers/`.

## How to extend

Add a row to the right section with the next free ID. A good case names:

1. **Setup**: what state it needs (test data in the Manual account, a cold month,
   a hidden account).
2. **Steps**: exact tool calls / web pages.
3. **Compare**: which of cache / live / web, and on which fields.
4. **Expected**: the outcome that counts as PASS, stated so a FAIL is unambiguous.
   Name the tolerance if there is one, and say "expected FAIL by code (file:line)"
   when the code already predicts a failure.
5. **Last run**: date and result. A FAIL links its issue.

Prefix the Case cell of a new row with a priority: **[P1]** could hide a
release-blocking bug, **[P2]** correctness, **[P3]** nice to have. When a fix
lands, re-run its cases and update **Last run**; do not delete a case because it
passes.

After editing, run `bun run check:skills`: it checks every tool name, every field
against the tool's default row, and that each table row has as many cells as its
header (a row with an extra cell renders shifted and loses its result). Its field
check skips a whole row that passes `fields:`, so keep `fields:` only on rows that
need it.

### Review history

- 2026-10-14: first run (ACC/INV/TXN/CAT/REC/V3/W/COH/ERR/CL first rows).
- 2026-10-15: priorities backfilled onto the rows first run on 2026-10-14, so
  the P1-only quick run still covers the core comparisons.
- 2026-10-15: two reviews of the plan against the code and the `docs/bugs/`
  corpus added the remaining rows (marked `not run`), the NET, BUD, GOAL, SES and
  SKL sections, and sharpened the Expected column of earlier rows. Two reviews
  found that a filter PASS on test rows alone is not evidence (TXN-03 passed
  while TXN-08 is a predicted FAIL), so filter cases now compare real data across
  modes.

## P — Preflight

| ID | Case | Steps | Expected | Last run |
|---|---|---|---|---|
| P-01 | [P1] MCP server runs the current build | The checkout the server runs from (`~/.claude.json`, `copilot-money` entry) is at `origin/main`; `ps -o lstart,command -ax \| grep src/cli.ts` shows a process started after that commit. If not, ask the user to `/mcp` reconnect `copilot-money`. | Server process newer than HEAD | 2026-10-14 PASS (after reconnect) |
| P-02 | [P1] Live and write mode are on | Tool list has `get_accounts_live` (not `get_accounts`) and `create_transaction` | Both present | 2026-10-14 PASS |
| P-03 | [P1] Web session | Chrome tab on `https://app.copilot.money/accounts` renders the account list | Logged in | 2026-10-14 PASS |
| P-04 | [P1] Manual account baseline | Ask the user which account is the test account; `get_accounts_live { account_type: "other", fields: ["id","itemId","name","balance","isManual"] }`; list its transactions over all dates | `isManual: true`. Record id, item id, balance, and every existing transaction id (DO NOT TOUCH) | 2026-10-14 PASS (no transactions) |
| P-05 | [P1] No API drift before comparing | `bun run smoke` then `bun run smoke:cache` from the server's checkout | All PASS. A drift verdict ends the run: otherwise drift shows up as dozens of parity FAILs | not run |
| P-06 | [P1] Cache side and live side run the same code | `git rev-parse HEAD` where `cache-call.ts` runs equals the server checkout's HEAD; `bun install` done | Equal | not run |
| P-07 | [P2] The cache is fresh | `cache-call.ts getCacheInfo` newest transaction date vs live's newest | Within 1 day; otherwise every cache comparison this run is SKIP (stale), not PASS or FAIL | not run |
| P-08 | [P1] No leftovers from an earlier run | `get_transactions_live { start_date: "2015-01-01", end_date: <today + 400d>, query: "ZZ MCP", exclude_transfers: false, exclude_excluded: false }` across all accounts; `get_tags_live`, `get_categories_live`, `get_recurring_live` by name | Zero hits, or each hit listed and settled with the user before writes | not run |
| P-09 | [P2] Record the clock | Local time, UTC offset, UTC date; list which months are live tier (age ≤ 14 days by UTC date, `src/utils/date.ts`) | The chosen cold month is at least two months back, so it cannot change tier during the run | not run |

## ACC — Accounts

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| ACC-01 | [P1] Every visible account | live `get_accounts_live` default vs cache `getAccounts` default vs web Accounts page | Same id set; names identical; balances equal to the cent except intraday-repriced brokerage rows (ACC-03) | 2026-10-14 PASS (one brokerage row per ACC-03) |
| ACC-02 | [P1] Hidden accounts | live default vs `include_hidden: true`; cache `user_hidden`; web "Hidden" badge | For every id, live `isUserHidden` equals cache `user_hidden` and the web badge; default row counts equal across modes | 2026-10-14 PASS |
| ACC-03 | [P1] Brokerage repriced intraday | live per-account `balance` vs web account figure; `get_investment_balance_live.current` vs web Investments "Live balance estimate" | Investment total equals web exactly; per-account `balance` is last-synced and may differ (documented in the description) | 2026-10-14 PASS on total; description gap #825 |
| ACC-04 | [P2] No nickname, `name` ≠ `official_name` | cache vs live `name` vs web | All three show `official_name` (#791) | 2026-10-14 PASS |
| ACC-05 | [P1] Totals | live `total_assets` / `total_liabilities` vs web Assets / Debts | Equal; any difference equals the ACC-03 per-account delta to the cent | 2026-10-14 PASS |
| ACC-06 | [P3] Field selection | `fields: ["default","balanse","mask"]` | `_field_warning` names `balanse`; `mask` returned | 2026-10-14 PASS |
| ACC-07 | [P3] `account_type` is case-insensitive | `"CREDIT"`, `"other"` | Same rows as the other case | 2026-10-14 PASS |
| ACC-08 | [P2] Full list including hidden, closed and merged | cache `getAccounts {include_hidden:true}` vs live `{include_hidden:true}` vs web | Every id only in cache is a merged (`user_deleted`) account absent from the web; every id only in live is explained; closed accounts absent by default in both modes and in the web | not run |
| ACC-09 | [P2] Credit card in credit (negative debt) | live `balance` sign and its share of `total_liabilities` vs web Debts | Signs and totals match the web. SKIP if no such account | not run |
| ACC-10 | [P3] Connection status | `get_connection_status` vs web sync / "needs attention" state | Same institutions flagged; last-update dates agree to the day | not run |

## NET — Net worth and balance history

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| NET-01 | [P1] Net worth headline | `get_networth_live {time_frame:"YTD"}` last row `assets - debt` vs web net worth vs live `total_assets - total_liabilities` | Equal apart from the ACC-03 delta (state it in cents); never `assets + debt` | not run |
| NET-02 | [P2] Every advertised `time_frame` | `get_networth_live` with each enum value | Each returns rows; no HTTP 400 | not run |
| NET-03 | [P2] `time_frame` switch and back | `YTD` → `ONE_MONTH` → `YTD` | Third call equals the first (row count, first date), never the `ONE_MONTH` series (`src/tools/live/networth.ts`) | not run |
| NET-04 | [P2] Balance history | `get_balance_history_live {item_id, account_id, time_frame:"ONE_MONTH"}` for the Manual account, one bank and one investment account vs cache `getBalanceHistory {account_id, granularity:"daily"}` vs web account chart on 3 dates | Last live point equals `get_accounts_live.balance`; overlapping dates equal to the cent; no account missing from the cache | not run |
| NET-05 | [P3] Balance-history paging | Same with `max_rows: 10`, then `offset: 10` | Pages contiguous, no overlap; `total_rows` identical; `truncated` iff `total_rows > offset + max_rows` | not run |

## INV — Investments

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| INV-01 | [P2] Position detail | live `get_holdings_live` row vs web holding detail (shares, value, average cost, total return) | Equal; return % may differ in the last rounding digit | 2026-10-14 PASS (rounding note #825) |
| INV-02 | [P1] Holdings sum vs investment balance | Sum `institution_value` vs `get_investment_balance_live.current` | Equal unless a position includes unvested stock-plan shares; then documented | 2026-10-14 differs: unvested shares, Copilot's data (#825) |
| INV-03 | [P2] Cache vs live holdings | cache `getHoldings` vs live | Same securities and quantities; prices differ by cache age; cash ticker `CUR:USD` vs `USD` (#825) | 2026-10-14 PASS with known ticker diff |
| INV-04 | [P1] Hidden account that holds something | Hide an investment account in the web (user approval required each run); `refresh_cache`; holdings default vs `include_hidden: true`; investment balance vs web; unhide | Holdings exclude it by default and include it on request; investment balance (live and web) still includes it | 2026-10-14 PASS (description gap #825) |
| INV-05 | [P2] Allocation | `get_investment_allocation_live` vs web allocation; sum vs `get_investment_balance_live.current`; then scoped to one account and unscoped again | Percentages sum to 100 ± 0.1; amounts equal the web; the second unscoped call equals the first, not the scoped one | not run |
| INV-06 | [P2] Aggregated holdings | `get_aggregated_holdings_live` per security vs the sum of `get_holdings_live` rows, with and without `include_hidden` | Equal to one of the two sums; record which, and flag a description gap if unstated | not run |
| INV-07 | [P3] Top movers | default, `filter: "PRICE_CHANGE"`, default again, vs web movers | Same securities and order as the web; third call equals the first | not run |
| INV-08 | [P3] Prices | `get_investment_prices_live {security_id, time_frame:"ONE_MONTH"}` latest close vs web holding price vs cache `getInvestmentPrices {ticker_symbol}` | Live equals web; cache may lag by its sync age; every row names its security | not run |
| INV-09 | [P3] Investment-balance history cap | default vs `history_limit: 0` | Same `history_total_count`; default is the last 30 points of the full series; `current` identical | not run |
| INV-10 | [P3] Stock splits | cache `getInvestmentSplits {ticker_symbol}` for a held security that has split, and one that has not | One row per split with the right multiplier; empty for the other | not run |

## TXN — Transaction reads

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| TXN-01 | [P1] Recent transactions | live vs web Transactions vs cache, same date range | Same id set; amounts to the cent; names equal ignoring case (cache upper-cases, #825) | 2026-10-14 PASS with known casing diff |
| TXN-02 | [P1] Default row shape | live and cache default rows | Same 10 default keys in both; cache omits `internal_transfer` when absent | 2026-10-14 FAIL (cache) #825 |
| TXN-03 | [P2] Filters on test rows | `pending: true`, `tag` by name (emoji tag), `merchant`, `account_id`, `transaction_type: "tagged"` | Each returns only matching rows, and every matching row in the range. Not evidence of cross-mode parity: see TXN-08 | 2026-10-14 PASS |
| TXN-04 | [P1] Transfers and income | `exclude_transfers: false`; `type`, `internal_transfer`, category | Transfers flagged; income/transfer rows uncategorised in live and web | 2026-10-14 PASS live; cache FAIL #824 |
| TXN-05 | [P1] Excluded category | Test transaction in an excluded category; live default and `exclude_excluded: false`; cache the same; monthly spend before and after | Hidden by default in both modes; `excluded: true` when shown; monthly spend unchanged | 2026-10-14 PASS |
| TXN-06 | [P3] Pagination tokens | `fields: ["*"]`, `limit: 1`, `offset: 2` | One full row; `has_more == (offset + limit < total_count)` | 2026-10-14 PASS |
| TXN-07 | [P1] Join cache and live by id, one cold month and the current month, every page | `exclude_transfers: false, exclude_excluded: false, fields: ["all"]` both modes, joined by id | Amounts exactly equal, negatives included. Each id only in cache is explained (pending replaced by posted, soft-deleted, split parent, cache window); any unexplained row is a FAIL | not run |
| TXN-08 | [P1] `transaction_type` means the same in both modes | `refunds`, `credits`, `hsa_eligible` over 90 days of real data: cache vs live vs web | Same ids. Expected FAIL by code: live `refunds` is every negative amount including paychecks, live `credits` is INCOME rows only (`src/tools/live/transactions.ts` ~459-461); cache uses keyword rules and excludes income (`src/tools/tools.ts` ~1160-1213) | not run |
| TXN-09 | [P1] The description's own recipe for spend | Sum `amount` over every page of `get_transactions_live {period:"last_month"}`, as its description says, vs web "spent" for that month | Equal. If INCOME rows net against spend, fix the description | not run |
| TXN-10 | [P1] The busiest month | Page through with `limit: 50` in both modes; web row count via its filtered search | Same `total_count` on every page; no duplicate ids; union equals the web count (exercises the 25-row server page cap) | not run |
| TXN-11 | [P2] Paging while a row is added | Current month: `limit: 1, offset: 0`; create a test row dated today; `offset: 1` | No duplicate or skipped row, or the description says offsets are unstable for live-tier months | not run |
| TXN-12 | [P2] Pending → posted (observe only) | Note one real pending id (local report only); a day later read both modes | Pending id gone; exactly one posted row; no doubled category total | not run |
| TXN-13 | [P2] Transaction category names are always real | One month, both modes: every `get_transactions_live` row (`fields: ["default", "category_id"]`) with a category id has a category name that appears in the category list | No raw ids, no blanks, including after a category is deleted (W-22) | not run |
| TXN-14 | [P1] Transactions in a hidden account | During INV-04: `get_transactions_live {account_id: <hidden>}` and the default month read; cache the same; web Transactions and Categories | All three agree on whether those rows appear and count toward spend | not run |
| TXN-15 | [P2] Date edges | `start_date == end_date`; a range ending on a month's last day; `last_7_days` vs web; `ytd` with a future-dated row | Inclusive bounds that match the web; note that `last_7_days` spans 8 calendar days (`src/utils/date.ts`) | not run |
| TXN-16 | [P2] Search on a renamed row | Rename a test row in the web; search old and new names in both modes and the web | Same results as the web search | not run |
| TXN-17 | [P2] Amount bounds | `min_amount: 10, max_amount: 50` both modes over a range including a refund | Absolute-value comparison in both; same ids | not run |
| TXN-18 | [P2] Single-row lookup | live `transaction_id` + `account_id` + `item_id` + date range vs cache `transaction_id`; repeat for a split parent | Same row for a normal id; for a split parent, record the difference (live omits parents) and whether the description says so | not run |
| TXN-19 | [P2] Cache coverage warning | cache `getTransactions` with `start_date` before `getCacheInfo.oldest_transaction_date` | `_cache_warning` names the cached range; live returns the older rows | not run |
| TXN-20 | [P3] `query` vs `merchant` | `query: X`, `merchant: X`, both with different values | First two equal; with both, the same one wins in both modes | not run |
| TXN-21 | [P3] Range spanning both tiers | live `last_90_days` twice | Second call refetches only live-tier months (`_cache_oldest_fetched_at` unchanged for cold months); identical ids | not run |

## CAT — Categories

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| CAT-01 | [P1] Category list and budget amounts | live `get_categories_live` `budget_amount` vs web Categories BUDGET column | Equal for every category, including negative rollover values | 2026-10-14 PASS (blank vs 0 note #825) |
| CAT-02 | [P1] Month spend | web "spent in <month>" vs sum of positive non-transfer, non-excluded `get_transactions_live` amounts vs `get_monthly_spend_live` last row | Transactions sum within $1 of the web; monthly spend last row = that month's positive-minus-refund REGULAR amounts with no `recurring_id` (read with fields: ["default", "recurring_id", "type"]; cumulative non-recurring spend, #823), NOT the web figure. | 2026-10-14 FAIL #823 (description fixed in #829; re-run) |
| CAT-03 | [P1] Dashboard | web "budgeted" vs sum of top-level non-excluded `budget_amount`; web "left" vs budgeted minus CAT-02 spend | Equal | 2026-10-14 PASS |
| CAT-04 | [P1] Spend in a parent category | `get_transactions_live {category: <parent id>}` vs the sum over its children vs web parent "spent" | Returns parent plus children, or the description says the filter matches one exact id (`transactions.ts` ~415) | not run |
| CAT-05 | [P1] Category passed by name | `{category: "<real name>"}` in both modes | An error or a warning; a silent 0 is a FAIL (cache substring-matches the id, `src/core/database.ts` ~1197) | not run |
| CAT-06 | [P1] Arguments a tool does not take | `get_categories_live {period:"last_month"}`, `get_budgets_live {active_only:true}`, `get_recurring_live {period:"last_90_days"}`, `get_holdings_live {fields:["x"]}` | Each rejects or warns; silently ignoring is a FAIL | not run |
| CAT-07 | [P2] Rename in the web, read through the MCP | Rename the test tag and category in the web; `get_tags_live`, `tag: <new name>` filter, the test row's `category_name` | New names show, or the result points at `refresh_cache` (tags/categories cached 24h) | not run |
| CAT-08 | [P2] Excluded parent category | Mark the test parent excluded with a test child under it | Child rows hidden exactly as the web hides them | not run |
| CAT-09 | [P2] Cache category spend | cache `getCategories {view:"list", period:"last_month"}` per category vs web | Equal per category within cache sync age | not run |
| CAT-10 | [P3] `excluded_only` / `include_history` / monthly `include_future` | `get_categories_live {excluded_only:true}`; `{fields:["default","budget"], include_history:true}`; `get_monthly_spend_live {include_future:true}` | Only excluded rows (= web); `budget.histories` only with `include_history`; one row per day of the month, future rows with a null `total_amount` | not run |
| CAT-11 | [P3] Monthly spend and excluded categories | On a day with a transaction in a user-excluded category, compare that day's `get_monthly_spend_live` `daily_amount` with its non-recurring REGULAR amounts read with fields: ["default", "recurring_id", "type"] and `exclude_excluded: false` | Records whether the series counts excluded-category spend, the one dimension #823's measurement left open | not run |

## BUD — Budgets

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| BUD-01 | [P1] Total budgeted | `get_budgets_live.total_budgeted` vs web Dashboard "budgeted" vs sum of top-level categories, including an excluded category that has a budget | Equal | not run |
| BUD-02 | [P2] Cache vs live budgets | cache `getBudgets` vs live, current month | Same set (no ghost rows), same amounts | not run |
| BUD-03 | [P2] Past months and `months_window` | `get_budgets_live` `amounts` for two past months vs web vs cache; `months_window: 0` | Equal per category per month; `0` returns at least the default 12 months | not run |
| BUD-04 | [P2] Parent budget roll-up | parent `budget_amount` vs web parent row vs sum of children | Parent equals web and is at least the sum of children | not run |

## REC — Recurring

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| REC-01 | [P1] Upcoming | live `get_upcoming_recurrings_live` vs web Dashboard "Next two weeks" | Same items, order and amounts | 2026-10-14 PASS |
| REC-02 | [P2] Test recurring round-trip | See W-08..W-10; read with `fields: ["default","rule","payments"]` | State, name, rule and payment as written | 2026-10-14 PASS |
| REC-03 | [P2] Full list | `get_recurring_live {fields:["default","rule"]}` vs web Recurrings page vs cache `getRecurringTransactions` | Same ids, state, frequency, amount, next date; include a negative recurring and a paused one | not run |
| REC-04 | [P2] Late evening local time | Run when the UTC date is a day ahead of local: cache "due" grouping and `get_upcoming_recurrings_live` vs web | Same (cache mixes UTC today with the local month, `tools.ts` ~2140) | not run |
| REC-05 | [P1] Real recurrings don't adopt test rows | After every W create, read `recurring_id` on each test row not linked on purpose; re-run REC-01 | All null; upcoming bills unchanged | not run |
| REC-06 | [P3] Recurring category names in a fresh session | `get_recurring_live` as the first call after reconnect, before any categories read; then again after a categories read | Null at first (documented), then populated | not run |

## GOAL — Goals (cache-only tools)

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| GOAL-01 | [P2] Goals list | cache `getGoals` vs web Goals: name, target, saved, status | Equal | not run |
| GOAL-02 | [P3] Goal history | cache `getGoalHistory` vs web goal chart | Equal for the last month | not run |

## V3 — v3.0 contract

| ID | Case | Expected | Last run |
|---|---|---|---|
| V3-01 | [P1] `compact: true` on `get_transactions_live` | Error explains the removal, what to pass instead, ends with `See docs/MIGRATING-v3.md` | 2026-10-14 PASS |
| V3-02 | [P2] Terse defaults on accounts, transactions, categories, recurring | Rows contain exactly the documented default fields | 2026-10-14 PASS |
| V3-03 | [P3] Unknown field names | `_field_warning` lists them and the valid names | 2026-10-14 PASS |
| V3-04 | [P3] Unsupported live filter (`city`) | Error names it and lists supported filters | 2026-10-14 PASS |
| V3-05 | [P2] Default rows on every remaining `fields` tool | Keys equal the preset table in `docs/MIGRATING-v3.md` exactly | not run |
| V3-06 | [P2] `fields: ["default","zzz"]` and `["*"]` and `[]` on every read tool | `_field_warning` names `zzz`; `*` equals `all`; `[]` equals default; tools without `fields` reject or warn | not run |
| V3-07 | [P3] Other removed or unsupported arguments: `include_logos` (cache accounts); live `exclude_split_parents:false`, `exclude_deleted:false`, `transaction_type:"foreign"` | Each errors, naming the argument and the alternative | not run |
| V3-08 | [P3] No dropped rows during the run | No `_dropped_invalid_rows` in any response; no `read-shape drift` line in the server log | not run |

## W — Writes (Manual account only, `ZZ MCP Test <RUN>` prefix)

Log every write in the ledger **before** sending it (SKILL.md Guardrail 2).

| ID | Case | Steps | Expected (live and web) | Last run |
|---|---|---|---|---|
| W-01 | [P1] Create tag and category | `create_tag` (emoji name), `create_category` | Appear in `get_tags_live` / `get_categories_live` and the web | 2026-10-14 PASS |
| W-02 | [P1] Create REGULAR with every optional field | Unicode, emoji, quotes, `<` `>`, `&` in the name; multi-line note with a URL and trailing spaces; a tag | Round-trips exactly | 2026-10-14 PASS |
| W-03 | [P1] Create INCOME and INTERNAL_TRANSFER with a `category_id` | — | Live `category_id` empty, `category_name` absent, `type` as written; web shows no category (API inconsistency #825) | 2026-10-14 PASS |
| W-04 | [P2] Future date, $0.01 | — | Stored; counted in the web balance | 2026-10-14 PASS |
| W-05 | [P1] Update | Rename (emoji), clear note (`""`), clear tags (`[]`), `reviewed: false`, date and amount | All land; web shows them | 2026-10-14 PASS |
| W-06 | [P1] Bulk | `bulk_edit_transactions` add tag; `review_transactions {rows, reviewed:false}` | Tag added and existing tags kept; reviewed as written | 2026-10-14 PASS |
| W-07 | [P1] Split | Two children, one unnamed, one in another category | Parent hidden; unnamed child takes the parent's name; children inherit tags | 2026-10-14 PASS |
| W-08 | [P2] Create recurring | `create_recurring` | In `get_recurring_live` | 2026-10-14 PASS |
| W-09 | [P1] Link a transaction | `add_transaction_to_recurring` | `recurring_id` set; payment in `get_recurring_live {fields:["payments"]}` and the web recurring detail | 2026-10-14 PASS |
| W-10 | [P2] Update and pause recurring | `update_recurring` (name + rule), `set_recurring_state PAUSED` | Read back exactly | 2026-10-14 PASS |
| W-11 | [P2] Budget override for one month | `set_budget {month}` on the test category for the current month, then a non-current month; read each; restore | Shows in the web for that month, then restores (the two months take different live-cache paths, `live-database.ts` ~755-794) | 2026-10-14 PASS (current month only) |
| W-12 | [P1] Manual balance follows its transactions | Web balance vs baseline after the creates | Baseline minus expenses plus income | 2026-10-14 PASS |
| W-13 | [P2] `update_category` and `update_tag` | Rename, colour, emoji, `is_excluded: true` then false on the test category; rename + colour on the test tag | Round-trip in live and web; while excluded the test row drops out of default reads and monthly spend; `tag: <old name>` errors, new name works | not run |
| W-14 | [P2] Create with `note` and `recurring_id` | `create_transaction` with both | Round-trip; the recurring's payments include it | not run |
| W-15 | [P2] Budget all-months default | `set_budget` without `month`; read current and next month in live and web; restore | Both months show it (the live cache patch touches only the current month, `live-database.ts` ~742: expected FAIL for other months) | not run |
| W-16 | [P2] Recurring states and fields | `ARCHIVED` then `ACTIVE`; `update_recurring {frequency, category_id, state}`; `create_recurring` with the `account_id`/`item_id` bypass and `BIWEEKLY` | Each reads back exactly in live and web | not run |
| W-17 | [P2] Per-row bulk update | `update_transactions` with two rows, different name/date/amount, one with `tag_ids` | All land; the `tag_ids` row's earlier tags are replaced (documented) | not run |
| W-18 | [P2] Bulk remove, category, type, both target modes | `bulk_edit_transactions {rows, remove_tag_ids}`; `{transaction_ids, category_id}`; `{type:"REGULAR"}`; `review_transactions {transaction_ids}` | Only the removed tag goes; category and type land; both target modes work | not run |
| W-19 | [P1] Transaction outside the 13-month lookup window | Create one dated 14+ months back; update without `account_id`/`item_id`; `/mcp` reconnect and again; with the bypass; `review_transactions {rows}` | Resolves through the persisted index, or the error says how to proceed (`tools.ts` ~2985) | not run |
| W-20 | [P2] Split variants | Split an INCOME row; split with a child dated in a cold month; edit a child's category; mixed-sign children | Matches the web; child edits visible (COH) | not run |
| W-21 | [P2] Parallel writes | In one turn: two `update_transaction` on one test row (name, tags) and two `create_transaction` | Both edits land; each create exists once; balance change equals their sum | not run |
| W-22 | [P2] Delete a category, tag or recurring still in use | Delete each while a test row references it | The row's category / tags / `recurring_id` in both modes match the web; no dangling ids; `tagged` filter has no ghost | not run |

## COH — Coherence (writes must be visible to the next read)

Run against a **cold month**: one whose last day is more than 14 days old (P-09),
read once first so it is cached. Check `_cache_hit` and `_cache_oldest_fetched_at`.

| ID | Case | Expected | Last run |
|---|---|---|---|
| COH-01 | [P1] `create_transaction` in a cold month, then read | Visible without `refresh_cache` | 2026-10-14 FAIL #820 |
| COH-02 | [P1] `split_transaction` in a cold month | Children visible, parent gone | not run (expected FAIL by code, #820) |
| COH-03 | [P1] `update_transaction` date/amount moving a row into a cold month | Shows at the new date | 2026-10-14 PASS |
| COH-04 | [P1] `bulk_edit_transactions` tag / `review_transactions` on a cold-month row | New tag / reviewed state visible | 2026-10-14 FAIL #821 |
| COH-05 | [P1] `update_transaction` category / note / tags on a cold-month row | Visible | not run (expected FAIL by code, #821) |
| COH-06 | [P1] `add_transaction_to_recurring` on a cold-month row | `recurring_id` visible | not run (expected FAIL by code, #821) |
| COH-07 | [P1] `delete_transaction` on a cold-month row | Gone | not run |
| COH-08 | [P2] Manual account balance after a transaction write | `get_accounts_live` shows it | 2026-10-14 FAIL (1h stale) #825 |
| COH-09 | [P1] Edits made in the **web**, read through the MCP: Edit a cold-month test row in the web (category, note, tag, amount) and create one there; read live | Visible; expected FAIL (cold months cached a week). At minimum `refresh_cache` fixes it | not run |
| COH-10 | [P2] Other live caches after MCP writes: `get_recurring_live` payments after `add_transaction_to_recurring`; `get_budgets_live` after `set_budget`; `get_upcoming_recurrings_live` after PAUSED; `get_monthly_spend_live` after creating a positive non-recurring REGULAR expense dated today (not the W-09-linked row: the series leaves out recurring-linked, income and transfer rows); `get_networth_live` after a manual write | Each shows the write; by code, up to 1h stale | not run |
| COH-11 | [P2] A month changes tier during the run: Write into a month at age 14 days before UTC midnight, read after | Visible | not run |
| COH-12 | [P2] `set_budget` without `month` in the last hours of a local month | Patched month is the one the web shows (UTC vs local month, `live-database.ts` ~738 vs `budgets.ts` ~46) | not run |
| COH-13 | [P2] Restart after writes: `/mcp` reconnect, re-read the cold month | Matches the web | not run |
| COH-14 | [P3] `refresh_cache {months:[M]}` | Only M's fetch time moves | not run |

## ERR — Validation and error messages

| ID | Input | Expected | Last run |
|---|---|---|---|
| ERR-01 | [P1] `update_transaction` `category_id` + `type: INCOME` | Rejected client-side with the reason | 2026-10-14 PASS |
| ERR-02 | [P2] `update_transaction` empty `name` | Rejected client-side | 2026-10-14 PASS |
| ERR-03 | [P1] `update_transactions` with one unknown id | Whole batch rejected before any write, with next steps | 2026-10-14 PASS |
| ERR-04 | [P2] Impossible date `2026-02-30` | Rejected client-side as invalid input | 2026-10-14 FAIL #825 |
| ERR-05 | [P1] Split amounts not summing to the parent | Rejected client-side | 2026-10-14 PASS (float noise, #825) |
| ERR-06 | [P2] `set_budget` negative amount | Rejected | 2026-10-14 PASS |
| ERR-07 | [P2] Reversed date range | Rejected with both dates | 2026-10-14 PASS |
| ERR-08 | [P2] Unknown `period` | Rejected, listing valid periods | 2026-10-14 FAIL #825 |
| ERR-09 | [P1] Well-formed but nonexistent `category_id` on `create_transaction` / a `split_transaction` child | Rejected before the write; expected FAIL by code (only the shape is checked, and the server accepts unknown ids) | not run |
| ERR-10 | [P2] Nonexistent `recurring_id` on `create_transaction` | Rejected before the write | not run |
| ERR-11 | [P1] `delete_transaction` / `split_transaction` on a split parent | Rejected client-side (#822) | not run |
| ERR-12 | [P1] `delete_transaction` with the right id and a wrong `item_id` | An error, not `success: true, deleted: false`; the row is still there | not run |
| ERR-13 | [P1] `bulk_edit_transactions` on [a live test row, an already-deleted test row] | Error names the skipped id and the count that landed; the web confirms the first row changed | not run |
| ERR-14 | [P2] `update_transaction` on a deleted id | Plain "not found", not "run `bun run smoke`" | not run |
| ERR-15 | [P2] `update_transactions {continue_on_error:true}` with one wrong `account_id`/`item_id` pair | Others land; `failures[]` names exactly that entry | not run |
| ERR-16 | [P2] Duplicate tag / category name | Clear duplicate error; no duplicate in the web | not run |
| ERR-17 | [P2] Unknown tag id in `bulk_edit_transactions`; the same id in add and remove; `account_id` without `item_id` | Each rejected before any write | not run |
| ERR-18 | [P3] Amount `12.345`, `0`, above the maximum | Rejected, or round-trips exactly as the web shows | not run |
| ERR-19 | [P3] `get_investment_prices_live` unheld `security_id`; `refresh_cache {months:["2026-1"]}`; `set_budget {month:"2026-1"}` | Each a clean, named error | not run |

## SES — Session and environment

| ID | Case | Steps | Expected | Last run |
|---|---|---|---|---|
| SES-01 | [P2] Token expiry | One read and one write ≥ 65 minutes after the server started | Both succeed without re-login | not run |
| SES-02 | [P2] Logged out (run last, after CL) | Log out of the web app, `get_accounts_live`, log back in, again | A clear "sign in" message, not drift; recovers without a restart | not run |
| SES-03 | [P3] Desktop app closed | Quit it; cache `getTransactions {period:"last_7_days"}` | A staleness warning (none today) | not run |
| SES-04 | [P3] Temp copies cleaned up | Check `$TMPDIR` after the run | No leftover LevelDB copies | not run |
| SES-05 | [P2] The shipped package | Install the release `.mcpb` or an `npm pack` tarball in a scratch dir; one live and one cache read through it | Works | not run |

## SKL — Skills end to end

Run each skill in a subagent with a fixed prompt against the server in `--write`
mode, for a fixed past month at least 45 days old. Compare its numbers with the
web for that month, and list every write-tool call in the subagent's transcript.

| ID | Case | Steps | Expected | Last run |
|---|---|---|---|---|
| SKL-01 | [P1] finance-pulse in live mode | `/finance-pulse` for month M | Every tool it calls exists in live mode (expected FAIL: it calls cache-mode names and `period` on categories); total spend and top 3 categories within $1 of the web | not run |
| SKL-02 | [P1] finance (affordability) | Fixed "can I afford $N" prompt | Its spent-this-month and free-money inputs match the web | not run |
| SKL-03 | [P2] finance-trip on test data | Four test rows: three in a 3-day window, one posted a day later; approve test rows only | The three proposed, the late one flagged; tag lands on exactly those | not run |
| SKL-04 | [P2] amazon-sync with a made-up CSV | Two orders matching test rows (one multi-category, one refund) | Proposes a split and a refund match on test rows only; web shows both after approval | not run |
| SKL-05 | [P2] finance-cleanup, declining every write | Run it and decline every proposal | No write calls; every proposed id exists in live; its unreviewed count equals the web's | not run |

## CL — Cleanup (always run, even after a failure)

| ID | Step | Expected | Last run |
|---|---|---|---|
| CL-01 | [P1] Recurring items deleted; budget overrides restored to their baseline values (not `"0"`) | Gone / restored in live and web | 2026-10-14 PASS |
| CL-02 | [P1] Transactions deleted in reverse creation order, split **children only** (#822) | No run-prefixed rows in live; cache catches up (CL-09) | 2026-10-14 PASS, but parent deletion caused #822 |
| CL-03 | [P1] Test category and tag deleted | Gone | 2026-10-14 PASS |
| CL-04 | [P1] Manual balance equals the P-04 baseline | Equal in live (after `refresh_cache {scope:"accounts"}`) and web | 2026-10-14 FAIL until the user reset it (#822) |
| CL-05 | [P1] Real-account settings changed during the run restored | Restored | 2026-10-14 PASS |
| CL-06 | [P1] Split parents after their children are gone | Record each parent's state in live and web; never delete one; a remaining parent is a known leftover | not run |
| CL-07 | [P1] Balance after every cleanup group | Baseline plus the effects of the ledger rows still present; the first drifting step is named | not run |
| CL-08 | [P2] Real categories touched by the test | Web month totals back to their before-test values | not run |
| CL-09 | [P2] Cache catches up | After the desktop app syncs, no test rows in the cache; wait at most 15 minutes, then SKIP (stale) | not run |
