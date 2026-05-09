# Account

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Clicking into a single account from the accounts list.
- **Observations:** 1

## Query

```graphql
query Account($itemId: ID!, $id: ID!, $accountLink: Boolean = false) {
  account(itemId: $itemId, id: $id) {
    ...AccountFields
    accountLink @include(if: $accountLink) {
      type
      account { ...AccountFields __typename }
      __typename
    }
    __typename
  }
}

fragment AccountFields on Account {
  hasHistoricalUpdates
  latestBalanceUpdate
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
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| itemId | ID! | true | `"<id>"` |
| id | ID! | true | `"<id>"` |
| accountLink | Boolean | false | `true` |

## Example request

```json
{"operationName":"Account","query":"query Account($itemId: ID!, $id: ID!, $accountLink: Boolean = false) {\n  account(itemId: $itemId, id: $id) {\n    ...AccountFields\n    accountLink @include(if: $accountLink) {\n      type\n      account { ...AccountFields __typename }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment AccountFields on Account {\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n  __typename\n}","variables":{"accountLink":true,"itemId":"<id>","id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "account": {
      "__typename": "Account",
      "id": "<id>",
      "itemId": "<id>",
      "institutionId": "<id>",
      "name": "<name>",
      "mask": "<placeholder>",
      "type": "<placeholder>",
      "subType": "<placeholder>",
      "color": "<placeholder>",
      "balance": "<amount>",
      "liveBalance": "<amount>",
      "limit": null,
      "isManual": false,
      "isUserHidden": false,
      "isUserClosed": false,
      "hasHistoricalUpdates": true,
      "hasLiveBalance": true,
      "latestBalanceUpdate": "<timestamp>",
      "accountLink": null
    }
  }
}
```
