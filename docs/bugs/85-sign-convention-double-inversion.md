---
id: 85
title: Sign convention "fixed" backwards — tests rewritten to encode the wrong convention, then flipped again
class: fixture-reality-drift
status: fixed
detected: dogfooding  # spending report collapsed to almost entirely "Uncategorized"
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/85
issue: none — found and fixed directly
date: 2026-01-17
---

## Symptom
Two symptoms, three days apart, from the same assumption. First: everyday purchases were classified as *income* (positive-amount filter caught them). Then, after the first "fix" (PR #71): `get_spending` reported the vast majority of all spending as "Uncategorized" and per-category totals were near zero — because now genuine expenses failed the sign filter entirely.

## How it was detected
Both times by dogfooding against the real database, comparing against the Copilot app. Crucially, the *test suite could not detect either state*: PR #71 changed ~50 sign checks in `src/tools/tools.ts` **and rewrote all mock data in 12 test files to match the new (wrong) convention** — 1000+ tests passed green on both sides of the inversion.

## Root cause
Copilot Money stores amounts with **positive = expense (money out), negative = income (money in)** — the opposite of standard accounting. PR #71 assumed the standard convention was correct and inverted every sign check to match it, updating fixtures in lockstep. Because fixtures are authored to satisfy the code rather than sampled from reality, code and tests shared the error term perfectly; the suite validated internal consistency with whichever convention the code currently held.

## The fix
PR #85 inverted the ~50 sign checks back to Copilot's actual convention (`amount > 0` = expense, `amount < 0` = income), fixed `getHsaFsaEligible`/`getRefunds`/`getCredits`, documented the convention in `src/models/transaction.ts`, and — again — rewrote the mock data in 12 test files. Verification this time was against the real database, including the real-DB integration tests.

## Detector
None that pins the convention to reality automatically — the fixtures still encode the convention by hand. The `RUN_REAL_DB_TESTS=1` integration suite is the honest class gate (it would show a sign inversion against genuine data), but it is opt-in, not CI. Documentation in the transaction model is the only always-on guard.

## Lesson
When a "fix" consists of flipping a polarity *and editing every test to agree*, the green suite proves nothing — one anchored test against a genuine artifact (a real cached transaction known to be an expense) would have failed both wrong states. Conventions of an external system should be captured as evidence, not decided by argument from what seems standard.
