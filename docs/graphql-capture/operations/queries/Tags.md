# Tags

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 10

## Query

```graphql
query Tags {
  tags {
    ...TagFields
    __typename
  }
}

fragment TagFields on Tag {
  colorName
  name
  id
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"Tags","query":"query Tags {\n  tags {\n    ...TagFields\n    __typename\n  }\n}\n\nfragment TagFields on Tag {\n  colorName\n  name\n  id\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "tags": [
      {
        "__typename": "Tag",
        "colorName": "ORANGE2",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "PINK1",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "YELLOW2",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "BLUE1",
        "name": "<name>",
        "id": "frenchpolynesia"
      },
      {
        "__typename": "Tag",
        "colorName": "YELLOW1",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "RED2",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "ORANGE2",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "OLIVE1",
        "name": "<name>",
        "id": "<id>"
      },
      {
        "__typename": "Tag",
        "colorName": "PINK1",
        "name": "<name>",
        "id": "<id>"
      }
    ]
  }
}
```
