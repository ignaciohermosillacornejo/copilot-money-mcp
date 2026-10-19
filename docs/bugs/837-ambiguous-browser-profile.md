---
id: 837
title: An ambiguous --browser-profile silently picked one profile — on Edge, often the other person's
class: identity-resolution
status: fixed
detected: code-review  # maintainer review of the merged fork PR #837, reasoning about Edge's built-in profile names
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/853
issue: none — found in review and fixed directly
date: 2026-10-18
---

## Symptom

`--browser-profile <name>` exists so that two people logged into Copilot on one machine
can each pin their own session. The name is looked up in more than one namespace, and when
it matched two different profiles the extractor picked one without saying so:

- **Chromium:** a directory-name match won over every display-name match. Microsoft Edge's
  built-in display names are off by one from its directories — directory `Default` is
  shown as "Profile 1", directory `Profile 1` as "Profile 2" — so a user who typed the name
  they saw in Edge (`--browser-profile "Profile 1"`) got the *other* profile's session.
- **Chromium, duplicate display names:** two profiles both named "Work" were both
  searched, and the first token to exchange won.
- **Firefox:** the union of directory, suffix and `profiles.ini` `Name=` matches was
  searched, again letting the first exchange decide.

Silent: the server started, authenticated, and served another account's data. Under
`--write` it would have written to that account.

## How it was detected

Code review of the merged contributor PR. The reviewer verified the feature on macOS and
then asked what happens when the input satisfies two lookups at once, which led to Edge's
default naming. No test, probe or user report was involved; nothing in the suite modelled
two namespaces answering to the same string.

## Root cause

`selectChromiumProfile` and `selectFirefoxProfile` in `src/core/auth/browser-token.ts`
resolved a user-supplied name against several identity spaces — directory names, display
names, Firefox suffixes, `profiles.ini` names — by precedence (Chromium) or by union
(Firefox), never by asking whether the answer was unique. A display name is a label, not an
identity: it is neither unique nor aligned with the directory it labels.

## Why the tests didn't catch it

Every fixture gave each profile a display name distinct from every directory name
("Person A", "Person B"), so the namespaces never overlapped and precedence was never
exercised. The tests asserted that each lookup *worked*, not that the lookups *disagreed
safely*.

## The fix

Root-cause fix: both selectors collect every profile the name matches, across all
namespaces, per user-data root, and refuse when more than one distinct profile matches —
the report names each match, and nothing is searched. A directory whose own display name
is the same string is one match.

Refusing alone was not enough. The first version of the fix told the user to "use the
directory name", but on a stock Edge with three profiles every middle `Profile N` is both a
directory and another profile's display name, so the plain directory name was refused too
and those profiles could not be selected at all (caught by the automated PR review). The
fix therefore adds a namespace qualifier: `dir:<name>` matches the exact directory name
only, which always names one profile, and the refusal offers it (`--browser-profile
"dir:Default" or "dir:Profile 1"`). `name:` restricts the match to display names; a
Firefox profile that `profiles.ini` keeps outside the listed profiles dir is offered as
`name:`, since `dir:` cannot see it. The tests check that every value a refusal offers
selects exactly one profile.

Downstream cleanup in the same PR: retried `Local State` / `profiles.ini` reads, clearer not-found errors, a
profile-directory hint for `--browser-data-dir`, and validating the selection only when
live reads or writes are on.

## Detector

`tests/core/auth/browser-selection.test.ts` → `ambiguous --browser-profile`: a sweep that
builds every pair of match namespaces on two different profiles, for both browser
families (Chromium: directory + display name, display + display; Firefox: every pair of
directory, suffix and `Name=`), and requires a refusal; plus single-namespace controls
that must still resolve. Both refusal sites are registered in `scripts/mutation-guards.ts`
(`an ambiguous Chromium profile name is refused`, `an ambiguous Firefox profile name is
refused`), so the detector is **mutation-verified** by the gate on every `bun run check`.

Scope, stated: the sweep covers the namespaces the selectors know today. A new namespace
added to one selector needs a new kind in the sweep; nothing finds that omission for you.

## Lesson

When a user-supplied name is resolved against more than one namespace, uniqueness is the
property to test, not each lookup on its own. Fixtures with conveniently distinct names
hide exactly this. And a refusal needs an input that is guaranteed to get through it: test
that every profile can still be selected, not just that the ambiguous name is refused.
