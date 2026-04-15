# Recurring

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 21

## Query

```graphql
query Recurring($id: ID!) {
  recurring(id: $id) {
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

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | string | true | `""` |

## Example request

```json
{"operationName":"Recurring","query":"query Recurring($id: ID!) {\n  recurring(id: $id) {\n    ...RecurringFields\n    rule {\n      ...RecurringRuleFields\n      __typename\n    }\n    payments {\n      ...RecurringPaymentFields\n      __typename\n    }\n    category @client {\n      ...CategoryFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  state\n  name\n  id\n  __typename\n}\n\nfragment RecurringRuleFields on RecurringRule {\n  nameContains\n  minAmount\n  maxAmount\n  days\n  __typename\n}\n\nfragment RecurringPaymentFields on RecurringPayment {\n  amount\n  isPaid\n  date\n  __typename\n}\n\nfragment CategoryFields on Category {\n  isRolloverDisabled\n  canBeDeleted\n  isExcluded\n  templateId\n  colorName\n  icon {\n    ... on EmojiUnicode {\n      unicode\n      __typename\n    }\n    ... on Genmoji {\n      id\n      src\n      __typename\n    }\n    __typename\n  }\n  name\n  id\n  __typename\n}","variables":{"id":""}}
```

## Example response

```json
{}
```
