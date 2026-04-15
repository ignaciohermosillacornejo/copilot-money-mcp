# EditBudgetMonthly

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 4

## Query

```graphql
mutation EditBudgetMonthly($categoryId: ID!, $input: [EditCategoryBudgetMonthlyInput!]!) {
  editCategoryBudgetMonthly(categoryId: $categoryId, input: $input)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| categoryId | string | true | `"<id>"` |
| input | array | true | `[{"amount":"<amount>","month":"2026-04"}]` |

## Example request

```json
{"operationName":"EditBudgetMonthly","query":"mutation EditBudgetMonthly($categoryId: ID!, $input: [EditCategoryBudgetMonthlyInput!]!) {\n  editCategoryBudgetMonthly(categoryId: $categoryId, input: $input)\n}","variables":{"categoryId":"<id>","input":[{"amount":"<amount>","month":"2026-04"}]}}
```

## Example response

```json
{
  "data": {
    "editCategoryBudgetMonthly": true
  }
}
```
