# InvestmentBalance

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Investment overview chart initial load.
- **Observations:** 1

## Query

```graphql
query InvestmentBalance($timeFrame: TimeFrame) {
  investmentBalance(timeFrame: $timeFrame) {
    id
    date
    balance
    __typename
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| timeFrame | TimeFrame | false | `"ALL"` |

## Example request

```json
{"operationName":"InvestmentBalance","query":"query InvestmentBalance($timeFrame: TimeFrame) {\n  investmentBalance(timeFrame: $timeFrame) {\n    id\n    date\n    balance\n    __typename\n  }\n}","variables":{"timeFrame":"ALL"}}
```

## Example response

```json
{
  "data": {
    "investmentBalance": [
      {
        "__typename": "InvestmentBalance",
        "id": "<id>",
        "date": "<YYYY-MM-DD>",
        "balance": "<amount>"
      },
      {
        "__typename": "InvestmentBalance",
        "id": "<id>",
        "date": "<YYYY-MM-DD>",
        "balance": "<amount>"
      }
    ]
  }
}
```
