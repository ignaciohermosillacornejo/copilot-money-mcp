# License hygiene — CI gate for production-dep licenses

**Status:** Design approved (2026-04-14)
**Author:** nach
**Scope:** Add a `license-checker` CI gate to `.github/workflows/test.yml` that fails the `quality` job when any production dependency (direct or transitive) uses a license outside an explicit allowlist. No runtime behavior change; no bundle-content change.

## Motivation

The `.mcpb` bundle distributed via GitHub Releases embeds `node_modules/` with roughly 118 production dependencies. When the project distributes that bundle, it becomes a redistributor under each dep's license. Today all transitive prod licenses are MIT/BSD/ISC/Apache-2.0, and the individual `LICENSE` files ship inside each `node_modules/<pkg>/` directory — so MIT/BSD/ISC/Apache-2.0 notice preservation is already satisfied by the existing bundle.

The remaining risk is **future drift**: a transitive-dep bump could silently pull in a package with a problematic license (GPL/AGPL is rare in npm but not unheard of — ~1% of public packages). Catching that in code review by eyeballing a lockfile diff is not realistic.

A ~10-line CI step that runs `license-checker` against the production tree and fails on anything outside an explicit allowlist is cheap insurance against that drift.

Tracking: issue #260, item C ("License and supply chain"). This spec implements only the CI-gate part of item C. The other sub-items (aggregated `THIRD_PARTY_LICENSES`, CycloneDX SBOM) are explicitly deferred — see **Non-goals** below.

## Scope

**In scope:**

