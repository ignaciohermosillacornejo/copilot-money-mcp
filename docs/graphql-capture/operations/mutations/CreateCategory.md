# CreateCategory

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
mutation CreateCategory($input: CreateCategoryInput!, $spend: Boolean = false, $budget: Boolean = false) {
  createCategory(input: $input) {
    ...CategoryFields
    spend @include(if: $spend) {
      ...SpendFields
    }
    budget @include(if: $budget) {
      ...BudgetFields
    }
    childCategories {
      ...CategoryFields
      spend @include(if: $spend) {
        ...SpendFields
      }
      budget @include(if: $budget) {
        ...BudgetFields
      }
    }
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

fragment SpendFields on CategorySpend {
  current {
    ...SpendMonthlyFields
  }
  histories {
    ...SpendMonthlyFields
  }
}

fragment BudgetFields on CategoryBudget {
  current {
    ...BudgetMonthlyFields
  }
  histories {
    ...BudgetMonthlyFields
  }
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| budget | boolean | true | `false` |
| spend | string | true | `"<amount>"` |
| input | object | true | `{"colorName":"OLIVE1","emoji":"🇬🇶","name":"<name>","isExcluded":false,"budget":{"unassignedAmount":"<amount>"}}` |

## Example request

```json
{"operationName":"CreateCategory","query":"mutation CreateCategory($input: CreateCategoryInput!, $spend: Boolean = false, $budget: Boolean = false) {\n  createCategory(input: $input) {\n    ...CategoryFields\n    spend @include(if: $spend) {\n      ...SpendFields\n    }\n    budget @include(if: $budget) {\n      ...BudgetFields\n    }\n    childCategories {\n      ...CategoryFields\n      spend @include(if: $spend) {\n        ...SpendFields\n      }\n      budget @include(if: $budget) {\n        ...BudgetFields\n      }\n    }\n  }\n}\n\nfragment SpendMonthlyFields on CategoryMonthlySpent {\n  unpaidRecurringAmount\n  paidRecurringAmount\n  monthName @client\n  comparisonAmount\n  amount\n  month\n  id\n}\n\nfragment BudgetMonthlyFields on CategoryMonthlyBudget {\n  unassignedRolloverAmount\n  childRolloverAmount\n  unassignedAmount\n  resolvedAmount\n  rolloverAmount\n  childAmount\n  goalAmount\n  amount\n  month\n  id\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  name\n  id\n}\n\nfragment SpendFields on CategorySpend {\n  current {\n    ...SpendMonthlyFields\n  }\n  histories {\n    ...SpendMonthlyFields\n  }\n}\n\nfragment BudgetFields on CategoryBudget {\n  current {\n    ...BudgetMonthlyFields\n  }\n  histories {\n    ...BudgetMonthlyFields\n  }\n}","variables":{"budget":false,"spend":"<amount>","input":{"colorName":"OLIVE1","emoji":"🇬🇶","name":"<name>","isExcluded":false,"budget":{"unassignedAmount":"<amount>"}}}}
```

## Example response

```json
{
  "data": {
    "createCategory": {
      "__typename": "Category",
      "spend": {
        "__typename": "CategorySpend",
        "current": {
          "__typename": "CategoryMonthlySpent",
          "unpaidRecurringAmount": "<amount>",
          "paidRecurringAmount": "<amount>",
          "monthName": "Apr",
          "comparisonAmount": "<amount>",
          "amount": "<amount>",
          "month": "2026-04",
          "id": "<id>"
        },
        "histories": [
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Apr",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "May",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jun",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jul",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Aug",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Sep",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Oct",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Nov",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Dec",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jan",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Feb",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Mar",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Apr",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "May",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jun",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jul",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Aug",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Sep",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Oct",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Nov",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Dec",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jan",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Feb",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Mar",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Apr",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "May",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jun",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jul",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Aug",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Sep",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Oct",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Nov",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Dec",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jan",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Feb",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Mar",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Apr",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "May",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jun",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jul",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Aug",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Sep",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Oct",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Nov",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Dec",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Jan",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Feb",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Mar",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlySpent",
            "unpaidRecurringAmount": "<amount>",
            "paidRecurringAmount": "<amount>",
            "monthName": "Apr",
            "comparisonAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-04",
            "id": "<id>"
          }
        ]
      },
      "childCategories": [],
      "isRolloverDisabled": false,
      "canBeDeleted": true,
      "isExcluded": false,
      "templateId": null,
      "colorName": "OLIVE1",
      "icon": {
        "__typename": "EmojiUnicode",
        "unicode": "🇬🇶"
      },
      "name": "<name>",
      "id": "<id>"
    }
  }
}
```
