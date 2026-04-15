# Recurrings

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query Recurrings($filter: RecurringFilter) {
  recurrings(filter: $filter) {
    ...RecurringFields
    rule {
      ...RecurringRuleFields
      __typename
    }
    payments {
      ...RecurringPaymentFields
      __typename
    }
    category @client {
      ...CategoryFields
      __typename
    }
    __typename
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
      __typename
    }
    ... on Genmoji {
      id
      src
      __typename
    }
    __typename
  }
  state
  name
  id
  __typename
}

fragment RecurringRuleFields on RecurringRule {
  nameContains
  minAmount
  maxAmount
  days
  __typename
}

fragment RecurringPaymentFields on RecurringPayment {
  amount
  isPaid
  date
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
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"Recurrings","query":"query Recurrings($filter: RecurringFilter) {\n  recurrings(filter: $filter) {\n    ...RecurringFields\n    rule {\n      ...RecurringRuleFields\n      __typename\n    }\n    payments {\n      ...RecurringPaymentFields\n      __typename\n    }\n    category @client {\n      ...CategoryFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  state\n  name\n  id\n  __typename\n}\n\nfragment RecurringRuleFields on RecurringRule {\n  nameContains\n  minAmount\n  maxAmount\n  days\n  __typename\n}\n\nfragment RecurringPaymentFields on RecurringPayment {\n  amount\n  isPaid\n  date\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "recurrings": [
      {
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
            "isPaid": false,
            "date": "2026-04-25"
          }
        ],
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
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-25",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💊",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💊"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-01-19"
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
        "nextPaymentDate": "2026-01-19",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-02-23"
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
        "nextPaymentDate": "2025-02-23",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📈",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📈"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-10-30"
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
        "nextPaymentDate": "2026-10-30",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "📷",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📷"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-24"
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
        "nextPaymentDate": "2026-09-24",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-05-30"
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
        "nextPaymentDate": "2025-05-30",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-07-28"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-07-28",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-11-11"
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
        "nextPaymentDate": "2025-11-11",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔁",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🔁"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-07-03"
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
        "nextPaymentDate": "2025-07-03",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-12-16"
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
        "nextPaymentDate": "2025-12-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-11-05"
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
        "nextPaymentDate": "2025-11-05",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🗞️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗞️"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-01-12"
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
        "nextPaymentDate": "2026-01-12",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🗞️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗞️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-10"
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
        "nextPaymentDate": "2026-05-10",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-01"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-01",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-30"
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
        "nextPaymentDate": "2026-04-30",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "☁️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "☁️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-16"
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
        "nextPaymentDate": "2026-04-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-10"
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
        "nextPaymentDate": "2026-04-10",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-13"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Utilities",
          "colorName": "ORANGE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🔌"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-13",
        "categoryId": "<id>",
        "frequency": "BIMONTHLY",
        "emoji": "⚡️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "⚡️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-01"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Rent",
          "colorName": "ORANGE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🔑"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-01",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔑",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🔑"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-28"
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
        "nextPaymentDate": "2026-04-28",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🤖",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🤖"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
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
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-11"
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
        "nextPaymentDate": "2026-04-11",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🎥",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🎥"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-10"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Utilities",
          "colorName": "ORANGE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🔌"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-10",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔌",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🔌"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Recurring",
        "rule": {
          "__typename": "RecurringRule",
          "nameContains": "<merchant>",
          "minAmount": "<amount>",
          "maxAmount": "<amount>",
          "days": []
        },
        "payments": [],
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
        "nextPaymentAmount": null,
        "nextPaymentDate": null,
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-02"
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
        "nextPaymentDate": "2026-05-02",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔃",
        "icon": null,
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-02-20"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2024-02-20",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-05-06"
          }
        ],
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
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-06",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "🚗",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🚗"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-09"
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
        "nextPaymentDate": "2026-09-09",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "🗞️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗞️"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-10-05"
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
        "nextPaymentDate": "2025-10-05",
        "categoryId": "<id>",
        "frequency": "QUADMONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-11-17"
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
        "nextPaymentDate": "2024-11-17",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🙋‍♀️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🙋‍♀️"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-05-30"
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
        "nextPaymentDate": "2024-05-30",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-01"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-01",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-11"
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
        "nextPaymentDate": "2026-09-11",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2023-12-29"
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
        "nextPaymentDate": "2023-12-29",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-07-12"
          }
        ],
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
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-07-12",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔁",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🔁"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-25"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Groceries",
          "colorName": "PURPLE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🥑"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-09-25",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "🥑",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🥑"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-17"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Utilities",
          "colorName": "ORANGE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🔌"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-17",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🛜",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🛜"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-06-16"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-06-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-06"
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
        "nextPaymentDate": "2026-09-06",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-01"
          }
        ],
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
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-04-01",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🅿️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🅿️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-03-27"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Personal Care",
          "colorName": "RED1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "✂️"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-03-27",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🛍",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🛍"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-06-12"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Education",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "💸"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-06-12",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📚",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📚"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-01-28"
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
        "nextPaymentDate": "2024-01-28",
        "categoryId": "<id>",
        "frequency": "BIWEEKLY",
        "emoji": "🗣️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗣️"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-06-16"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Fitness",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "👟"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-06-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "👟",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "👟"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-09-29"
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
        "nextPaymentDate": "2026-09-29",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-04-03"
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
        "nextPaymentDate": "2024-04-03",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-06-17"
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
        "nextPaymentDate": "2025-06-17",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🔁",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🔁"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-23"
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
        "nextPaymentDate": "2026-04-23",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2023-10-20"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Utilities",
          "colorName": "ORANGE2",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🔌"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2023-10-20",
        "categoryId": "<id>",
        "frequency": "QUARTERLY",
        "emoji": "📞",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📞"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-09-22"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Transportation",
          "colorName": "TEAL1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "🚌"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2025-09-22",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🛴",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🛴"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-12-25"
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
        "nextPaymentDate": "2026-12-25",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "🗞️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗞️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-16"
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
        "nextPaymentDate": "2026-04-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🥑",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🥑"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2027-02-13"
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
        "nextPaymentDate": "2027-02-13",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-08-21"
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
        "nextPaymentDate": "2025-08-21",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-12"
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
        "nextPaymentDate": "2027-04-12",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-01-02"
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
        "nextPaymentDate": "2026-01-02",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-04-16"
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
        "nextPaymentDate": "2026-04-16",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🗣️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🗣️"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-09-22"
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
        "nextPaymentDate": "2025-09-22",
        "categoryId": "<id>",
        "frequency": "ANNUALLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-02-19"
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
        "nextPaymentDate": "2026-02-19",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-02-06"
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
        "nextPaymentDate": "2024-02-06",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🤷‍♂️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🤷‍♂️"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-01-03"
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
        "nextPaymentDate": "2026-01-03",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "🌐",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🌐"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-02-13"
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
        "nextPaymentDate": "2024-02-13",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2026-05-20"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Insurance",
          "colorName": "YELLOW1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "☂️"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-20",
        "categoryId": "<id>",
        "frequency": "SEMIANNUALLY",
        "emoji": "🚗",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🚗"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-06-17"
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
        "nextPaymentDate": "2025-06-17",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": true,
            "date": "2026-04-14"
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
        "nextPaymentDate": "2026-05-14",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "📺",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "📺"
        },
        "state": "ACTIVE",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2024-08-06"
          }
        ],
        "category": {
          "__typename": "Category",
          "isRolloverDisabled": false,
          "canBeDeleted": true,
          "isExcluded": false,
          "templateId": "Education",
          "colorName": "BLUE1",
          "icon": {
            "__typename": "EmojiUnicode",
            "unicode": "💸"
          },
          "name": "<name>",
          "id": "<id>"
        },
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2024-08-06",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💸",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💸"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      },
      {
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
            "isPaid": false,
            "date": "2025-05-27"
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
        "nextPaymentDate": "2025-05-27",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "💳",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "💳"
        },
        "state": "ARCHIVED",
        "name": "<name>",
        "id": "<id>"
      }
    ]
  }
}
```
