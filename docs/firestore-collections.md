# Copilot Money Firestore Collections

Complete documentation of all Firestore collections cached locally by Copilot Money. This is the authoritative reference for understanding the local LevelDB data, derived from systematic app screenshots and raw Firestore document inspection.

**Last verified:** 2026-04-05 | **App version:** macOS (App Store) | **Total documents:** ~55,953 across ~35 unique collection patterns

**Decode coverage:** 100% (55,953 / 55,953 documents) — all 35 collection paths decoded

## Database Location

```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main
```

## Collection Path Structure

Firestore documents have hierarchical paths. In LevelDB, keys look like:
```
remote_document/projects/copilot-production-22904/databases/(default)/documents/{collection}/{doc_id}
```

Key separator in binary: `0x00 0x01 0xBE`

### Path matching

Collections can appear as simple names or full paths:
```typescript
collection === target || collection.endsWith(`/${target}`)
```

---

## Collection Inventory

| Collection Pattern | Count | Decoded? | Description |
|---|---|---|---|
| `transactions` | ~5,500+ | Yes | Financial transactions |
| `accounts` | ~20 | Yes | Plaid account data |
| `users/{user_id}/accounts` | ~20 | Yes | User account customizations |
| `users/{user_id}/recurring` | ~66 | Yes | Recurring transaction patterns |
| `users/{user_id}/budgets` | ~36 | Yes | Budget configurations |
| `users/{user_id}/categories` | ~32 | Yes | User-defined categories |
| `users/{user_id}/financial_goals` | ~2 | Yes | Savings goals |
| `users/{user_id}/financial_goals/{id}/financial_goal_history` | ~2 | Yes | Goal progress snapshots |
| `investment_prices/{security_hash}` | ~25,555 | Yes | Investment price data |
| `investment_prices/{hash}/daily` | ~225 | Yes | Daily price subcollection |
| `investment_prices/{hash}/hf` | ~850 | Yes | High-frequency price subcollection |
| `investment_splits` | ~17 | Yes | Stock split records |
| `items` | ~13 | Yes | Plaid item connections |
| `items/{id}/accounts/{id}` | ~6,867 | Yes | Plaid account docs (with holdings) |
| `items/{id}/accounts/{id}/balance_history` | ~4,945 | Yes | Daily account balance history |
| `items/{id}/accounts/{id}/transactions` | ~1,367 | Yes | Plaid raw transactions |
| `items/{id}/accounts/{id}/holdings_history/{hash}` | ~630 | Yes | Holdings snapshot metadata |
| `items/{id}/accounts/{id}/holdings_history/{hash}/history` | ~84 | Yes | Daily holdings price/quantity |
| `items/{id}/accounts` | ~23 | Yes | Plaid account listing per item |
| `investment_performance` | ~10 | Yes | Performance tracking metadata |
| `investment_performance/{hash}` | ~8,088 | Yes | Performance data per security |
| `investment_performance/{hash}/twr_holding` | ~887 | Yes | Time-weighted return per holding |
| `securities` | ~17 | Yes | Security master data |
| `amazon/{id}` | ~72 | Yes | Amazon integration metadata |
| `amazon/{id}/orders` | ~72 | Yes | Amazon order details |
| `changes/{id}` | ~995 | Yes | Sync/change tracking |
| `changes/{id}/t` | ~535 | Yes | Transaction changes |
| `changes/{id}/a` | ~381 | Yes | Account changes |
| `users/{user_id}/tags` | ~8 | Yes | Transaction tags |
| `users` | 1 | Yes | User profile/settings |
| `subscriptions` | 1 | Yes | App subscription data |
| `invites` | 2 | Yes | Referral invite codes |
| `user_items` | 1 | Yes | User-to-item mapping |
| `feature_tracking` | 1 | Yes | Feature usage tracking |
| `support` | 1 | Yes | Feature flags |

---

## Currently Decoded Collections

### `transactions`

**Path:** `users/{user_id}/transactions/{transaction_id}` (or top-level `transactions`)
**App view:** Transactions list, Transaction detail panel, Dashboard "Transactions to review"

