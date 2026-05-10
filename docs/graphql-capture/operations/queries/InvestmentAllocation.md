# InvestmentAllocation

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** Clicking into an investment account (drives the allocation breakdown UI).
- **Observations:** 1

## Query

```graphql
query InvestmentAllocation($filter: AllocationFilter) {
  investmentAllocation(filter: $filter) {
    ...AllocationFields
    __typename
  }
}

fragment AllocationFields on Allocation {
  percentage
  amount
  type
  id
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| filter | AllocationFilter | false | `{"accountId":"<id>","itemId":"<id>"}` |

`AllocationFilter` is an input object with `accountId` and `itemId` fields.

## Example request

```json
{"operationName":"InvestmentAllocation","query":"query InvestmentAllocation($filter: AllocationFilter) {\n  investmentAllocation(filter: $filter) {\n    ...AllocationFields\n    __typename\n  }\n}\n\nfragment AllocationFields on Allocation {\n  percentage\n  amount\n  type\n  id\n  __typename\n}","variables":{"filter":{"accountId":"<id>","itemId":"<id>"}}}
```

## Example response

```json
{
  "data": {
    "investmentAllocation": [
      {
        "__typename": "Allocation",
        "id": "<id>",
        "type": "<allocation-type>",
        "amount": "<amount>",
        "percentage": "<amount>"
      },
      {
        "__typename": "Allocation",
        "id": "<id>",
        "type": "<allocation-type>",
        "amount": "<amount>",
        "percentage": "<amount>"
      }
    ]
  }
}
```
