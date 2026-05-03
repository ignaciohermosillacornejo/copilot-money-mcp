# Hidden Copilot Money Mutations

Mutations discovered on Copilot's GraphQL endpoint (`https://app.copilot.money/api/graphql`) that the web-session capture never observed. Surfaced by error-leak recon (see [`introspection-recon.md`](./introspection-recon.md)).

Signatures below reflect only what the server confirmed via validation errors. Optional input fields and non-required output fields may exist but are hidden by Apollo's error suppression — "unknowns" are called out per mutation.

## Summary

| Mutation | MCP tool yet? | Risk | Primary use |
|---|---|---|---|
| [`splitTransaction`](#splittransaction) | ✅ PR #323 | medium (reversal via edit/delete) | Split one transaction into N children |
| [`createTransaction`](#createtransaction) | ✅ PR #320 | medium | Manual-account transactions |
| [`deleteTransaction`](#deletetransaction) | ✅ PR #321 | high (destructive) | Remove a transaction |
| [`addTransactionToRecurring`](#addtransactiontorecurring) | ✅ PR #322 | low | Attach one-off to existing recurring |
| [`bulkEditTransactions`](#bulkedittransactions) | ❌ | **DO NOT PROBE** blindly | Edit many transactions at once |
| [`bulkDeleteTransactions`](#bulkdeletetransactions) | ❌ | **high (destructive)** | Delete many transactions |
| [`createAccount`](#createaccount) | ❌ | medium | Manual account creation |
| [`deleteAccount`](#deleteaccount) | ❌ | high (cascades to all txns) | Remove a manual account |
| [`deleteUser`](#deleteuser) | ❌ | **existential** | Delete the entire user account |
| [`acceptTerms`](#accepttermsdismissannouncement-editinvestmentconfig) | ❌ | low | Record that the user accepted updated ToS |
| [`dismissAnnouncement`](#accepttermsdismissannouncement-editinvestmentconfig) | ❌ | low | Dismiss an in-app announcement |
| [`editInvestmentConfig`](#accepttermsdismissannouncement-editinvestmentconfig) | ❌ | low | User-level investment config (odd — no required args) |
| [`confirmConnection`](#connection-lifecycle) | ❌ | low-medium | Confirm a Plaid-link connection after institution challenge |
| [`deleteConnection`](#connection-lifecycle) | ❌ | **high (assumed cascade)** | Remove a Plaid connection |
| [`startSubscription`](#subscription-lifecycle) | ❌ | **do not expose** | Start a Copilot paid plan |
| [`changeSubscription`](#subscription-lifecycle) | ❌ | **do not expose** | Switch between Copilot plans |
| [`cancelSubscription`](#subscription-lifecycle) | ❌ | **do not expose** | Cancel the Copilot subscription |
| [`claimPromotion`](#subscription-lifecycle) | ❌ | low | Redeem a promo code |
| [`deletePaymentMethod`](#subscription-lifecycle) | ❌ | medium | Remove a saved payment method |

### Sweep coverage — 2026-04-22

A second broad sweep across ~170 additional candidates covered Amazon, Plaid, Account, Holdings/Investments, Rules, Notifications, User preferences, Subscription/billing, Attachments, Sharing, AI/assistant, Reports, Search, and miscellaneous (password/PIN/2FA/device). The nine new mutations above came out of that sweep; everything else in those categories returned "Cannot query field" on all tested candidates. Tested-and-absent candidates are catalogued in the "Tested-and-absent surface" section below so future authors don't re-probe the same names.

## Budget mutations — finding

**No hidden budget mutations exist.** Budget CRUD is entirely captured by `editBudget(categoryId, input)` and `editBudgetMonthly(categoryId, input)` — Copilot treats a budget as an *attribute of a category*, not a separate entity. No `createBudget`, `deleteBudget`, `resetBudget`, or `rolloverBudget` exist on the server. "Removing" a budget is done by calling `editBudget` with the appropriate zero/null amount.

## Goal mutations — finding

**No goal mutations exist on the GraphQL endpoint.** A focused sweep of 277 candidate names returned zero hits. The sweep covered:

- all verb × entity combinations for `Goal`, `Goals`, `FinancialGoal`, `FinancialGoals`, `SavingsGoal`, `SavingsGoals`, and `Savings` — across 33 verbs (`create`/`edit`/`delete`/`archive`/`pause`/`complete`/`contribute`/`fund`/`allocate`/`transfer`/…);
- transaction-goal linking candidates: `setTransactionGoal`, `linkTransactionToGoal`, `attachTransactionToGoal`, `moveTransactionToGoal`, `assignGoalToTransaction`, etc.;
- account-goal linking candidates: `linkAccountToGoal`, `setGoalAccount`, `setSavingsAccount`, `enableSavings`, etc.;
- goal-category linking candidates: `linkCategoryToGoal`, `setGoalCategories`, etc.;
- progress/contribution ops: `editGoalProgress`, `incrementGoal`, `contributeToGoal`, etc.

Additionally, `editTransaction`'s `EditTransactionInput` does **not** accept any of `goal`, `goalId`, `financial_goal_id`, `financialGoalId`, `savingsGoalId` — all probed keys were rejected with "not defined by type EditTransactionInput". The `goal_id` field we decode from Firestore (see `src/models/transaction.ts`) is a Firestore-side attribute only; it has no GraphQL read or write path.

**Conclusion:** goals are entirely client-side in Copilot. The iOS and desktop apps write goal changes directly to Firestore (bypassing the GraphQL layer that Copilot's own backend enforces for other entities). To support goal writes from the MCP, we'd need Firestore write access — a larger architectural change than adding another GraphQL tool.

---

## splitTransaction

Signature:

```graphql
mutation SplitTransaction(
  $itemId:    ID!
  $accountId: ID!
  $id:        ID!                         # parent transaction's ID
  $input:     [SplitTransactionInput!]!   # one entry per child split
) {
  splitTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    parentTransaction  { id }             # original, "hidden" after split
    splitTransactions  { id }             # new child docs
  }
}

input SplitTransactionInput {
  name:       String!   # display name per split (e.g. "Rent", "Hotel")
  date:       Date!     # typically matches parent.date
  amount:     Float!    # children must sum to parent.amount (server enforces)
  categoryId: ID!       # required per split
}
```

**Return shape:** `SplitTransactionOutput!` has exactly two fields: `parentTransaction: Transaction!` and `splitTransactions: [Transaction!]!`.

**Unknowns:** optional fields on `SplitTransactionInput` (tags, notes, isReviewed, etc. all rejected as "not defined" — the server really does only accept the four required fields at split time). Downstream edits require per-child `editTransaction` calls.

**How splits manifest in Firestore (for the cache):** after success, the parent doc gets `children_transaction_ids: [...]` with the new child IDs and `category_id: ""` + `old_category_id: <original>`. Each child doc gets `parent_transaction_id: <parent>`. This is what the Phase 1 decoder work (PR #315) surfaces to MCP consumers.

**Reversal:** no dedicated mutation. Probes for `unsplitTransaction`, `revertSplit`, `undoSplit` all "Cannot query field". To undo a split, callers would delete each child (via `deleteTransaction`) and then edit the parent to restore its category — but Copilot's UI also supports reverting via "edit split → remove all entries".

---

## createTransaction

```graphql
mutation CreateTransaction(
  $itemId:    ID!
  $accountId: ID!
  $input:     CreateTransactionInput!
) {
  createTransaction(itemId: $itemId, accountId: $accountId, input: $input) {
    id
    # Transaction fields per existing TransactionFields fragment
  }
}

input CreateTransactionInput {
  name:       String!
  date:       Date!
  amount:     Float!
  categoryId: ID!
  type:       TransactionType!   # enum — values unknown, needs probe
  # Optional fields unknown
}
```

**Unknowns:**
- `TransactionType` enum values — Copilot UI allows manual transactions to be "expense", "income", or "transfer" so those are likely candidates. Confirm by sending an invalid value and harvesting the "must be one of" list.
- Optional input fields (notes, tags, isReviewed, etc.).

**Intended use:** This is what Copilot uses when the user adds a manual transaction to a manual account. Plaid-connected accounts should not be written to this way — they'd be overwritten on the next sync.

---

## deleteTransaction

```graphql
mutation DeleteTransaction($itemId: ID!, $accountId: ID!, $id: ID!) {
  deleteTransaction(itemId: $itemId, accountId: $accountId, id: $id)   # Boolean!
}
```

Returns `Boolean!`. **Destructive — no soft-delete.** Firestore picks up the removal and Copilot's clients stop rendering it.

⚠ **Unverified behavior.** Plaid-connected transactions *may* re-appear on the next sync (Plaid is the source of truth), making delete appear idempotent — but this hasn't been tested. Even if the transaction reappears, any user-side metadata (category override, tags, notes, reviewed state, goal link, split children) is likely *not* preserved across the delete/re-sync round-trip. Treat `deleteTransaction` on Plaid transactions as destructive until verified otherwise.

---

## addTransactionToRecurring

```graphql
mutation AddTransactionToRecurring(
  $itemId:    ID!
  $accountId: ID!
  $id:        ID!                          # transaction ID to attach
  $input:     AddTransactionToRecurringInput!
) {
  addTransactionToRecurring(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    transaction {                          # the ONLY field on the output type
      ...TransactionFields                 # same shape as createTransaction's output
    }
  }
}

input AddTransactionToRecurringInput {
  recurringId: ID!      # required — the only field
}
```

**Return shape:** `AddTransactionToRecurringOutput!` has exactly one field: `transaction: Transaction!`. Probed output candidates `recurring`, `updated`, `id`, `success`, `errors`, `node`, `data`, `recurringTransaction` all failed with "Cannot query field X" — the server even suggested "Did you mean 'transaction'" when probing `recurringTransaction`, confirming `transaction` is the canonical (and only) field.

**Input shape:** `AddTransactionToRecurringInput` has exactly one field: `recurringId: ID!`. Optional-field probes for `date`, `isReviewed`, `notes`, and `tagIds` were all rejected as "not defined by type AddTransactionToRecurringInput" — downstream edits (category/notes/tags) require a follow-up `editTransaction` call.

**Use case:** manually link a one-off transaction to an existing recurring series that Copilot's auto-detection missed (e.g., a rent transaction that didn't match the existing rent recurring).

---

## bulkEditTransactions

```graphql
mutation BulkEditTransactions($input: BulkEditTransactionInput!) {
  bulkEditTransactions(input: $input) {
    # BulkEditTransactionsOutput fields unknown
  }
}
```

**⚠ Do not probe with empty input.** A probe with `input: {}` caused the server to execute a real SQL query (`select "item_id", "account_id", "transaction_id" from "transactions" where ...`) with ~48 placeholders before failing. The full input shape is unknown and reverse-engineering it via error leak is not safe against a live account.

**Intended use:** batch apply the same change (category, tags, reviewed state) to many transactions in one call. Likely what Copilot's iOS "select many → edit" UI uses.

**How to reverse-engineer safely:** iOS traffic capture, or set up a disposable test account and probe against it.

---

## bulkDeleteTransactions

```graphql
mutation BulkDeleteTransactions(/* args unknown */) {
  bulkDeleteTransactions(/* required args not yet probed */) {
    # BulkDeleteTransactionsOutput fields unknown
  }
}
```

Confirmed to exist (returns `BulkDeleteTransactionsOutput!`) but neither argument shape nor output fields are known. **Do not call without args** — it almost certainly requires a list of transaction IDs, but reading the error-enumeration path further could risk the same validation-bypass behavior as `bulkEditTransactions`. Given the risk profile, we didn't probe further.

---

## createAccount

```graphql
mutation CreateAccount(/* required args unknown */) {
  createAccount {
    # Returns Account!
  }
}
```

Confirmed to exist and return `Account!`. Intended for manual account creation (the "Add account → Manual" flow in Copilot's UI).

---

## deleteAccount

```graphql
mutation DeleteAccount($itemId: ID!, /* other args unknown */) {
  deleteAccount(itemId: $itemId /* ... */)   # returns ID!
}
```

Confirmed to exist, returns `ID!` (presumably the deleted account's ID). Only `itemId` is confirmed required.

**Destructive:** deleting an account likely cascades to its transactions.

---

## deleteUser

```graphql
mutation DeleteUser($confirm: Boolean!) {
  deleteUser(confirm: $confirm)   # Boolean!
}
```

**⚠⚠ Existential — deletes the user's entire Copilot account.** Surfaced by the brute-force sweep; listed here for completeness and as a warning. The `confirm: Boolean!` guard is the only protection — do not expose this via any MCP tool without a multi-step confirmation gate.

---

## acceptTerms, dismissAnnouncement, editInvestmentConfig

Surfaced by the 2026-04-22 sweep. All three return a user-scoped object with no cross-user effects.

```graphql
mutation Probe { acceptTerms { id } }                              # User!; no args
mutation Probe { dismissAnnouncement(id: $id) { id } }             # Announcement!
mutation Probe { editInvestmentConfig { id } }                     # User!; no required args
```

`editInvestmentConfig` having no required args is unusual — likely accepts an optional input object whose fields Apollo doesn't leak (same suppression problem as elsewhere). Not worth probing without an iOS capture.

---

## Connection lifecycle

Plaid-style institution connections have two hidden mutations — a `create` / `refresh` /`edit` / `reconnect` family was probed and does **not** exist. The UI-driven "connect an account" flow is presumably `createAccount` → `confirmConnection` after the institution challenge.

```graphql
mutation Probe {
  confirmConnection(institutionId: ID!, input: ConfirmConnectionInput!) { id }   # Connection!
}

mutation Probe { deleteConnection(id: ID!) }                                     # no output subfields
```

**Unknowns:** `ConfirmConnectionInput` fields. Probing with empty input (or any input) requires a real `institutionId`, which would hit the data layer — refused without an isolated test account. Input probably carries a Plaid `public_token` or equivalent OAuth grant.

**Destructive:** `deleteConnection` almost certainly cascades to every account + transaction tied to that institution. Same risk class as `deleteAccount` — do not expose without confirmation gates.

---

## Subscription lifecycle

Copilot's in-app paid-plan management. Four billing-sensitive mutations plus one lower-risk payment-method mutation.

```graphql
mutation Probe { startSubscription(input: StartSubscriptionInput!) { id } }    # StartSubscriptionResult!
mutation Probe { changeSubscription(input: ChangeSubscriptionInput!) { id } }  # ChangeSubscriptionResult!
mutation Probe { cancelSubscription(subscriptionId: ID!) { id } }              # CopilotSubscription
mutation Probe { claimPromotion(promotionCode: String!) { id } }               # ClaimPromotionResult!
mutation Probe { deletePaymentMethod(id: ID!) }
```

Confirmed input shapes:
- `StartSubscriptionInput`: `planId: ID!, paymentMethodId: ID!` (both required; other fields unknown).
- `ChangeSubscriptionInput`: has `planId: ID!` (confirmed via "Did you mean planId" error on a `plan` probe); other fields unknown.

**Do not expose any of these via MCP tools.** Billing operations — cancelling, changing plans, or claiming promotions — should always be user-driven through Copilot's own UI. The right safety-posture is to explicitly refuse these even if asked; leave them documented here only so the recon surface is complete.

**`deletePaymentMethod` is lower-risk than the other four** — it removes a saved card from the user's wallet without changing the active plan or charging anything. Still left out of MCP scope: payment-method management is account-administration UX that belongs in Copilot's own settings screen, and a stale removal can break the next renewal. Same "user-driven only" posture, but for ergonomic reasons rather than billing-impact reasons.

---

## Tested-and-absent surface (saves re-probing)

The 2026-04-22 sweep returned "Cannot query field on type Mutation" for every candidate in these categories. Suggestions surfacing in "Did you mean" errors were followed up and are all captured above.

- **Amazon** (20 probed): `linkAmazonOrder`, `unlinkAmazonOrder`, `matchAmazonOrder`, `unmatchAmazonOrder`, `setAmazonOrder`, `editAmazonOrder`, `createAmazonIntegration`, `editAmazonIntegration`, `deleteAmazonIntegration`, `refreshAmazonOrders`, `syncAmazonOrders`, `importAmazonOrders`, `setAmazonOrderId`, `editTransactionAmazonOrder`, `attachAmazonOrder`, `detachAmazonOrder`, `setTransactionAmazonOrder`, `createAmazonOrder`, `deleteAmazonOrder`, `amazonOrderMatch`. **Amazon order-to-transaction linkage is set server-side only** — the Firestore `amazon/{id}/orders/{order_id}.copilot_tx` field is populated by Copilot's backend matcher, not by any user-accessible mutation. Downstream: to expose Amazon data via MCP we'd need read-only tools on the decoded cache (we have `AmazonOrderSchema` in `src/models/amazon.ts`, just no `get_amazon_orders` tool).
- **Plaid item lifecycle** (16 probed): `createLinkToken`, `exchangePublicToken`, `refreshItem`, `syncItem`, `reconnectItem`, `editItem`, `deleteItem`, `createItem`, `retriggerItem`, `forceItemSync`, `updateItemCredentials`, `resolveItemError`, `removeItem`, `disconnectItem`, `linkPlaid`, `updatePlaidItem`. None exist — connection lifecycle goes through `createAccount` + `confirmConnection` + `deleteConnection` only.
- **Account variants** (12 probed): `createManualAccount`, `deleteManualAccount`, `editManualAccountBalance`, `setAccountBalance`, `addAccount`, `removeAccount`, `hideAccount`, `unhideAccount`, `archiveAccount`, `unarchiveAccount`, `closeAccount`, `reopenAccount`. Account hiding is an `editAccount` field (`isUserHidden`), not a separate mutation.
- **Holdings / Investments** (12 probed): `editHolding`, `createHolding`, `deleteHolding`, `setCostBasis`, `updateCostBasis`, `editCostBasis`, `markInvestmentTransfer`, `editInvestmentTransaction`, `setHoldingQuantity`, `refreshHoldings`, `createInvestmentTransaction`, `deleteInvestmentTransaction`. Investments are fully read-only via GraphQL — no write path exists for holdings, cost basis, or per-holding transactions. (Investment-transaction amounts are `editTransaction`-able via the regular transaction path.)
- **Rules** (12 probed): `createRule`, `editRule`, `deleteRule`, `applyRule`, `createTransactionRule`, `editTransactionRule`, `deleteTransactionRule`, `createCategoryRule`, `editCategoryRule`, `deleteCategoryRule`, `setTransactionRule`, `runRules`. **No user-facing rules API exists on GraphQL** — Copilot's categorization rules (the `rule` field on `EditRecurringInput`) are scoped to recurring detection only.
- **Notifications** (11 probed): `createNotification`, `markNotificationRead`, `deleteNotification`, `editNotificationPreferences`, `setNotificationPreferences`, `markAllNotificationsRead`, `subscribeToNotifications`, `unsubscribeFromNotifications`, `registerDevice`, `unregisterDevice`, `setPushToken`. Device / push registration presumably happens via a non-GraphQL endpoint.
- **User preferences / settings / onboarding** (16 probed): `editUserPreferences`, `setUserPreference`, `updateUserPreferences`, `setCurrency`, `setLocale`, `setTimezone`, `completeOnboarding`, `markOnboardingStep`, `completeOnboardingStep`, `setOnboardingState`, `acceptTerms`*, `dismissAnnouncement`*, `setFeatureFlag`, `trackEvent`, `logEvent`, `submitFeedback`. (*acceptTerms and dismissAnnouncement exist — see above.) Most user-level settings live on `editUser`; separate settings mutations don't exist.
- **Attachments / receipts** (8 probed): `uploadReceipt`, `setReceipt`, `deleteReceipt`, `attachReceipt`, `createAttachment`, `deleteAttachment`, `addTransactionAttachment`, `removeTransactionAttachment`. No receipt/attachment API — if Copilot has receipt storage it's either Firestore-direct or a separate HTTP endpoint.
- **Sharing / household** (10 probed): `inviteUser`, `acceptInvitation`, `removeSharedUser`, `shareAccount`, `unshareAccount`, `createHousehold`, `leaveHousehold`, `inviteToHousehold`, `addPartner`, `removePartner`. No sharing mutations — Copilot currently has no household/partner feature (and if they add one, the surface will shift).
- **AI / assistant** (8 probed): `sendAssistantMessage`, `createInsight`, `dismissInsight`, `requestInsight`, `createChat`, `sendMessage`, `editInsight`, `generateInsight`. No assistant-surface mutations. If Copilot ships an AI feature it isn't exposed on this endpoint.
- **Reports / exports** (6 probed): `generateReport`, `requestExport`, `createReport`, `downloadReport`, `exportTransactions`, `scheduleReport`. No report generation via GraphQL.
- **Views / search** (5 probed): `saveSearch`, `saveFilter`, `createView`, `editView`, `deleteView`. No saved-view mutations.
- **Auth / security / device** (8 probed): `refreshCache`, `resetPassword`, `changePassword`, `setPin`, `clearPin`, `enableTwoFactor`, `disableTwoFactor`, `requestMagicLink`. Auth is fully handled by Firebase on a separate endpoint — no auth mutations on the Copilot GraphQL server.
- **Misc transaction operations** (5 probed): `archiveTransaction`, `hideTransaction`, `flagTransaction`, `markTransactionReviewed`, `confirmTransaction`. Only the already-known `editTransaction.isReviewed` path exists.
- **Recurring detection** (4 probed): `detectRecurring`, `acceptRecurring`, `rejectRecurring`, `suggestCategory`. Recurring-detection UI appears to be server-automated — no user-triggered mutations.
- **Category suggestions** (2 probed): `acceptSuggestion`, `dismissSuggestion`. Suggestions live on `Transaction.suggestedCategoryIds` (read-only).

**Total sweep (including prior): ~460 + 170 = ~630 candidate names across all known surfaces.** The discovered write surface is ~25 mutations. See the "Remaining recon work" section of `introspection-recon.md` for directions still uncovered (queries, subscriptions, optional-input-field enumeration).

---

## What the web-session capture already knows

These are in `docs/graphql-capture/operations/mutations/` — confirmed by real traffic, not recon:

`CreateCategory`, `CreateRecurring`, `CreateTag`, `DeleteCategory`, `DeleteRecurring`, `DeleteTag`, `EditAccount`, `EditBudget`, `EditBudgetMonthly`, `EditCategory`, `EditRecurring`, `EditTag`, `EditTransaction`, `EditUser`.
