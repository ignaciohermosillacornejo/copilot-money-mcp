---
id: 238
title: get_categories was built around the Plaid taxonomy; the app only uses user categories
class: external-api-drift
status: fixed
detected: incidental  # the #232 investigation needed category search and it couldn't find real app categories
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/239
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/238
date: 2026-04-13
---

## Symptom
Three user-visible wrongs at once: (1) `list` view returned ~144 categories, over 120 of them Plaid-taxonomy noise the app never shows; (2) several real user categories were completely invisible unless they had spending in the queried period; (3) `search` returned Plaid taxonomy IDs (e.g. `general_services_education`) that no write tool accepts — so a category found via search could not actually be assigned, while the user's real category of that name was unfindable.

## How it was detected
Found during the #232 cleanup: reassigning orphaned transactions required searching for an existing user category, and `get_categories(view: "search")` returned zero results for a category plainly visible in the app. The workaround (pasting a raw Firestore ID) exposed how broken the tool's model was.

## Root cause
`getCategories()` in `src/tools/tools.ts` treated the static Plaid taxonomy (`src/utils/categories.ts`) as the primary category system and user categories as an overlay derived from transaction activity. Copilot's app does the opposite: user-created categories in Firestore are the *only* category system; the Plaid taxonomy is internal plumbing. The tool also mixed two id spaces in its output — Plaid string IDs and Firestore document IDs — only one of which is usable elsewhere in the API.

## The fix
PR #239 rebuilt all four views (`list`, `search`, `tree`, `subcategories`) exclusively on user categories from the local cache: all categories listed regardless of activity, search over user category names, hierarchy from `parent_category_id`. Plaid-specific concepts (the `type` filter, taxonomy imports) were removed.

## Detector
none — instance-only tests. The general risk (a tool's data model diverging from what the app actually uses) is now mitigated culturally by the "trust the Copilot UI as ground truth" rule and by parity audits against live GraphQL reads, but there is no automated gate.

## Lesson
Build read tools around what the vendor's app demonstrably displays, not around whatever taxonomy happens to ship in the data. If a read tool emits IDs, every emitted ID should be accepted by the corresponding write tool — a quick round-trip check would have exposed this immediately.
