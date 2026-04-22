# DeleteTransaction

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** (synthetic — not captured from real traffic; signature confirmed via live-endpoint probe. The web capture never observed this mutation; it surfaced via error-leak recon as documented in hidden-mutations.md. Intended use: user deletes a transaction from the Copilot Money web or iOS app.)
- **Observations:** synthetic (signature confirmed via live-endpoint probe — see hidden-mutations.md)

## Query

```graphql
mutation DeleteTransaction($itemId: ID!, $accountId: ID!, $id: ID!) {
  deleteTransaction(itemId: $itemId, accountId: $accountId, id: $id)
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| itemId | string | true | `"<id>"` |
| accountId | string | true | `"<id>"` |
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"DeleteTransaction","query":"mutation DeleteTransaction($itemId: ID!, $accountId: ID!, $id: ID!) {\n  deleteTransaction(itemId: $itemId, accountId: $accountId, id: $id)\n}","variables":{"itemId":"<id>","accountId":"<id>","id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "deleteTransaction": true
  }
}
```
