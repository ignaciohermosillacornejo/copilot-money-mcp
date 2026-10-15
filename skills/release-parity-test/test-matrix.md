# Release parity test matrix

The case list for `skills/release-parity-test/SKILL.md`. Each case compares up to
three sources for the same fact:

- **cache**: cache-mode tools, run through `scripts/parity/cache-call.ts`
  (the cache-mode read tools are hidden while `--live-reads` is on)
- **live**: the `copilot-money` MCP tools, through the real MCP client
- **web**: `app.copilot.money` in Chrome (ground truth, see CLAUDE.md "Trust the
  Copilot UI")

**Committed file, PII rules apply.** Record outcomes as PASS / FAIL / SKIP with an
issue number. Never write a real balance, amount, account name or merchant here;
the per-run figures go in the local report under `docs/superpowers/`.

## How to extend

Add a row to the right section with the next free ID. A good case names:

1. **Setup**: what state it needs (test data in the Manual account, a cold month,
   a hidden account).
2. **Steps**: exact tool calls / web pages.
3. **Compare**: which of cache / live / web, and on which fields.
4. **Expected**: the outcome that counts as PASS, stated so a FAIL is unambiguous.
5. **Last run**: date and result. A FAIL links its issue.

When a fix lands, re-run the case and update **Last run**; do not delete a case
because it passes.

## P — Preflight

| ID | Case | Steps | Expected | Last run |
|---|---|---|---|---|
| P-01 | MCP server runs the current build | `git -C <repo> log -1` matches `origin/main`; `ps -o lstart,command -ax \| grep src/cli.ts` shows a process started after the last merge. If not, ask the user to `/mcp` reconnect `copilot-money`. | Server process newer than HEAD | 2026-10-14 PASS (after reconnect) |
| P-02 | Live mode is on | The tool list has `get_accounts_live` and not `get_accounts` | Live tools present | 2026-10-14 PASS |
| P-03 | Web session | Chrome tab on `https://app.copilot.money/accounts` renders the account list | Logged in | 2026-10-14 PASS |
| P-04 | Manual account baseline | `get_accounts_live { account_type: "other", fields: ["id","name","balance","isManual"] }`; `get_transactions_live { account_id, start_date: "2020-01-01", end_date: <year end>, exclude_transfers: false, exclude_excluded: false }` | Record id, item id, balance, and that it has no transactions (or list them) | 2026-10-14 PASS (no transactions) |

## ACC — Accounts

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| ACC-01 | Every visible account: name, balance, type | live `get_accounts_live` vs web Accounts page vs cache `getAccounts {include_hidden:true}` | Same set of ids, names and balances in all three | 2026-10-14 PASS for all but one brokerage row (see ACC-03) |
| ACC-02 | Hidden accounts | live default vs `include_hidden: true`; cache `user_hidden`; web "Hidden" badge | Default excludes hidden; flags agree across modes | 2026-10-14 PASS |
| ACC-03 | Brokerage repriced intraday | live per-account `balance` vs web account figure; `get_investment_balance_live.current` vs web Investments "Live balance estimate" | Investment total equals web exactly; per-account balance is last-synced and may differ (documented) | 2026-10-14 PASS on total; per-account differs, description gap #825 |
| ACC-04 | Account with no nickname whose `name` and `official_name` differ | cache vs live `name` vs web | All three show `official_name` (#791) | 2026-10-14 PASS |
| ACC-05 | Totals | live `total_assets` / `total_liabilities` vs web Assets / Debts | Equal, allowing for ACC-03 repricing | 2026-10-14 PASS (difference = ACC-03) |
| ACC-06 | Field selection | `fields: ["default","balanse","mask"]` | `_field_warning` names `balanse`; `mask` returned | 2026-10-14 PASS |
| ACC-07 | `account_type` filter is case-insensitive | `account_type: "CREDIT"` and `"other"` | Same rows as lowercase / uppercase | 2026-10-14 PASS |

## INV — Investments

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| INV-01 | Position detail | live `get_holdings_live` row vs web Investments → holding detail (shares, value, average cost, total return) | Equal; return % may differ in the last rounding digit | 2026-10-14 PASS (rounding note #825) |
| INV-02 | Holdings sum vs investment balance | Sum `institution_value` vs `get_investment_balance_live.current` | Equal unless a position includes unvested shares (stock plan); then documented, not a bug | 2026-10-14 differs: unvested shares, Copilot's data (#825) |
| INV-03 | Cache vs live holdings | cache `getHoldings` vs live | Same securities and quantities; prices differ by cache age; cash ticker differs (`CUR:USD` vs `USD`, #825) | 2026-10-14 PASS with known ticker diff |
| INV-04 | Hidden account that holds something | Hide an investment account in the web app (user approval required), `refresh_cache`, then: holdings default vs `include_hidden: true`, investment balance vs web | Holdings exclude it by default and include it on request; investment balance (live and web) still includes it. Unhide afterwards. | 2026-10-14 PASS (description gap #825) |

## TXN — Transaction reads

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| TXN-01 | Recent transactions, name and amount | live vs web Transactions page vs cache | Same rows; cache names are upper-cased (#825) | 2026-10-14 PASS with known casing diff |
| TXN-02 | Default row shape | live default row; cache default row | Both have the same 10 default keys; cache omits `internal_transfer` when absent (#825) | 2026-10-14 FAIL (cache) #825 |
| TXN-03 | Filters | `transaction_type` refunds / tagged, `pending: true`, `tag` by name (including an emoji tag), `merchant`, `account_id` | Each returns only matching rows; tagged returns exactly the tagged test rows | 2026-10-14 PASS |
| TXN-04 | Transfers and income | `exclude_transfers: false`; check `type`, `internal_transfer`, category | Transfers flagged; income/transfer rows uncategorised in live and web | 2026-10-14 PASS live; cache FAIL #824 |
| TXN-05 | Excluded category | Create a test transaction in an excluded category (e.g. Work); read live default and `exclude_excluded: false`; cache the same; monthly spend before and after | Hidden by default in both modes; `excluded: true` when shown; monthly spend unchanged | 2026-10-14 PASS |
| TXN-06 | Pagination and tokens | `fields: ["*"]`, `limit: 1`, `offset: 2` | One full row, `total_count` and `has_more` consistent | 2026-10-14 PASS |

## CAT / BUD — Categories and budgets

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| CAT-01 | Category list and budget amounts | live `get_categories_live` `budget_amount` vs web Categories BUDGET column | Equal for every category, including negative rollover values | 2026-10-14 PASS (blank vs 0 note #825) |
| CAT-02 | Month spend | web Categories "spent in <month>" vs sum of positive `get_transactions_live` amounts for the month vs `get_monthly_spend_live` last row | Transactions sum ≈ web; monthly spend series semantics per #823 | 2026-10-14 FAIL #823 |
| CAT-03 | Dashboard | web Dashboard "left" / "budgeted" vs category totals | Consistent | 2026-10-14 PASS |

## REC — Recurring

| ID | Case | Compare | Expected | Last run |
|---|---|---|---|---|
| REC-01 | Upcoming | live `get_upcoming_recurrings_live` vs web Dashboard "Next two weeks" | Same items, order and amounts | 2026-10-14 PASS |
| REC-02 | Full list round-trip of a test recurring | See W-08..W-10; read with `fields: ["default","rule","payments"]` | State, name, rule (`days`, amounts, `nameContains`) and payment as written | 2026-10-14 PASS |

## V3 — v3.0 contract

| ID | Case | Expected | Last run |
|---|---|---|---|
| V3-01 | `compact: true` on `get_transactions_live` | Error explains the removal, what to pass instead, ends with `See docs/MIGRATING-v3.md` | 2026-10-14 PASS |
| V3-02 | Terse defaults on every live read tool | Rows contain exactly the documented default fields | 2026-10-14 PASS (spot-checked accounts, transactions, categories, recurring) |
| V3-03 | Unknown field names | `_field_warning` lists them and the valid names | 2026-10-14 PASS |
| V3-04 | Unsupported live filter | `city` on `get_transactions_live` | Error names the parameter and lists supported filters | 2026-10-14 PASS |

## W — Writes (Manual account only, `ZZ MCP Test` prefix)

Every case records the ids it creates in the run's cleanup ledger.

| ID | Case | Steps | Expected (live and web) | Last run |
|---|---|---|---|---|
| W-01 | Create tag and category | `create_tag` (emoji name), `create_category` | Appear in `get_tags_live` / `get_categories_live` and the web | 2026-10-14 PASS |
| W-02 | Create REGULAR with every optional field | Name with unicode, emoji, quotes, `<` `>`, `&`; multi-line note with a URL and trailing spaces; a tag | Round-trips exactly in live and web | 2026-10-14 PASS |
| W-03 | Create INCOME and INTERNAL_TRANSFER | With a `category_id` | Server clears the category (#825 for the API inconsistency) | 2026-10-14 PASS |
| W-04 | Future date, $0.01 | — | Stored; counted in the web balance | 2026-10-14 PASS |
| W-05 | Update | Rename (emoji), clear note (`""`), clear tags (`[]`), `reviewed: false`, date and amount change | All land; web shows them | 2026-10-14 PASS |
| W-06 | Bulk | `bulk_edit_transactions` add tag; `review_transactions` with `rows` | Land server-side | 2026-10-14 PASS |
| W-07 | Split | Two children, one unnamed, one in another category | Parent hidden; unnamed child takes parent's name; children inherit tags | 2026-10-14 PASS |
| W-08 | Create recurring from a transaction | `create_recurring` | Appears in `get_recurring_live` | 2026-10-14 PASS |
| W-09 | Link a transaction to it | `add_transaction_to_recurring` | `recurring_id` set; payment shows | 2026-10-14 PASS |
| W-10 | Update and pause | `update_recurring` (name + rule), `set_recurring_state PAUSED` | Read back exactly | 2026-10-14 PASS |
| W-11 | Budget month override | `set_budget` with `month`, then `"0"` to clear | Shows in web for that month, then clears | 2026-10-14 PASS |
| W-12 | Manual account balance follows its transactions | Web balance after the creates vs baseline | Baseline minus expenses plus income | 2026-10-14 PASS |

## COH — Write → live-read coherence (the cache must reflect the write)

Run each against a **cold month**: a month whose last day is more than 14 days old,
read once before the write so it is cached. Check `_cache_hit` and
`_cache_oldest_fetched_at` in the response.

| ID | Case | Expected | Last run |
|---|---|---|---|
| COH-01 | `create_transaction` in a cold month, then read it | Row visible without `refresh_cache` | 2026-10-14 FAIL #820 |
| COH-02 | `split_transaction` in a cold month, then read | Children visible, parent gone | not run (inferred FAIL #820) |
| COH-03 | `update_transaction` date/amount moving a row into a cold month | Row shows at the new date | 2026-10-14 PASS |
| COH-04 | `bulk_edit_transactions` tag / `review_transactions` on a cold-month row | New tag / reviewed state visible | 2026-10-14 FAIL #821 |
| COH-05 | `update_transaction` category / note / tags on a cold-month row | Visible | not run (FAIL by code, #821) |
| COH-06 | `add_transaction_to_recurring` on a cold-month row | `recurring_id` visible | not run (FAIL by code, #821) |
| COH-07 | `delete_transaction` on a cold-month row | Row gone | not run |
| COH-08 | Manual account balance after a transaction write | `get_accounts_live` shows the new balance | 2026-10-14 FAIL (1h stale) #825 |

## ERR — Validation and error messages

| ID | Input | Expected | Last run |
|---|---|---|---|
| ERR-01 | `update_transaction` `category_id` + `type: INCOME` | Rejected client-side, explains why | 2026-10-14 PASS |
| ERR-02 | `update_transaction` empty `name` | Rejected client-side | 2026-10-14 PASS |
| ERR-03 | `update_transactions` with one unknown id | Whole batch rejected before any write; message says how to proceed | 2026-10-14 PASS |
| ERR-04 | Impossible date `2026-02-30` | Rejected client-side as invalid input | 2026-10-14 FAIL #825 (blamed on API drift) |
| ERR-05 | Split amounts not summing to the parent | Rejected client-side | 2026-10-14 PASS (float noise in message, #825) |
| ERR-06 | `set_budget` negative amount | Rejected | 2026-10-14 PASS |
| ERR-07 | Reversed date range | Rejected with both dates in the message | 2026-10-14 PASS |
| ERR-08 | Unknown `period` | Rejected, listing valid periods | 2026-10-14 FAIL #825 (no list) |

## CL — Cleanup (always run, even after a failure)

| ID | Step | Expected | Last run |
|---|---|---|---|
| CL-01 | Delete recurring, clear budget overrides | Gone from live and web | 2026-10-14 PASS |
| CL-02 | Delete test transactions: split **children only**, never a split parent (#822) | Manual account has no `ZZ MCP Test` rows in live or cache | 2026-10-14 PASS, but parent deletion caused #822 |
| CL-03 | Delete test category and tag | Gone | 2026-10-14 PASS |
| CL-04 | Manual account balance equals the P-04 baseline | Equal in live and web | 2026-10-14 FAIL until the user reset it (#822) |
| CL-05 | Any real-account setting changed (INV-04) is restored | Restored | 2026-10-14 PASS |
