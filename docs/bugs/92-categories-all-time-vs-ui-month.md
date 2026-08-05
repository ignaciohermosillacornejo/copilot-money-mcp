---
id: 92
title: get_categories aggregated all-time totals while the app shows per-month — 2-4x discrepancies
class: ui-parity
status: fixed
detected: dogfooding  # category totals several times larger than the app's
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/92
issue: none — found and fixed directly
date: 2026-01-18
---

## Symptom
Category spending totals from `get_categories` were 2–4x the numbers shown in the Copilot app for the same categories. Categories with no recent activity were also missing entirely, while the app lists them at zero.

## How it was detected
Dogfooding: side-by-side comparison of tool output against the Copilot Money UI. Nothing was "broken" in a testable sense — every number was a correct sum of *some* set of transactions, just not the set the app sums.

## Root cause
The tool reimplemented an app-side computation with different implicit semantics: it aggregated over **all cached transactions ever** with no time window, whereas the Copilot UI aggregates per selected month. It also only emitted categories that had matching transactions, while the UI enumerates all known categories. Two computations that must agree (ours and the app's) had silently divergent filter semantics.

## The fix
PR #92 added `period` / `start_date` / `end_date` parameters to `get_categories`, defaulted behavior to match the UI's windowing, included zero-spend categories, and exposed category hierarchy fields (`parent_id`, `parent_name`, `type`).

## Detector
None automated — manual UI comparison was and remains the mechanism for this class in cache mode. The class-level machinery arrived much later as live-mode parity audits (comparing cache-derived vs GraphQL-derived numbers), and "trust the Copilot UI as ground truth" became an explicit project rule after this era.

## Lesson
Reimplementing an aggregation the app already performs means inheriting *all* of its implicit semantics — time window, category enumeration, exclusion rules — not just its arithmetic. Before shipping a derived-number tool, reproduce one known screenful of the app exactly.
