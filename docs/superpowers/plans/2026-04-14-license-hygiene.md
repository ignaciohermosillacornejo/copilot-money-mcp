# License hygiene — CI gate implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `license-checker` CI step to the `quality` job in `.github/workflows/test.yml` that fails when any production dependency's license falls outside `MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0`.

**Architecture:** A single ~10-line `run:` step, appended after `Check formatting` in the existing `quality` job. The step creates a scratch directory, runs `npm install --omit=dev --ignore-scripts` against a staged `package.json` (no lockfile) to produce the same production tree that `scripts/pack-mcpb.ts` ships, then invokes `license-checker` via `npx --yes license-checker@25.0.1 --onlyAllow ...`. No `package.json` change, no new workflow file, no bundle change. Local repro instructions are added to `CONTRIBUTING.md` so developers can run the same check before pushing.

**Tech Stack:** GitHub Actions (ubuntu-latest), `license-checker` (invoked via npx, no devDep), `npm install` (mirroring `pack-mcpb.ts`). Nothing new on the project's core stack.

**Reference spec:** `docs/superpowers/specs/2026-04-14-license-hygiene-design.md`

---

## File Structure

**Modified:**
- `.github/workflows/test.yml` — add one step to the `quality` job.
- `CONTRIBUTING.md` — add a short "License check" subsection under the existing contributing guidance so developers can run the gate locally.

**Not touched:** `package.json`, `bun.lock`, `scripts/pack-mcpb.ts`, `.github/workflows/build-mcpb.yml`, `.github/workflows/auto-release.yml`, `.github/workflows/npm-publish.yml`, any test file, any source file, the bundle.

---

## Task 1: Add the CI license-check step

**Files:**
- Modify: `.github/workflows/test.yml` (append one step to the `quality` job, after `Check formatting`)

**Context:** The existing `quality` job ends with:

```yaml
      - name: Check formatting
        run: bun run format:check
```

Followed by the `unit-tests` job at line 33. The new step must land *before* the `unit-tests` job starts and *inside* the `quality` job, i.e., between lines 31 and 33 of the current file.

- [ ] **Step 1: Read the existing workflow to confirm line layout**

Run: `cat .github/workflows/test.yml | head -35`

Expected output shows the `quality` job ending with the `Check formatting` step, followed by a blank line, then `unit-tests:` at the top of the next job. Confirm the structure matches before editing.

- [ ] **Step 2: Append the license-check step to the `quality` job**

Edit `.github/workflows/test.yml`. Insert after the existing `Check formatting` step (currently lines 30-31) and before the blank line that separates the `quality` job from the `unit-tests` job:

```yaml
      - name: License check (production deps)
        run: |
          mkdir -p .license-check
          cp package.json .license-check/
          (cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
          npx --yes license-checker@25.0.1 \
            --start .license-check \
            --production \
            --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
            --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
            --summary
```

Indentation must use spaces (not tabs) and match the other steps in the job — 6 spaces for the `- name:` line, 8 for `run:`, 10 for the heredoc body. After the edit, the `quality` job contains six steps: `checkout`, `Setup Bun`, `Install dependencies`, `Run type checking`, `Run linting`, `Check formatting`, `License check (production deps)`.

- [ ] **Step 3: Verify the YAML parses cleanly**

Run: `bunx --yes actionlint-cli .github/workflows/test.yml`

