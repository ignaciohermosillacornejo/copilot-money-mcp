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
def rank: {"low": 1, "medium": 2, "high": 3};
[ .unaddressed[]
  | ((.severity // "") | ascii_downcase) as $s
  | if (rank | has($s)) and (rank | has($t))
    then (rank[$s] >= rank[$t])
    else true
    end
] | map(select(.)) | length
