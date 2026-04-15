# CreateTag

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 5

## Query

```graphql
mutation CreateTag($input: CreateTagInput!) {
  createTag(input: $input) {
    ...TagFields
  }
}

fragment TagFields on Tag {
  colorName
  name
  id
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| input | object | true | `{"colorName":"PURPLE2","name":"<name>"}` |

## Example request

```json
{"operationName":"CreateTag","query":"mutation CreateTag($input: CreateTagInput!) {\n  createTag(input: $input) {\n    ...TagFields\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n}","variables":{"input":{"colorName":"PURPLE2","name":"<name>"}}}
```

## Example response

```json
{
  "data": {
    "createTag": {
      "__typename": "Tag",
      "colorName": "PURPLE2",
      "name": "<name>",
      "id": "<id>"
    }
  }
}
```
