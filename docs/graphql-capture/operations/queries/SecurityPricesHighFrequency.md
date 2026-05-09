# SecurityPricesHighFrequency

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Tapping a security on /investments and clicking 1D or 1W on the chart (intraday / short-range price data).
- **Observations:** 1

## Query

```graphql
query SecurityPricesHighFrequency($id: ID!, $timeFrame: TimeFrame) {
  securityPricesHighFrequency(securityId: $id, timeFrame: $timeFrame) {
    timestamp
    price
    id
    __typename
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | ID! | true | `"<id>"` |
| timeFrame | TimeFrame | false | `"ONE_DAY"` |

Observed `timeFrame` values: `ONE_DAY`, `ONE_WEEK`.

## Example request

```json
{"operationName":"SecurityPricesHighFrequency","query":"query SecurityPricesHighFrequency($id: ID!, $timeFrame: TimeFrame) {\n  securityPricesHighFrequency(securityId: $id, timeFrame: $timeFrame) {\n    timestamp\n    price\n    id\n    __typename\n  }\n}","variables":{"id":"<id>","timeFrame":"ONE_DAY"}}
```

## Example response

```json
{
  "data": {
    "securityPricesHighFrequency": [
      {
        "__typename": "SecurityPrice",
        "id": "<id>",
        "timestamp": "<epoch-ms>",
        "price": "<amount>"
      },
      {
        "__typename": "SecurityPrice",
        "id": "<id>",
        "timestamp": "<epoch-ms>",
        "price": "<amount>"
      }
    ]
  }
}
```
