# EditRecurring

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 9

## Query

```graphql
mutation EditRecurring($id: ID!, $input: EditRecurringInput!) {
  editRecurring(id: $id, input: $input) {
  recurring {
  ...RecurringFields
  rule {
  ...RecurringRuleFields
}
  payments {
  ...RecurringPaymentFields
}
  category @client {
  ...CategoryFields
}
}
}
}

fragment RecurringFields on Recurring {
  nextPaymentAmount
  nextPaymentDate
  categoryId
  frequency
  emoji
  icon {
  ... on EmojiUnicode {
  unicode
}
  ... on Genmoji {
  id
  src
}
}
  state
  name
  id
}

fragment RecurringRuleFields on RecurringRule {
  nameContains
  minAmount
  maxAmount
  days
}

fragment RecurringPaymentFields on RecurringPayment {
  amount
  isPaid
  date
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
| input | object | true | `{"state":"PAUSED"}` |
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"EditRecurring","query":"mutation EditRecurring($id: ID!, $input: EditRecurringInput!) {\n  editRecurring(id: $id, input: $input) {\n  recurring {\n  ...RecurringFields\n  rule {\n  ...RecurringRuleFields\n}\n  payments {\n  ...RecurringPaymentFields\n}\n  category @client {\n  ...CategoryFields\n}\n}\n}\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n  ... on EmojiUnicode {\n  unicode\n}\n  ... on Genmoji {\n  id\n  src\n}\n}\n  state\n  name\n  id\n}\n\nfragment RecurringRuleFields on RecurringRule {\n  nameContains\n  minAmount\n  maxAmount\n  days\n}\n\nfragment RecurringPaymentFields on RecurringPayment {\n  amount\n  isPaid\n  date\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n  ... on EmojiUnicode {\n  unicode\n}\n  ... on Genmoji {\n  id\n  src\n}\n}\n  name\n  id\n}","variables":{"input":{"state":"PAUSED"},"id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "editRecurring": {
      "__typename": "EditRecurringOutput",
      "recurring": {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [
          {
            "__typename": "RecurringPayment",
            "amount": "<amount>",
            "isPaid": "<amount>",
            "date": "2026-04-05"
          }
        ],
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
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-05",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "✍️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "✍️"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      }
    }
  }
}
```
