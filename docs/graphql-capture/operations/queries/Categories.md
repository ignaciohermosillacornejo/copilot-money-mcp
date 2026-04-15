# Categories

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 23

## Query

```graphql
query Categories($spend: Boolean = false, $budget: Boolean = false, $rollovers: Boolean) {
  categories {
    ...CategoryFields
    spend @include(if: $spend) {
      ...SpendFields
      __typename
    }
    budget(isRolloverEnabled: $rollovers) @include(if: $budget) {
      ...BudgetFields
      __typename
    }
    childCategories {
      ...CategoryFields
      spend @include(if: $spend) {
        ...SpendFields
        __typename
      }
      budget(isRolloverEnabled: $rollovers) @include(if: $budget) {
        ...BudgetFields
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment SpendMonthlyFields on CategoryMonthlySpent {
  unpaidRecurringAmount
  paidRecurringAmount
  monthName @client
  comparisonAmount
  amount
  month
  id
  __typename
}

fragment BudgetMonthlyFields on CategoryMonthlyBudget {
  unassignedRolloverAmount
  childRolloverAmount
  unassignedAmount
  resolvedAmount
  rolloverAmount
  childAmount
  goalAmount
  amount
  month
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

fragment SpendFields on CategorySpend {
  current {
    ...SpendMonthlyFields
    __typename
  }
  histories {
    ...SpendMonthlyFields
    __typename
  }
  __typename
}

fragment BudgetFields on CategoryBudget {
  current {
    ...BudgetMonthlyFields
    __typename
  }
  histories {
    ...BudgetMonthlyFields
    __typename
  }
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| spend | string | true | `"<amount>"` |
| budget | boolean | true | `false` |

## Example request

```json
{"operationName":"Categories","query":"query Categories($spend: Boolean = false, $budget: Boolean = false, $rollovers: Boolean) {\n  categories {\n    ...CategoryFields\n    spend @include(if: $spend) {\n      ...SpendFields\n      __typename\n    }\n    budget(isRolloverEnabled: $rollovers) @include(if: $budget) {\n      ...BudgetFields\n      __typename\n    }\n    childCategories {\n      ...CategoryFields\n      spend @include(if: $spend) {\n        ...SpendFields\n        __typename\n      }\n      budget(isRolloverEnabled: $rollovers) @include(if: $budget) {\n        ...BudgetFields\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment SpendMonthlyFields on CategoryMonthlySpent {\n  unpaidRecurringAmount\n  paidRecurringAmount\n  monthName @client\n  comparisonAmount\n  amount\n  month\n  id\n  __typename\n}\n\nfragment BudgetMonthlyFields on CategoryMonthlyBudget {\n  unassignedRolloverAmount\n  childRolloverAmount\n  unassignedAmount\n  resolvedAmount\n  rolloverAmount\n  childAmount\n  goalAmount\n  amount\n  month\n  id\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}\n\nfragment SpendFields on CategorySpend {\n  current {\n    ...SpendMonthlyFields\n    __typename\n  }\n  histories {\n    ...SpendMonthlyFields\n    __typename\n  }\n  __typename\n}\n\nfragment BudgetFields on CategoryBudget {\n  current {\n    ...BudgetMonthlyFields\n    __typename\n  }\n  histories {\n    ...BudgetMonthlyFields\n    __typename\n  }\n  __typename\n}","variables":{"spend":"<amount>","budget":false}}
```

## Example response

```json
{
  "data": {
    "categories": [
      {
        "__typename": "Category",
        "childCategories": [
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Household",
            "colorName": "ORANGE2",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🧹"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
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
          {
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
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": "Household",
        "colorName": "ORANGE2",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [
          {
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
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": null,
            "colorName": "TEAL1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🔧"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": null,
            "colorName": "TEAL1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "⛽"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
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
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": null,
        "colorName": "TEAL1",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [
          {
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
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": null,
            "colorName": "PURPLE1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "☕"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Fun",
            "colorName": "PURPLE1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🥃"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
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
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": null,
        "colorName": "PURPLE1",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": "Fun",
        "colorName": "GREEN1",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🎟"
        },
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [
          {
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
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Shopping",
            "colorName": "BLUE1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🎿"
            },
            "name": "<name>",
            "id": "<id>"
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": null,
        "colorName": "BLUE1",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": null,
            "colorName": "BLUE1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "✈️"
            },
            "name": "<name>",
            "id": "<id>"
          },
          {
            "__typename": "Category",
            "isRolloverDisabled": false,
            "canBeDeleted": true,
            "isExcluded": false,
            "templateId": "Travel & Vacation",
            "colorName": "BLUE1",
            "icon": {
              "__typename": "EmojiUnicode",
              "unicode": "🏨"
            },
            "name": "<name>",
            "id": "<id>"
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": null,
        "colorName": "BLUE1",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [
          {
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
          {
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
          {
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
          }
        ],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": false,
        "templateId": null,
        "colorName": "RED1",
        "icon": null,
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [],
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
      {
        "__typename": "Category",
        "childCategories": [],
        "isRolloverDisabled": false,
        "canBeDeleted": true,
        "isExcluded": true,
        "templateId": null,
        "colorName": "GRAY1",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "🏢"
        },
        "name": "<name>",
        "id": "<id>"
      }
    ]
  }
}
```
