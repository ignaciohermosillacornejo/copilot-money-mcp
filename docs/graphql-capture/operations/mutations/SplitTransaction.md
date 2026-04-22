# SplitTransaction

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** (synthetic — not captured from real traffic; signature confirmed via live-endpoint probe. The web capture never observed this mutation because the web app's split UI doesn't emit it; it surfaced via error-leak recon as documented in hidden-mutations.md. Intended use: user splits a single parent transaction into multiple category-specific children — e.g. one "Hotel + Car + Meals" charge into three rows.)
- **Observations:** synthetic (signature confirmed via live-endpoint probe — see hidden-mutations.md)

## Query

```graphql
mutation SplitTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: [SplitTransactionInput!]!) {
  splitTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {
    parentTransaction {
      ...TransactionFields
      category @client {
        ...CategoryFields
      }
    }
    splitTransactions {
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
| input | array | true | `[{"name":"<name>","date":"2026-04-21","amount":"<amount>","categoryId":"<id>"}, ...]` |

`input` is `[SplitTransactionInput!]!` — one entry per child. Each entry requires exactly four fields (`name: String!`, `date: Date!`, `amount: Float!`, `categoryId: ID!`). Probes for optional per-split fields (`tagIds`, `notes`, `isReviewed`) all returned "not defined by type SplitTransactionInput" — follow-up metadata edits require per-child `editTransaction` calls.

## Example request

```json
{"operationName":"SplitTransaction","query":"mutation SplitTransaction($itemId: ID!, $accountId: ID!, $id: ID!, $input: [SplitTransactionInput!]!) {\n  splitTransaction(itemId: $itemId, accountId: $accountId, id: $id, input: $input) {\n    parentTransaction {\n      ...TransactionFields\n      category @client {\n        ...CategoryFields\n      }\n    }\n    splitTransactions {\n      ...TransactionFields\n      category @client {\n        ...CategoryFields\n      }\n    }\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n}\n\nfragment GoalFields on Goal {\n  name\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  id\n}\n\nfragment TransactionFields on Transaction {\n  identifierId @client\n  suggestedCategoryIds\n  datetime @client\n  recurringId\n  categoryId\n  isReviewed\n  accountId\n  createdAt\n  isPending\n  tipAmount\n  userNotes\n  itemId\n  amount\n  date\n  name\n  type\n  id\n  tags {\n    ...TagFields\n  }\n  goal {\n    ...GoalFields\n  }\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  name\n  id\n}","variables":{"itemId":"<id>","accountId":"<id>","id":"<id>","input":[{"name":"<name>","date":"2026-04-21","amount":"<amount>","categoryId":"<id>"},{"name":"<name>","date":"2026-04-21","amount":"<amount>","categoryId":"<id>"}]}}
```

## Example response

Post-split, the `parentTransaction` carries `category_id: ""` and an `old_category_id: <original>` in the Firestore doc, plus a `children_transaction_ids` array pointing at the new children. Each child carries `parent_transaction_id` back to the parent. The parent is hidden from Copilot's UI but not deleted — there is no reversal mutation (`unsplitTransaction`, `revertSplit`, `undoSplit` all probed and don't exist).

```json
{
  "data": {
    "splitTransaction": {
      "__typename": "SplitTransactionOutput",
      "parentTransaction": {
        "__typename": "Transaction",
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Travel",
          "colorName": "PURPLE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "✈️"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "identifierId": "<id>",
        "suggestedCategoryIds": [],
        "datetime": "2026-04-21T07:00:00.000Z",
        "recurringId": null,
        "categoryId": "",
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
        "id": "<parent-id>",
        "tags": [],
        "goal": null
      },
      "splitTransactions": [
        {
          "__typename": "Transaction",
          "category": {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Travel",
            "colorName": "PURPLE2",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🏨"
            },
            "name": "<name>",
            "id": "<id>"
          },
          "identifierId": "<id>",
          "suggestedCategoryIds": [],
          "datetime": "2026-04-21T07:00:00.000Z",
          "recurringId": null,
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
          "id": "<child-1-id>",
          "tags": [],
          "goal": null
        },
        {
          "__typename": "Transaction",
          "category": {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Travel",
            "colorName": "PURPLE2",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🚗"
            },
            "name": "<name>",
            "id": "<id>"
          },
          "identifierId": "<id>",
          "suggestedCategoryIds": [],
          "datetime": "2026-04-21T07:00:00.000Z",
          "recurringId": null,
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
          "id": "<child-2-id>",
          "tags": [],
          "goal": null
        }
      ]
    }
  }
}
```
