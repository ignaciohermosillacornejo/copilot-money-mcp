---
id: <issue or PR number>
title: <one line, plain language, describing the wrong behaviour — not the fix>
class: <slug from README.md#bug-classes — or propose a new one there first>
status: fixed | open | wont-fix
detected: <token>  # <free-text detail>
# token is exactly one of, so the corpus stays countable:
#   ci-gate | detector-first | live-probe | adversarial-review | audit-sweep
#   code-review | dogfooding | incidental | user-report
# See README.md#how-we-find-bugs. Put the specifics in the comment, not the token.
fixed_in: <PR link, or "not yet">
issue: <issue link, or "none — found and fixed directly">
date: <YYYY-MM-DD the fix landed>
---

## Symptom

What a user or caller actually saw. Concrete, with a redacted response snippet where it
helps. If the bug was silent — wrong output that looks right — say so explicitly, because
that is the most expensive kind and worth counting.

## How it was detected

**The most valuable field in this document.** Be specific about the mechanism, not the
person: "a review agent mutation-tested the guard", not "review caught it". If it was
found by luck, say that — near-misses are data. What we want to learn from this corpus is
which detection mechanisms actually pay, so be honest when the answer is "nothing caught
this; someone happened to look."

## Root cause

The mechanism, not the symptom. Cite `file:line`. If several defects share one cause, say
so and enumerate them — the cause is what belongs to the class, the defects are its
surface.

## Why the tests didn't catch it

Walk the defenses that were actually in place and say concretely why each was blind. "We
had no test" is fine when true. This section is what makes the corpus useful; skipping it
turns a post-mortem into a changelog entry.

## The fix

What changed, briefly. Link the PR for detail. Name the part that is the *root-cause* fix
versus the parts that are downstream cleanup.

## Detector

The class-level gate that now catches this **class** — not an instance-only regression
test. If the honest answer is "none — instance-only regression test", write that. A
corpus full of missing detectors is a useful signal; a corpus of invented ones is worse
than nothing.

State whether the detector was **mutation-verified**: reintroduce the defect, confirm the
test goes red. A test that executes a guard does not necessarily detect its deletion (see
[#596](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/596)).

## Lesson

One or two sentences. What habit or gate would have caught this earlier — and is it worth
its cost? "Not worth defending against" is a legitimate conclusion; write it down so the
question isn't relitigated.
