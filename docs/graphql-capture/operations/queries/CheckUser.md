# CheckUser

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 29

## Query

```graphql
query CheckUser {
  userExists
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"CheckUser","query":"query CheckUser {\n  userExists\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "userExists": true
  }
}
```
