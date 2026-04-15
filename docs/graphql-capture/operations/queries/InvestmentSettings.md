# InvestmentSettings

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 4

## Query

```graphql
query InvestmentSettings {
  settings: user {
    id
    investmentConfig {
      excludedAccounts {
        id
        itemId
        __typename
      }
      benchmarkHoldingId
      liveBalance
      __typename
    }
    __typename
  }
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"InvestmentSettings","query":"query InvestmentSettings {\n  settings: user {\n    id\n    investmentConfig {\n      excludedAccounts {\n        id\n        itemId\n        __typename\n      }\n      benchmarkHoldingId\n      liveBalance\n      __typename\n    }\n    __typename\n  }\n}","variables":{}}
```

## Example response

```json
{}
```
