# BalanceHistory

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Clicking a time-range button (1W / 1M / 3M / YTD / 1Y / ALL) on an account detail page.
- **Observations:** 1

## Query

```graphql
query BalanceHistory($itemId: ID!, $accountId: ID!, $timeFrame: TimeFrame) {
  accountBalanceHistory(itemId: $itemId, accountId: $accountId, timeFrame: $timeFrame) {
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
| itemId | ID! | true | `"<id>"` |
| accountId | ID! | true | `"<id>"` |
| timeFrame | TimeFrame | false | `"ONE_MONTH"` |

## Example request

```json
{"operationName":"BalanceHistory","query":"query BalanceHistory($itemId: ID!, $accountId: ID!, $timeFrame: TimeFrame) {\n  accountBalanceHistory(itemId: $itemId, accountId: $accountId, timeFrame: $timeFrame) {\n    ...BalanceFields\n    __typename\n  }\n}\n\nfragment BalanceFields on AccountBalanceHistory {\n  balance\n  date\n  __typename\n}","variables":{"itemId":"<id>","accountId":"<id>","timeFrame":"ONE_MONTH"}}
```

## Example response

```json
{
  "data": {
    "accountBalanceHistory": [
      {
        "__typename": "AccountBalanceHistory",
        "date": "<YYYY-MM-DD>",
        "balance": "<amount>"
      },
      {
        "__typename": "AccountBalanceHistory",
        "date": "<YYYY-MM-DD>",
        "balance": "<amount>"
      }
    ]
  }
}
```
