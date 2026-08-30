# Documentation

Index of everything under `docs/` for the Copilot Money MCP Server.

Start with **[CONFORMANCE_ARCHITECTURE.md](CONFORMANCE_ARCHITECTURE.md)** if you are about
to touch the GraphQL surface, add a tool, or fix a boundary bug — it explains the ledger,
the smokes, and the PR rituals as one system. Start with
**[tools-by-mode.md](tools-by-mode.md)** if you just want to know which tools exist in
which mode.

## Architecture & design

- **[CONFORMANCE_ARCHITECTURE.md](CONFORMANCE_ARCHITECTURE.md)** — How the repo defends
  against drift in Copilot's API, which we neither own nor get change notice for. Covers
  the three kinds of oracle, the conformance ledger as the spine, the five invariants,
  the standing (no-one-is-coding) posture, and where each piece lives. Read this first.
- **[DESIGN_NOTES.md](DESIGN_NOTES.md)** — Context-conscious tool design: why tool
  responses are compact, paginated, and aggregate-first, so a large transaction history
  can't blow out the model's context window.
- **[tools-by-mode.md](tools-by-mode.md)** — Per-tool inventory across the three modes
  (default cache reads, `--live-reads`, `--write`), including which cache tools get
  swapped for `_live` variants, which are cache-only forever, and known caveats.
- **[graphql-live-reads.md](graphql-live-reads.md)** — What `--live-reads` changes, the
  browser-session auth prerequisite, the live cache architecture and freshness fields,
  `refresh_cache`, filter reference, and error meanings.
- **[firestore-collections.md](firestore-collections.md)** — Authoritative reference for
  the local LevelDB/Firestore cache: collection inventory, decode coverage (decoded vs.
  undecoded paths), data quirks and gotchas, and app-view → collection mapping.
- **[REVERSE_ENGINEERING_FINDING.md](REVERSE_ENGINEERING_FINDING.md)** — The original
  research writeup: where Copilot stores local data, the Firestore-protobuf-in-LevelDB
  wire format, a working decoder, sample extracted data, and the initial implementation
  plan. Historical in framing, still the best explanation of the binary format.

## Operations & distribution

- **[bulk-edit-transactions.md](bulk-edit-transactions.md)** — How bulk transaction edits
  work: `bulkEditTransactions` applying one edit to many rows, what can and cannot be
  bulk-edited and which tool to reach for, why the `filter` argument is dangerous and
  where the verified/inferred boundary sits, and why `failed: []` does not mean success.
- **[MCPB_COMPLIANCE.md](MCPB_COMPLIANCE.md)** — `.mcpb` bundle guide: the top rejection
  reasons and how they're addressed, the full compliance checklist, bundle technical
  requirements, and the build → test → submit flow for the MCP directory.
- **[TESTING_GUIDE.md](TESTING_GUIDE.md)** — Manual testing in Claude Desktop:
  installation methods, verifying the install, per-tool test cases, performance, error
  handling, privacy/security checks, and common issues.
- **[scheduled-smoke.md](scheduled-smoke.md)** — The weekly launchd drift check that runs
  the Tier-1 conformance suite on the owner's machine, where browser-session auth lives.
  Install/uninstall and manual trigger.
- **[EXAMPLE_QUERIES.md](EXAMPLE_QUERIES.md)** — Natural-language query cookbook grouped
  by topic (transactions, spending analysis, income, travel, investments, subscriptions,
  healthcare, comparisons), plus example conversation flows and phrasing tips.

## `audits/` — dated audits

Dated, one-off sweeps of a single concern across the whole repo. Two rituals file here,
with different scopes:

*Boundary audits* — output of `/boundary-audit` (`skills/boundary-audit/SKILL.md`): a
periodic inventory of the repo's external assumptions against `src/conformance/ledger.ts`,
with the verification-class trend, retro-checks of recent bugs for missing class-level
detectors, and docs-freshness spot checks.

*Bug-class audits* — a sweep triggered by one defect class recurring, examining every
guard in the repo for that class and proving each finding by mutation.

