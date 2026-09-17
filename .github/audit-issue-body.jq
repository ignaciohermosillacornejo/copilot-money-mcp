# Renders one Markdown section per unaddressed audit finding.
#
# Extracted from audit-reviews.yml for the reason audit-severity-gate.jq gives:
# a filter that lives only inside a `run:` block is a filter nothing checks.
# tests/scripts/audit-issue-body.test.ts runs THIS FILE against the edge cases,
# and the workflow reads it with `jq -r -f`.
#
# `.severity` is the only field here that is not merely interpolated, and it was
# the one that could take the step down. `ascii_upcase` throws on anything that
# is not a string — `null` included — and the step runs under `set -e`, so a
# single finding with a missing or numeric severity aborted the render before
# ANY issue or comment was filed. Every OTHER finding in that batch went with
# it, and silently from the author's point of view: the step fails on a jq error
# that names no finding.
#
# `// "unspecified" | tostring` keeps the direction the severity gate already
# takes with the same input — an unclassifiable finding is still SHOWN, labelled
# as unclassifiable, rather than being the reason the batch disappears. It is
# also the direction that keeps the two filters agreeing: the gate counts such a
# finding as escalating, so the issue it opens has to be able to print it.
#
# The remaining fields need no guard, and the difference is not stylistic:
# interpolation renders `null` as the text "null" rather than throwing, so a
# missing `.file` costs one wrong-looking line instead of the whole report.
# `.line` is guarded by an `if` because the suffix has to disappear entirely
# when there is no line number, not print as `:null`.
.unaddressed[]
| "### \(.severity // "unspecified" | tostring | ascii_upcase): \(.summary)\n\n- **File:** `\(.file)`\(if .line then ":\(.line|tostring)" else "" end)\n- **Reviewer said:** > \(.quote)\n- **Evidence not applied:** \(.evidence)\n"
