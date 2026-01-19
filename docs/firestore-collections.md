# Copilot Money Firestore Collections

This document describes the Firestore collections used by Copilot Money and their data structures. This knowledge base helps maintain understanding of the local LevelDB cache format across development sessions.

## Database Location

```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main
```

## Collection Path Structure

Firestore stores documents with hierarchical paths. In the LevelDB cache, these appear as:

```
users/{user_id}/{collection}/{document_id}
```

For subcollections:
```
users/{user_id}/{parent_collection}/{parent_id}/{subcollection}/{document_id}
```

### Key Parsing

LevelDB keys use a binary format with segments separated by `0x00 0x01 0xBE`. When parsing:
- The full collection path should be preserved (e.g., `users/{user_id}/financial_goals`)
- Document ID is the last segment
- For subcollections, parent IDs are embedded in the path

---

## Collections

### `transactions`

**Path:** `users/{user_id}/transactions/{transaction_id}`

Standard financial transactions from linked accounts.

| Field | Type | Description |
|-------|------|-------------|
| `transaction_id` | string | Unique identifier |
| `amount` | number | Transaction amount (negative = expense, positive = income) |
| `date` | string | Transaction date (YYYY-MM-DD) |
| `name` | string | Original transaction name from bank |
| `display_name` | string | User-edited or cleaned name |
| `category_id` | string | Category identifier |
| `account_id` | string | Associated account |
| `pending` | boolean | Whether transaction is pending |
| `excluded` | boolean | Excluded from reports |

---

### `accounts`

**Path:** `users/{user_id}/accounts/{account_id}`

Linked financial accounts (bank accounts, credit cards, investments).

| Field | Type | Description |
|-------|------|-------------|
| `account_id` | string | Unique identifier |
| `name` | string | Account name |
| `official_name` | string | Official name from institution |
| `type` | string | Account type (depository, credit, investment, etc.) |
| `subtype` | string | Account subtype (checking, savings, credit card, etc.) |
| `mask` | string | Last 4 digits of account number |
| `current_balance` | number | Current balance |
| `available_balance` | number | Available balance |
| `institution_id` | string | Plaid institution ID |
| `user_deleted` | boolean | Whether user has deleted this account |

---

### `financial_goals`

**Path:** `users/{user_id}/financial_goals/{goal_id}`

User-defined savings goals.

| Field | Type | Description |
|-------|------|-------------|
| `goal_id` | string | Unique identifier |
| `name` | string | Goal name (e.g., "Emergency Fund") |
| `emoji` | string | Display emoji |
| `created_date` | string | Creation date (YYYY-MM-DD) |
| `associated_accounts` | string[] | Account IDs linked to this goal |
| `created_with_allocations` | boolean | Whether created with account allocations |

**Nested `savings` object:**

| Field | Type | Description |
|-------|------|-------------|
| `target_amount` | number | Target savings amount |
| `tracking_type` | string | `"monthly_contribution"` or `"end_date"` |
| `tracking_type_monthly_contribution` | number | Monthly contribution amount (if tracking_type is monthly_contribution) |
| `start_date` | string | Goal start date (YYYY-MM-DD) |
| `status` | string | Goal status (`"active"`, `"paused"`, etc.) |
| `is_ongoing` | boolean | Whether goal continues after target is reached |
| `inflates_budget` | boolean | Whether goal affects budget calculations |

**Important Notes:**
- `current_amount` is NOT stored in the goal document itself
- Current progress is stored in the `financial_goal_history` subcollection
- The UI calculates "months remaining" from: `(target_amount - current_amount) / monthly_contribution`

---

### `financial_goal_history`

**Path:** `users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}`

Monthly snapshots of goal progress. Document ID is the month in `YYYY-MM` format.

| Field | Type | Description |
|-------|------|-------------|
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

**Important Notes:**
- The field is `balance`, NOT `amount` in daily_data entries
- `current_amount` should be derived from the latest `balance` in `daily_data`
- Goal ID must be extracted from the collection path at index [3]: `users/[1]/financial_goals/[3]/financial_goal_history`

---

### `budgets`

**Path:** `users/{user_id}/budgets/{budget_id}`

Monthly budget configurations.

| Field | Type | Description |
|-------|------|-------------|
| `budget_id` | string | Unique identifier |
| `name` | string | Budget name |
| `amount` | number | Budget limit |
| `category_id` | string | Associated category (if category-specific) |
| `period` | string | Budget period (`"monthly"`, etc.) |

---

### `recurring`

**Path:** `users/{user_id}/recurring/{recurring_id}`

