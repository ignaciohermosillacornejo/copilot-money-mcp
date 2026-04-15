# MonthlySpend

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2

## Query

```graphql
query MonthlySpend {
  monthlySpending {
    comparisonAmount
    totalAmount
    date
    id
    __typename
  }
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"MonthlySpend","query":"query MonthlySpend {\n  monthlySpending {\n    comparisonAmount\n    totalAmount\n    date\n    id\n    __typename\n  }\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "monthlySpending": [
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-01",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-02",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-03",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-04",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-05",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-06",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-07",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-08",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-09",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-10",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-11",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-12",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-13",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": "<amount>",
        "totalAmount": "<amount>",
        "date": "2026-04-14",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-15",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-16",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-17",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-18",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-19",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-20",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-21",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-22",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-23",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-24",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-25",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-26",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-27",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-28",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-29",
        "id": "<id>"
      },
      {
        "__typename": "CategoriesDailySpent",
        "comparisonAmount": null,
        "totalAmount": null,
        "date": "2026-04-30",
        "id": "<id>"
      }
    ]
  }
}
```
