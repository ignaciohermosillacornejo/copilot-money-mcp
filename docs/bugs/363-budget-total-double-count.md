---
id: 363
title: total_budgeted double-counted child categories — parent.amount already includes them
class: aggregation-double-count
status: fixed
detected: audit-sweep  # live-mode parity audit (finding C2); headline vs web app
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/363
issue: none — found and fixed directly (audit finding C2)
date: 2026-05-04
---

## Symptom
`get_budgets_live` returned a headline `total_budgeted` larger than what the Copilot web app shows: every child category's budget was counted twice.

## How it was detected
Live-mode parity audit. The fix was deliberately sequenced last in the audit batch, after the other category/budget fixes (notably #357, which restored `parentId`) so the post-fix headline could be measured against an accurate live baseline — it then matched the web app within rollover-snapshot timing skew.

## Root cause
Empirically, on real GraphQL responses `parent.amount = unassignedAmount + childAmount + rolloverAmount` — a parent's amount **already aggregates its children's base budgets**. The aggregator summed every row's `amount`, so each child contributed once via its own row and again inside its parent's `childAmount`. A prerequisite defect made this hard to even fix: the flatten step had discarded parent linkage (audit C3, #357), so no consumer could tell parents from children.

## The fix
Filter the headline aggregation on `cat.parentId === null` so only top-level categories (parents and standalones) contribute. Per-row amounts are unchanged. Fixture tests pin both the parent+child exclusion and the standalone inclusion.

## Detector
none — instance-only regression tests. The invariant is recorded in project memory ("parent.amount includes children — aggregations across categories[] must filter parentId === null or they double-count"), which later steered sibling code, but no automated gate checks new aggregation sites.

## Lesson
Same law as #315, opposite data source: any hierarchy where the parent row aggregates its children makes naive summing wrong by construction. When a vendor field is an aggregate, document the aggregation identity the moment it is discovered — every future summing path needs it.
