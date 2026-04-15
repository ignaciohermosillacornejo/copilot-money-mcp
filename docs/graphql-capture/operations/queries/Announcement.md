# Announcement

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query Announcement($id: ID!) {
  announcement(id: $id) {
    ...AnnouncementFields
    __typename
  }
}

fragment AnnouncementFields on Announcement {
  isDismissed
  createdAt
  subtitle @client
  title @client
  id
  __typename
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| id | string | true | `"feature_enable_mfa"` |

## Example request

```json
{"operationName":"Announcement","query":"query Announcement($id: ID!) {\n  announcement(id: $id) {\n    ...AnnouncementFields\n    __typename\n  }\n}\n\nfragment AnnouncementFields on Announcement {\n  isDismissed\n  createdAt\n  subtitle @client\n  title @client\n  id\n  __typename\n}","variables":{"id":"feature_enable_mfa"}}
```

## Example response

```json
{
  "data": {
    "announcement": {
      "__typename": "Announcement",
      "isDismissed": false,
      "createdAt": 1770660675158,
      "subtitle": "Add an extra layer of security by requiring a code when you sign in",
      "title": "Enable 2FA",
      "id": "feature_enable_mfa"
    }
  }
}
```