Recurring transaction patterns (subscriptions, bills) detected or defined by user.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (stored as `id`, mapped to `recurring_id`) |
| `name` | string | Display name (user-editable) |
| `emoji` | string | Display emoji for UI |
| `amount` | number | Expected amount (positive = expense) |
| `min_amount` | number | Minimum amount for matching range |
| `max_amount` | number | Maximum amount for matching range |
| `frequency` | string | Frequency (see values below) |
| `state` | string | Status: `"active"`, `"paused"`, `"archived"` |
| `latest_date` | string | Last payment date (YYYY-MM-DD) |
| `category_id` | string | Internal category ID |
| `plaid_category_id` | string | Plaid category ID (e.g., `"18009000"`) |
| `match_string` | string | Merchant name pattern for matching transactions |
| `transaction_ids` | string[] | Array of associated transaction IDs |
| `included_transaction_ids` | string[] | Manually included transaction IDs |
| `excluded_transaction_ids` | string[] | Manually excluded transaction IDs |
| `days_filter` | number | Day of month filter for matching |
| `skip_filter_update` | boolean | Whether to skip automatic filter updates |
| `identification_method` | string | How the recurring was detected (e.g., `"new_existing"`) |
| `_origin` | string | Source of the record (e.g., `"firebase"`) |

**Frequency Values:**
- `daily`, `weekly`, `biweekly` (every 2 weeks)
- `monthly`, `bimonthly` (every 2 months), `quarterly` (every 3 months)
- `quadmonthly` (every 4 months), `semiannually` (every 6 months)
- `annually` / `yearly`

**Important Notes:**
- `state` replaces the older `is_active` boolean field
- `latest_date` is the actual field name (not `last_date`)
- `next_date` is NOT stored - must be calculated from `latest_date` + `frequency`
- `id` field contains the recurring_id (not `recurring_id`)
- The UI groups items by state and payment status:
  - **This Month**: Active items with `latest_date` in current month (paid) or calculated `next_date` in current month (upcoming)
  - **Overdue**: Active items where calculated `next_date` is before today
  - **In the Future**: Active items where calculated `next_date` is after current month
  - **Paused**: Items with `state: "paused"`
  - **Archived**: Items with `state: "archived"`

---

### `categories`

**Path:** `users/{user_id}/categories/{category_id}`

User-defined custom categories.

| Field | Type | Description |
|-------|------|-------------|
| `category_id` | string | Unique identifier |
| `name` | string | Category name |
| `emoji` | string | Display emoji |
| `parent_id` | string | Parent category (for subcategories) |
| `is_income` | boolean | Whether this is an income category |

**Note:** Copilot also uses Plaid's standard category taxonomy for bank-provided categories.

---

### `items`

**Path:** `users/{user_id}/items/{item_id}`

Plaid Items representing connections to financial institutions.

| Field | Type | Description |
|-------|------|-------------|
| `item_id` | string | Plaid item identifier |
| `institution_id` | string | Institution identifier |
| `institution_name` | string | Institution display name |
| `status` | string | Connection status |

---

### `users/{user_id}/accounts` (User Account Customizations)

**Path:** `users/{user_id}/accounts/{account_id}`

**Note:** This is a DIFFERENT collection from the top-level `accounts`. This stores user customizations for accounts.

| Field | Type | Description |
|-------|------|-------------|
| `account_id` | string | References main account |
| `name` | string | User's custom name for account |
| `hidden` | boolean | Whether account is hidden in UI |
| `order` | number | Display order |

**Important:** When parsing, this collection must be checked BEFORE the main `accounts` collection since both end with `/accounts`.

---

### `investment_prices`

**Path:** Various nested structures for daily and high-frequency prices.

Investment price history for portfolio tracking.

---

### `investment_splits`

Stock split information for accurate historical calculations.

---

## Data Quirks and Gotchas

### 1. Collection Path Matching

Collections can appear as either:
- Simple: `transactions`
- Full path: `users/{user_id}/transactions`

Always use `endsWith()` matching:
```typescript
collection === target || collection.endsWith(`/${target}`)
```

### 2. User Accounts vs Main Accounts

Both end with `/accounts` but are different:
- `accounts` - Main account data from Plaid
- `users/{user_id}/accounts` - User customizations

Check for user accounts FIRST when routing documents.

### 3. Goal Progress Data

- Goals store configuration (target, contribution rate)
- Progress (current_amount) is in `financial_goal_history`
- Must join these to get complete goal state
- Daily data uses `balance` field, not `amount`

### 4. Subcollection Path Parsing

For `users/{user_id}/financial_goals/{goal_id}/financial_goal_history/{month}`:
- Split by `/` to get segments
- Index [3] = goal_id
- Index [5] or last segment = document_id (month)

### 5. Amount Sign Convention

- Expenses: negative amounts
- Income: positive amounts
- This matches Copilot's UI display format

### 6. Excluded Transactions

Transactions can be excluded via:
- `excluded: true` field
- Category-based exclusion rules
- User deletion

---

## Version History

| Date | Changes |
|------|---------|
| 2026-01-18 | Updated `recurring` collection with complete field list: `state`, `emoji`, `latest_date`, `match_string`, `min_amount`/`max_amount`, `transaction_ids`, `plaid_category_id`, etc. Added UI grouping logic notes. |
| 2026-01-18 | Initial documentation. Added goal history parsing fixes. |
