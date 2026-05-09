# SecurityPrices

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Tapping a security and clicking 1M / 3M / YTD / 1Y / ALL on the chart (longer ranges, daily granularity).
- **Observations:** 1

## Query

```graphql
query SecurityPrices($id: ID!, $timeFrame: TimeFrame) {
  securityPrices(securityId: $id, timeFrame: $timeFrame) {
    price
    date
    id
    __typename
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | ID! | true | `"<id>"` |
| timeFrame | TimeFrame | false | `"ONE_MONTH"` |

Observed `timeFrame` values: `ONE_MONTH`, `THREE_MONTHS`, `YTD`, `ONE_YEAR`, `ALL`.

## Example request

```json
{"operationName":"SecurityPrices","query":"query SecurityPrices($id: ID!, $timeFrame: TimeFrame) {\n  securityPrices(securityId: $id, timeFrame: $timeFrame) {\n    price\n    date\n    id\n    __typename\n  }\n}","variables":{"id":"<id>","timeFrame":"ONE_MONTH"}}
```

## Example response

```json
{
  "data": {
    "securityPrices": [
      {
        "__typename": "SecurityPrice",
        "id": "<id>",
        "date": "<YYYY-MM-DD>",
        "price": "<amount>"
      },
      {
        "__typename": "SecurityPrice",
        "id": "<id>",
        "date": "<YYYY-MM-DD>",
        "price": "<amount>"
      }
    ]
  }
}
```
