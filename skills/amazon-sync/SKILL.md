---
name: amazon-sync
description: "Use when the user wants to reconcile Amazon order history with Copilot Money transactions — categorize purchases, split multi-category orders, and match card refunds. Requires an Amazon order-data export in CSV form."
---

# Amazon Sync

Reconcile Amazon order data with Copilot Money transactions. Fix categories, split multi-category shipments, and match card refunds. Read-only by default during analysis; writes only after user approval (with Amazon Fresh and other high-confidence fixes as the one exception — see Phase 5).

**Scope:** card refunds only. Amazon store-credit (gift-card balance applied to later orders) is out of scope — those mismatches get flagged, not ledgered.

## Phase 1 — Read Profile and Locate the Export

**Step 1 — Read the user profile first.** Open `skills/user-profile.md`. If it doesn't exist, copy `skills/user-profile.template.md` to `skills/user-profile.md` first. Note any existing `## Amazon Categorization Rules` section — **these rules take precedence over any inference the skill would otherwise do in Phases 5, 6, and 9.** If the profile says `coffee pods → Groceries`, never re-derive that; apply the rule directly. If the profile contradicts a rule you were about to propose, the profile wins. Also note the general `## Preferences` section for category conventions (e.g., "Coffee category is cafés only").

**Step 2 — Locate the export.** The user may supply Amazon data from multiple sources, each with its own CSV shape:

- **Amazon's official "Request My Data" export** — typically a folder like `Your Orders/` with files named `Order History.csv`, `Refund Details.csv`, `Returns Status.csv`, `Replacement Orders.csv`, `Digital Content Orders.csv`.
- **Third-party tools** (e.g., community scrapers, browser extensions) — column names and file names vary.
- **Manual CSV exports** — subset of fields, arbitrary column order.

**Ask for the path** if not provided. Default to `~/Downloads/orders/` if a hint suggests that; otherwise ask.

**Identify files by inspecting column headers, not filenames.** The skill must not hard-code filenames. Use these signatures:

| Stream | Required columns (case-insensitive substring match) |
|--------|------------------------------------------------------|
| Orders | `order` AND `id`; `product` AND (`name` OR `title`); a date column; an amount column (`total`, `price`, or `unit price`) |
| Refunds | `order id`; `refund amount` (or just `amount`); `refund date` (or `creation date`) |
| Returns | `order id`; `return reason` OR `return amount`; a date |
| Digital | `asin`; `transaction amount` OR `price`; `digital order item id` OR `order id`; a date |

For each CSV in the supplied folder, read the header row, normalize column names (lowercase, collapse spaces/underscores), and classify it into one of the streams above. Skip files you can't classify.

**Map the schema** once per file. Produce a `column_map` dict: `{canonical_field: actual_column_name}` with these canonical fields per stream:

- Orders: `order_id`, `order_date`, `ship_date`, `product_name`, `asin`, `unit_price`, `quantity`, `shipment_total`, `payment_method`, `carrier`, `shipping_charge`, `discounts`
- Refunds: `order_id`, `refund_amount`, `refund_date`, `quantity`, `disbursement_type`
- Digital: `order_id`, `asin`, `product_name`, `order_date`, `transaction_amount`, `subscription_order_type`

When a field is absent, the skill degrades gracefully (e.g., no `carrier` → treat every shipment as non-Fresh unless the user overrides).

## Phase 2 — Parse into Shipments

**The unit of reconciliation is the shipment, not the order.** Amazon charges per-shipment, and a single Copilot transaction usually represents one shipment. Group order rows by `(order_id, ship_date)` — each group is a shipment with N items.

**Per-shipment data:** `total_amount`, `ship_date`, `payment_method`, item list (each with `product_name`, `asin`, `unit_price`, `quantity`), carrier string.

**Detect Amazon Fresh** by scanning all carrier values in the shipment for the substring `RABBIT` (case-insensitive). Fresh shipments auto-categorize to Groceries with no item-level inference.

**Default window:** last 6 months. Extend with `--all` or an explicit date range.

**Filter out:**
- Shipments whose `ship_date` is outside the window.
- Digital-stream rows where `subscription_order_type` indicates a renewal — those are handled by Copilot's recurring detection, not by this skill.

Save parsed shipments to `/tmp/amazon-sync/shipments.json` and refunds to `/tmp/amazon-sync/refunds.json` for the rest of the flow to consume.

## Phase 3 — Pull Copilot Data

Use these MCP tools:

