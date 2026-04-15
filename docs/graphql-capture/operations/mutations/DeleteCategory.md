# DeleteCategory

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 3

## Query

```graphql
mutation DeleteCategory($id: ID!) {
  deleteCategory(id: $id)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"DeleteCategory","query":"mutation DeleteCategory($id: ID!) {\n  deleteCategory(id: $id)\n}","variables":{"id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "deleteCategory": true
  }
}
```
