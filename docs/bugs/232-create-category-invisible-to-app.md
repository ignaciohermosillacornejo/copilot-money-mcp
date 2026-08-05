---
id: 232
title: create_category wrote category documents the Copilot app doesn't recognize
class: external-api-drift
status: fixed
detected: dogfooding  # MCP-created category never appeared in the app; transactions assigned to it silently showed under their old category
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/235
issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/232
date: 2026-04-13
---

## Symptom
`create_category` returned `success: true` and the MCP could read the new category back — but the Copilot Money app never displayed it. Transactions assigned to it were orphaned: the app showed them under their previous category, while the MCP showed them under the new one. Two views of the same data disagreed for 24+ hours with no error anywhere.

## How it was detected
The user noticed the category was missing from the app's category list a day after creating it. A control experiment (assigning a transaction to an app-created category via the MCP) worked fine, isolating the problem to MCP-*created* documents rather than MCP writes generally.

## Root cause
The MCP wrote category documents via raw Firestore REST with only 3 fields (`category_id`, `name`, `excluded`) and a self-invented `custom_<16 hex>` document ID. App-created categories carry ~12 fields (`emoji`, `color`, `bg_color`, `order`, `is_other`, `auto_budget_lock`, `auto_delete_lock`, `plaid_category_ids`, `partial_name_rules`, ...) and Firestore auto-generated IDs. The app silently ignores documents that don't match its expected shape. Writing directly to the datastore bypassed every invariant Copilot's own clients maintain — and nothing validates the result, so the write "succeeds" into a shape only we could see.

## The fix
PR #235 made `create_category` write all app-required fields with sane defaults and use Firestore auto-generated IDs (added `FirestoreClient.getDocument()` and auto-ID support to `createDocument`). The broken category was deleted and its orphaned transactions reassigned. The deeper, class-level fix came shortly after: PR #275 rewrote all write tools onto Copilot's own GraphQL API, so the server — not us — constructs documents.

## Detector
none as an automated gate at the time. The class was eliminated structurally: since the 2.0.0 GraphQL rewrite (#275), no tool hand-crafts Firestore documents, so "document shape the app doesn't recognize" can no longer be produced. Today's conformance ledger + live smoke system exists to catch the surviving variant (wrong assumptions about GraphQL inputs).

## Lesson
A write that the server accepts is not a write the application understands — go through the vendor's own API so the server owns document invariants. When reverse-engineering a datastore, diff your created document against a native-created one before declaring the write tool done.
