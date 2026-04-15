# DeleteRecurring

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
mutation DeleteRecurring($deleteRecurringId: ID!) {
  deleteRecurring(id: $deleteRecurringId)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| deleteRecurringId | string | true | `"<id>"` |

## Example request

```json
{"operationName":"DeleteRecurring","query":"mutation DeleteRecurring($deleteRecurringId: ID!) {\n  deleteRecurring(id: $deleteRecurringId)\n}","variables":{"deleteRecurringId":"<id>"}}
```

## Example response

```json
{
  "data": {
    "deleteRecurring": true
  }
}
```