| Field | Type | Description |
|---|---|---|
| `transaction_id` | string | Unique identifier (= Firestore doc ID) |
| `amount` | number | Transaction amount (positive = expense, negative = income/credit) |
| `date` | string | Transaction date (YYYY-MM-DD) |
| `name` | string | Display name (user-edited or cleaned) |
| `display_name` | string | **Computed, not stored.** Added by `withDisplayName()` at read time |
| `original_name` | string | Raw merchant name from bank |
| `original_clean_name` | string | Bank-cleaned version |
| `original_date` | string | Original date before edits |
| `original_amount` | number | Original amount before edits |
| `category_id` | string | Category identifier |
| `category_id_source` | string | How category was assigned |
| `plaid_category_id` | string | Plaid's category ID |
| `plaid_category_strings` | string[] | Category hierarchy from Plaid |
| `account_id` | string | Associated account |
| `item_id` | string | Plaid item connection |
| `user_id` | string | User identifier |
| `pending` | boolean | Whether transaction is pending |
| `pending_transaction_id` | string | Links pending to posted version |
| `user_reviewed` | boolean | User has reviewed this transaction |
| `excluded` | boolean | Excluded from reports |
| `plaid_deleted` | boolean | Deleted from Plaid |
| `internal_transfer` | boolean | Marked as internal transfer (vs regular) |
| `is_amazon` | boolean | Amazon transaction flag |
| `from_investment` | string | Investment-related flag |
| `payee` | object | `{ name: string }` - who received money |
| `payer` | object | `{ name: string }` - who sent money |
| `payment_method` | string | Payment method |
| `payment_processor` | string | Payment processor |
| `location` | object | `{ address, city, region, postal_code, country, lat, lon }` |
| `iso_currency_code` | string | Currency code (e.g., "USD") |
| `plaid_transaction_type` | string | Plaid transaction type |
| `reference_number` | string | Reference number |
| `ppd_id` | string | ACH PPD ID |
| `by_order_of` | string | ACH originator |
| `account_dashboard_active` | boolean | Dashboard visibility |
| `created_timestamp` | timestamp | Creation timestamp |
| `note` | string | User-added note |
| `tags` | string[] | User-assigned tag IDs |
| `goal_id` | string | Associated goal ID |

**App-visible fields not stored directly:**
- "Similar transactions" - computed by matching `name`/`original_name`
- "Split" - creates child transactions with parent reference
- Transaction type ("Regular" vs "Internal Transfer") maps to `internal_transfer`
- The Filter > Type menu shows 4 types: **Income** (negative amount / income category), **Internal Transfer** (`internal_transfer: true`), **Recurring** (linked to a recurring pattern), **Regular** (default). "Income" and "Recurring" are computed, not stored as separate fields.
- Filter dimensions: Account, Category, Date, Goals, Keywords, Recurring, Review status, Tags, Type

---

### `accounts`

**Path:** top-level `accounts/{account_id}`
**App view:** Accounts list, Account detail panel, Sidebar account list

| Field | Type | Description |
|---|---|---|
| `account_id` | string | Unique identifier |
| `name` | string | Account name |
| `official_name` | string | Official name from institution |
| `account_type` | string | Account type: `depository`, `credit`, `investment`, `loan`, `brokerage` |
| `subtype` | string | Subtype: `checking`, `savings`, `credit card`, `401k`, `brokerage`, etc. |
| `mask` | string | Last 4 digits of account number |
| `current_balance` | number | Current balance |
| `available_balance` | number | Available balance |
| `limit` | number | Credit limit (credit cards only) |
| `iso_currency_code` | string | Currency code |
| `institution_id` | string | Plaid institution ID |
| `institution_name` | string | Institution display name |
| `item_id` | string | Parent Plaid item |
| `user_deleted` | boolean | User has deleted this account |
| `holdings` | array | Investment holdings (see Cost Basis section) |

**App-visible data from this collection:**
- Balance chart uses `balance_history` subcollection (separate)
- Account balance change % shown in list view
- Credit limit shown next to balance for credit cards (e.g., "/ $XX,XXX.00")
- "Goals" section on checking accounts links via `financial_goals.associated_accounts`

---

### `users/{user_id}/accounts` (User Account Customizations)

**Path:** `users/{user_id}/accounts/{account_id}`

User overrides for account display. Must be checked BEFORE main `accounts` since both end with `/accounts`.

| Field | Type | Description |
|---|---|---|
| `account_id` | string | References main account |
| `name` | string | User's custom display name |
| `user_id` | string | User identifier |
| `hidden` | boolean | Whether account is hidden in UI |
| `order` | number | Display sort order |

---

### `users/{user_id}/recurring`

**Path:** `users/{user_id}/recurring/{recurring_id}`
**App view:** Recurrings list (This month / Overdue / In the future / Paused / Archived), Recurring detail panel

