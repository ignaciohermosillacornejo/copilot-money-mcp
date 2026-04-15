# RefreshAllConnections

- **Type:** query
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query RefreshAllConnections {
  refreshAllConnections {
    ...ConnectionFields
    institution {
      ...InstitutionFields
      __typename
    }
    __typename
  }
}

fragment AccountFields on Account {
  isConcealable @client
  hasHistoricalUpdates
  latestBalanceUpdate
  identifierId @client
  status @client
  hasLiveBalance
  institutionId
  isUserHidden
  isUserClosed
  liveBalance
  isManual
  balance
  subType
  itemId
  limit
  color
  name
  type
  mask
  id
  __typename
}

fragment ConnectionFields on Connection {
  id
  numAccounts
  connectionStatus
  connectedSince
  connectionType
  loginRequired
  newAccounts
  accounts {
    ...AccountFields
    __typename
  }
  institution {
    type
    __typename
  }
  __typename
}

fragment InstitutionFields on Institution {
  id
  name
  type
  color
  url
  displayType
  logo {
    ... on LogoBase64 {
      content
      contentType
      __typename
    }
    ... on LogoUrl {
      src
      __typename
    }
    __typename
  }
  logoFull {
    ... on LogoBase64 {
      content
      contentType
      __typename
    }
    ... on LogoUrl {
      src
      __typename
    }
    __typename
  }
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"RefreshAllConnections","query":"query RefreshAllConnections {\n  refreshAllConnections {\n    ...ConnectionFields\n    institution {\n      ...InstitutionFields\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment AccountFields on Account {\n  isConcealable @client\n  hasHistoricalUpdates\n  latestBalanceUpdate\n  identifierId @client\n  status @client\n  hasLiveBalance\n  institutionId\n  isUserHidden\n  isUserClosed\n  liveBalance\n  isManual\n  balance\n  subType\n  itemId\n  limit\n  color\n  name\n  type\n  mask\n  id\n  __typename\n}\n\nfragment ConnectionFields on Connection {\n  id\n  numAccounts\n  connectionStatus\n  connectedSince\n  connectionType\n  loginRequired\n  newAccounts\n  accounts {\n    ...AccountFields\n    __typename\n  }\n  institution {\n    type\n    __typename\n  }\n  __typename\n}\n\nfragment InstitutionFields on Institution {\n  id\n  name\n  type\n  color\n  url\n  displayType\n  logo {\n    ... on LogoBase64 {\n      content\n      contentType\n      __typename\n    }\n    ... on LogoUrl {\n      src\n      __typename\n    }\n    __typename\n  }\n  logoFull {\n    ... on LogoBase64 {\n      content\n      contentType\n      __typename\n    }\n    ... on LogoUrl {\n      src\n      __typename\n    }\n    __typename\n  }\n  __typename\n}","variables":{}}
```

## Example response

```json
{}
```
