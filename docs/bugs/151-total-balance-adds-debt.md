---
id: 151
title: getAccounts total balance added debt instead of subtracting it
class: sign-convention
status: fixed
detected: dogfooding  # computed total did not match the Copilot app's displayed balance
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/151
issue: none — found and fixed directly
date: 2026-03-30
---

## Symptom
`get_accounts` reported an inflated `total_balance` for any user with debt. Loans, mortgages, and credit-card balances were added to the total as if they were assets, so a user with $X in assets and $Y in debt saw $X + $Y instead of $X − $Y.

## How it was detected
Comparison against the Copilot Money app UI: the tool's total visibly disagreed with the app's net figure. The PR explicitly lists "Verified calculation matches Copilot Money app display" as the acceptance check — the app was the ground truth that exposed the error.

## Root cause
`src/tools/tools.ts` (`getAccounts`) computed `totalBalance` with a naive `accounts.reduce((sum, acc) => sum + acc.current_balance, 0)`. Copilot stores liability balances as positive magnitudes, so the account type (`loan`, `credit`) — not the stored sign — determines whether a balance is an asset or a liability. The aggregation ignored that domain convention entirely.

## The fix
The reduce now branches on `account_type`: `loan` and `credit` balances are subtracted, everything else added. Follow-up PR #155 also exposed `total_assets` and `total_liabilities` separately so callers can see both sides.

## Detector
none — instance-only regression tests (5 unit tests covering mixed/assets-only/liabilities-only/unknown account types). Much later, side-by-side comparison with Copilot's official MCP server became an informal parity check, but there is no automated gate for sign conventions.

## Lesson
Stored sign is not semantic sign: any aggregation over Copilot balances (or amounts) must consult the entity's type/direction convention first. Cross-checking every new aggregate against the app UI before shipping would have caught this on day one.
