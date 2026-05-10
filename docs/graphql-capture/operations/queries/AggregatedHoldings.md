# AggregatedHoldings

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Investment overview chart time-range buttons (1W/1M/3M/YTD/1Y/ALL); also fires when entering an account-level holdings view.
- **Observations:** 1

## Query

```graphql
query AggregatedHoldings($timeFrame: TimeFrame, $filter: AggregatedHoldingsFilter, $accountId: ID, $itemId: ID) {
  aggregatedHoldings(
    timeFrame: $timeFrame
    filter: $filter
    accountId: $accountId
    itemId: $itemId
  ) {
    security {
      marketInfo { closeTime openTime __typename }
      lastUpdate
      symbol
      name
      type
      id
      __typename
    }
    change
    value
    __typename
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| timeFrame | TimeFrame | false | `"ONE_MONTH"` |
| filter | AggregatedHoldingsFilter | false | `[]` |
| accountId | ID | false | `"<id>"` |
| itemId | ID | false | `"<id>"` |

`TimeFrame` enum values observed: `ONE_DAY`, `ONE_WEEK`, `ONE_MONTH`, `THREE_MONTHS`, `YTD`, `ONE_YEAR`, `ALL`.

`AggregatedHoldingsFilter` is an array; concrete enum members are not yet enumerated from captures.

The inline security selection here omits `currentPrice` (which the `SecurityFields` fragment in `Holdings.md` / `TopMovers.md` does include). This matches the captured web traffic — the aggregated view renders `change` + `value` only and does not need the spot price. Future implementors should match the web app's selection here rather than reaching for `SecurityFields`.

## Example request

```json
{"operationName":"AggregatedHoldings","query":"query AggregatedHoldings($timeFrame: TimeFrame, $filter: AggregatedHoldingsFilter, $accountId: ID, $itemId: ID) {\n  aggregatedHoldings(\n    timeFrame: $timeFrame\n    filter: $filter\n    accountId: $accountId\n    itemId: $itemId\n  ) {\n    security {\n      marketInfo { closeTime openTime __typename }\n      lastUpdate\n      symbol\n      name\n      type\n      id\n      __typename\n    }\n    change\n    value\n    __typename\n  }\n}","variables":{"timeFrame":"ONE_MONTH"}}
```

## Example response

```json
{
  "data": {
    "aggregatedHoldings": [
      {
        "__typename": "AggregatedHolding",
        "change": "<amount>",
        "value": "<amount>",
        "security": {
          "__typename": "Security",
          "id": "<id>",
          "name": "<name>",
          "symbol": "<symbol>",
          "type": "EQUITY",
          "lastUpdate": "<timestamp>",
          "marketInfo": {
            "__typename": "MarketInfo",
            "closeTime": "<epoch-ms>",
            "openTime": "<epoch-ms>"
          }
        }
      }
    ]
  }
}
```
