# EditCategory

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 13

## Query

```graphql
mutation EditCategory($id: ID!, $input: EditCategoryInput!, $spend: Boolean = false, $budget: Boolean = false, $rollovers: Boolean = false) {
  editCategory(id: $id, input: $input) {
    category {
      ...CategoryFields
      spend @include(if: $spend) {
        ...SpendFields
      }
      budget(isRolloverEnabled: $rollovers) @include(if: $budget) {
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
| id | string | true | `"<id>"` |
| input | object | true | `{"name":"<name>"}` |
| budget | boolean | false | `false` |
| spend | boolean | false | `true` |

## Example request

```json
{"operationName":"EditCategory","query":"mutation EditCategory($id: ID!, $input: EditCategoryInput!, $spend: Boolean = false, $budget: Boolean = false, $rollovers: Boolean = false) {\n  editCategory(id: $id, input: $input) {\n    category {\n      ...CategoryFields\n      spend @include(if: $spend) {\n        ...SpendFields\n      }\n      budget(isRolloverEnabled: $rollovers) @include(if: $budget) {\n        ...BudgetFields\n      }\n    }\n  }\n}\n\nfragment SpendMonthlyFields on CategoryMonthlySpent {\n  unpaidRecurringAmount\n  paidRecurringAmount\n  monthName @client\n  comparisonAmount\n  amount\n  month\n  id\n}\n\nfragment BudgetMonthlyFields on CategoryMonthlyBudget {\n  unassignedRolloverAmount\n  childRolloverAmount\n  unassignedAmount\n  resolvedAmount\n  rolloverAmount\n  childAmount\n  goalAmount\n  amount\n  month\n  id\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  name\n  id\n}\n\nfragment SpendFields on CategorySpend {\n  current {\n    ...SpendMonthlyFields\n  }\n  histories {\n    ...SpendMonthlyFields\n  }\n}\n\nfragment BudgetFields on CategoryBudget {\n  current {\n    ...BudgetMonthlyFields\n  }\n  histories {\n    ...BudgetMonthlyFields\n  }\n}","variables":{"id":"<id>","input":{"name":"<name>"}}}
```

## Example response

```json
{
  "data": {
    "editCategory": {
      "__typename": "EditCategoryOutput",
      "category": {
        "__typename": "Category",
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
}
```