| Field | Type | Description | In Schema? |
|---|---|---|---|
| `id` | string | Unique identifier (decoder maps to `recurring_id`) | Yes |
| `name` | string | Display name (user-editable) | Yes |
| `merchant_name` | string | Merchant name (fallback display name) | Yes |
| `emoji` | string | Display emoji | Yes |
| `amount` | number | Expected amount (positive = expense) | Yes |
| `min_amount` | number | Minimum amount for matching range | Yes |
| `max_amount` | number | Maximum amount for matching range | Yes |
| `frequency` | string | See frequency values below | Yes |
| `state` | string | `"active"`, `"paused"`, `"archived"` | Yes |
| `is_active` | boolean | Legacy field, derived from `state` for compatibility | Yes |
| `latest_date` | string | Last payment date (YYYY-MM-DD). Decoder maps to `last_date` | Yes (as `last_date`) |
| `category_id` | string | Internal category ID | Yes |
| `plaid_category_id` | string | Plaid category ID | Yes |
| `account_id` | string | Account this recurring is charged to | Yes |
| `match_string` | string | Merchant name pattern for matching | Yes |
| `transaction_ids` | string[] | Associated transaction IDs | Yes |
| `included_transaction_ids` | string[] | Manually included transaction IDs | No (dropped by strict schema) |
| `excluded_transaction_ids` | string[] | Manually excluded transaction IDs | No (dropped by strict schema) |
| `days_filter` | number | Day of month filter for matching | Yes |
| `skip_filter_update` | boolean | Whether to skip automatic filter updates | No (dropped by strict schema) |
| `identification_method` | string | Detection method (e.g., `"new_existing"`) | No (dropped by strict schema) |
| `iso_currency_code` | string | Currency code | Yes |
| `_origin` | string | Source (e.g., `"firebase"`) | No (dropped by strict schema) |

**Frequency values:** `daily`, `weekly`, `biweekly`, `monthly`, `bimonthly`, `quarterly`, `quadmonthly`, `semiannually`, `annually`/`yearly`

**Field name mapping quirks:**
- Firestore stores `id`, decoder maps to `recurring_id`
- Firestore stores `latest_date`, decoder maps to `last_date`
- `next_date` is **computed** by the decoder from `latest_date` + `frequency`, not stored in Firestore (but the decoder also checks for an explicit `next_date` field as fallback)
- `is_active` is derived from `state` by the decoder for backwards compatibility

**App detail panel shows:**
- Header: "Monthly recurring" (type + frequency)
- Category badge, emoji + name, next payment amount + date
- RULES section: Named match pattern (`match_string`), amount range (`min_amount` to `max_amount`), day filter (`days_filter`), frequency
- Payment history chart (monthly amounts over time)
- Key metrics: Spent per year, Avg transaction
- Last account used: account name + mask + balance
- Transaction history list with ADD button
- Three-dot menu: **Pause** (sets `state: "paused"`), **Archive** (sets `state: "archived"`), **Delete**

**UI grouping:**
- **This month**: Active with `latest_date` or calculated `next_date` in current month; checkmark shows paid
- **Overdue**: Active where `next_date` < today
- **In the future**: Active where `next_date` > current month
- **Paused**: `state: "paused"`
- **Archived**: `state: "archived"`

**List item display:** date, emoji, name, frequency label, category badge, amount, paid checkmark

---

### `users/{user_id}/budgets`

**Path:** `users/{user_id}/budgets/{budget_id}`
**App view:** Categories view "LEFT" column (when budgeting enabled)

| Field | Type | Description |
|---|---|---|
| `budget_id` | string | Unique identifier |
| `name` | string | Budget name |
| `amount` | number | Budget limit |
| `category_id` | string | Associated category |
| `period` | string | Budget period (`"monthly"`, etc.) |

---

### `users/{user_id}/categories`

**Path:** `users/{user_id}/categories/{category_id}`
**App view:** Categories list (Regular Categories / Excluded Categories), category detail panel
**32 documents**

| Field | Type | Description | In Schema? |
|---|---|---|---|
| `category_id` | string | Unique identifier (= doc ID or `id` field) | Yes |
| `name` | string | Category name (e.g., "Restaurants", "Car") | Yes |
| `emoji` | string | Display emoji (e.g., "🍔", "🔧") | Yes |
| `color` | string | Hex color for category dot/badge (e.g., "#8002E3") | Yes |
| `bg_color` | string | Background color for badges (e.g., "#FAF5FD") | Yes |
| `parent_category_id` | string | Parent category ID (for subcategories) | Yes |
| `children_category_ids` | string[] | Child category IDs | Yes |
| `order` | number | Display sort order within parent | Yes |
| `excluded` | boolean | Excluded from spending reports | Yes |
| `is_other` | boolean | Whether this is the "Other" catch-all category | Yes |
| `auto_budget_lock` | boolean | Locked from automatic budget adjustments | Yes |
| `auto_delete_lock` | boolean | Locked from automatic deletion | Yes |
| `plaid_category_ids` | string[] | Plaid category IDs mapped to this custom category (e.g., `["18021000", "19025000"]`) | Yes |
| `partial_name_rules` | string[] | Merchant name substrings for auto-categorization | Yes |
| `user_id` | string | Owner user ID | Yes |
| `budget_id` | string | Associated budget ID | No (in Firestore, not in schema) |
| `children_categories` | unknown | Alternate children field | No (in Firestore, not in schema) |
| `_origin` | string | Source (e.g., `"firebase"`) | No (dropped by strict schema) |

