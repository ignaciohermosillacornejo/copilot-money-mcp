# UpcomingRecurrings

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query UpcomingRecurrings {
  unpaidUpcomingRecurrings {
    ...RecurringFields
    rule {
      ...RecurringRuleFields
      __typename
    }
    payments @connection(key: "upcoming") {
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
{"operationName":"UpcomingRecurrings","query":"query UpcomingRecurrings {\n  unpaidUpcomingRecurrings {\n    ...RecurringFields\n    rule {\n      ...RecurringRuleFields\n      __typename\n    }\n    payments @connection(key: \"upcoming\") {\n      ...RecurringPaymentFields\n      __typename\n    }\n    category @client {\n      ...CategoryFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  state\n  name\n  id\n  __typename\n}\n\nfragment RecurringRuleFields on RecurringRule {\n  nameContains\n  minAmount\n  maxAmount\n  days\n  __typename\n}\n\nfragment RecurringPaymentFields on RecurringPayment {\n  amount\n  isPaid\n  date\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "unpaidUpcomingRecurrings": [
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
        "payments": [
          {
            "__typename": "RecurringPayment",
            "amount": "<amount>",
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
            "isPaid": "<amount>",
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
      }
    ]
  }
}
```
