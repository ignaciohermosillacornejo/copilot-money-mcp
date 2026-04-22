# AddTransactionToRecurring

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** (synthetic — not captured from real traffic; signature confirmed via live-endpoint probe. The web capture never observed this mutation; it surfaced via error-leak recon as documented in hidden-mutations.md. Intended use: user manually attaches an existing transaction to an existing recurring series from the Copilot Money web or iOS app — e.g. a rent charge that auto-detection missed.)
- **Observations:** synthetic (signature confirmed via live-endpoint probe — see hidden-mutations.md)

## Query

```graphql
mutation AddTransactionToRecurring($itemId: ID!, $accountId: ID!, $id: ID!, $input: AddTransactionToRecurringInput!) {
  addTransactionToRecurring(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
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
| itemId | string | true | `"<id>"` |
| accountId | string | true | `"<id>"` |
| id | string | true | `"<id>"` |
| input | object | true | `{"recurringId":"<id>"}` |

## Example request

```json
{"operationName":"AddTransactionToRecurring","query":"mutation AddTransactionToRecurring($itemId: ID!, $accountId: ID!, $id: ID!, $input: AddTransactionToRecurringInput!) {\n  addTransactionToRecurring(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {\n    transaction {\n      ...TransactionFields\n      category @client {\n        ...CategoryFields\n      }\n    }\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n}\n\nfragment GoalFields on Goal {\n  name\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  id\n}\n\nfragment TransactionFields on Transaction {\n  identifierId @client\n  suggestedCategoryIds\n  datetime @client\n  recurringId\n  categoryId\n  isReviewed\n  accountId\n  createdAt\n  isPending\n  tipAmount\n  userNotes\n  itemId\n  amount\n  date\n  name\n  type\n  id\n  tags {\n    ...TagFields\n  }\n  goal {\n    ...GoalFields\n  }\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  name\n  id\n}","variables":{"itemId":"<id>","accountId":"<id>","id":"<id>","input":{"recurringId":"<id>"}}}
```

## Example response

```json
{
  "data": {
    "addTransactionToRecurring": {
      "__typename": "AddTransactionToRecurringOutput",
      "transaction": {
        "__typename": "Transaction",
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Rent",
          "colorName": "OLIVE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🏠"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "identifierId": "<id>",
        "suggestedCategoryIds": [],
        "datetime": "2026-04-21T07:00:00.000Z",
        "recurringId": "<id>",
        "categoryId": "<id>",
        "isReviewed": false,
        "accountId": "<id>",
        "createdAt": 1777785600000,
        "isPending": false,
        "tipAmount": null,
        "userNotes": null,
        "itemId": "<id>",
        "amount": "<amount>",
        "date": "2026-04-21",
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
