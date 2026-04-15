# EditTag

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 10

## Query

```graphql
mutation EditTag($id: ID!, $input: EditTagInput!) {
  editTag(id: $id, input: $input) {
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
| id | string | true | `"<id>"` |
| input | object | true | `{"name":"<name>"}` |

## Example request

```json
{"operationName":"EditTag","query":"mutation EditTag($id: ID!, $input: EditTagInput!) {\n  editTag(id: $id, input: $input) {\n  ...TagFields\n}\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n}","variables":{"id":"<id>","input":{"name":"<name>"}}}
```

## Example response

```json
{
  "data": {
    "editTag": {
      "colorName": "YELLOW2",
      "name": "<name>",
      "id": "<id>",
      "__typename": "Tag"
    }
  }
}
```
