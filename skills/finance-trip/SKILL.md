---
name: finance-trip
description: "Use when the user wants to track trip expenses, tag travel transactions, find late-posting charges from a trip, or get a trip spending summary. Example: 'tag my Tahiti trip expenses' or 'how much did I spend in Whistler?'"
---

# Finance Trip

Track trip expenses by finding transactions in a date range, using location and merchant data to suggest which ones belong to the trip, and tagging confirmed ones. Can re-run to catch stragglers.

## Phase 1 — Scope the Trip

1. **Read the user profile.** Open `skills/user-profile.md`. If it doesn't exist, copy `skills/user-profile.template.md` to `skills/user-profile.md` first. Check Trip Tracking preferences and any existing trips.

2. **Get trip parameters.** Ask the user or infer from context:
   - **Trip name:** e.g., "French Polynesia", "Whistler Weekend"
   - **Date range:** start and end date. If the user says "my Tahiti trip" and you know dates from prior conversation or tagged transactions, use those.
   - **Location hint:** country, city, or region (optional — helps filter)

3. **Check for existing trip tag.** Use `get_transactions` with `tag` filter to see if a tag already exists for this trip. If it does, this is a **re-run** to find stragglers — note which transactions are already tagged.

## Phase 2 — Find Trip Transactions

1. **Pull transactions for the date range.** Use `get_transactions` with `start_date`/`end_date`, `exclude_transfers: true`. Paginate if needed.

2. **Also pull a 2-week buffer after the trip end date.** Late-posting charges (hotels, rental cars, foreign transactions) often settle days or weeks after the trip. Use a separate `get_transactions` call for `end_date + 1` through `end_date + 14`.

3. **Score each transaction.** Use Python via Bash. For each transaction, compute a trip-likelihood score based on:

   **Strong signals (high confidence):**
   - Location match: transaction's `city`, `region`, or `country` field matches the trip location
   - Merchant type matches travel categories: Hotels, Airplane Tickets, Car (rental), Transportation (rideshare/taxi)
   - Foreign currency or foreign transaction fee during trip dates

   **Medium signals:**
   - Merchant name contains trip location keywords (e.g., "PAPEETE", "MOOREA", "WHISTLER")
   - Category is travel-adjacent: Restaurants, Bars & Pubs, Tickets & Shows, Gas (road trips)
   - Transaction is in the buffer window (post-trip) from a merchant that also appears during the trip

   **Weak signals (include but flag as uncertain):**
   - Online purchases during trip dates (could be coincidental)
   - Generic merchants (Amazon, grocery stores) during trip dates

   **Exclude:**
   - Recurring charges that happen regardless of travel (subscriptions, rent, utilities, phone)
   - Transactions already tagged with this trip (if re-run)
   - Internal transfers

4. **Group into tiers:**
   - **Definitely trip:** Strong signals. Will be auto-suggested.
   - **Probably trip:** Medium signals. Present for confirmation.
   - **Maybe trip:** Weak signals. Mention but don't push.

## Phase 3 — Present & Confirm

**Tone:** Match `skills/user-profile.md` Communication Style. Default: blunt, simple, dollar amounts.

1. **Show the trip summary first** (before asking about individual transactions):

   > **[Trip Name]: [Start Date] – [End Date]**
   > Found [N] transactions totaling $[X]
   >
   > | Category | Amount | Count |
   > |----------|--------|-------|
   > | Hotels   | $X     | N     |
   > | Restaurants | $X  | N     |
   > | ...      | ...    | ...   |

2. **Present transactions for confirmation in batches:**
   - "Definitely trip" items: present as a batch for quick approval ("These 15 look like trip expenses — approve all?")
   - "Probably trip" items: present individually or in small groups with context
   - "Maybe trip" items: mention briefly ("Also found 3 Amazon orders during your trip — include any?")

3. **Show full merchant names.** Always use `name` or `original_name`, not `normalized_merchant`.

4. **For re-runs (stragglers):** Only show NEW transactions not already tagged. Frame as: "Found 3 late-posting charges from your [Trip Name] trip:"

## Phase 4 — Tag & Summarize

1. **Create the trip tag** if it doesn't exist. Use `create_tag` with the trip name (e.g., "frenchpolynesia", "whistler-jan-2026"). Use lowercase, no spaces.

2. **Tag confirmed transactions.** Use `set_transaction_tags` for each approved transaction.

3. **Show final summary:**

   > **[Trip Name] — Final Tally**
   > Tagged [N] transactions, total: $[X]
   >
   > | Category | Amount | Count |
   > |----------|--------|-------|
   > | Flights  | $X     | N     |
   > | Hotels   | $X     | N     |
   > | Food     | $X     | N     |
   > | Transport| $X     | N     |
   > | Activities| $X    | N     |
   > | Other    | $X     | N     |
   >
   > Per-day average: $[X/days]

4. **Update user profile.** Add the trip to the Trip Tracking section:
   ```
   - [Trip Name]: [dates], $[total], [N] transactions
   ```

## Phase 5 — Straggler Follow-up (optional)

If the trip ended recently (within 3 weeks), suggest a follow-up:
> "Some charges may still be posting. Want me to check again in a week or two?"

If the user agrees, note it in the conversation for future reference. The user can re-invoke `/finance-trip [trip name]` anytime.

## Rules

1. **User confirms before tagging.** Never tag a transaction without the user approving it first. "Definitely trip" items can be batch-approved, but the batch must be presented first.
2. **Use Python for aggregations.** Category totals, per-day averages, scoring — all via Bash with Python.
3. **Show full merchant names.** Always `name` or `original_name`, never truncated `normalized_merchant`.
4. **Respect existing tags.** If transactions already have tags, add the trip tag alongside them — don't replace.
5. **Recurring charges are not trip expenses.** Subscriptions, rent, utilities, and other recurring charges that happen regardless of travel should be excluded even if they fall within the trip dates.
6. **Buffer for late charges.** Always check 2 weeks after the trip end date for late-posting charges (hotels, car rentals, foreign transactions).
7. **Re-runs are safe.** The skill can be re-run on the same trip without double-tagging — it skips already-tagged transactions.
8. **Tag filter bug (known issue).** `set_transaction_tags` writes succeed but `get_transactions` with `tag` filter may return nothing even after `refresh_database`. This is a known MCP bug under investigation. Workaround: after tagging, verify by re-querying the specific transaction IDs rather than using the tag filter.
9. **Transaction IDs change on settlement.** Plaid replaces pending transaction IDs with new IDs when transactions settle. If you're tagging transactions from recent trips, some IDs from prior sessions may no longer exist. Always re-query by date range, not by cached IDs.
10. **Category IDs: user-created only.** When creating trip-related categories, only user-created category IDs work for `set_transaction_category`. Plaid taxonomy IDs (e.g., `travel_lodging`) will fail.
11. **Large datasets go to disk.** MCP tool responses >100KB are saved to temp files. Use Python via Bash to process them.
12. **`exclude_transfers` defaults to true.** To see all transactions including transfers (which you'll want to exclude from trip totals anyway), this default is fine. But be aware that payment app transactions (Venmo) may have trip-related spending on the payment app account side, not the bank-stub side — check both.
