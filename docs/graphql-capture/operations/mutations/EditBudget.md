# EditBudget

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 5

## Query

```graphql
mutation EditBudget($categoryId: ID!, $input: EditCategoryBudgetInput!) {
  editCategoryBudget(categoryId: $categoryId, input: $input)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| categoryId | string | true | `"<id>"` |
| input | object | true | `{"amount":"<amount>"}` |

## Example request

```json
{"operationName":"EditBudget","query":"mutation EditBudget($categoryId: ID!, $input: EditCategoryBudgetInput!) {\n  editCategoryBudget(categoryId: $categoryId, input: $input)\n}","variables":{"categoryId":"<id>","input":{"amount":"<amount>"}}}
```

## Example response

```json
{
  "data": {
    "editCategoryBudget": true
  }
}
```
