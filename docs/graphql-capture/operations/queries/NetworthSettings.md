# NetworthSettings

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query NetworthSettings {
  settings: user {
    id
    networthConfig {
      combinesAssetsAndDebt
      excludedAccounts {
        id
        itemId
        __typename
      }
      isSingleLine
      __typename
    }
    investmentConfig {
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
{"operationName":"NetworthSettings","query":"query NetworthSettings {\n  settings: user {\n    id\n    networthConfig {\n      combinesAssetsAndDebt\n      excludedAccounts {\n        id\n        itemId\n        __typename\n      }\n      isSingleLine\n      __typename\n    }\n    investmentConfig {\n      liveBalance\n      __typename\n    }\n    __typename\n  }\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "settings": {
      "__typename": "User",
      "id": "<id>",
      "networthConfig": {
        "__typename": "NetworthConfig",
        "combinesAssetsAndDebt": false,
        "excludedAccounts": [],
        "isSingleLine": false
      },
      "investmentConfig": {
        "__typename": "InvestmentConfig",
        "liveBalance": true
      }
    }
  }
}
```
