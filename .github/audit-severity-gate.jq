# Counts audit findings at or above a severity threshold ($t).
#
# Extracted from audit-reviews.yml so it can be tested: the workflow reads this
# file with `jq --arg t "$AUDIT_ISSUE_THRESHOLD" -f`, and
# tests/scripts/audit-severity-gate.test.ts runs THIS FILE against the edge
# cases. A gate that lives only inside a `run:` block is a gate nothing checks.
#
# FAIL-SAFE DIRECTION, deliberate: a finding whose severity is missing or
# unrecognised, or ANY finding when the threshold itself is unrecognised,
# counts as escalating. A gate that cannot classify something must not be the
# reason it disappears, and a new severity value appearing upstream should make
# this louder rather than quieter.
#
# `tostring` before `ascii_downcase`, because the fail-safe above has to SURVIVE
# the input that triggers it. `ascii_downcase` throws on anything that is not a
# string, and `// ""` only covers `null` — so a numeric or boolean severity
# aborted this filter under `set -e` and took the whole step with it. That is
# not the escalating direction or the quiet one; it is neither, and no issue or
# comment was filed at all. `tostring` turns such a value into an unrecognised
# string, which the branch below already knows how to escalate.
#
# The THRESHOLD is downcased for the same reason the severities are. Without it
# `AUDIT_ISSUE_THRESHOLD: Medium` is unrecognised, and unrecognised means
# escalate EVERYTHING — the fail-safe firing over a difference in case rather
# than a difference in meaning, on a knob whose own comment invites editing it.
# Normalising narrows the fail-safe to genuine typos: "Medium" now means
# medium, while "mediumm" still escalates.
def rank: {"low": 1, "medium": 2, "high": 3};
($t | ascii_downcase) as $threshold
| [ .unaddressed[]
    | ((.severity // "") | tostring | ascii_downcase) as $s
    | if (rank | has($s)) and (rank | has($threshold))
      then (rank[$s] >= rank[$threshold])
      else true
      end
  ] | map(select(.)) | length
