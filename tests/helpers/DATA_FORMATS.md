# Test Data vs Production Data Formats

This document describes the differences between the test data structures and the actual Firestore production data structures used by Copilot Money.

## Overview

The test helper (`test-db.ts`) creates LevelDB databases with Firestore-compatible protobuf documents. While the test data is structurally correct, some production data has more complex nested structures.

## Collection Mappings

| Test Collection | Production Collection | Notes |
|----------------|----------------------|-------|
| `transactions` | `transactions` | Same |
| `accounts` | `accounts` | Same |
| `recurring` | `recurring` | Same |
| `budgets` | `budgets` | Same |
| `financial_goals` | `financial_goals` | **Note: NOT `goals`** |
| `goalHistory` | `goalHistory` | May have subcollection path |
| `investmentPrices` | `investmentPrices` | Same |
| `investmentSplits` | `investmentSplits` | Same |
| `items` | `items` | Same |
| `categories` | User subcollection | Usually `users/{userId}/categories` |

## Nested Structure Differences

### Goals (`financial_goals`)

**Production Format:**
```json
{
  "goal_id": "goal_abc123",
  "name": "Emergency Fund",
  "emoji": "💰",
  "created_date": "2024-01-15",
  "created_with_allocations": false,
  "recommendation_id": "rec_xyz",
  "user_id": "user_123",
  "savings": {
    "type": "savings",
    "status": "active",
    "tracking_type": "automatic",
    "tracking_type_monthly_contribution": 500.00,
    "target_amount": 10000.00,
    "start_date": "2024-01-15",
    "modified_start_date": false,
    "inflates_budget": false,
    "is_ongoing": false
  }
}
```

**Test Format (simplified):**
```typescript
{
  goal_id: 'goal_abc123',
  name: 'Emergency Fund',
  target_amount: 10000.00,  // Flat, not nested
  current_amount: 5000.00,  // Flat, not nested
  target_date: '2024-12-31',
  goal_type: 'savings',
  is_active: true,
}
```

**TODO:** Update `createGoalDb` to support nested `savings` structure.

### User Account Customizations

**Production Format:**
Documents stored in subcollection: `users/{userId}/accounts/{accountId}`

```json
{
  "user_id": "user_123",
  "account_id": "acc_456",
  "custom_name": "My Checking",
  "is_hidden": false,
  "override_type": "checking"
}
```

### Categories

**Production Format:**
Documents stored in subcollection: `users/{userId}/categories/{categoryId}`

```json
{
  "category_id": "cat_custom_001",
  "name": "Coffee Shops",
  "user_id": "user_123",
  "icon": "☕",
  "color": "#8B4513",
  "parent_id": "FOOD_AND_DRINK"
}
```

## Field Name Conventions

All field names in production Firestore use **snake_case**:
- `transaction_id` (not `transactionId`)
- `account_id` (not `accountId`)
- `current_balance` (not `currentBalance`)

The decoder looks for snake_case fields, so test data must use snake_case.

## Timestamps

**Production Format:**
Firestore timestamps are stored as protobuf Timestamp messages:
```json
{
  "created_at": {
    "seconds": 1705334400,
    "nanos": 0
  }
}
```

**Test Format:**
The test helper accepts ISO date strings which are converted:
```typescript
{
  date: '2024-01-15',  // Converted to timestamp during encoding
}
```

## Missing Features for 1:1 Production Parity

To achieve full production data parity, the following enhancements are needed:

### 1. Nested Object Support in Goals
```typescript
interface TestGoal {
  goal_id: string;
  name?: string;
  savings?: {  // Add nested savings support
    type?: string;
    status?: string;
    target_amount?: number;
    tracking_type_monthly_contribution?: number;
    // ...etc
  };
}
```

### 2. Subcollection Support
```typescript
// Support for user subcollections
createDocument({
  collection: 'users/user_123/categories',  // Subcollection path
  id: 'cat_001',
  fields: { ... }
});
```

### 3. Timestamp Field Types
```typescript
interface TestTransaction {
  // Add proper timestamp fields
  created_at?: { seconds: number; nanos: number };
  updated_at?: { seconds: number; nanos: number };
}
```

### 4. Reference Fields
```typescript
// Some fields are Firestore references
{
  account_ref: 'projects/copilot-production/databases/(default)/documents/accounts/acc_123'
}
```

## Usage Example

Current simplified test data creation:
```typescript
await createTransactionDb(dbPath, [
  {
    transaction_id: 'txn_001',
    amount: 50.0,
    date: '2024-01-15',
    name: 'Coffee Shop',
  },
]);
```

Future production-equivalent:
```typescript
await createTransactionDb(dbPath, [
  {
    transaction_id: 'txn_001',
    account_id: 'acc_001',
    amount: 50.0,
    date: '2024-01-15',
    name: 'Coffee Shop',
    original_name: 'STARBUCKS #12345',
    original_clean_name: 'Starbucks',
    pending: false,
    excluded: false,
    user_reviewed: true,
    iso_currency_code: 'USD',
    category_id: 'FOOD_AND_DRINK_COFFEE',
    plaid_category_id: '13005043',
    created_at: { seconds: 1705334400, nanos: 0 },
  },
]);
```

## Decoder Field Extraction

The decoder extracts fields from Firestore documents based on field names. See `src/core/decoder.ts` for the complete list of expected fields for each collection.

Key decoder functions:
- `decodeTransactions()` - Expects `amount`, `date`, various string/bool fields
- `decodeAccounts()` - Expects `current_balance` (required), type fields
- `decodeGoals()` - Expects nested `savings` object with amounts/dates
- `decodeCategories()` - Expects `category_id`, `name`, `user_id`
