# Migrating to v3.0.0

v3 is a **response-shape release**. No tool was renamed, no tool was removed, no
filter changed meaning, and nothing about writes changed. What changed is how
much each read tool hands back when you don't ask for anything in particular.

If you are reading this because something broke, skip to
[Did something break?](#did-something-break).

## The one change behind almost all of it

Read tools used to return the **whole underlying record**. A transaction row
carried around 30 populated fields; an accounts row embedded the institution
logo as base64; a categories row embedded a full monthly budget series.

Most callers used a handful of those fields and paid for all of them, in an MCP
client's context window, on every row of every page.

In v3 each of those tools returns a **small default row**, and everything else
is one named request away:

```jsonc
// v2: the whole document, whether you wanted it or not
{ "period": "last_30_days" }

// v3: the same call returns the terse row
{ "period": "last_30_days" }

// v3: ask for what you actually need
{ "period": "last_30_days", "fields": ["default", "tag_ids", "user_note"] }

// v3: or take everything, exactly like v2 did
{ "period": "last_30_days", "fields": ["all"] }
```

`fields` accepts three special tokens alongside ordinary field names:

| Token | Means |
|---|---|
| `"default"` | the tool's terse preset — the tables below |
| `"all"` (or `"*"`) | the full record, i.e. v2 behaviour |
| *(omitted)* | same as `["default"]` |

A name that matches nothing is **not** silently ignored: it is dropped from the
rows and reported in a top-level `_field_warning` on the response. If you get
one, the name is either misspelled or belongs to the other mode — cache rows and
live rows do not carry identical field sets.

## Did something break?

| Symptom | Cause | Fix |
|---|---|---|
| A field you read is suddenly `undefined`, no error | That tool is terse by default and the field is not in its preset | Add it: `fields: ["default", "<the field>"]` |
| `` `compact` was removed in v3.0.0 `` | `compact` is gone from `get_transactions` and `get_transactions_live` | Passing `true`? Drop the argument. Passing `false`? Use `fields: ["all"]` |
| `` `include_logos` was removed in v3.0.0 `` | `include_logos` is gone from `get_accounts` | `fields: ["default", "logo", "logo_content_type"]` |
| `fields: []` used to return full rows, now returns the terse row | An empty selection now means the same as omitting `fields` | Use `fields: ["all"]` |
| `_field_warning` names a field you know exists | The name exists on the *other* mode, or is misspelled | Check the tables below for the mode you are running |
| `__typename` keys are gone from live responses | They are stripped from every response now | Nothing to do in almost every case. The one place it disambiguated anything was the icon union, and `{unicode}` vs `{id, src}` already tells those apart |
| Responses are no longer pretty-printed | Responses serialize compactly | Nothing to do — the JSON is identical, only whitespace changed |
| `get_investment_balance_live` returns ~30 history points | `history_limit` defaults to 30 | Pass `history_limit: 0` for the full series |
| `get_investment_prices` rows lost their `prices` map | Replaced by a derived `latest_price` / `latest_at` | `fields: ["default", "prices"]` |
| A `get_categories_live` row lost its `budget` object | Replaced by a derived `budget_amount` | `fields: ["default", "budget"]` |
| A recurring row lost `rule` or `payments` | Both dropped from the live default row | `fields: ["default", "rule", "payments"]` |

Two things that are **not** symptoms of this release:

- **Fewer keys than the preset names.** Cache rows carry only the fields the
  underlying document actually has, so an ordinary `get_transactions` row is 8
  keys, not 10 — `pending` and `internal_transfer` are absent when unset. An
  absent key is falsy, so boolean reads behave the same. Live rows have the
  mirror case: `category_name` is dropped for an uncategorized row, making it 9.
- **`excluded` being `true` on a row you never excluded by hand.** It answers
  "is this row excluded from spending?", which includes rows whose *category* is
  user-excluded.

## The terse defaults, tool by tool

Each table lists what you get when `fields` is omitted. Anything not listed is
still available by name.

<!-- BEGIN PRESET TABLE: pinned to the real presets by tests/docs/migration-guide.test.ts -->

| Tool | Default row |
|---|---|
| `get_transactions` | `transaction_id`, `date`, `amount`, `name`, `category_name`, `account_id`, `item_id`, `pending`, `excluded`, `internal_transfer` |
| `get_transactions_live` | `transaction_id`, `date`, `amount`, `name`, `category_name`, `account_id`, `item_id`, `pending`, `excluded`, `internal_transfer` |
| `get_accounts` | `account_id`, `name`, `account_type`, `subtype`, `current_balance`, `institution_name`, `iso_currency_code`, `item_id`, `user_hidden`, `user_deleted` |
| `get_accounts_live` | `id`, `name`, `type`, `subType`, `balance`, `institutionId`, `itemId`, `isUserHidden`, `isUserClosed` |
| `get_categories_live` | `id`, `parentId`, `name`, `colorName`, `isExcluded`, `budget_amount` |
| `get_recurring_transactions` | `merchant`, `normalized_merchant`, `occurrences`, `average_amount`, `total_amount`, `frequency`, `confidence`, `category_name`, `last_date`, `next_expected_date` |
| `get_recurring_live` | `id`, `name`, `state`, `frequency`, `nextPaymentAmount`, `nextPaymentDate`, `categoryId`, `category_name`, `emoji` |
| `get_upcoming_recurrings_live` | `id`, `name`, `state`, `frequency`, `nextPaymentAmount`, `nextPaymentDate`, `categoryId`, `category_name`, `emoji` |
| `get_investment_prices` | `security_id`, `ticker_symbol`, `price_type`, `date`, `month`, `latest_price`, `latest_at` |
| `get_top_movers_live` | `security_id`, `ticker_symbol`, `name`, `type`, `change` |

<!-- END PRESET TABLE -->

`get_investment_balance_live` is the one tool that did not get a preset: the
time series *is* its purpose, so excluding it would have made the tool useless.
Its `history` is **capped** instead — `history_limit`, default 30, `0` for the
whole series — and every response reports `history_total_count` and
`history_truncated` so you can tell what was left out. `current` is resolved
separately and can never be lost to truncation.

## Two arguments were removed

Both throw rather than being ignored, because an argument that is silently
dropped looks exactly like the field selection quietly changing underneath you.

| Removed | On | Replacement |
|---|---|---|
| `compact` | `get_transactions`, `get_transactions_live` | `compact: true` → drop it (the default is terser). `compact: false` → `fields: ["all"]` |
| `include_logos` | `get_accounts` only | `fields: ["default", "logo", "logo_content_type"]` |

**`get_accounts_live` is not part of the second row**, and asking it for a logo
does not work: the GraphQL account node has no logo under any name, so the live
row never carried one and `include_logos` was never one of its arguments. A
`fields: ["default", "logo"]` there returns the terse row plus a
`_field_warning` — the cache tool is the only place an institution logo exists.

Note the direction for `compact: false`. It used to mean "give me everything",
which is the one shape that omitting `fields` no longer produces — so that
caller is the one who has to change something.

## Other response-shape changes

- **`__typename` is stripped from every response.** Live tools carried a
  GraphQL type discriminator on each nested object. Requests are unchanged; the
  key is removed on the way out. The icon union is the only place it carried
  information, and its two shapes distinguish themselves without it.
- **Responses are serialized compactly.** Previously pretty-printed with
  two-space indentation. The JSON content is identical.
- **`get_investment_prices` (cache) rows were unusable before** and are fixed in
  this release, not merely dieted — the previous rows could not answer "what is
  this worth".
- **`history_limit` above 5,000 now clamps.** `get_investment_balance_live`
  inherited a shared pagination helper's hard cap where the old local code had
  no upper bound. `0` remains the unlimited escape hatch, so nothing that
  wanted the full series is affected.

## What did not change

- Tool names, and which tools exist in which mode.
- Every filter argument — dates, categories, accounts, amounts, text search,
  tags, location — and what they mean.
- All write tools, and the `--write` / `--live-reads` flags.
- Privacy posture: default-mode reads remain 100% local with zero network
  requests.
- `category_name` is still resolved to a human-readable name for you.

## If you maintain a skill or an agent prompt

Anything that reads a transaction, account, category, recurring or investment
field by name should pass an explicit `fields` list for that field, or read it
from the preset tables above. The skills shipped in this repo were updated
in the same release, and `bun run check:skills` cross-checks skill field
references against the real presets, so a skill that reads a dropped field fails
the linter instead of failing silently at use time.
