# Transaction

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 21

## Query

```graphql
query Transaction($itemId: ID!, $accountId: ID!, $id: ID!) {
  transaction(itemId: $itemId, accountId: $accountId, id: $id) {
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
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| accountId | string | true | `"<id>"` |
| itemId | string | true | `"<id>"` |
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"Transaction","query":"query Transaction($itemId: ID!, $accountId: ID!, $id: ID!) {\n  transaction(itemId: $itemId, accountId: $accountId, id: $id) {\n    ...TransactionFields\n    account @client {\n      ...AccountFields\n      __typename\n    }\n    category @client {\n      ...CategoryFields\n      __typename\n    }\n    recurring @client {\n      ...TransactionRecurringFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n  __typename\n}\n\nfragment GoalFields on Goal {\n  name\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  id\n  __typename\n}\n\nfragment TransactionFields on Transaction {\n  identifierId @client\n  suggestedCategoryIds\n  datetime @client\n  recurringId\n  categoryId\n  isReviewed\n  accountId\n  createdAt\n  isPending\n  tipAmount\n  userNotes\n  itemId\n  amount\n  date\n  name\n  type\n  id\n  tags {\n    ...TagFields\n    __typename\n  }\n  goal {\n    ...GoalFields\n    __typename\n  }\n  __typename\n}\n\nfragment AccountFields on Account {\n  isConcealable @client\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  identifierId @client\n  status @client\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}\n\nfragment TransactionRecurringFields on Recurring {\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}","variables":{"accountId":"<id>","itemId":"<id>","id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "transaction": {
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
  }
}
```
