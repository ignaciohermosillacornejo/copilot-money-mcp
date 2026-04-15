# Spends

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query Spends($history: Boolean = true) {
  categoriesTotal {
    spend {
      current {
        ...SpendMonthlyFields
        __typename
      }
      histories @include(if: $history) {
        ...SpendMonthlyFields
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
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| history | boolean | true | `true` |

## Example request

```json
{"operationName":"Spends","query":"query Spends($history: Boolean = true) {\n  categoriesTotal {\n    spend {\n      current {\n        ...SpendMonthlyFields\n        __typename\n      }\n      histories @include(if: $history) {\n        ...SpendMonthlyFields\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment SpendMonthlyFields on CategoryMonthlySpent {\n  unpaidRecurringAmount\n  paidRecurringAmount\n  monthName @client\n  comparisonAmount\n  amount\n  month\n  id\n  __typename\n}","variables":{"history":true}}
```

## Example response

```json
{
  "data": {
    "categoriesTotal": {
      "__typename": "CategoriesTotal",
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
      }
    }
  }
}
```