- `refresh_database` — ensure the local cache is current.
- `get_transactions` with `query: "amazon"` and the same date window. Expect >100KB responses — the MCP saves them to disk; read via `jq` or Python, not into context.
- `get_accounts` — map `account_mask` back to the payment-method suffix in Amazon data (`Visa - XXXX` in a shipment's `payment_method` → Copilot account with `mask: XXXX`).
- `get_categories` with `view: "list"` — capture the full list of user-created category IDs. Note these IDs; **Plaid taxonomy IDs will not stick on writes.**

Save to `/tmp/amazon-sync/copilot-amazon-txns.json`, `/tmp/amazon-sync/accounts.json`, and `/tmp/amazon-sync/categories.json`.

## Phase 4 — Match Shipments to Copilot Transactions

For each Copilot Amazon transaction, attempt to find a matching shipment (or combo of shipments):

**Match criteria (all must hold for a "confident" match):**
1. **Amount:** exact match within $0.02.
2. **Date:** Copilot `date` is in `[ship_date - 2, ship_date + 5]`. Tighter than you might expect — looser windows produce false positives (a $9.99 shipment 9 days before a $10 tip got spuriously matched during development).
3. **Account:** Copilot `account_mask` appears in the shipment's `payment_method` string, OR the shipment's payment is the literal string `Not Available` (common for Amazon Fresh).

**Match outcomes:**
- `single` — exactly one shipment matches. Strongest signal.
- `single-ambig` — multiple shipments match; prefer closest ship-date.
- `combo` — two or more shipments whose amounts sum to the Copilot amount (same-day bundle). Check combos up to size 5, but **pre-filter candidates before the combinatorial search**: only include shipments whose `total_amount` is less than or equal to the Copilot amount and dated within `[copilot_date - 10, copilot_date]` on the same account. Without this pre-filter C(N, 5) explodes on users with many unmatched shipments; with it the search is effectively O(K⁵) where K is usually under ~15.
- `none` — no match. Most common causes: export is stale (user downloaded it days ago and Copilot has newer charges), or merchant is Amazon Pharmacy / Prime subscription / tips (not in Order History). Leave these alone — do not guess.

**Important:** never extend the date window to chase matches. False matches cause miscategorizations. "No match" is a legitimate outcome.

## Phase 5 — Auto-Apply Confident Fixes

These classes apply without asking (Approach B rule #1):

1. **Pure-Fresh Copilot transactions** — a Copilot transaction whose matched shipment(s) are **all** Amazon Fresh (every matched shipment's carrier contains `RABBIT`). Handle per the reviewed-state guard below:

   - `user_reviewed: false`, any current category → set to **Groceries**, then `review_transactions([id])`.
   - `user_reviewed: true` AND already Groceries → skip (no-op; nothing to change).
   - `user_reviewed: true` AND **not** Groceries → **do not auto-overwrite.** The user deliberately categorized a Fresh charge as something else (e.g., Healthcare for a Fresh-delivered prescription, Household for a cleaning-supplies Fresh order). Route this transaction to Phase 6 for explicit approval with the item list attached — the user may have meant it or may want to split it per item.

   Never split a pure-Fresh charge — the user treats every Fresh-only shipment as groceries regardless of item mix.

   **Bundled charges with Fresh + non-Fresh shipments are NOT pure-Fresh** — they go to Phase 6 for split approval. The bundle's Fresh shipments collapse into a single Groceries child; non-Fresh shipments each contribute a child of their own resolved category.

2. **Merchant-pattern auto-categorizations** (no shipment match needed):
   - Copilot `name` contains `AMAZON GROCE` → Groceries
   - Copilot `name` contains `AMAZON PHARMACY` → Healthcare
   - Copilot `name` contains `AMAZON TIPS` → Groceries (Fresh delivery tip)
   - Copilot `name` contains `AMAZON PRIME` AND `recurring: true` → skip (Copilot's recurring handler owns it)

3. **Single-item non-Fresh shipments where the item's category is unambiguous from a profile rule.** Example: seller = Audible → Books & Media. Do NOT auto-apply LLM-inferred categories — those go to Phase 6.

After each write, confirm to the user what was changed. If `update_transaction` returns an error, report it and continue; never retry silently.

## Phase 6 — Present Ambiguous for Approval

**Actively scan every matched Copilot transaction** — reviewed and unreviewed alike — for item-vs-category mismatches. The presence of `user_reviewed: true` does NOT disqualify a transaction from Phase 6; it only disqualifies it from Phase 5 auto-apply. The point of Phase 6 is to use item-level data (which Copilot never had) to surface categorizations Copilot's defaults got wrong, even on already-reviewed rows.

Four streams feed Phase 6:

- **Single-item non-Fresh shipments** where category requires LLM inference.
- **Multi-category non-Fresh shipments** requiring a split.
- **Mixed-Fresh bundles** (Fresh + non-Fresh shipments in one Copilot charge) requiring a split with a dedicated Groceries child for the Fresh portion.
- **Reviewed transactions with a clearly wrong category** — actively surfaced, not buried. Examples: a bulk toilet-paper order tagged General Shopping should be Household things; a medical silicone gel tagged General Shopping should be Healthcare; a book tagged General Shopping should be Books & Media.

**Presentation format:** markdown table, batches of 3–5. Columns: date, amount, current category, proposed category (for a split: a list of child amounts + categories), rationale. Always show full `original_name` for the Copilot txn and full product names for the items. Never truncate to `normalized_merchant`.

Ask in free text, not `AskUserQuestion`. Large batches in `AskUserQuestion` are slow and fatigue the user.

After the user approves a batch, apply it in Phase 7.

## Phase 7 — Write Categorizations and Splits

- **Single category:** `update_transaction(transaction_id, category_id)`, then `review_transactions([id])`.
- **Split:** `split_transaction(transaction_id, account_id, item_id, splits=[...])`. All three parent IDs are required — `transaction_id` is the parent transaction, `account_id` is the parent's account ID, `item_id` is Copilot's Firestore `item_id` from the parent transaction row (not the ASIN or any Amazon item identifier). Pull all three from the parent's row in `copilot-amazon-txns.json`. Child amounts must sum to parent amount. Group items by resolved category first — children are one-per-category, not one-per-item. Children inherit the parent's `user_reviewed` state; if the parent was not reviewed, call `review_transactions([child_id_1, child_id_2, ...])` after the split to mark them reviewed (there is no `reviewed` param on `split_transaction`, and `update_transaction` can't set reviewed either — use `review_transactions`).

**Allocation inside a single-shipment split:**
- Use per-item `unit_price * quantity` as the base allocation.
- If the CSV has per-item tax (`unit_price_tax` or `shipment_item_subtotal_tax`), add it to that item's bucket.
- Distribute shipment-level `shipping_charge` proportionally across categories by share of unit price.
- Round children to 2 decimals; put the rounding remainder into the largest child so the sum equals the parent exactly.

**Allocation inside a bundled split (multiple shipments sum to one Copilot charge):**
- Each shipment contributes its `shipment_total` to its resolved category's bucket. Fresh shipments all merge into the Groceries bucket.
- Sum of bucket amounts may differ from the Copilot parent amount by up to 5¢ (tax/promo rounding between Amazon's per-shipment totals and the card charge). **Absorb the remainder — `parent_amount - sum(buckets)` — into the largest bucket's amount** so children sum exactly to the parent. If the remainder exceeds 5¢, stop and re-examine the match — that delta means you probably matched the wrong shipments.

**If `split_transaction` is not available** in the installed MCP (older bundle), skip the split step and only do single-category updates. Tell the user: *"Splits require the split_transaction tool — your MCP bundle predates it. Rebuild with `bun run pack:mcpb`, reinstall the .mcpb, and re-run."* Continue with the rest of the flow.

**Reversibility note:** `split_transaction` has no reversal — undoing a split means deleting each child and restoring the parent's category. Always present the split plan for approval before executing.

## Phase 8 — Match Card Refunds

For each refund in `Refund Details` within the window:

1. Find the original order's Copilot charge (Phase 4 result) so you know which `account_id` / `account_mask` the refund should post back to.
2. Match `order_id` + `refund_amount` to a negative-signed Copilot transaction, `refund_date ± 3 days`. **Account check is required** (same criterion as Phase 4 #3): the Copilot negative-signed transaction's `account_mask` must appear in the original shipment's `payment_method` string. Do not match a refund across accounts — a user with Amazon charges on two cards could get a false match otherwise.
3. If the original order was split across categories in Phase 7, categorize the refund to match the returned item's category (look up via `Returns Status` if present — that has which item was returned).
4. If the refund's `disbursement_type` is not a card refund (e.g., Amazon balance), ignore — store credit is out of scope.
5. If no matching Copilot credit is found, flag but do not guess; the refund may be pending or outside the window.

## Phase 9 — Update Profile

After writes are applied, update `skills/user-profile.md` with rules discovered during this run. Tell the user exactly what is being saved before writing.

**Amazon-specific profile section** — create the section if absent:

```
## Amazon Categorization Rules
<!-- Auto-populated by /amazon-sync. Patterns match against product name, ASIN, carrier, seller. First match wins. -->
```

Then append rules the user has confirmed in this session — **only rules the user has confirmed**, no pre-populated defaults. Examples of rule syntax (these are shapes, not rules to inject automatically):

- `Carrier contains "RABBIT" → Groceries` (merchant/carrier-based)
- `Merchant name contains "AMAZON PHARMACY" → Healthcare` (Copilot-side merchant match)
- `Product name contains "coffee pods" → Groceries` (Amazon-side product-name substring)
- `Seller is "Audible" → Books & Media` (seller-based)

Phrase each rule as a simple substring, seller-name, or field match so a reader can eyeball and edit them. Before writing, tell the user exactly what's being saved, e.g., *"Adding to profile: 'Product name contains toilet paper → Household things'. OK?"*

## Phase 10 — Summary and Cleanup

**Summarize** with:

- Shipments in window, matched vs. unmatched.
- Writes applied, broken down by type (categorization, split, marked reviewed, refund fix).
- Unmatched Copilot Amazon transactions — count and most common reason (usually stale export).
- Shipments in CSV with no Copilot match — count (usually normal; charges older than export coverage or already-reviewed).
- Suggestion to re-download the Amazon export if the last Copilot Amazon transaction date is after the last `ship_date` in the CSV (export is stale).

**Then clean up PII side-files.** The intermediate JSON files in `/tmp/amazon-sync/` (`shipments.json`, `refunds.json`, `copilot-amazon-txns.json`, `accounts.json`, `categories.json`, and any match-result files) contain Order IDs, product names, amounts, account masks, and payment details. Delete the directory at end of run: `rm -rf /tmp/amazon-sync/`. If the user ran under an alternate working directory, delete that one instead. Mention the cleanup in the summary so the user knows it happened. Only skip cleanup if the user explicitly asks to keep the files for debugging.

## Rules

1. **Never write without approval — except the Phase 5 confident classes.** Fresh and clear merchant-pattern categorizations are the only auto-applied writes. Everything else requires dry-run presentation.
2. **Respect user-reviewed state.** `user_reviewed: true` means the user made a deliberate decision and auto-apply must not overwrite it. Phase 5 checks reviewed state before writing — a reviewed Fresh charge categorized as Healthcare (e.g., a prescription delivery) is routed to Phase 6 for approval, not silently converted to Groceries. Phase 6 may surface reviewed transactions for correction, but only with explicit user approval — never auto-applied.
3. **No invented data.** Only reference shipments, Order IDs, products, and Copilot transactions that actually exist. Never fabricate examples.
4. **Tight match window.** Amount within $0.02; dates in `[ship - 2, ship + 5]`. Looser windows produce false positives. "No match" is a valid outcome.
5. **Exact payment-method match.** A shipment's `payment_method` must contain the Copilot `account_mask`. Do not match across accounts.
6. **User-created category IDs only.** `update_transaction` and `split_transaction` reject Plaid taxonomy IDs. If the needed category does not exist, `create_category` first.
7. **Large MCP responses go to disk.** `get_transactions` and `get_accounts` routinely exceed 100KB; read via Python or `jq`. Do not try to pull them into context.
8. **Use Python for any aggregation over ~10 rows.** Match scoring, amount comparisons, combo-sum search, allocation math — all via the `Bash` tool with Python.
9. **Preserve full merchant names.** Show the Copilot `original_name` or `name`, not `normalized_merchant`. Users need the full suffix after `AMAZON MKTPL*` to recall which order a charge corresponds to.
10. **Report staleness explicitly.** If the export's latest `ship_date` is more than 3 days before the Copilot data's latest Amazon transaction, tell the user the export is stale and suggest a fresh download before acting on recent unmatched transactions.
11. **Digital subscriptions are out of scope; one-off digital purchases are.** Prime Video, Audible subscriptions, Kindle Unlimited renewals — skip. Copilot's recurring detection owns them. A row is a subscription when `subscription_order_type` is non-empty and not `Not Applicable`. One-off digital purchases (Kindle books bought individually, single-song MP3s, non-renewing digital rentals) flow through the normal Phase 4/6 pipeline: match on amount + date + account like retail, then categorize per profile rules (e.g., Kindle book → Books & Media; Prime Video rental → Entertainment & Experiences).
12. **Store credit is out of scope.** If a shipment's Copilot charge is less than the CSV's `shipment_total` (gift-card applied), flag and leave alone. Do not try to reconstruct an Amazon balance ledger.
13. **`exclude_transfers: true` is fine** — Amazon charges are not internal transfers. No special handling needed here.
