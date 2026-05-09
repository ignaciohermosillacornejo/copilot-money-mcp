# InvestmentLiveBalance

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Initial /investments page load (live balance estimate dot on the chart).
- **Observations:** 1

## Query

```graphql
query InvestmentLiveBalance {
  investmentLiveBalance {
    id
    date
    balance
    __typename
  }
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"InvestmentLiveBalance","query":"query InvestmentLiveBalance {\n  investmentLiveBalance {\n    id\n    date\n    balance\n    __typename\n  }\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "investmentLiveBalance": {
      "__typename": "InvestmentBalance",
      "id": "<id>",
      "date": "<YYYY-MM-DD>",
      "balance": "<amount>"
    }
  }
}
```
