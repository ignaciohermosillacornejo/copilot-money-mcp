# EditTransaction

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 14

## Query

```graphql
mutation EditTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: EditTransactionInput) {
  editTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    transaction {
      ...TransactionFields
      category @client {
        ...CategoryFields
      }
    }
  }
}

fragment TagFields on Tag {
  colorName
  name
  id
}

fragment GoalFields on Goal {
  name
  icon {
    ... on EmojiUnicode {
      unicode
    }
    ... on Genmoji {
      id
      src
    }
  }
  id
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
  }
  goal {
    ...GoalFields
  }
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
    }
    ... on Genmoji {
      id
      src
    }
  }
  name
  id
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| accountId | string | true | `"<id>"` |
| itemId | string | true | `"<id>"` |
| id | string | true | `"<id>"` |
| input | object | true | `{"categoryId":"<id>"}` |

## Example request

```json
{"operationName":"EditTransaction","query":"mutation EditTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: EditTransactionInput) {\n  editTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {\n    transaction {\n      ...TransactionFields\n      category @client {\n        ...CategoryFields\n      }\n    }\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n}\n\nfragment GoalFields on Goal {\n  name\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  id\n}\n\nfragment TransactionFields on Transaction {\n  identifierId @client\n  suggestedCategoryIds\n  datetime @client\n  recurringId\n  categoryId\n  isReviewed\n  accountId\n  createdAt\n  isPending\n  tipAmount\n  userNotes\n  itemId\n  amount\n  date\n  name\n  type\n  id\n  tags {\n    ...TagFields\n  }\n  goal {\n    ...GoalFields\n  }\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  name\n  id\n}","variables":{"accountId":"<id>","itemId":"<id>","id":"<id>","input":{"categoryId":"<id>"}}}
```

## Example response

```json
{
  "data": {
    "editTransaction": {
      "__typename": "EditTransactionOutput",
      "transaction": {
        "__typename": "Transaction",
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Clothing",
          "colorName": "RED1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👕"
          },
          "name": "<name>",
          "id": "<id>"
        },
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
    }
  }
}
```
