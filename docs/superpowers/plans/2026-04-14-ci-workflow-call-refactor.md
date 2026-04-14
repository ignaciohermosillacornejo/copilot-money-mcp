# CI workflow_call refactor — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `.mcpb` build + GitHub release creation from inline steps in `auto-release.yml` into `build-mcpb.yml` as a reusable `workflow_call` target. No user-visible behavior change.

**Architecture:** `auto-release.yml` becomes a thin orchestrator with three jobs (`detect-version` → `release` via `workflow_call` → `publish` via `workflow_call`). `build-mcpb.yml` owns the full build-and-release-atomically story and keeps `workflow_dispatch` for manual releases. The dead `push: tags: v*` trigger is removed.

**Tech Stack:** GitHub Actions (YAML), `actionlint` (CI YAML validator), `@anthropic-ai/mcpb`, `bun`, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-04-14-ci-workflow-call-refactor-design.md`

---

## File Structure

- **Modify:** `.github/workflows/build-mcpb.yml` — rewrite entirely as a reusable workflow with `workflow_call` + `workflow_dispatch` triggers, single `build-and-release` job.
- **Modify:** `.github/workflows/auto-release.yml` — split into three jobs (`detect-version`, `release`, `publish`); release job delegates to `build-mcpb.yml` via `workflow_call`; hoist `concurrency` to workflow level.

No new files. No source code changes. No test changes.

---

## Task 1: Set up `actionlint` locally

We need a way to statically validate the YAML before pushing to CI. `actionlint` checks GitHub Actions syntax, `workflow_call` input wiring, and expression references.

**Files:** none (tool install only).

- [ ] **Step 1: Install `actionlint` via Homebrew**

Run: `brew install actionlint`
Expected: installs the `actionlint` binary.

- [ ] **Step 2: Baseline — lint the workflows at their current state**

Run: `actionlint .github/workflows/*.yml`
Expected: either silent exit (clean) or a list of issues. Record the output — any issues present now are not caused by this refactor.

If the output lists issues, that's the baseline; subsequent runs must not add to it.

- [ ] **Step 3: Commit (nothing to commit yet — skip)**

No file changes in this task.

---

## Task 2: Rewrite `build-mcpb.yml` as a reusable workflow

Replace the existing content entirely. The new workflow has two triggers (`workflow_call`, `workflow_dispatch`), identical input shapes on both, and a single `build-and-release` job that either creates a release or uploads an artifact based on the `dry_run` input.

**Files:**
- Modify: `.github/workflows/build-mcpb.yml` — full replacement.

- [ ] **Step 1: Replace the file contents**

Open `.github/workflows/build-mcpb.yml` and replace the entire file with:

```yaml
name: Build & Release .mcpb

on:
  workflow_call:
    inputs:
      version:
        description: Release version without the `v` prefix (e.g. "1.6.2")
        required: true
        type: string
      target_sha:
        description: Commit SHA to check out, build, and tag at
        required: true
        type: string
      dry_run:
        description: Build only; upload the bundle as an artifact and skip release creation
        required: false
        type: boolean
        default: false
  workflow_dispatch:
    inputs:
      version:
        description: Release version without the `v` prefix (e.g. "1.6.2")
        required: true
        type: string
      target_sha:
        description: Commit SHA to check out. Defaults to the selected branch's HEAD.
        required: false
        type: string
      dry_run:
        description: Build only; upload the bundle as an artifact and skip release creation
        required: false
        type: boolean
        default: false

jobs:
  build-and-release:
    name: Build and release .mcpb
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          ref: ${{ inputs.target_sha || github.sha }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install

      - name: Build .mcpb bundle
        run: bun run pack:mcpb

      - name: Extract changelog notes
        if: ${{ !inputs.dry_run }}
        env:
          VERSION: ${{ inputs.version }}
        run: |
          NOTES=$(awk -v ver="$VERSION" '
            /^## \[/ {
              if (found) exit
              if (index($0, "[" ver "]")) found=1
              next
            }
            found { print }
          ' CHANGELOG.md)
          if [ -z "$NOTES" ]; then
            echo "No changelog entry for v$VERSION, using default message"
            NOTES="Release v$VERSION"
          fi
          echo "$NOTES" > /tmp/release-notes.md

      - name: Create release with bundle
        if: ${{ !inputs.dry_run }}
        env:
          GH_TOKEN: ${{ github.token }}
          VERSION: ${{ inputs.version }}
          TARGET: ${{ inputs.target_sha || github.sha }}
        run: |
          gh release create "v$VERSION" \
            --title "v$VERSION" \
            --notes-file /tmp/release-notes.md \
            --target "$TARGET" \
            copilot-money-mcp.mcpb

      - name: Upload artifact (dry run)
        if: ${{ inputs.dry_run }}
        uses: actions/upload-artifact@v7
        with:
          name: copilot-money-mcp-bundle
          path: copilot-money-mcp.mcpb
          retention-days: 7
```

- [ ] **Step 2: Lint the rewritten workflow**

Run: `actionlint .github/workflows/build-mcpb.yml`
Expected: exits silently (0 issues for this file). If issues appear, fix them inline — common causes:
- Missing `type:` on an input
- Expression inside `if:` without `${{ }}` wrapping (actionlint is picky about boolean coercion on `inputs.dry_run`)
- `uses:` action version that no longer resolves

Re-run until clean.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-mcpb.yml
git commit -m "ci: make build-mcpb.yml a reusable workflow_call target

Replace the tag-push-triggered workflow with a workflow_call +
workflow_dispatch reusable workflow. Inputs: version, target_sha,
dry_run. Single build-and-release job — either creates a GitHub
release with the .mcpb attached (normal path) or uploads the bundle
as an artifact (dry_run). Drops the dead push: tags: v* trigger
and the QA steps that duplicate test.yml."
```

---

## Task 3: Manually validate the rewritten `build-mcpb.yml`

Before wiring up the caller, prove the reusable workflow actually runs end-to-end. `workflow_dispatch` lets us pick any branch from the GitHub UI.

**Files:** none (manual verification via GitHub UI).

- [ ] **Step 1: Push the branch to the remote**

```bash
git push -u origin ci/workflow-call-refactor
```

- [ ] **Step 2: Trigger the workflow manually via the GitHub UI**

1. Open https://github.com/ignaciohermosillacornejo/copilot-money-mcp/actions
2. Pick "Build & Release .mcpb" in the left sidebar.
3. Click **Run workflow** (top right).
4. Select branch: `ci/workflow-call-refactor`.
5. Fill inputs:
   - `version`: `0.0.0-test`
   - `target_sha`: leave blank (defaults to branch HEAD)
   - `dry_run`: `true` (check the box)
6. Click **Run workflow**.

Expected outcome:
- The run succeeds.
- A `copilot-money-mcp-bundle` artifact appears on the run's summary page.
- **No GitHub release is created for `v0.0.0-test`** (confirm at `/releases`).

If the run fails or a release gets created, stop and diagnose. Do NOT proceed to Task 4 — the next step depends on this one working.

- [ ] **Step 3: Commit (nothing to commit — manual step)**

No file changes.

---

## Task 4: Rewrite `auto-release.yml` as an orchestrator

Split the workflow into three jobs. `detect-version` is unchanged logic, just lifted into its own job. `release` delegates to `build-mcpb.yml` via `workflow_call`. `publish` stays the same. Concurrency moves to workflow level.

**Files:**
- Modify: `.github/workflows/auto-release.yml` — full replacement.

- [ ] **Step 1: Replace the file contents**

Open `.github/workflows/auto-release.yml` and replace the entire file with:

```yaml
name: Auto Release

on:
  push:
    branches: [main]
    paths:
      - 'package.json'

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  detect-version:
    name: Detect version bump
    runs-on: ubuntu-latest
    if: github.actor == 'ignaciohermosillacornejo'
    outputs:
      changed: ${{ steps.version.outputs.changed }}
      current: ${{ steps.version.outputs.current }}

    steps:
      - name: Checkout repository
        uses: actions/checkout@v6

      - name: Fetch pre-push state for version comparison
        env:
          BEFORE: ${{ github.event.before }}
        run: |
          # Fetch the commit that was HEAD before this push, so we can compare
          # package.json across the entire push (not just HEAD vs HEAD~1).
          if [ "$BEFORE" != "0000000000000000000000000000000000000000" ] && [ -n "$BEFORE" ]; then
            git fetch --depth=1 origin "$BEFORE" || true
          fi

      - name: Check for version bump
        id: version
        env:
          BEFORE: ${{ github.event.before }}
        run: |
          CURRENT_VERSION=$(node -p "require('./package.json').version")
          echo "current=$CURRENT_VERSION" >> "$GITHUB_OUTPUT"

          # Check if tag already exists (fetch tags first)
          git fetch --tags --quiet
          if git rev-parse "v$CURRENT_VERSION" >/dev/null 2>&1; then
            echo "Tag v$CURRENT_VERSION already exists, skipping"
            echo "changed=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          # Compare against the state before this push (handles multi-commit pushes)
          if [ "$BEFORE" = "0000000000000000000000000000000000000000" ] || [ -z "$BEFORE" ]; then
            echo "Initial push, treating as version change"
            OLD_VERSION=""
          else
            git show "$BEFORE":package.json > /tmp/old-package.json 2>/dev/null || true
            OLD_VERSION=$(node -p "try { require('/tmp/old-package.json').version } catch { '' }")
          fi

          if [ "$CURRENT_VERSION" != "$OLD_VERSION" ]; then
            echo "Version changed: $OLD_VERSION -> $CURRENT_VERSION"
            echo "changed=true" >> "$GITHUB_OUTPUT"
          else
            echo "Version unchanged ($CURRENT_VERSION), skipping"
            echo "changed=false" >> "$GITHUB_OUTPUT"
          fi

  # Build the .mcpb and create the GitHub release atomically. Chained via
  # workflow_call rather than relying on a tag-push trigger, because tags
  # created with the default GITHUB_TOKEN do not fire `push: tags: v*`.
  release:
    name: Build and release .mcpb
    needs: detect-version
    if: needs.detect-version.outputs.changed == 'true' && github.actor == 'ignaciohermosillacornejo'
    permissions:
      contents: write
    uses: ./.github/workflows/build-mcpb.yml
    with:
      version: ${{ needs.detect-version.outputs.current }}
      target_sha: ${{ github.sha }}
      dry_run: false

  # Publishing is chained directly via workflow_call rather than relying on the
  # release event, because releases created with the default GITHUB_TOKEN do not
  # trigger downstream `release: published` workflows.
  publish:
    name: Publish to npm
    needs: [detect-version, release]
    if: needs.detect-version.outputs.changed == 'true' && github.actor == 'ignaciohermosillacornejo'
    permissions:
      contents: read
      id-token: write
    uses: ./.github/workflows/npm-publish.yml
    with:
      dry_run: false
    secrets: inherit
```

- [ ] **Step 2: Lint the rewritten workflow**

Run: `actionlint .github/workflows/auto-release.yml`
Expected: exits silently. Common issues and fixes:
- `needs.detect-version.outputs.current` used but job didn't declare the output → check the `outputs:` block on `detect-version`.
- `uses: ./.github/workflows/build-mcpb.yml` path wrong → path must be relative to the repo root and start with `./`.
- `secrets: inherit` missing on the `publish` job → keep it; removing it breaks npm-publish's OIDC plumbing.

Re-run until clean.

- [ ] **Step 3: Lint ALL workflows together to catch cross-file issues**

Run: `actionlint .github/workflows/*.yml`
Expected: no new issues compared to the Task 1 baseline. If `actionlint` reports issues in files we didn't touch, they existed before this refactor — leave them alone.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/auto-release.yml
git commit -m "ci: shrink auto-release.yml to an orchestrator

Split into three jobs: detect-version → release (via workflow_call
to build-mcpb.yml) → publish (via workflow_call to npm-publish.yml).
Move concurrency key to workflow level so it serializes the full
run, not just a single job. Drops all inline bun setup / install /
pack / changelog / gh release create steps — those now live in
build-mcpb.yml behind a reusable interface.

No user-visible behavior change. Refs #260."
```

---

## Task 5: Push and open the PR

**Files:** none (git + gh only).

- [ ] **Step 1: Push the updated branch**

```bash
git push
```

- [ ] **Step 2: Rebase onto origin/main if it has moved**

```bash
git fetch origin main
git log HEAD..origin/main --oneline
```

If there are new commits on main, rebase:

```bash
git rebase origin/main
git push --force-with-lease
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "ci: delegate .mcpb build/release to reusable workflow (#260)" --body "$(cat <<'EOF'
## Summary

- Shrinks `auto-release.yml` from ~125 lines to ~85 by moving the inline bun setup / install / pack / changelog / `gh release create` steps into `build-mcpb.yml` behind a `workflow_call` interface.
- Mirrors the existing `npm-publish.yml` `workflow_call` pattern.
- Hoists \`concurrency\` to workflow level in \`auto-release.yml\` so it serializes the whole run, not just one job.
- Removes the dead \`push: tags: v*\` trigger from \`build-mcpb.yml\` (never fires for GITHUB_TOKEN-created tags).
- Drops QA steps (typecheck/lint/format:check/test) from \`build-mcpb.yml\` — \`test.yml\` already guards every commit on main via PR CI.

No user-visible behavior change. No new secrets; still uses only \`github.token\`.

Spec: \`docs/superpowers/specs/2026-04-14-ci-workflow-call-refactor-design.md\`
Tracks: #260

## Test plan

- [x] \`actionlint .github/workflows/*.yml\` clean locally
- [x] Manual \`workflow_dispatch\` of \`build-mcpb.yml\` on this branch with \`dry_run=true\` → bundle uploaded as artifact, no release created
- [ ] Post-merge: next \`chore: bump version\` commit creates a GitHub release with \`copilot-money-mcp.mcpb\` attached and publishes to npm

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI + automated review**

After the PR is open, CI (`test.yml`) runs. An automated review usually arrives in 2–5 minutes. Read it and address any feedback before considering the task complete.

---

## Self-review checklist (run before handing off)

Before marking the plan ready, verify:

- [ ] Every spec requirement has a task (spec coverage).
- [ ] No TBD/TODO/placeholder text in any step.
- [ ] Every workflow input referenced later is defined earlier (input consistency across `build-mcpb.yml` and `auto-release.yml`).
- [ ] Every code block for YAML is complete and valid (no ellipses, no "…same as above").
- [ ] Every commit message matches the conventional-commit prefix style the repo uses (`ci:`, `fix:`, `docs:`, etc.).
