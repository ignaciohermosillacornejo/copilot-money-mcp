# EditRecurring

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 9
- **Response fields trimmed vs. captured shape (issue #288):** the
  original capture selected `rule { ...RecurringRuleFields }`, `payments { ... }`,
  and `category @client { ... }`. We do not consume those fields in
  `editRecurring()` and the captured `RecurringRuleFields` fragment
  includes `nameContains`, which Copilot's server marks non-nullable
  despite actually returning `null` on any recurring that was matched
  by amount-only rules. Keeping that selection made `setRecurringState`
  throw even when the mutation succeeded server-side. Dropping the
  sub-selection avoids the nullability error without losing any
  data we consume — `editRecurring()` now echoes the caller's input
  for the `changed.rule` report.

## Query

```graphql
mutation EditRecurring($id: ID!, $input: EditRecurringInput!) {
  editRecurring(id: $id, input: $input) {
    recurring {
      ...RecurringFields
    }
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
| input | object | true | `{"state":"PAUSED"}` |
| id | string | true | `"<id>"` |

## Example request

```json
{"operationName":"EditRecurring","query":"mutation EditRecurring($id: ID!, $input: EditRecurringInput!) {\n  editRecurring(id: $id, input: $input) {\n    recurring {\n      ...RecurringFields\n    }\n  }\n}\n\nfragment RecurringFields on Recurring {\n  nextPaymentAmount\n  nextPaymentDate\n  categoryId\n  frequency\n  emoji\n  icon {\n    ... on EmojiUnicode {\n      unicode\n    }\n    ... on Genmoji {\n      id\n      src\n    }\n  }\n  state\n  name\n  id\n}","variables":{"input":{"state":"PAUSED"},"id":"<id>"}}
```

## Example response

```json
{
  "data": {
    "editRecurring": {
      "__typename": "EditRecurringOutput",
      "recurring": {
        "__typename": "Recurring",
        "nextPaymentAmount": "<amount>",
        "nextPaymentDate": "2026-05-05",
        "categoryId": "<id>",
        "frequency": "MONTHLY",
        "emoji": "✍️",
        "icon": {
          "__typename": "EmojiUnicode",
          "unicode": "✍️"
        },
        "state": "PAUSED",
        "name": "<name>",
        "id": "<id>"
      }
    }
  }
}
```
