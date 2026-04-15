# NetworthLiveBalance

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query NetworthLiveBalance {
  networthLiveBalance {
    ...NetworthFields
    __typename
  }
}

fragment NetworthFields on NetworthHistory {
  total @client
  assets
  date
  debt
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"NetworthLiveBalance","query":"query NetworthLiveBalance {\n  networthLiveBalance {\n    ...NetworthFields\n    __typename\n  }\n}\n\nfragment NetworthFields on NetworthHistory {\n  total @client\n  assets\n  date\n  debt\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "networthLiveBalance": {
      "__typename": "NetworthHistory",
      "total": "<amount>",
      "assets": "<amount>",
      "date": "live",
      "debt": "<amount>"
    }
  }
}
```
