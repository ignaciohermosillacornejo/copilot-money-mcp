# TransactionSummary

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query TransactionSummary($filter: TransactionFilter) {
  transactionsSummary(filter: $filter) {
    transactionsCount
    totalNetIncome
    totalIncome
    totalSpent
    __typename
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| filter | object | true | `{"isReviewed":false}` |

## Example request

```json
{"operationName":"TransactionSummary","query":"query TransactionSummary($filter: TransactionFilter) {\n  transactionsSummary(filter: $filter) {\n    transactionsCount\n    totalNetIncome\n    totalIncome\n    totalSpent\n    __typename\n  }\n}","variables":{"filter":{"isReviewed":false}}}
```

## Example response

```json
{
  "data": {
    "transactionsSummary": {
      "__typename": "TransactionSummaryOutput",
      "transactionsCount": 113,
      "totalNetIncome": "<amount>",
      "totalIncome": "<amount>",
      "totalSpent": "<amount>"
    }
  }
}
```