**Category hierarchy:**
- Parent categories have `children_category_ids` listing their subcategories
- Subcategories have `parent_category_id` pointing to parent
- Parent categories show a count badge (e.g., "4") in the UI
- Standalone categories (Subscriptions, Transportation, Healthcare, etc.) have no parent or children

**Category sections in the app:**
- **Regular Categories**: `excluded: false` (default). Shown hierarchically with parent > children.
- **Excluded Categories**: `excluded: true`. Transactions in excluded categories don't count toward spending totals. (e.g., "Work")

**Plaid category mapping:**
- `plaid_category_ids` maps Plaid numeric IDs to this custom category for auto-categorization
- `partial_name_rules` provides merchant-name-based auto-categorization
- Copilot also has a hardcoded Plaid taxonomy (`src/utils/categories.ts`, `src/models/category-full.ts`)

**Detail panel (for category groups):**
- Color dot + emoji + name, subcategory badges
- "Spent in [Month]" total, over-budget amount
- Monthly spending bar chart (multi-year)
- Key metrics: Spent per year, Avg monthly spend (2022-2026)
- Transaction list for current month

**Three-dot menu:** Ungroup categories, Spending category type (Regular / Excluded)

**Note:** `is_income` does NOT exist in the Firestore data. Income is determined by the hardcoded Plaid taxonomy, not a category field. The old doc incorrectly listed this. Also, `parent_id` was wrong — the actual field name is `parent_category_id`.

---

### `users/{user_id}/financial_goals`

**Path:** `users/{user_id}/financial_goals/{goal_id}`
**App view:** Goals list, Goal detail panel

| Field | Type | Description |
|---|---|---|
| `goal_id` | string | Unique identifier |
| `name` | string | Goal name |
| `emoji` | string | Display emoji |
| `created_date` | string | Creation date (YYYY-MM-DD) |
| `associated_accounts` | string[] | Account IDs linked to this goal |
| `created_with_allocations` | boolean | Whether created with account allocations |
| `savings.target_amount` | number | Target savings amount |
| `savings.tracking_type` | string | `"monthly_contribution"` or `"end_date"` |
| `savings.tracking_type_monthly_contribution` | number | Monthly contribution (if applicable) |
| `savings.start_date` | string | Goal start date |
| `savings.end_date` | string | Target end date |
| `savings.status` | string | `"active"`, `"paused"`, etc. |
| `savings.is_ongoing` | boolean | Continues after target reached |
| `savings.inflates_budget` | boolean | Affects budget calculations |

**App detail shows:**
- Saved amount / to go
- Progress chart over time
- "You need to save $X per month" calculation
- Summary: Goal amount, Start date, Target date, Saving mode (Target date / Monthly contribution)
- Contributions: Account name + mask + contribution amount
- Transactions: ability to link transactions to goal

**`current_amount` is NOT stored here** - derived from `financial_goal_history`.

---

### `users/{user_id}/financial_goals/{goal_id}/financial_goal_history`

**Path:** `users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}`
**Document ID** is the month in `YYYY-MM` format.

| Field | Type | Description |
|---|---|---|
| `user_id` | string | User identifier |
| `total_contribution` | number | Total contributions for the month |
| `daily_data` | object | Daily balance snapshots |

**`daily_data` structure:**
```json
{
  "2026-01-01": { "balance": 899.6 },
  "2026-01-13": { "balance": 899.6 }
}
```

**Important:** Field is `balance`, NOT `amount`. Goal ID extracted from path at index [3].

---

### `investment_prices/{security_hash}`

**Path:** `investment_prices/{security_hash}` and subcollections `daily/{month}`, `hf/{date}`
**App view:** Investment holding detail price chart

Stores daily and high-frequency price data per security (identified by SHA256 hash).

