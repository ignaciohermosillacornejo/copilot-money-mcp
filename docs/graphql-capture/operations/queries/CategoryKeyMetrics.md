# CategoryKeyMetrics

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** automatically after a bulk category change — the web app refetches key metrics for the affected category
- **Observations:** 1 (2026-07-31 Chrome capture, incidental to [`BulkEditTransactions`](../mutations/BulkEditTransactions.md))
- **Adopted:** ❌ not in `IN_SCOPE_QUERIES`

## Query

```graphql
query CategoryKeyMetrics($id: ID!) {
  category(id: $id) {
    id
    keyMetrics {
      averageMonthlySpent
      totalSpent
      year
    }
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | ID | true | `"<id>"` |

## Example request

```json
{"operationName":"CategoryKeyMetrics","query":"query CategoryKeyMetrics($id: ID!) {\n  category(id: $id) {\n    id\n    keyMetrics {\n      averageMonthlySpent\n      totalSpent\n      year\n      __typename\n    }\n    __typename\n  }\n}","variables":{"id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "category": {
      "__typename": "Category",
      "id": "<id>",
      "keyMetrics": [
        {
          "__typename": "CategoryKeyMetrics",
          "averageMonthlySpent": "<amount>",
          "totalSpent": "<amount>",
          "year": 2022
        }
      ]
    }
  }
}
```

## Notes

- `keyMetrics` is an **array**, one element per year (2022 observed; the full range was
  not recorded).
- `Query.category(id:)` — a single-category root query — was not previously documented.
  Our `get_categories_live` fetches the whole list via `Categories`.
- Potentially interesting for per-category spend history without summing transactions
  client-side, but the wire types of `averageMonthlySpent` / `totalSpent` were redacted
  in capture, and this repo has a documented history of Copilot returning numbers where
  a string was assumed. **Probe the wire types before writing a read schema against
  this.**
