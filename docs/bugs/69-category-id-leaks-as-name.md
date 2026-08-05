---
id: 69
title: User-defined category IDs displayed as raw Firestore IDs instead of names
class: identity-resolution
status: fixed
detected: dogfooding  # opaque IDs visible in tool output
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/69
issue: none — found and fixed directly (follow-up audit issue #88)
date: 2026-01-14
---

## Symptom
Any transaction categorized with a user-created category showed a 20-character opaque Firestore ID (e.g. `5Qqr8qs3GHNCj8H6fIKd`) in the `category_name` field instead of the human-readable name the user sees in the app. Spending groupings keyed by these IDs were unreadable.

## How it was detected
Dogfooding: raw IDs are visually obvious in tool output. No test failed — fixtures only used categories from the static Plaid taxonomy, where ID and name resolution happened to work.

## Root cause
Name resolution consulted only a static, hardcoded mapping of ~800 Plaid taxonomy categories (`src/utils/categories.ts`). User-created categories live in a Firestore collection (`/users/{uid}/categories/{id}`) with auto-generated document IDs that by definition cannot appear in a static mapping — so the resolver fell through to echoing the ID. The code conflated two ID spaces (Plaid taxonomy slugs vs Firestore document IDs) behind one lookup.

## The fix
PR #69 added `decodeCategories()` for the user categories collection, a `getCategoryNameMap()` on the database layer, and a `resolveCategoryName()` that checks user-defined categories first, falling back to the Plaid mapping. PR #70 applied the identical pattern to account names (bank-internal names vs user-defined names) the same day.

## Detector
None — instance-only regression tests. The same class recurred years later in the opposite direction (the 2026-05 cache-mode tag filter compared an input *name* against tag *IDs*), which is now the canonical identity-resolution example; no automated gate distinguishes ID spaces.

## Lesson
Every "resolve name for ID" helper should declare which ID space it accepts; a fallback that returns the input unchanged converts a lookup failure into silently wrong display data. Fixtures must use realistic opaque IDs — ID-equals-name fixtures mask exactly this class.
