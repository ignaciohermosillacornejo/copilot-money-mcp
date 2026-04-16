# CreateRecurring

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 2
- **Response fields trimmed vs. captured shape (issue #288):** the
  original capture selected `rule { ...RecurringRuleFields }`, `payments { ... }`,
  and `category @client { ... }`. We don't consume any of those fields
  in `createRecurring()`, and `RecurringRuleFields.nameContains` is
  non-nullable in Copilot's schema despite being null on some
  recurrings — a schema/data mismatch that makes EditRecurring throw
  server-side. We drop the same sub-selections here for consistency
  and forward-safety.

## Query

```graphql
mutation CreateRecurring($input: CreateRecurringInput!) {
  createRecurring(input: $input) {
    ...RecurringFields
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
    }
    ... on Genmoji {
      id
      src
    }
  }
  state
  name
  id
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| input | object | true | `{"frequency":"MONTHLY","transaction":{"accountId":"<id>","transactionId":"<id>","itemId":"<id>"}}` |

## Example request

```json
{"operationName":"CreateRecurring","query":"mutation CreateRecurring($input: CreateRecurringInput!) {\n  createRecurring(input: $input) {\n    ...RecurringFields\n  }\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  state\n  name\n  id\n}","variables":{"input":{"frequency":"MONTHLY","transaction":{"accountId":"<id>","transactionId":"<id>","itemId":"<id>"}}}}
```

## Example response

```json
{
  "data": {
    "createRecurring": {
      "__typename": "Recurring",
      "nextPaymentAmount": "<amount>",
      "nextPaymentDate": "2026-05-14",
      "categoryId": "<id>",
      "frequency": "MONTHLY",
      "emoji": "🍔",
      "icon": {
        "__typename": "EmojiUnicode",
        "unicode": "🍔"
      },
      "state": "ACTIVE",
      "name": "<name>",
      "id": "<id>"
    }
  }
}
```
