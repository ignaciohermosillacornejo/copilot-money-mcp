# AccountLiveBalance

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 18

## Query

```graphql
query AccountLiveBalance($itemId: ID!, $accountId: ID!) {
  accountLiveBalance(itemId: $itemId, accountId: $accountId) {
    ...BalanceFields
    __typename
  }
}

fragment BalanceFields on AccountBalanceHistory {
  balance
  date
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| itemId | string | true | `"<id>"` |
| accountId | string | true | `"<id>"` |
| timeFrame | string | true | `"ALL"` |

## Example request

```json
{"operationName":"AccountLiveBalance","query":"query AccountLiveBalance($itemId: ID!, $accountId: ID!) {\n  accountLiveBalance(itemId: $itemId, accountId: $accountId) {\n    ...BalanceFields\n    __typename\n  }\n}\n\nfragment BalanceFields on AccountBalanceHistory {\n  balance\n  date\n  __typename\n}","variables":{"itemId":"<id>","accountId":"<id>","timeFrame":"ALL"}}
```

## Example response

```json
{}
```
