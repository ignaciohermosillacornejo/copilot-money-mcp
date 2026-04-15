# Budgets

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query Budgets {
  categoriesTotal {
    budget {
      ...BudgetFields
      __typename
    }
    __typename
  }
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

_(no variables)_

## Example request

```json
{"operationName":"Budgets","query":"query Budgets {\n  categoriesTotal {\n    budget {\n      ...BudgetFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment BudgetMonthlyFields on CategoryMonthlyBudget {\n  unassignedRolloverAmount\n  childRolloverAmount\n  unassignedAmount\n  resolvedAmount\n  rolloverAmount\n  childAmount\n  goalAmount\n  amount\n  month\n  id\n  __typename\n}\n\nfragment BudgetFields on CategoryBudget {\n  current {\n    ...BudgetMonthlyFields\n    __typename\n  }\n  histories {\n    ...BudgetMonthlyFields\n    __typename\n  }\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "categoriesTotal": {
      "__typename": "CategoriesTotal",
      "budget": {
        "__typename": "CategoryBudget",
        "current": {
          "__typename": "CategoryMonthlyBudget",
          "unassignedRolloverAmount": "<amount>",
          "childRolloverAmount": "<amount>",
          "unassignedAmount": "<amount>",
          "resolvedAmount": "<amount>",
          "rolloverAmount": "<amount>",
          "childAmount": null,
          "goalAmount": "<amount>",
          "amount": "<amount>",
          "month": "2026-04",
          "id": "<id>"
        },
        "histories": [
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2022-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2023-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2024-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-04",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-05",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-06",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-07",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-08",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-09",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-10",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-11",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2025-12",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-01",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-02",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-03",
            "id": "<id>"
          },
          {
            "__typename": "CategoryMonthlyBudget",
            "unassignedRolloverAmount": "<amount>",
            "childRolloverAmount": "<amount>",
            "unassignedAmount": "<amount>",
            "resolvedAmount": "<amount>",
            "rolloverAmount": "<amount>",
            "childAmount": null,
            "goalAmount": "<amount>",
            "amount": "<amount>",
            "month": "2026-04",
            "id": "<id>"
          }
        ]
      }
    }
  }
}
```
