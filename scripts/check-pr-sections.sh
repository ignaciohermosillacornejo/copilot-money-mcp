#!/usr/bin/env bash
#
# check-pr-sections.sh — enforce required PR-body sections.
#
# Reads the PR body from the file named by $1 (or stdin if no arg) and the PR
# title from $PR_TITLE. Exits 0 when the body satisfies the gate, non-zero with
# a ::error:: annotation otherwise.
#
# Rules:
#   1. The body must contain a `## External assumptions` header followed by a
#      non-empty answer (the PR template ships "None" as the explicit default,
#      so an empty section is a deletion, not an omission).
#   2. If the PR title starts with `fix:` (a bug-fix per Conventional Commits),
#      the body must also contain every Bug Response Ritual field label from
#      CONTRIBUTING.md.
#
# HTML comments are stripped before matching so the template's commented-out
# placeholder text never counts as a real answer.
#
# This logic lives in a script (not inline YAML) so it can be unit-tested
# locally: see tests/check-pr-sections.test.sh.

set -euo pipefail

REQUIRED_HEADER='External assumptions'

# Ritual field labels (kept in sync with CONTRIBUTING.md "Bug Response Ritual").
RITUAL_FIELDS=(
  'Root cause:'
  'Bug class:'
  'Detector added:'
  'Siblings checked:'
  'Ledger updated:'
)

fail() {
  # GitHub Actions surfaces ::error:: lines in the checks UI / annotations.
  echo "::error::$1" >&2
  echo "FAIL: $1" >&2
  exit 1
}

# --- read body -------------------------------------------------------------
if [ "$#" -ge 1 ] && [ "$1" != "-" ]; then
  raw_body="$(cat -- "$1")"
else
  raw_body="$(cat)"
fi

title="${PR_TITLE:-}"

# --- strip HTML comments ---------------------------------------------------
# Use perl for a multiline, non-greedy strip of <!-- ... --> blocks so that a
# commented-out template section can't masquerade as a filled-in answer.
body="$(printf '%s' "$raw_body" | perl -0777 -pe 's/<!--.*?-->//gs')"

# --- check 1: External assumptions ----------------------------------------
# Extract the text from the `## External assumptions` header up to (but not
# including) the next `## ` header or end of body, then test that something
# non-whitespace remains. Header match is case-insensitive and tolerates
# trailing whitespace after the title.
section="$(
  printf '%s\n' "$body" | awk -v hdr="$REQUIRED_HEADER" '
    BEGIN { want = tolower("## " hdr); capturing = 0 }
    {
      line = $0
      stripped = line
      sub(/[ \t\r]+$/, "", stripped)        # rstrip
      lower = tolower(stripped)
      if (capturing && line ~ /^##[ \t]/) { capturing = 0 }
      if (lower == want) { capturing = 1; next }
      if (capturing) { print line }
    }
  '
)"

if ! printf '%s\n' "$body" | grep -qiE '^##[[:space:]]+External assumptions[[:space:]]*$'; then
  fail "PR body is missing the required '## External assumptions' section. \
Restore it from .github/PULL_REQUEST_TEMPLATE.md (use 'None' if there are no new assumptions)."
fi

if ! printf '%s' "$section" | grep -qE '[^[:space:]]'; then
  fail "The '## External assumptions' section is empty. \
List new Copilot API/data assumptions and their evidence class, or write 'None'."
fi

echo "OK: '## External assumptions' section present and non-empty."

# --- check 2: Bug Response Ritual (fix: PRs only) -------------------------
# Match a Conventional-Commits bug-fix prefix: fix, fix(scope), fix!, etc.
if printf '%s' "$title" | grep -qiE '^fix(\([^)]*\))?!?:'; then
  echo "Title is a 'fix:' PR — checking Bug Response Ritual fields."
  missing=()
  for field in "${RITUAL_FIELDS[@]}"; do
    if ! printf '%s' "$body" | grep -qiF "$field"; then
      missing+=("$field")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "'fix:' PR is missing Bug Response Ritual field(s): ${missing[*]} \
(see CONTRIBUTING.md → 'Bug Response Ritual'; fill every line, fix the class not the instance)."
  fi
  echo "OK: all Bug Response Ritual fields present."
else
  echo "Title is not a 'fix:' PR — skipping Bug Response Ritual check."
fi

echo "All required-section checks passed."