| Field | Type | Description |
|---|---|---|
| `investment_id` | string | Security hash identifier |
| `ticker_symbol` | string | Ticker (e.g., "DASH", "META") |
| `date` | string | Date for HF prices |
| `month` | string | Month for daily prices (YYYY-MM) |
| `close_price` | number | Closing price |
| `open_price` | number | Opening price |
| `high_price` | number | High price |
| `low_price` | number | Low price |

---

### `investment_splits`

**Path:** `investment_splits/{split_id}`

| Field | Type | Description |
|---|---|---|
| `split_id` | string | Unique identifier |
| `ticker_symbol` | string | Ticker symbol |
| `split_date` | string | Split date |
| `split_ratio` | string | Ratio (e.g., "4:1") |

---

### `items`

**Path:** `items/{item_id}`
**App view:** Settings > Connections, "Connection needing attention" in Accounts view

| Field | Type | Description |
|---|---|---|
| `item_id` | string | Plaid item identifier |
| `institution_id` | string | Institution identifier |
| `institution_name` | string | Display name |
| `connection_status` | string | Connection status |
| `needs_update` | boolean | Needs user reverification |
| `consent_expiration_time` | string | When consent expires |
| `error` | object | Error details if connection broken |

---

## Undecoded Collections

### `items/{item_id}/accounts/{account_id}` (Plaid Account Documents)

**~6,867 documents** | **High priority - contains holdings with cost basis**

These are the raw Plaid account documents, distinct from the top-level `accounts` collection. They contain the `holdings` array with cost basis data.

**Known fields:** All standard account fields plus nested `holdings` array.

Each holdings entry:
| Field | Type | Description |
|---|---|---|
| `cost_basis` | number/null | Total cost basis in dollars (NOT per-share) |
| `institution_price` | number | Current price per share (from institution) |
| `institution_value` | number | Current total value |
| `quantity` | number | Number of shares |
| `security_id` | string | SHA256 hash linking to `securities` |
| `account_id` | string | Parent account |
| `iso_currency_code` | string | Currency |
| `vested_quantity` | number | Vested shares |
| `vested_value` | number | Vested value |

**Average cost = cost_basis / quantity** (verified against app screenshots).

---

### `items/{item_id}/accounts/{account_id}/balance_history`

**~4,945 documents** | **High priority - powers account balance charts**

Daily balance snapshots. Document ID is the date (YYYY-MM-DD).

| Field | Type | Description |
|---|---|---|
| `current_balance` | number | Balance on that date |
| `available_balance` | number | Available balance (optional) |
| `limit` | number/null | Credit limit (optional) |
| `_origin` | string | Source (`"firebase"`) |

**App usage:** Powers the balance chart (1W/1M/YTD/3M/1Y/ALL) on account detail panels and the Assets/Debt chart on Dashboard.

---

### `items/{item_id}/accounts/{account_id}/transactions`

**~1,367 documents** | **Medium priority**

Raw Plaid transaction data per account. These appear to be a denormalized copy of transactions organized by account, likely used for the account-specific transaction lists.

---

### `items/{item_id}/accounts/{account_id}/holdings_history/{security_hash}/history`

**~84 documents** | **Medium priority - powers holdings charts**

Daily price and quantity snapshots per holding per account. Document ID is the month (YYYY-MM).

| Field | Type | Description |
|---|---|---|
| `id` | string | Month identifier (YYYY-MM) |
| `history` | object | Map of epoch_ms -> `{ price, quantity }` |

**History entry structure:**
```json
{
  "1768539600000": { "price": 150.16, "quantity": 913.028 },
  "1768626000000": { "price": 150.11, "quantity": 913.028 }
}
```

Keys are Unix timestamps in milliseconds. For cash positions, price=1 and quantity=0.

---

### `securities`

**17 documents** | **High priority - security master data**

Security reference data (stocks, ETFs, mutual funds, cash).

