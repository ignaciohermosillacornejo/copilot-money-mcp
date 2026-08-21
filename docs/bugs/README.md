# Bug post-mortems

A public knowledge base of bugs this project has shipped, organized by **class**.

The point is not to catalogue mistakes. It is to answer three questions that are hard to
answer from a changelog:

1. **Which failure modes recur here?** A single bug is an accident; the third instance of
   the same class is a design problem.
2. **Which detection mechanisms actually pay?** Every entry records *how the bug surfaced*.
   Over time that field is the honest scoreboard for our tests, reviews, and audits — and
   it is uncomfortable reading, because a lot of real bugs were found by someone happening
   to look rather than by anything we built.
3. **Does this class have a detector yet?** Entries say plainly when the answer is no.

This complements the [Bug Response Ritual](../../CONTRIBUTING.md#bug-response-ritual),
which governs the PR. The ritual asks the right questions at fix time; this directory is
where the answers accumulate so patterns become visible across bugs.

## Adding an entry

Every bug-fix PR that fixes a **user-visible wrong behaviour** gets one. Copy
[`TEMPLATE.md`](TEMPLATE.md) to `<number>-<kebab-slug>.md` and fill it in — the number is
the issue if there is one, otherwise the PR.

Skip entries for chores, refactors, dependency bumps, docs, and new features. A missing
guard that let bad data through **does** count. Bugs too small to justify a post-mortem —
CI plumbing, packaging, latent defects fixed before anyone hit them — go as one-line rows
in [`MINOR.md`](MINOR.md) instead.

**Known gap in the seeded entries:** the template asks for a `## Why the tests didn't
catch it` section, and only [#622](622-investment-prices-nested-layout.md) has one. The 42
historical entries were reconstructed from diffs and PR bodies, which rarely record why a
defence was blind — inferring it after the fact would have produced plausible fiction, and
this corpus is only worth keeping if every claim in it is substantiated. New entries are
written at fix time, when the answer is actually known, so they should include it.

**No PII.** This project handles personal financial data. Never put real balances,
amounts, account names, institution names, or ticker symbols in an entry — use
placeholders (`$X`, "an account", "a security"). Synthetic numbers are fine. See the
scrubbing rules in [`CLAUDE.md`](../../CLAUDE.md).

Two things make an entry worth writing rather than performative:

- **Be honest in `Detector`.** "none — instance-only regression test" is a valuable
  answer. An invented detector is worse than an absent one, because it stops anyone
  looking again.
- **Be honest in `How it was detected`.** If nothing caught it and someone got lucky, that
  is the finding.

## Bug classes

Grouped by where in the system the mistake lives. A class needs a definition sharp enough
to decide whether a future bug belongs to it — if you can't write that sentence, it isn't
a class yet.

### Decoding the local cache

| Class | Definition | Detector |
|---|---|---|
| `fixture-reality-drift` | A fixture encodes an assumed external-data shape that reality does not have, so the fixture and the code share an error term and their agreement proves nothing. Signature: **fixing the bug makes the tests fail.** | `tests/core/decode-path-parity.test.ts` — partial: catches two decoders of one collection disagreeing, not a collection that is simply extinct |
| `heuristic-decode-bleed` | Parsing structured binary by pattern-scanning fixed byte windows rather than walking the real format. Symptoms: fields bleeding between adjacent records, records silently missing. | retired architecturally by the structural parser (#73/#74) |
| `numeric-width-overflow` | Decoding uses a narrower numeric representation than the wire format, silently corrupting values into other plausible numbers. | none |
| `stale-cache-semantics` | Wrong assumptions about soft-delete vs tombstones, refresh, invalidation, or staleness windows. | none — closed structurally (live-first resolution), not by a gate |
| `absence-inference` | Concluding a field or collection is structurally absent because one snapshot didn't exercise it, then pruning schema or removing a capability on that basis. | none |

### Talking to Copilot's API

| Class | Definition | Detector |
|---|---|---|
| `external-api-drift` | An assumption about Copilot's API — an enum value, an input field, an operation signature — was wrong when written, or became wrong. | conformance ledger + Tier-1 smokes (`bun run smoke`); see [`CONFORMANCE_ARCHITECTURE.md`](../CONFORMANCE_ARCHITECTURE.md) |
| `wire-type-drift` | The API or the cache holds a value the schema cannot represent — a number where a string was expected, a null where non-null was assumed, an IEEE-754 `NaN`/`±Infinity` where JSON has no such value. | runtime warn-mode validation on all read shapes; non-finite leaves are stripped at the decode boundary instead of costing the document (#659), and `smoke:cache` reports any that exist in the real cache |
| `referential-integrity-gap` | A write accepts ids without existence checks, producing silent no-ops or dangling references. | none — client-side validation on bulk writes only. No full entry yet; instance in [`MINOR.md`](MINOR.md) (#213), and Copilot's own `bulkEditTransactions` has the same gap server-side |
| `ambiguous-candidate-selection` | Committing to one candidate from a noisy source before the only authority that can validate it runs, with no fallback; the benign rejection is then misreported as a system error. | none |

### Computing the answer

| Class | Definition | Detector |
|---|---|---|
| `identity-resolution` | Comparing values across id spaces — matching a display name against an id, or an id belonging to a different entity. | `assertOpaqueIds` fixture invariant (#461) |
| `aggregation-double-count` | Summing across a parent/child hierarchy without excluding parents, so the same money is counted twice. | none |
| `sign-convention` | Ignoring the domain's sign/direction convention, so the stored sign is not the semantic sign and naive sums are wrong. | none |
| `ui-parity` | A reimplementation of an app-side computation uses different semantics — time window, enumeration set, exclusion rules — and disagrees with the Copilot app. | none |
| `config-blind-default` | Hardcoding a parameter the vendor's own client derives from live user configuration; silently wrong for everyone whose config differs from the guess. | none |

### Our own machinery

| Class | Definition | Detector |
|---|---|---|
| `path-divergence` | Two code paths that must agree drift apart silently, and which one runs depends on incidental state such as load order. | `decode-path-parity` (decode paths), `check:tool-counts`, `check:version-sync`, scripts typecheck |
| `vacuous-assertion` | A test executes a guard but would still pass if the guard were deleted. Coverage cannot detect this; only mutation can. | none — proposed registry in [#596](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues/596) |
| `silent-failure-masking` | An error-handling construct — `continue-on-error`, catch-and-return-null, an allow-list drop — turns a real failure into a green signal, so it surfaces late or never. | none |
| `doc-reality-drift` | Documentation asserts a verifiable property the code no longer has. Invisible to every behavioural gate, because nothing reads Markdown. | `check-privacy-endpoints`, `check:tool-counts` (per-property only) |
| `stale-kill-switch` | A temporary disablement outlives the condition it guarded and silently disables a restored feature. | none |
| `packaging-environment-mismatch` | The shipped artifact works in dev but fails in the target runtime — missing bundled deps, hardened-runtime constraints, GUI PATH. | `tests/integration/mcpb-bundle.test.ts` (extract-and-boot outside the repo) |
| `unsettled-promise` | An async operation has a completion path where neither resolve nor reject fires, hanging callers forever. | none |
| `deferred-cleanup-never-runs` | Releasing a resource is deferred to a timer or callback that only fires if the process outlives it — in a process that routinely exits first. The resource is acquired eagerly and released never, while every same-process test still observes correct bookkeeping. | none — instance-only; the class is a deployment property (does this process outlive its own timers?) that no static check here can evaluate |
| `unbounded-trusted-payload` | A budgeted or validated surface embeds a value whose size or shape is guaranteed only by convention, because the only writer it has met is well-behaved. The guarantee holds until something else writes the file. | partial — `tests/context-budget.test.ts` measures the populated branch against a maximal legitimate input, for this surface only; no sweep across budgeted responses that embed external files |
| `alarm-by-fallthrough` | A classifier recognizes a few signatures and routes *everything else* into its most alarming state, so any unmodelled failure is reported as the specific serious condition the detector exists to find. The inverse of `silent-failure-masking`: unknown becomes red rather than green, and the alarm stops correlating with the condition it names. | `tests/scripts/scheduled-smoke.test.ts` (mutation-verified): `fail` is reachable only when the output carries a drift-verdict marker, asserted over a corpus of every real non-drift failure mode |
| `overbroad-precondition-gate` | A precondition for one resource is checked at a shared chokepoint (dispatch, startup) for all requests, including those whose handling never uses the resource — so any configuration where the resource is legitimately absent is fully locked out. | registry-walk sweep in `tests/integration/live-reads.test.ts` (mutation-verified): every live tool and live-mode write must dispatch past the local-cache gate with the cache absent |

## How we find bugs

Recorded per entry, using a fixed vocabulary so the corpus stays countable. Here is what
this corpus actually says, across all 48 entries:

| Found by | Count | |
|---|---|---|
| `dogfooding` — used the tool, noticed the answer disagreed with the Copilot app | 15 | █████████████ |
| `live-probe` — a probe or smoke against the real backend | 7 | ██████ |
| `audit-sweep` — a deliberate cross-cutting audit | 7 | ██████ |
| `incidental` — found while working on something else | 7 | ██████ |
| `user-report` | 8 | ███████ |
| `adversarial-review` — a reviewer tried to refute a claim or mutation-tested a guard | 2 | █ |
| `detector-first` — a detector was built, and then found bugs | 1 | ▌ |
| `code-review` | 1 | ▌ |
| **`ci-gate`** — **a checked-in invariant failed** | **0** | |

**No bug in this corpus was first caught by a CI gate.** That is the single most useful
thing this directory says, and it is worth sitting with rather than explaining away.

The gates this project has built are real and they work — but they work by *preventing
recurrence* of a class already paid for in production. Only one entry (#537) records a
detector finding bugs that were not already known, and it did so because the detector was
built deliberately as a net rather than as a regression test.

Meanwhile the top three mechanisms — dogfooding, live probes, audit sweeps — are all
variations on **looking at real output**. The cheapest reliable habit this history
supports is: *call the thing against real data and read what comes back*, especially
before optimizing or refactoring it. [#622](622-investment-prices-nested-layout.md) was
found exactly that way, during what was supposed to be a performance task.

Two honest caveats. This is a young project, so `ci-gate: 0` partly reflects gates that
are younger than the bugs. And a gate that fires in CI before a merge often never becomes
an entry at all — the bug is fixed in the same PR and leaves no trace. So the true score
for CI is better than zero; it just isn't visible here, and that is itself a reason to
record near-misses.

## Index

### Decoding the local cache

**`fixture-reality-drift`** — 5

| | Bug | Found by | Date |
|---|---|---|---|
| #74 | [Decoder written against a synthetic fixture format that real Firestore never uses](74-synthetic-fixture-format-drift.md) | `incidental` | 2026-01-15 |
| #85 | [Sign convention "fixed" backwards — tests rewritten to encode the wrong convention, then flipped again](85-sign-convention-double-inversion.md) | `dogfooding` | 2026-01-17 |
| #355 | [total_liabilities came back 0 — lowercase literals compared against uppercase server enums](355-liability-enum-case-mismatch.md) | `audit-sweep` | 2026-05-04 |
| #622 | [get_investment_prices returned rows that named no security, mislabelled their type, and silently dropped 91% of documents](622-investment-prices-nested-layout.md) | `incidental` | 2026-08-05 |
| #624 | [Cache-mode get_accounts hides nothing — include_hidden filters against an extinct collection while the real flag is decoded and ignored](624-hidden-accounts-not-filtered.md) ⚠️ **open** | `audit-sweep` | 2026-08-05 |

**`heuristic-decode-bleed`** — 2

| | Bug | Found by | Date |
|---|---|---|---|
| #33 | [Goal name extracted from an adjacent LevelDB document](33-goal-name-adjacent-document-bleed.md) | `dogfooding` | 2026-01-13 |
| #72 | [Brokerage account silently missing because its document exceeded the decoder's scan window](72-brokerage-account-missing-scan-window.md) | `dogfooding` | 2026-01-14 |

**`numeric-width-overflow`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #83 | [64-bit varint decoding silently corrupted negative transaction amounts (32-bit bitwise overflow)](83-varint-32bit-overflow.md) | `dogfooding` | 2026-01-16 |

**`stale-cache-semantics`** — 6

| | Bug | Found by | Date |
|---|---|---|---|
| #82 | [Soft-deleted (merged) account still appeared in accounts and net worth](82-user-deleted-phantom-account.md) | `dogfooding` | 2026-01-16 |
| #122 | [Pending and posted versions of the same charge both counted — category totals doubled](122-pending-posted-double-count.md) | `user-report` | 2026-03-11 |
| #280 | [Deleted-budget tombstones surfaced as ghost rows — 58% of get_budgets output was garbage](280-budget-tombstones-ghost-rows.md) | `incidental` | 2026-04-15 |
| #326 | [Deleted transactions kept appearing in reads — Copilot soft-deletes, decoder never filtered](326-soft-deleted-transactions-leak.md) | `live-probe` | 2026-05-03 |
| #498 | [Write tools could only edit transactions inside the ~30-day local cache window, despite docs promising otherwise](498-write-resolution-cache-window.md) | `user-report` | 2026-06-19 |
| #528 | [Live caches kept serving the previous account's data after a mid-session re-auth as a different user](528-uid-transition-stale-live-caches.md) | `adversarial-review` | 2026-07-08 |

**`absence-inference`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #387 | [get_investment_splits removed on the belief the cache was always empty — it wasn't](387-splits-absence-inference.md) | `incidental` | 2026-05-12 |


### Talking to Copilot's API

**`external-api-drift`** — 9

| | Bug | Found by | Date |
|---|---|---|---|
| #89 | [Goal history parsed against an invented schema; goal progress wrong](89-goal-history-shape-assumption.md) | `dogfooding` | 2026-01-18 |
| #224 | [Tag filter searched for #hashtags in transaction names; real tags live in tag_ids](224-tag-filter-searched-name-hashtags.md) | `live-probe` | 2026-04-13 |
| #232 | [create_category wrote category documents the Copilot app doesn't recognize](232-create-category-invisible-to-app.md) | `dogfooding` | 2026-04-13 |
| #238 | [get_categories was built around the Plaid taxonomy; the app only uses user categories](238-get-categories-plaid-taxonomy.md) | `incidental` | 2026-04-13 |
| #266 | [Copilot restricted direct Firestore writes; all 18 write tools broke with 403](266-firestore-writes-permission-denied.md) | `live-probe` | 2026-04-15 |
| #278 | [get_budgets read the legacy top-level amount field the app abandoned years ago](278-budgets-read-stale-amount-field.md) | `live-probe` | 2026-04-15 |
| #288 | [setRecurringState threw on rule-less recurrings — server applied the change, client reported failure](288-editrecurring-nonnullable-response-throw.md) | `live-probe` | 2026-04-16 |
| #419 | [create_recurring rejected 5 valid cadences and accepted invalid YEARLY, blaming the server](419-create-recurring-frequency-enum.md) | `live-probe` | 2026-06-08 |
| #495 | [get_networth_live advertised time_frame values that the server rejects with a hard 400](495-networth-timeframe-enum-drift.md) | `dogfooding` | 2026-06-15 |

**`wire-type-drift`** — 3

| | Bug | Found by | Date |
|---|---|---|---|
| #302 | [Null vested_* fields in holdings made Zod throw, silently dropping whole accounts](302-null-vested-fields-drop-accounts.md) | `dogfooding` | 2026-04-18 |
| #537 | [Read-query interfaces systematically declared the wrong wire types (string amounts that are numbers, non-null prices that are null)](537-read-shape-string-number-drift.md) | `detector-first` | 2026-07-18 |
| #659 | [An Infinity price in the cache silently removed a whole investment account and 18 months of holdings history](659-non-finite-price-drops-documents.md) | `user-report` | 2026-08-21 |

**`ambiguous-candidate-selection`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #478 | [Logged-out users got a raw PROJECT_NUMBER_MISMATCH error because the token extractor picked up other sites' Firebase tokens](478-foreign-token-project-mismatch.md) | `incidental` | 2026-06-13 |


### Computing the answer

**`identity-resolution`** — 3

| | Bug | Found by | Date |
|---|---|---|---|
| #69 | [User-defined category IDs displayed as raw Firestore IDs instead of names](69-category-id-leaks-as-name.md) | `dogfooding` | 2026-01-14 |
| #122 | [Content-based dedup key silently dropped real transactions](122-dedup-drops-real-transactions.md) | `user-report` | 2026-03-11 |
| #394 | [Cache-mode tag filter compared tag names against opaque tag IDs — always zero results](394-tag-filter-name-vs-id.md) | `dogfooding` | 2026-05-12 |

**`aggregation-double-count`** — 2

| | Bug | Found by | Date |
|---|---|---|---|
| #315 | [Split transactions returned parent AND children, doubling spend totals](315-split-parent-double-count.md) | `dogfooding` | 2026-04-21 |
| #363 | [total_budgeted double-counted child categories — parent.amount already includes them](363-budget-total-double-count.md) | `audit-sweep` | 2026-05-04 |

**`sign-convention`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #151 | [getAccounts total balance added debt instead of subtracting it](151-total-balance-adds-debt.md) | `dogfooding` | 2026-03-30 |

**`ui-parity`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #92 | [get_categories aggregated all-time totals while the app shows per-month — 2-4x discrepancies](92-categories-all-time-vs-ui-month.md) | `dogfooding` | 2026-01-18 |

**`config-blind-default`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #362 | [Categories query hardcoded rollovers:false, zeroing rollover amounts for rollover users](362-hardcoded-rollovers-false.md) | `audit-sweep` | 2026-05-04 |


### Our own machinery

**`path-divergence`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #530 | [The live conformance smoke crashed on startup for a month — scripts/ silently drifted from a src/ contract change](530-scripts-drift-smoke-gate-crash.md) | `live-probe` | 2026-07-11 |

**`vacuous-assertion`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #596 | [Two tests in the bulk-edit PR executed safety guards but could not fail if the guards were deleted](596-vacuous-assertions-bulk-edit.md) | `adversarial-review` | 2026-08-02 |

**`silent-failure-masking`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #398 | [MCP registry publish failed with HTTP 422 but the release workflow ran green](398-registry-publish-masked-failure.md) | `audit-sweep` | 2026-05-13 |

**`doc-reality-drift`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #594 | [PRIVACY.md described network destinations and modes the code no longer had — including calling a network-bearing mode offline](594-privacy-doc-endpoint-drift.md) | `audit-sweep` | 2026-08-03 |

**`stale-kill-switch`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #294 | [--write parsed but hardwired to false — the 2.0.0 headline feature was a no-op in the CLI](294-write-flag-hardwired-off.md) | `audit-sweep` | 2026-04-16 |

**`packaging-environment-mismatch`** — 2

| | Bug | Found by | Date |
|---|---|---|---|
| #251 | [Shipped .mcpb bundle omitted a runtime dependency; two releases dead on install](251-mcpb-bundle-missing-deps.md) | `user-report` | 2026-04-14 |
| #270 | [Claude Desktop launched the server in an Electron UtilityProcess that rejects the native module](270-claude-desktop-utilityprocess-dlopen.md) | `user-report` | 2026-04-15 |

**`unsettled-promise`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #129 | [Decode-worker promise hangs forever if the worker exits without sending a result](129-worker-exit-promise-hang.md) | `code-review` | 2026-03-12 |

**`deferred-cleanup-never-runs`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #631 | [Every LevelDB read left its ~120 MB temp copy on disk — 366 stale directories (~33 GB) filled a user's disk](631-temp-copy-deferred-cleanup.md) | `user-report` | 2026-08-12 |
**`unbounded-trusted-payload`** — 1

- [#638 — a context-budget assertion counted bytes it did not own](638-unbounded-trusted-payload-in-budgeted-response.md)

**`overbroad-precondition-gate`** — 1

| | Bug | Found by | Date |
|---|---|---|---|
| #640 | [Every tool call — including pure-GraphQL live tools — blocked on machines without the native app's local cache](640-live-tools-blocked-by-cache-gate.md) | `user-report` | 2026-08-15 |

