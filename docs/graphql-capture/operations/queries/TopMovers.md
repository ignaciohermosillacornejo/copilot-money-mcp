# TopMovers

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Initial /investments page load (powers the "Your top movers" cards). Fires twice — once with `PRICE_CHANGE`, once with `MY_EQUITY_CHANGE`.
- **Observations:** 1

## Query

```graphql
query TopMovers($filter: TopMoversFilter) {
  topMovers(filter: $filter) {
    security { ...SecurityFields __typename }
    values { timestamp price id __typename }
    change
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

| Name | Type | Required | Example |
|------|------|----------|---------|
| filter | TopMoversFilter | false | `"PRICE_CHANGE"` |

Observed `filter` values: `PRICE_CHANGE`, `MY_EQUITY_CHANGE`.

## Example request

```json
{"operationName":"TopMovers","query":"query TopMovers($filter: TopMoversFilter) {\n  topMovers(filter: $filter) {\n    security { ...SecurityFields __typename }\n    values { timestamp price id __typename }\n    change\n    __typename\n  }\n}\n\nfragment SecurityFields on Security {\n  marketInfo { closeTime openTime __typename }\n  currentPrice\n  lastUpdate\n  symbol\n  name\n  type\n  id\n  __typename\n}","variables":{"filter":"PRICE_CHANGE"}}
```

## Example response

```json
{
  "data": {
    "topMovers": [
      {
        "__typename": "TopMover",
        "change": "<amount>",
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
        "values": [
          {
            "__typename": "SecurityPrice",
            "id": "<id>",
            "timestamp": "<epoch-ms>",
            "price": "<amount>"
          }
        ]
      }
    ]
  }
}
```