| Field | Type | Description |
|---|---|---|
| `security_id` | string | SHA256 hash (= doc ID) |
| `ticker_symbol` | string | Ticker (e.g., "VIGAX", "BNDX", "DASH") |
| `name` | string | Full security name |
| `type` | string | `"etf"`, `"equity"`, `"mutual fund"`, `"cash"`, `"derivative"` |
| `provider_type` | string | `"ETF"`, `"FUND"`, `"EQUITY"` |
| `close_price` | number | Last closing price |
| `current_price` | number | Current/live price |
| `close_price_as_of` | string/null | Close price date |
| `is_cash_equivalent` | boolean | Cash equivalent flag |
| `iso_currency_code` | string | Currency |
| `isin` | string/null | ISIN identifier |
| `cusip` | string/null | CUSIP identifier |
| `sedol` | string/null | SEDOL identifier |
| `institution_id` | string/null | Institution |
| `institution_security_id` | string/null | Institution's ID |
| `market_identifier_code` | string/null | MIC |
| `last_update` | string | ISO timestamp of last price update |
| `next_update` | string | Expected next update time |
| `update_frequency` | number | Update interval in seconds (300=5min, 86400=daily) |
| `source` | string | Price source: `"polygon"`, `"eod"` |
| `comparison` | boolean | Used as comparison benchmark (e.g., VOO for Performance vs Benchmark chart) |
| `option_contract` | object/null | Options data |
| `proxy_security_id` | string/null | Proxy security |
| `trades_24_7` | boolean | 24/7 trading (crypto) |
| `unofficial_currency_code` | string/null | Non-ISO currency |
| `cik` | string/null | SEC CIK number |
| `_origin` | string | Source flag |
| `info` | object | Additional metadata |
| `update_datetime` | string | Update timestamp |

**App usage:** Security detail panel shows ticker, full name, type badge ("Equity"/"ETF"), current price, price chart, and links to positions across accounts.

---

### `investment_performance`

**10 documents** | **Medium priority - performance tracking**

Top-level documents that define which securities have performance tracking.

| Field | Type | Description |
|---|---|---|
| `securityId` | string | Security hash |
| `type` | string | `"overall-security"` |
| `userId` | string | `"all"` |
| `access` | string[] | `["all"]` |
| `position` | number | Display position/order |
| `last_update` | string | ISO timestamp |

---

### `investment_performance/{security_hash}/twr_holding`

**~887 documents** | **Medium priority - time-weighted returns**

Monthly time-weighted return (TWR) data per security. Document ID is the month (YYYY-MM).

| Field | Type | Description |
|---|---|---|
| `history` | object | Map of epoch_ms -> `{ value }` |

**History entry:** `value` is a decimal TWR (e.g., -0.001024 = -0.1% return).

```json
{
  "1609822800000": { "value": -0.0010245901639344135 },
  "1609909200000": { "value": -0.0023907103825137055 }
}
```

**App usage:** Powers the "Total return" metric and investment performance charts. The percentage shown in the app (e.g., "-32.86%") is likely derived from this TWR data.

---

### `amazon/{id}/orders`

**72 documents** | **Low priority - Copilot Labs feature (currently Off)**

Amazon order integration. Matches Amazon orders to bank transactions.

| Field | Type | Description |
|---|---|---|
| `id` | string | Amazon order ID (e.g., "111-XXXXXXX-XXXXXXX") |
| `date` | string | Order date (YYYY-MM-DD) |
| `account_id` | string | Linked bank account (hashed) |
| `match_state` | string | `"AUTO"` - how order was matched to transactions |
| `items` | array | Order items: `[{ id, name, price, quantity, link }]` |
| `details` | object | `{ beforeTax, shipping, subtotal, tax, total }` |
| `payment` | object | `{ card: "XXXX" }` - last 4 digits of card |
| `transactions` | array | Matched transaction IDs |
| `copilot_tx` | object | Transaction-to-items mapping (keyed by tx ID) |

Each item in `copilot_tx[tx_id]`:
```json
{
  "items": [{ "id": "B0BGGCYK5J", "name": "...", "price": 11.9, "quantity": 1, "link": "..." }],
  "other": { "giftWrapping": 0, "rewards": 0, "savings": 0, "shipping": 0, "tax": 1.22 }
}
```

---

### `users/{user_id}/tags`

**8 documents** | **Medium priority**

User-defined tags for categorizing transactions. Visible in Settings > Tags and Transaction detail panel.

| Field | Type | Description |
|---|---|---|
| `name` | string | Tag name (e.g., "Tahiti", "papas-2025") |
| `color_name` | string | Named color (e.g., "olive10") |
| `hex_color` | string | Hex color with alpha (e.g., "#939D00FF") |

**App view:** Tags settings shows color dots + names. Transaction detail has "Tags" section with "Add tag" button.

---

### `users` (User Profile)

**1 document** | **Low priority - user settings**

User profile and app settings. Document ID is the Firebase user ID.