(If `actionlint-cli` isn't available, substitute: `bunx --yes js-yaml .github/workflows/test.yml >/dev/null && echo OK`.)

Expected: no output, or "OK". Any parse error means the indentation is wrong.

- [ ] **Step 4: Run the license check locally to verify it passes against the current tree**

Run (from the repo root):

```bash
rm -rf .license-check
mkdir -p .license-check
cp package.json .license-check/
(cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes license-checker@25.0.1 \
  --start .license-check \
  --production \
  --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
  --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
  --summary
rm -rf .license-check
```

Expected output (final two lines):

```
├─ MIT: 95
├─ BSD-3-Clause: 14
├─ ISC: 7
├─ BSD-2-Clause: 1
└─ Apache-2.0: 1
```

Exit code `$?` must be `0`. If any disallowed license is reported, STOP and report — the current tree was expected to be clean and the audit was run on 2026-04-14.

Note: exact counts may drift over time as transitive deps update. What matters for this step is: (a) exit 0, (b) all reported licenses are in the allowlist. Numeric counts can differ from the reference above.

- [ ] **Step 5: Ensure `.license-check/` is not tracked by git**

Run: `git check-ignore -v .license-check/ || echo "not ignored"`

If the output is "not ignored", add `.license-check/` to `.gitignore`. Check: `grep -F '.license-check' .gitignore`. If not present, append the entry:

```bash
echo '.license-check/' >> .gitignore
```

(This is the only reason `.gitignore` might need a change. Most repos already ignore it via generic patterns; the repo's current `.gitignore` does not, so this addition is likely required. Run `git status` after the CI step change to confirm no `.license-check/` leaked in.)

- [ ] **Step 6: Confirm no stray files remain**

Run: `git status`

Expected: only `.github/workflows/test.yml` listed as modified, plus `.gitignore` if Step 5 touched it. Nothing else. If the staging `.license-check/` directory shows up as untracked, Step 5 was skipped or failed — go back.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/test.yml
# Only add .gitignore if Step 5 modified it:
git diff --cached --quiet .gitignore 2>/dev/null || git add .gitignore
git commit -m "$(cat <<'EOF'
ci: add license-checker gate for production deps (#260)

Adds a license-check step to the quality job in test.yml. Fails CI
when any production dep (direct or transitive) declares a license
outside MIT/ISC/BSD-2/BSD-3/Apache-2.0. Uses npx license-checker
against an isolated npm --omit=dev tree so the check matches the
.mcpb bundle's graph exactly.

See docs/superpowers/specs/2026-04-14-license-hygiene-design.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Document local repro in `CONTRIBUTING.md`

**Files:**
- Modify: `CONTRIBUTING.md` (add a short subsection)

**Context:** Developers should be able to run the same license check locally before pushing to avoid a CI round-trip. The spec mentions this explicitly as part of the rollout plan.

- [ ] **Step 1: Find the right insertion point**

Run: `grep -n '^## ' CONTRIBUTING.md`

The file has section headings like `## Getting Started`, `## Testing`, etc. Pick the section that most closely matches "running checks locally." If there's a `## Testing` or `## Development` section, insert after it. If none obviously fits, append a new `## License Checks` section at the end of the file, above any trailing `## License` / `## Contact` sections.

- [ ] **Step 2: Add a "License check" subsection**

Insert this block at the chosen location (either as a new `### License check` under an existing section, or as a standalone `## License checks` section):

```markdown
### License check

Production-tree licenses are gated in CI against the allowlist
`MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0`. To run the same
check locally before pushing:

```bash
mkdir -p .license-check
cp package.json .license-check/
(cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes license-checker@25.0.1 \
  --start .license-check \
  --production \
  --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
  --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
  --summary
rm -rf .license-check
```

Expect exit 0. If a disallowed license surfaces, either swap the
offending dep, pin to an earlier version, or — if the SPDX
declaration is clearly wrong — add an explicit `--excludePackages`
entry with a comment.
```

Use the triple-backtick rendering exactly as shown; markdown renderers handle nested fences with language tags. If your editor struggles with the nested fences, use four backticks on the outer fence in the actual file.

- [ ] **Step 3: Preview the rendered markdown**

Run: `bunx --yes markdown-it CONTRIBUTING.md > /tmp/contributing-preview.html && echo OK`

(If `markdown-it` isn't installed, skip — it's only a sanity check.)
Expected: "OK". Open `/tmp/contributing-preview.html` to eyeball the rendering if tooling is available; otherwise proceed.

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "$(cat <<'EOF'
docs: document local license-check repro in CONTRIBUTING (#260)

Mirrors the CI gate added in the previous commit so contributors
can validate production-tree licenses before pushing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Full-suite verification

**Files:** none modified; verification only.

- [ ] **Step 1: Run the repo's full check suite**

Run: `bun run check`

Expected: all four sub-commands (`typecheck`, `lint`, `format:check`, `test --bail`) pass with exit 0. This matches what the pre-push hook runs.

If anything fails, STOP and investigate. Nothing in this plan touches runtime code, so failures here should be pre-existing and unrelated — but fix them or surface them before proceeding.

- [ ] **Step 2: Confirm branch state**

Run: `git log --oneline origin/main..HEAD`

Expected: three commits on the branch:

1. `docs: spec CI license hygiene (#260)` — already on branch before this plan executes.
2. `ci: add license-checker gate for production deps (#260)` — from Task 1.
3. `docs: document local license-check repro in CONTRIBUTING (#260)` — from Task 2.

Any other commits indicate drift; investigate.

- [ ] **Step 3: Rebase onto origin/main**

Before pushing, re-verify the branch is up to date with `main`:

```bash
git fetch origin main
git rebase origin/main
```

Expected: either "Current branch ci/license-hygiene is up to date" or a clean rebase with no conflicts. If conflicts surface, STOP — this plan touches a single CI file plus CONTRIBUTING, and conflicts mean something unexpected landed on main. Do not force-resolve.

---

## Task 4: Push and open PR

**Files:** none modified; git operations only.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin ci/license-hygiene
```

Pre-push hook will run `bun run check` again. Expected: exit 0. Do NOT use `--no-verify`.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "ci: license-checker gate for production deps" --body "$(cat <<'EOF'
## Summary

- Adds a `license-checker` step to the `quality` job in `test.yml` that fails CI on any production dep (direct or transitive) outside the allowlist `MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0`.
- Scans an isolated `npm install --omit=dev --ignore-scripts` tree (package.json only, no lockfile) so the check mirrors the `.mcpb` bundle's graph exactly.
- Uses `npx --yes license-checker@25.0.1` — no devDep added.
- Documents local repro in `CONTRIBUTING.md`.

Implements issue #260 item C (the CI-gate portion only). Aggregated `THIRD_PARTY_LICENSES` and CycloneDX SBOM are explicitly deferred — see the linked spec for the rationale.

Spec: `docs/superpowers/specs/2026-04-14-license-hygiene-design.md`
Plan: `docs/superpowers/plans/2026-04-14-license-hygiene.md`

## Test plan

- [ ] CI `quality` job passes on this PR, including the new License check step
- [ ] License check reports the expected ~118 packages under MIT/BSD/ISC/Apache licenses with exit 0
- [ ] No unexpected files or `.license-check/` artifacts are committed
- [ ] Existing `unit-tests` and `e2e-tests` jobs remain green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints a PR URL. Record it.

- [ ] **Step 3: Wait for CI and review**

Per the user's workflow preferences: wait 3-5 minutes for CI checks and automated review comments. Then:

```bash
gh pr checks
gh pr view --comments
gh api "repos/:owner/:repo/pulls/$(gh pr view --json number -q .number)/comments"
```

Expected: all checks green; no blocking review comments. Address every comment — including nits — before considering the work done.

- [ ] **Step 4: Address review feedback (if any)**

For each comment: make the change locally, commit with a conventional-commit prefix (`fix:`, `ci:`, `docs:` as appropriate), push. Re-check CI. Repeat until no outstanding comments.

- [ ] **Step 5: Mark task complete**

Work is done when: all CI green, all review comments addressed or resolved, PR approved (if reviewer required) or ready to merge.

---

## Self-review checklist (for the writer, already run)

- **Spec coverage:** Every in-scope item in the spec maps to a task — the CI step (Task 1), local repro docs (Task 2), verification (Task 3), rollout (Task 4). Out-of-scope items (`THIRD_PARTY_LICENSES`, SBOM, modclean docs) are correctly absent.
- **Placeholder scan:** No TBDs, TODOs, or "similar to Task N" references. Every code block is complete and verbatim.
- **Type consistency:** The `--excludePackages` version-extraction expression is identical in the workflow step, the local repro, and the CONTRIBUTING snippet. Allowlist is spelled identically across all four appearances (spec Context, workflow step, CONTRIBUTING, PR body).
