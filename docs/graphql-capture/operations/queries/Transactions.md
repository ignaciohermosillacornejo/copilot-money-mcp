# Transactions

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 4

## Query

```graphql
query Transactions($first: Int, $after: String, $last: Int, $before: String, $filter: TransactionFilter, $sort: [TransactionSort!]) {
  transactions(first: $first, after: $after, last: $last, before: $before, filter: $filter, sort: $sort) {
    ...TransactionPaginationFields
    __typename
  }
}

fragment TagFields on Tag {
  colorName
  name
  id
  __typename
}

fragment GoalFields on Goal {
  name
  icon {
    ... on EmojiUnicode {
      unicode
      __typename
    }
    ... on Genmoji {
      id
      src
      __typename
    }
    __typename
  }
  id
  __typename
}

fragment TransactionFields on Transaction {
  identifierId @client
  suggestedCategoryIds
  datetime @client
  recurringId
  parentId
  isoCurrencyCode
  categoryId
  isReviewed
  accountId
  createdAt
  isPending
  tipAmount
  userNotes
  itemId
  amount
  date
  name
  type
  id
  tags {
    ...TagFields
    __typename
  }
  goal {
    ...GoalFields
    __typename
  }
  __typename
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

fragment CategoryFields on Category {
  isRolloverDisabled
  canBeDeleted
  isExcluded
  templateId
  colorName
  icon {
    ... on EmojiUnicode {
      unicode
      __typename
    }
    ... on Genmoji {
      id
      src
      __typename
    }
    __typename
  }
  name
  id
  __typename
}

fragment TransactionRecurringFields on Recurring {
  icon {
    ... on EmojiUnicode {
      unicode
      __typename
    }
    ... on Genmoji {
      id
      src
      __typename
    }
    __typename
  }
  name
  id
  __typename
}

fragment TransactionPaginationFields on TransactionPagination {
  edges {
    cursor
    node {
      ...TransactionFields
      account @client {
        ...AccountFields
        __typename
      }
      category @client {
        ...CategoryFields
        __typename
      }
      recurring @client {
        ...TransactionRecurringFields
        __typename
      }
      __typename
    }
    __typename
  }
  pageInfo {
    endCursor
    hasNextPage
    hasPreviousPage
    startCursor
    __typename
  }
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| filter | object | true | `{"isReviewed":false}` |
| first | number | false | `20` |

## Example request

```json
{"operationName":"Transactions","query":"query Transactions($first: Int, $after: String, $last: Int, $before: String, $filter: TransactionFilter, $sort: [TransactionSort!]) {\n  transactions(first: $first, after: $after, last: $last, before: $before, filter: $filter, sort: $sort) {\n    ...TransactionPaginationFields\n    __typename\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n  __typename\n}\n\nfragment GoalFields on Goal {\n  name\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  id\n  __typename\n}\n\nfragment TransactionFields on Transaction {\n  identifierId @client\n  suggestedCategoryIds\n  datetime @client\n  recurringId\n  categoryId\n  isReviewed\n  accountId\n  createdAt\n  isPending\n  tipAmount\n  userNotes\n  itemId\n  amount\n  date\n  name\n  type\n  id\n  tags {\n    ...TagFields\n    __typename\n  }\n  goal {\n    ...GoalFields\n    __typename\n  }\n  __typename\n}\n\nfragment AccountFields on Account {\n  isConcealable @client\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  identifierId @client\n  status @client\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}\n\nfragment TransactionRecurringFields on Recurring {\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}\n\nfragment TransactionPaginationFields on TransactionPagination {\n  edges {\n    cursor\n    node {\n      ...TransactionFields\n      account @client {\n        ...AccountFields\n        __typename\n      }\n      category @client {\n        ...CategoryFields\n        __typename\n      }\n      recurring @client {\n        ...TransactionRecurringFields\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  pageInfo {\n    endCursor\n    hasNextPage\n    hasPreviousPage\n    startCursor\n    __typename\n  }\n  __typename\n}","variables":{"filter":{"isReviewed":false}}}
```

## Example response

```json
{
  "data": {
    "transactions": {
      "__typename": "TransactionPagination",
      "edges": [
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Restaurants",
              "colorName": "PURPLE1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🍔"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-14T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776196390084,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-14",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Subscriptions",
              "colorName": "PINK1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "💳"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": {
              "__typename": "Recurring",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "📺"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-14T07:00:00.000Z",
            "recurringId": "<id>",
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776175551119,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-14",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Shopping",
              "colorName": "RED1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🛍"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776196390086,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": false,
              "isExcluded": false,
              "templateId": "Other",
              "colorName": "GRAY1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🤷‍♂️"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776175551122,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Healthcare",
              "colorName": "RED2",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "💊"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776138569990,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": false,
              "isExcluded": false,
              "templateId": "Other",
              "colorName": "GRAY1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🤷‍♂️"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776138569988,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Car",
              "colorName": "TEAL1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🚗"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776128066128,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776088485183,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-13T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776088485182,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-13",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": "Restaurants",
              "colorName": "PURPLE1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🍔"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-12T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776128066130,
            "isPending": true,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-12",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-12T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1776088485183,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-12",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-11T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775954732568,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-11",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "templateId": null,
              "colorName": "TEAL1",
              "icon": {
                "__typename": "EmojiUnicode",
                "unicode": "🅿️"
              },
              "name": "<name>",
              "id": "<id>"
            },
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [
              "<id>",
              "<id>"
            ],
            "datetime": "2026-04-09T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "<id>",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775780761750,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-09",
            "name": "<name>",
            "type": "REGULAR",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-08T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775752036595,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-08",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-08T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775740040316,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-08",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-08T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775652857414,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-08",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-07T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775565639103,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-07",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-07T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775565639101,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-07",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-06T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775606364616,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-06",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        },
        {
          "__typename": "TransactionEdge",
          "cursor": "<id>",
          "node": {
            "__typename": "Transaction",
            "account": {
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
            "category": null,
            "recurring": null,
            "identifierId": "<id>",
            "suggestedCategoryIds": [],
            "datetime": "2026-04-06T07:00:00.000Z",
            "recurringId": null,
            "categoryId": "",
            "isReviewed": false,
            "accountId": "<id>",
            "createdAt": 1775565639106,
            "isPending": false,
            "tipAmount": "<amount>",
            "userNotes": null,
            "itemId": "<id>",
            "amount": "<amount>",
            "date": "2026-04-06",
            "name": "<name>",
            "type": "INTERNAL_TRANSFER",
            "id": "<id>",
            "tags": [],
            "goal": null
          }
        }
      ],
      "pageInfo": {
        "__typename": "TransactionsPageInfo",
        "endCursor": "<id>",
        "hasNextPage": true,
        "hasPreviousPage": false,
        "startCursor": "<id>"
      }
    }
  }
}
```
