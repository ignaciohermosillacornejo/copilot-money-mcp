# EditAccount

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 8

## Query

```graphql
mutation EditAccount($itemId: ID!, $id: ID!, $input: EditAccountInput!) {
  editAccount(itemId: $itemId, id: $id, input: $input) {
    account {
      ...AccountFields
    }
  }
}

fragment AccountFields on Account {
  isConcealable @client
  hasHistoricalUpdates
  latestBalanceUpdate
  identifierId @client
  status @client
  hasLiveBalance
  institutionId
  isUserHidden
  isUserClosed
  liveBalance
  isManual
  balance
  subType
  itemId
  limit
  color
  name
  type
  mask
  id
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| input | object | true | `{"isUserHidden":true}` |
| itemId | string | true | `"<id>"` |
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"EditAccount","query":"mutation EditAccount($itemId: ID!, $id: ID!, $input: EditAccountInput!) {\n  editAccount(itemId: $itemId, id: $id, input: $input) {\n    account {\n      ...AccountFields\n    }\n  }\n}\n\nfragment AccountFields on Account {\n  isConcealable @client\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  identifierId @client\n  status @client\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n}","variables":{"input":{"isUserHidden":true},"itemId":"<id>","id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "editAccount": {
      "account": {
        "hasHistoricalUpdates": false,
        "latestBalanceUpdate": null,
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": true,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": true,
        "balance": "<amount>",
        "subType": "cash management",
        "itemId": "<id>",
        "limit": null,
        "color": "#02890BFF",
        "name": "<name>",
        "type": "OTHER",
        "mask": null,
        "id": "<id>",
        "__typename": "Account"
      },
      "__typename": "EditAccountOutput"
    }
  }
}
```
