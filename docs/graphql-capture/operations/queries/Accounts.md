# Accounts

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query Accounts($filter: AccountFilter, $accountLink: Boolean = false) {
  accounts(filter: $filter) {
    ...AccountFields
    accountLink @include(if: $accountLink) {
      type
      account {
        ...AccountFields
        __typename
      }
      __typename
    }
    __typename
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
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| accountLink | boolean | true | `false` |

## Example request

```json
{"operationName":"Accounts","query":"query Accounts($filter: AccountFilter, $accountLink: Boolean = false) {\n  accounts(filter: $filter) {\n    ...AccountFields\n    accountLink @include(if: $accountLink) {\n      type\n      account {\n        ...AccountFields\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment AccountFields on Account {\n  isConcealable @client\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  identifierId @client\n  status @client\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n  __typename\n}","variables":{"accountLink":false}}
```

## Example response

```json
{
  "data": {
    "accounts": [
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T00:54:26.701Z",
        "identifierId": "<id>",
        "status": "21 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#F10019",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T14:05:52.151Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#117ACA",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T19:53:10.884Z",
        "identifierId": "<id>",
        "status": "2 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#006fcf",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T14:05:52.151Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#117ACA",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T14:05:52.151Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#117ACA",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T00:54:26.701Z",
        "identifierId": "<id>",
        "status": "21 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#F10019",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T04:18:37.462Z",
        "identifierId": "<id>",
        "status": "18 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#D85917",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-01-19T00:24:51.848Z",
        "identifierId": "<id>",
        "status": "3 months ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "credit card",
        "itemId": "<id>",
        "limit": "<amount>",
        "color": "#117ACA",
        "name": "<name>",
        "type": "CREDIT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T14:05:52.151Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "checking",
        "itemId": "<id>",
        "limit": null,
        "color": "#117ACA",
        "name": "<name>",
        "type": "DEPOSITORY",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-13T13:39:28.361Z",
        "identifierId": "<id>",
        "status": "1 day ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "checking",
        "itemId": "<id>",
        "limit": null,
        "color": "#CD1409",
        "name": "<name>",
        "type": "DEPOSITORY",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": false,
        "latestBalanceUpdate": "2026-04-10T21:17:46.379Z",
        "identifierId": "<id>",
        "status": "Email forwarding",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": true,
        "balance": "<amount>",
        "subType": "venmo",
        "itemId": "<id>",
        "limit": null,
        "color": "#2962BF",
        "name": "<name>",
        "type": "DEPOSITORY",
        "mask": null,
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T20:11:36.531Z",
        "identifierId": "<id>",
        "status": "2 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "brokerage",
        "itemId": "<id>",
        "limit": null,
        "color": "#017DAE",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T13:35:08.832Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "401k",
        "itemId": "<id>",
        "limit": null,
        "color": "#608619",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T07:13:47.299Z",
        "identifierId": "<id>",
        "status": "15 hours ago",
        "hasLiveBalance": false,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "stock plan",
        "itemId": "<id>",
        "limit": null,
        "color": "#5627D8",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T13:35:08.832Z",
        "identifierId": "<id>",
        "status": "8 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "401k",
        "itemId": "<id>",
        "limit": null,
        "color": "#608619",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T07:13:47.299Z",
        "identifierId": "<id>",
        "status": "15 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "brokerage",
        "itemId": "<id>",
        "limit": null,
        "color": "#5627D8",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": "<account-id>",
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T20:11:36.531Z",
        "identifierId": "<id>",
        "status": "2 hours ago",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "stock plan",
        "itemId": "<id>",
        "limit": null,
        "color": "#017DAE",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": null,
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": true,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T20:11:36.531Z",
        "identifierId": "<id>",
        "status": "Hidden",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": true,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "stock plan",
        "itemId": "<id>",
        "limit": null,
        "color": "#017DAE",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": null,
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": true,
        "hasHistoricalUpdates": true,
        "latestBalanceUpdate": "2026-04-14T20:11:36.531Z",
        "identifierId": "<id>",
        "status": "Hidden",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": true,
        "isUserClosed": false,
        "liveBalance": true,
        "isManual": false,
        "balance": "<amount>",
        "subType": "stock plan",
        "itemId": "<id>",
        "limit": null,
        "color": "#017DAE",
        "name": "<name>",
        "type": "INVESTMENT",
        "mask": null,
        "id": "<id>"
      },
      {
        "__typename": "Account",
        "isConcealable": false,
        "hasHistoricalUpdates": false,
        "latestBalanceUpdate": null,
        "identifierId": "<id>",
        "status": "Manual account",
        "hasLiveBalance": true,
        "institutionId": "<account-id>",
        "isUserHidden": false,
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
        "id": "<id>"
      }
    ]
  }
}
```
