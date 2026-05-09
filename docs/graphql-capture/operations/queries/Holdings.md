# Holdings

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Initial page load of /investments
- **Observations:** 1

## Query

```graphql
query Holdings {
  holdings {
    security {
      ...SecurityFields
      __typename
    }
    metrics {
      averageCost
      totalReturn
      costBasis
      __typename
    }
    accountId
    quantity
    itemId
    id
    __typename
  }
}

fragment SecurityFields on Security {
  marketInfo { closeTime openTime __typename }
  currentPrice
  lastUpdate
  symbol
  name
  type
  id
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"Holdings","query":"query Holdings {\n  holdings {\n    security {\n      ...SecurityFields\n      __typename\n    }\n    metrics {\n      averageCost\n      totalReturn\n      costBasis\n      __typename\n    }\n    accountId\n    quantity\n    itemId\n    id\n    __typename\n  }\n}\n\nfragment SecurityFields on Security {\n  marketInfo { closeTime openTime __typename }\n  currentPrice\n  lastUpdate\n  symbol\n  name\n  type\n  id\n  __typename\n}","variables":{}}
```

## Example response

> Note: `metrics` is `null` for some holdings (e.g. CASH positions where average cost / cost basis / total return are not meaningful).

```json
{
  "data": {
    "holdings": [
      {
        "__typename": "Holding",
        "id": "<id>",
        "accountId": "<id>",
        "itemId": "<id>",
        "quantity": "<amount>",
        "security": {
          "__typename": "Security",
          "id": "<id>",
          "name": "<name>",
          "symbol": "<symbol>",
          "type": "EQUITY",
          "currentPrice": "<amount>",
          "lastUpdate": "<timestamp>",
          "marketInfo": {
            "__typename": "MarketInfo",
            "closeTime": "<epoch-ms>",
            "openTime": "<epoch-ms>"
          }
        },
        "metrics": {
          "__typename": "HoldingMetric",
          "averageCost": "<amount>",
          "costBasis": "<amount>",
          "totalReturn": "<amount>"
        }
      },
      {
        "__typename": "Holding",
        "id": "<id>",
        "accountId": "<id>",
        "itemId": "<id>",
        "quantity": "<amount>",
        "security": {
          "__typename": "Security",
          "id": "<id>",
          "name": "<name>",
          "symbol": "<symbol>",
          "type": "CASH",
          "currentPrice": "<amount>",
          "lastUpdate": "<timestamp>",
          "marketInfo": {
            "__typename": "MarketInfo",
            "closeTime": "<epoch-ms>",
            "openTime": "<epoch-ms>"
          }
        },
        "metrics": null
      }
    ]
  }
}
```