| Field | Type | Description |
|---|---|---|
| `_origin` | string | `"ios"` |
| `account_creation_timestamp` | string | ISO timestamp |
| `accounts_config` | object | Account display config (`combine_assets_and_debt`, `excluded_accounts`, `single_line`) |
| `authentication_required` | boolean | Biometric auth required |
| `auto_terms_timestamps` | object | Terms acceptance timestamps |
| `budgeting_enabled` | boolean | Budgeting feature toggle |
| `data_initialized` | boolean | Initial data load complete |
| `fcm_tokens` | string[] | Push notification tokens |
| `finance_goals_monthly_summary_mode_enabled` | boolean | Goals summary mode |
| `finance_goals_review_timestamps` | object | Per-goal review timestamps |
| `intelligence_categories_review_count` | number | Category reviews count |
| `investments_performance_initialized` | boolean | Performance data loaded |
| `items_disconnect_on_ms` | number | When items disconnect (subscription end) |
| `last_cold_open` | string | Last app cold open timestamp |
| `last_warm_open` | string | Last app warm open timestamp |
| `last_month_reviewed` | string | Last reviewed month |
| `last_year_reviewed` | string | Last reviewed year |
| `latest_spending_trigger` | object | Spending notification trigger |
| `logged_out` | boolean | Logged out flag |
| `match_internal_txs_enabled` | boolean | Internal transfer matching |
| `ml_report` | object | ML categorization report |
| `notifications` | object | Notification preferences |
| `onboarding_completed` | boolean | Onboarding done |
| `onboarding_completed_timestamp` | string | When onboarding completed |
| `onboarding_last_completed_step` | string | Last onboarding step |
| `public_id` | string | Public user ID |
| `rollovers_enabled` | boolean | Budget rollovers |
| `rollovers_starte_date` | string | Rollover start date (note: typo in field name) |
| `service_ends_on_ms` | number | Subscription end timestamp |
| `terms_timestamps` | object | Terms acceptance dates |

**App usage:** Maps to Settings toggles (Budgeting, notifications, etc.)

---

### `subscriptions`

**1 document** | **Low priority**

App Store subscription data including Apple receipt.

| Field | Type | Description |
|---|---|---|
| `_origin` | string | `"firebase"` |
| `created_timestamp` | string | Subscription start |
| `environment` | string | `"Production"` |
| `expires_date_ms` | string | Expiration epoch ms |
| `is_eligible_for_initial_offer` | boolean | Trial eligibility |
| `product_id` | string | `"com.copilot.production.subscription.yearly.1month"` |
| `provider` | string | `"apple"` |
| `price` | number | Price (95 = yearly) |
| `user_id` | string | Firebase user ID |
| `will_auto_renew` | boolean | Auto-renewal status |
| `original_transaction_id` | string | Apple transaction ID |
| `latest_result` | object | Full Apple receipt validation result |

---

### `invites`

**2 documents** | **Low priority**

Referral/gift invite codes.

| Field | Type | Description |
|---|---|---|
| `code` | string | Invite code |
| `inviter_id` | string | User who created invite |
| `is_available` | boolean | Whether invite can be redeemed |
| `is_unlimited` | boolean | Unlimited use flag |
| `assigned` | boolean | Has been assigned |
| `product_id` | string | Gift product (e.g., `"com.copilot.production.consumable.gift.6months"`) |
| `offer_reviewed` | boolean | Offer reviewed flag |

---

### `user_items`

**1 document** | **Low priority**

Maps user ID to their Plaid item IDs. Document ID is the user ID, fields are item IDs with boolean values.

```json
{
  "plaid_item_id_example_1": true,
  "plaid_item_id_example_2": true
}
```

---

### `feature_tracking`

**1 document** | **Low priority**

Tracks feature onboarding steps. Document ID is user ID.

```json
{
  "fwd:email@example.com": {
    "COMPLETED": "2023-09-13T19:01:46.347Z",
    "FWD_GMAIL": "2023-09-13T19:00:42.254Z",
    "INITIAL_GMAIL": "2023-09-13T18:57:53.538Z"
  },
  "venmo": {
    "CREATE_ITEM": "2023-09-13T18:57:53.271Z"
  }
}
```

---

### `support`

**1 document** | **Low priority**

Feature flags for support features. Document ID: `feature_flags`.

```json
{
  "mint": { "enabled": true, "percentage": 1 }
}
```

---

### `changes/{timestamp}`

**~995 documents** | **Low priority - internal sync**

Change tracking for Firestore sync. Documents are mostly empty containers. Subcollections:
- `changes/{id}/t` (~535 docs) - Transaction changes
- `changes/{id}/a` (~381 docs) - Account changes

---

## Data Quirks and Gotchas

### 1. Collection Path Matching
Collections can appear as either simple or full path. Always use `endsWith()` matching.

### 2. User Accounts vs Main Accounts
Both end with `/accounts`. Check for user accounts (`users/{user_id}/accounts`) FIRST.

### 3. Goal Progress
Goals store config (target, rate). Progress (`current_amount`) is in `financial_goal_history`. Must join to get complete state.

