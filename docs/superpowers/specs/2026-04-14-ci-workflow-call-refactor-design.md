# CI workflow_call refactor — delegate .mcpb build/release from auto-release

**Status:** Design approved (2026-04-14)
**Author:** nach
**Scope:** CI restructuring — move .mcpb build + GitHub release creation from inline steps in `auto-release.yml` into a reusable `workflow_call` target in `build-mcpb.yml`. No user-visible behavior change.

## Motivation

PR #251 fixed the regression where the .mcpb bundle shipped broken in v1.6.0 and v1.6.1. That fix added the bundle build + release creation as inline steps inside `auto-release.yml`:

```yaml
- name: Setup Bun
- name: Install dependencies
- name: Build .mcpb bundle
- name: Create release with bundle
```

This works, but it mixes two responsibilities in one workflow:

1. **Version-bump detection** — scan `package.json`, compare against the pre-push state, decide whether this commit is a release.
2. **Bundle build + release publishing** — checkout, install, pack, `gh release create` with the asset.

We already have a precedent for splitting responsibilities via reusable workflows: `npm-publish.yml` was refactored into a `workflow_call` target (commit `1656219`) for exactly the same reason — GITHUB_TOKEN-created tags don't trigger downstream `push: tags: v*` or `release: published` handlers, so chaining had to happen at the workflow level.

`build-mcpb.yml` currently has a dead `push: tags: v*` trigger (for the same GITHUB_TOKEN reason) and a `workflow_dispatch` trigger. Turning it into a reusable workflow consolidates the bundle-release story in one file and shrinks `auto-release.yml` to a thin orchestrator.

Tracking: issue #260, item "CI simplification".

## Scope

**In scope:**

- Restructure `build-mcpb.yml` to be reusable via `workflow_call` (plus keep `workflow_dispatch` for manual releases).
- Remove the dead `push: tags: v*` trigger from `build-mcpb.yml`.
- Rewrite `auto-release.yml` to delegate the build + release to `build-mcpb.yml` via `workflow_call`.
- Hoist the `concurrency` key in `auto-release.yml` from the `release` job to the workflow level.
- Drop the redundant QA steps (typecheck, lint, format:check, test) from `build-mcpb.yml` — `test.yml` already guards every main commit through PR CI.

**Out of scope:**

- Any change to `npm-publish.yml`.
- Any change to `test.yml`.
- Any change to the bundle contents, `pack-mcpb.ts`, or the regression test.
- Other items from issue #260 (license hygiene, platform-specific variants, modclean, SBOM, Node ABI pinning).

## Architecture

```
push main (package.json changed)
         │
         ▼
┌────────────────────┐
│ auto-release.yml   │  Orchestrator
│  • detect version  │  (no secrets, no build)
│  • call mcpb       │
│  • call npm        │
└─────────┬──────────┘
          │ workflow_call
          ├───────────────────────────┐
          ▼                           ▼
┌────────────────────┐      ┌────────────────────┐
│ build-mcpb.yml     │      │ npm-publish.yml    │
│  (reusable)        │      │  (already reusable)│
│  • pack            │      │                    │
│  • create release  │      │                    │
│  • attach .mcpb    │      │                    │
└────────────────────┘      └────────────────────┘
```

## `build-mcpb.yml` (reusable)

**Triggers:**

- `workflow_call` — new; used by `auto-release.yml`.
- `workflow_dispatch` — kept; for manual releases.
- `push: tags: v*` — **removed**. Dead code under the GITHUB_TOKEN model; manual tag pushes can use `workflow_dispatch` instead.

**Inputs (identical shape for both triggers):**

| Name         | Type    | Required | Default | Notes                                           |
|--------------|---------|----------|---------|-------------------------------------------------|
| `version`    | string  | yes      | —       | Release version, without `v` prefix. E.g. `1.6.2`. |
| `target_sha` | string  | yes      | —       | Commit SHA to check out, build, and tag at.     |
| `dry_run`    | boolean | no       | `false` | Build only; upload as artifact, no release.     |

**Permissions:** `contents: write` (for `gh release create`).
**Auth:** `GH_TOKEN: ${{ github.token }}` — default token, no secrets.

**Single job `build-and-release`:**