- **[audits/2026-06-10-boundary-audit.md](audits/2026-06-10-boundary-audit.md)** — First
  boundary-audit run (issue #445), covering the 2026-03-12 → 2026-06-10 window.
- **[audits/2026-08-29-completeness-guard-audit.md](audits/2026-08-29-completeness-guard-audit.md)**
  — Completeness-guard audit, triggered by the #635 bug class recurring in #673/#676.
  24 findings (F1–F18 across tests, `scripts/` gates and CI, one since withdrawn;
  D1–D7 in the data layer), mutation-proven and independently fact-checked. Two
  security-relevant, and D1 silently corrupts spend totals.

## `graphql-capture/` — Copilot's GraphQL API, as observed

Captured and reverse-engineered documentation of `app.copilot.money/api/graphql`. This is
the source material behind `src/core/graphql/operations.generated.ts`.

- **[graphql-capture/wire-protocol.md](graphql-capture/wire-protocol.md)** — HTTP-level
  details: endpoint, method, Apollo `BatchHttpLink` batching, bearer-token auth, headers.
- **[graphql-capture/flows/01-web-session.md](graphql-capture/flows/01-web-session.md)** —
  The live web-session capture (2026-04-14) that seeded the operation set: methodology
  (an Apollo-layer interceptor, since a service worker defeats `fetch` patching) and the
  resulting observation counts.
- **[graphql-capture/schema/operations.md](graphql-capture/schema/operations.md)** — Index
  of every captured operation with observation counts, linking into `operations/`.
- **[graphql-capture/operations/queries/](graphql-capture/operations/queries/)** — One
  file per observed query (34 files: `Transactions`, `Accounts`, `Categories`, `Budgets`,
  `Recurrings`, `Holdings`, `Networth`, `SecurityPrices`, `TopMovers`, …), each with the
  verbatim document, variables, and response shape.
- **[graphql-capture/operations/mutations/](graphql-capture/operations/mutations/)** — One
  file per observed mutation (19 files: `EditTransaction`, `SplitTransaction`,
  `CreateRecurring`, `EditBudget`, `CreateTag`, …), same treatment.
- **[graphql-capture/hidden-mutations.md](graphql-capture/hidden-mutations.md)** —
  Mutations that exist on the server but the web app never fires (`splitTransaction`,
  `createTransaction`, `deleteTransaction`, `addTransactionToRecurring`), with confirmed
  signatures, risk ratings, and explicitly flagged unknowns.
- **[graphql-capture/introspection-recon.md](graphql-capture/introspection-recon.md)** —
  The error-leak recon method used to recover those signatures with introspection
  disabled, plus its read-only-by-construction rules of engagement.
- **[graphql-capture/test-agents.md](graphql-capture/test-agents.md)** — Copy-paste agent
  prompts for independently re-verifying the hidden-mutation signatures against the live
  endpoint. Probe-only, fake IDs, safe to run in parallel.

## `reference/`

- **[reference/firestore-write-schema.md](reference/firestore-write-schema.md)** —
  Archived reference for the direct-to-Firestore write path, retired around April 2026
  when Copilot deployed server-side type checking and writes moved to GraphQL. Preserves
  document-shape knowledge that lived in the since-deleted client code; `src/models/`
  remains authoritative for entity shapes.

## `superpowers/` — plans and specs (gitignored going forward)

Per-feature design specs and their implementation plans. `docs/superpowers/` is listed in
`.gitignore`; the files tracked here predate that rule and are PII-clean. **Do not add new
files under this tree to the index** — new plans stay local.

- **[superpowers/specs/](superpowers/specs/)** — 11 design specs: investment holdings
  tools, full decode coverage, Firestore write operations, the missing-tools audit,
  consolidating transaction setters into `update_transaction`, finance skills & agents,
  the CI `workflow_call` refactor, GraphQL capture, the GraphQL write-tool rewrite,
  license hygiene, and GraphQL live reads.
- **[superpowers/plans/](superpowers/plans/)** — 12 step-by-step implementation plans for
  those specs, plus the finance-skills foundation and `/finance-pulse`.

## `archive/` — superseded documents

- **[archive/REVIEW_AUDIT_PLAN.md](archive/REVIEW_AUDIT_PLAN.md)** — Historical. A
  2026-01-13 audit of unaddressed code-review suggestions across PRs #1–#48. Every item
  has since been resolved or closed; kept for reference, not as a work list.

## Site assets (GitHub Pages)

- **`index.html`** — The project landing page served at
  `ignaciohermosillacornejo.github.io/copilot-money-mcp/`.
- **`icon.png`** — Favicon, Apple touch icon, and Open Graph image for that page.
- **`demos/spending.mp4`** — Screen-capture demo of a spending query, embedded in
  `index.html`.

## Quick links

- [Main README](../README.md) — Project overview and quick start
- [CLAUDE.md](../CLAUDE.md) — Agent-facing repo guide (symlinked as `AGENTS.md` and `GEMINI.md`)
- [CONTRIBUTING](../CONTRIBUTING.md) — How to contribute
- [CHANGELOG](../CHANGELOG.md) — Version history
- [PRIVACY](../PRIVACY.md) — Privacy policy
- [SECURITY](../SECURITY.md) — Security policy and vulnerability reporting