- Add a `License check (production deps)` step to the existing `quality` job in `.github/workflows/test.yml`.
- Use `license-checker` via `npx --yes license-checker@latest` — no devDep added to `package.json`.
- Run the check against an isolated `npm install --omit=dev --ignore-scripts` tree that mirrors what `scripts/pack-mcpb.ts` ships (package.json only, no lockfile), not against bun's workspace layout.
- Allowlist: `MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0` (verbatim from issue #260 item C).
- Document a local repro command for developers who want to run the same check before pushing.

**Out of scope (explicitly deferred):**

- Aggregated `THIRD_PARTY_LICENSES` file. Individual `LICENSE` files already ship inside each `node_modules/<pkg>/` in the bundle, so license-notice preservation obligations are already satisfied. The aggregation is convenience for auditors, not a compliance gap for this project's scale.
- CycloneDX SBOM. Low ROI for a personal-scale MCP; defer to a follow-up if/when compliance or vuln-scanning consumers ask for one.
- Modclean preservation documentation. Will be specified as part of issue #260 item D (the modclean pass itself), not pre-emptively here.
- Dev-dep license scanning. Dev deps do not ship in the bundle; no redistribution concern.
- Any change to `build-mcpb.yml`, `auto-release.yml`, `npm-publish.yml`, `scripts/pack-mcpb.ts`, or `package.json`.

## Context: current production-tree audit

Run against the working tree on 2026-04-14 via `npx license-checker --production --summary`:

| License     | Count |
|-------------|------:|
| MIT         | 95 |
| BSD-3-Clause | 14 |
| ISC         | 7 |
| BSD-2-Clause | 1 |
| Apache-2.0  | 1 |
| **Total**   | **118** |

All 118 prod-tree packages are covered by the proposed allowlist. No expansion needed today.

The four direct prod deps are `@modelcontextprotocol/sdk`, `classic-level`, `protobufjs`, and `zod` — all MIT. All license diversity comes from the transitive tree.

## Design

### Where the step lands

One new step at the end of the `quality` job in `.github/workflows/test.yml`, after `Check formatting`:

```yaml
- name: License check (production deps)
  run: |
    mkdir -p .license-check
    cp package.json .license-check/
    (cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
    npx --yes license-checker@latest \
      --start .license-check \
      --production \
      --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
      --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
      --summary
```

### Design decisions and rationale

**`npm install` in a scratch directory with `package.json` only (no lockfile), not `bun install`'s workspace tree.**
The `.mcpb` bundle's dep graph is produced by `npm install --omit=dev --ignore-scripts` inside `scripts/pack-mcpb.ts`, which copies `package.json` into the staging directory but NOT `package-lock.json`. Scanning under the same semantics ensures the CI check sees the same set of packages the bundle ships. Copying the lockfile and switching to `npm ci` was considered and rejected: with the lockfile present npm walks the full resolved tree (including devDep entries) during peer-dep validation, and the project's `typescript@^6` conflicts with `typescript-eslint@8`'s `typescript@">=4.8.4 <6.0.0"` peer constraint. Forcing past that with `--legacy-peer-deps` would pass the check but silence a real signal, and — more importantly — would no longer mirror the bundle's actual install path. Bun's `node_modules/` layout can differ subtly (hoisting, peer-dep resolution) — catching a violation against a tree that is NOT what we ship would be a bug.

**`npx license-checker@latest` rather than adding a devDep.**
`license-checker` pulls ~30 transitive deps that are only relevant to CI. Adding it to `package.json` pollutes the dev graph (lockfile churn, `bun install` time). `npx --yes ... @latest` keeps it ephemeral. `@latest` is acceptable because the tool is low-churn and any breaking-change fallout surfaces as a visible CI failure, not a silent one. If the tool ever ships a regression, we pin a version in the step.

**`--production` + `--onlyAllow`.**
`--production` restricts to the `dependencies` tree — matching what the bundle ships. `--onlyAllow` causes the tool to exit nonzero if any package's license is outside the list. Exit status is what fails the job.

**`--excludePackages "copilot-money-mcp@<version>"`.**
The repo's own package appears in the scanned tree. Its license (MIT) is already in the allowlist, but excluding it avoids including the project itself in the checked set. The version is read dynamically via `node -p` so the step does not need to be kept in sync with `package.json`.

**Allowlist handling of composite SPDX expressions.**
`--onlyAllow` matches flat SPDX IDs only; a dep that declares e.g. `(MIT OR Apache-2.0)` reports the raw expression and does not match either half. No current prod dep uses a composite expression. If one surfaces in the future, the fix is to either switch to `license-checker-rseidelsohn` (which supports `--onlyAllow` with expression parsing) or add that specific package to `--excludePackages`. We'll decide when it actually happens.

**Gating semantics.**
Blocking on PRs at the same level as `typecheck`, `lint`, and `format:check`. A disallowed license is treated exactly like a failed type-check: fix the dep, push again. Release-time gating falls out for free because `auto-release.yml` only runs against main, which only gets updated via PR merges that are green.

### Files changed

- `.github/workflows/test.yml` — one new step in the `quality` job, ~10 lines.
- `.gitignore` — add `.license-check/` so the scratch directory created by the CI step is never accidentally committed.

No other files are touched.

## Testing and rollout

**Pre-merge verification (developer-local):**

```bash
mkdir -p .license-check
cp package.json .license-check/
(cd .license-check && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
npx --yes license-checker@latest \
  --start .license-check \
  --production \
  --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0' \
  --excludePackages "copilot-money-mcp@$(node -p "require('./package.json').version")" \
  --summary
rm -rf .license-check
```

Expect exit 0 against the current tree.

**Gate negative-path verification (manual, local only — not committed):**

Temporarily add a known-GPL package (e.g. `readline-sync` which is under WTFPL) to `package.json`, run the `npm install` step in the scratch dir, rerun the license-checker command, expect exit 1 with that package's name in the output. Revert the change. This verifies the gate actually rejects disallowed licenses; do not land this as a committed negative test.

**CI verification (in-PR):**
The new step runs as part of the `quality` job on every PR. The PR that introduces the step exercises the step itself — expect the `quality` job to pass.

**Failure mode and recovery:**
If a future PR introduces a dep with a disallowed license, `license-checker` prints the offending package name, version, and license on stderr and exits nonzero. `quality` fails. The PR author either swaps the dep, pins to an earlier version, or — if the reporting is wrong (e.g. misdeclared SPDX) — adds the package to `--excludePackages` with a comment explaining why.

**Rollback:**
The change is a single step in one workflow file. Revert the commit if anything misbehaves post-merge. No state needs unwinding; the step does not produce artifacts.

**Line-count delta:** `.github/workflows/test.yml` grows by ~10 lines.

## Non-goals / things we explicitly did NOT consider

- **Adding `THIRD_PARTY_LICENSES` to the bundle.** Individual `LICENSE` files already ride along inside each `node_modules/<pkg>/` directory in the bundle, so MIT/BSD/ISC/Apache-2.0 notice-preservation obligations are already discharged. An aggregated file is auditor-convenience, not legal requirement.
- **Adding a CycloneDX SBOM.** Deferred as low-ROI at this project's scale. Revisit if a downstream consumer requests one.
- **Pinning `license-checker` to an exact version via devDeps.** Rejected in favor of `npx @latest` to keep the dev dep graph clean. Trade-off: we trust the tool not to break silently. Revisit if it ever does.
- **Running the gate inside `build-mcpb.yml` or `pack-mcpb.ts`.** Release-path gating is redundant with PR gating (main can only advance through green PRs). Adding the check to the pack script would duplicate work and slow bundle builds for no incremental safety.
- **Broadening the allowlist to include BlueOak-1.0.0, CC0-1.0, Unlicense, 0BSD.** None currently appear in the tree. Expanding pre-emptively loosens the gate without benefit. Add when a real dep forces the decision.
- **Blocking on main with `on: push` as well as PRs.** Redundant: `test.yml` already runs on main pushes for the existing jobs, and main only advances through PRs that have already run the gate.