1. `actions/checkout@v6` at `${{ inputs.target_sha }}`.
2. `oven-sh/setup-bun@v2`.
3. `bun install`.
4. `bun run pack:mcpb` — produces `copilot-money-mcp.mcpb` at repo root.
5. If `!inputs.dry_run`: extract the `## [<version>]` section from `CHANGELOG.md` into `/tmp/release-notes.md`. Fall back to `"Release v<version>"` when the section is missing.
6. If `!inputs.dry_run`: `gh release create "v<version>" --title "v<version>" --notes-file /tmp/release-notes.md --target "<target_sha>" copilot-money-mcp.mcpb`. Atomic — the release and the asset land together.
7. If `inputs.dry_run`: `actions/upload-artifact@v7` with `name: copilot-money-mcp-bundle`, `path: copilot-money-mcp.mcpb`, `retention-days: 7`.

**Why one job instead of the current two:** the current file has a separate `release` job only because its release creation was gated on the trigger. With the gate now expressed inline as `if: !inputs.dry_run`, the artifact-handoff dance (`upload-artifact` then `download-artifact`) becomes ceremony with no benefit.

## `auto-release.yml` (orchestrator)

**Trigger:** unchanged — `push: branches: [main], paths: ['package.json']`.

**Workflow-level concurrency** (hoisted from job level): `group: release-${{ github.ref }}, cancel-in-progress: false`. With three jobs in the workflow, job-level concurrency doesn't serialize the whole run; workflow-level does.

**Three jobs:**

1. **`detect-version`** — runs on `ubuntu-latest`, gated on `github.actor == 'ignaciohermosillacornejo'`. Same steps as today's version-detection logic (checkout, fetch pre-push state, compare `package.json` versions, emit `changed` and `current` outputs).

2. **`release`** — `needs: detect-version`, `if: needs.detect-version.outputs.changed == 'true' && github.actor == 'ignaciohermosillacornejo'`, `permissions: contents: write`. A `uses: ./.github/workflows/build-mcpb.yml` call with:
   ```yaml
   with:
     version:    ${{ needs.detect-version.outputs.current }}
     target_sha: ${{ github.sha }}
     dry_run:    false
   ```

3. **`publish`** — unchanged. `needs: [detect-version, release]`, same actor check, same `uses: ./.github/workflows/npm-publish.yml` with `dry_run: false` and `secrets: inherit`.

**Line-count delta:** `auto-release.yml` drops from ~125 to ~70 lines. All Bun setup, install, pack, changelog extraction, and `gh release create` steps move to `build-mcpb.yml`.

## Behavior delta

None that is user-visible:

- Same trigger for auto-release.
- Same actor gate.
- Same atomic release creation (tag + release + asset in one step).
- Same npm publish chain with OIDC.
- No new secrets; no environment references.

## Testing and rollout

**Pre-merge verification:**

- `actionlint .github/workflows/*.yml` locally. Catches YAML shape errors, unused inputs, bad expression references, and missing `workflow_call` input bindings. Cheap (~1s).
- From the PR branch, GitHub UI → Actions → `build-mcpb` → Run workflow with `version: <anything>`, `target_sha: <PR head>`, `dry_run: true`. Exercises the full build path end-to-end, uploads an artifact, creates no release. Proves: inputs wiring, checkout-at-SHA, `bun run pack:mcpb`, artifact upload step.

**What can't be tested pre-merge:**

- The `workflow_call` edge from `auto-release.yml` → `build-mcpb.yml`. It only resolves when `auto-release.yml` runs against `main`, which requires a real version bump in `package.json`. The first post-merge release exercises it.

**Failure modes and recovery:**

- `build-mcpb` fails after the version bump lands → no release is created, `publish` is skipped. To retry: either push a trivial commit (auto-release no-ops because version is unchanged) and manually `workflow_dispatch build-mcpb.yml` with the stuck version, or bump the patch again.
- Tag already exists → `gh release create` errors out explicitly; not silent.
- Npm publish fails after release succeeds → release + asset are already on GitHub. Same as today; the `publish` job can be re-run from the Actions UI.

**Rollback:** the two workflow files are self-contained. Revert the commit if anything misbehaves post-merge.

## Non-goals / things we explicitly did NOT consider

- **Storing a PAT to chain via `release: published`.** Explicitly avoided; `workflow_call` exists for exactly this reason without secrets.
- **A separate `mcpb-release.yml` file.** Renaming `build-mcpb.yml` would break the Actions UI history continuity for no benefit.
- **Passing release notes as a workflow input.** GitHub Actions string inputs technically support multi-line values, but re-extracting the changelog inside the reusable workflow is simpler and keeps the orchestrator free of CHANGELOG knowledge.
