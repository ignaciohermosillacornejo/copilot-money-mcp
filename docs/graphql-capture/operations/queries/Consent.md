# Consent

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query Consent {
  user {
    consent {
      transcendToken
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
{"operationName":"Consent","query":"query Consent {\n  user {\n    consent {\n      transcendToken\n      __typename\n    }\n    __typename\n  }\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "user": {
      "__typename": "User",
      "consent": null
    }
  }
}
```