### 4. Amount Sign Convention
- Expenses: **positive** amounts (e.g., a $50 purchase is stored as `50`)
- Income/credits/refunds: **negative** amounts (e.g., a $1000 paycheck is stored as `-1000`)
- This is the **opposite of standard accounting convention** but matches Plaid's format
- The app UI flips the sign for display (shows "-$50" for expenses, "+$1000" for income)

### 5. Pending Transaction Reconciliation
When a charge posts, two versions coexist. The posted version has `pending_transaction_id` pointing to the pending one. Reconcile by dropping superseded pending transactions.

### 6. Investment Data Architecture
Investment data is spread across multiple collections:
- `securities` - Master data (ticker, name, type, current price)
- `items/*/accounts/*` - Holdings array (cost_basis, quantity, institution_price)
- `investment_prices/{hash}` - Historical prices (daily + high-frequency)
- `investment_performance/{hash}/twr_holding` - Time-weighted returns
- `items/*/accounts/*/holdings_history/{hash}/history` - Historical holdings snapshots
- `investment_splits` - Stock split adjustments

To recreate the app's investment view, join: security via `security_id` hash, holdings from account docs, prices from `investment_prices`, returns from `investment_performance`.

### 7. Epoch Timestamps
`holdings_history` and `twr_holding` use Unix epoch milliseconds as object keys (e.g., `"1768539600000"`). Convert with `new Date(parseInt(key))`.

### 8. Security Hash IDs
Securities are identified by SHA256 hashes (64 hex chars), NOT ticker symbols. The hash is used consistently across `securities`, `investment_prices`, `investment_performance`, and `holdings` arrays.

---

## App View to Collection Mapping

| App View | Primary Collections | Computed From |
|---|---|---|
| Dashboard - Monthly spending | `transactions` | Sum of expenses in current month |
| Dashboard - Assets/Debt | `accounts`, `balance_history` | Current balances + historical chart |
| Dashboard - Transactions to review | `transactions` | Filter: `user_reviewed == false` |
| Dashboard - Top categories | `transactions`, `categories` | Group by category, sum amounts |
| Dashboard - Next two weeks | `recurring` | Calculate next dates from `latest_date` + `frequency` |
| Transactions list | `transactions` | Sorted by date, grouped by day |
| Transaction detail | `transactions`, `categories`, `accounts`, `tags` | Joined data |
| Goals list | `financial_goals`, `financial_goal_history` | Join for current progress |
| Goal detail | `financial_goals`, `financial_goal_history`, `accounts` | Join goal + history + contributions |
| Cash flow | `transactions` | Computed: income vs expenses over time |
| Accounts list | `accounts`, `user accounts`, `items` | Merge with customizations |
| Account detail | `accounts`, `balance_history`, `transactions`, `financial_goals` | Chart + transactions + linked goals |
| Investments overview | `accounts` (investment type), `securities` | Filter investment accounts |
| Investments - Performance vs Benchmark | `investment_performance/*/twr_holding`, `securities` (where `comparison: true`) | TWR data + benchmark security (e.g., VOO) |
| Investments - Allocation | `holdings`, `securities` | Group by `securities.type` (Equity/ETF/Mutual Fund/Cash) |
| Investments - Settings | `users` | Live balance estimate toggle, benchmark selection, included accounts |
| Investment account detail | `accounts`, `holdings`, `securities`, `investment_prices` | Holdings + per-account allocation |
| Security detail | `securities`, `investment_prices`, `holdings`, `twr_holding` | Price chart + metrics + positions |
| Categories list | `categories`, `transactions`, `budgets` | Hierarchical with spending |
| Category detail | `categories`, `transactions` | Spending + key metrics + tx list |
| Recurrings list | `recurring` | Grouped by state + payment status |
| Recurring detail | `recurring`, `transactions`, `accounts` | Rules + chart + history |
| Settings - Tags | `tags` | Tag list with colors |
| Settings - Connections | `items`, `items/*/accounts` | Institution list with linked date, account count, status (needs attention / healthy) |
| Settings - General | `users` | User preferences |

---

## Version History

| Date | Changes |
|---|---|
| 2026-03-30 | **Major rewrite.** Complete inventory of all 35 collection patterns from full cache dump (52,679 docs). Added: securities, amazon/orders, balance_history, holdings_history, investment_performance/twr_holding, tags, users profile, subscriptions, invites, user_items, feature_tracking, support, changes. Added app view to collection mapping. Added investment data architecture notes. |
| 2026-01-18 | Updated `recurring` collection with complete field list. |
| 2026-01-18 | Initial documentation. |
