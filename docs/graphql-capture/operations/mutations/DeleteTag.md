# DeleteTag

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 5

## Query

```graphql
mutation DeleteTag($id: ID!) {
  deleteTag(id: $id)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"DeleteTag","query":"mutation DeleteTag($id: ID!) {\n  deleteTag(id: $id)\n}","variables":{"id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "deleteTag": true
  }
}
```
