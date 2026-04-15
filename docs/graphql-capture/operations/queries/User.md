# User

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 28

## Query

```graphql
query User {
  user {
    ...UserFields
    __typename
  }
}

fragment OnboardingFields on Onboarding {
  lastCompletedStep
  isCompleted
  __typename
}

fragment UserFields on User {
  budgetingConfig {
    isEnabled
    rolloversConfig {
      isEnabled
      startDate
      categories {
        isRolloverDisabled
        canBeDeleted
        isExcluded
        colorName
        name
        id
        __typename
      }
      __typename
    }
    __typename
  }
  onboarding {
    ...OnboardingFields
    __typename
  }
  intercomUserHash
  serviceEndsOn
  termsStatus
  id
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"User","query":"query User {\n  user {\n    ...UserFields\n    __typename\n  }\n}\n\nfragment OnboardingFields on Onboarding {\n  lastCompletedStep\n  isCompleted\n  __typename\n}\n\nfragment UserFields on User {\n  budgetingConfig {\n    isEnabled\n    rolloversConfig {\n      isEnabled\n      startDate\n      categories {\n        isRolloverDisabled\n        canBeDeleted\n        isExcluded\n        colorName\n        name\n        id\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  onboarding {\n    ...OnboardingFields\n    __typename\n  }\n  intercomUserHash\n  serviceEndsOn\n  termsStatus\n  id\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "user": {
      "__typename": "User",
      "budgetingConfig": {
        "__typename": "BudgetingConfig",
        "isEnabled": false,
        "rolloversConfig": {
          "__typename": "RolloversConfig",
          "isEnabled": true,
          "startDate": "2024-02-28",
          "categories": [
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "ORANGE2",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "TEAL1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": false,
              "isExcluded": false,
              "colorName": "GRAY1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "PURPLE1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "RED2",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "YELLOW1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "GREEN1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "BLUE1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "TEAL1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "BLUE1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "RED1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "BLUE1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": false,
              "colorName": "PINK1",
              "name": "<name>",
              "id": "<id>"
            },
            {
              "__typename": "Category",
              "isRolloverDisabled": false,
              "canBeDeleted": true,
              "isExcluded": true,
              "colorName": "GRAY1",
              "name": "<name>",
              "id": "<id>"
            }
          ]
        }
      },
      "onboarding": {
        "__typename": "Onboarding",
        "lastCompletedStep": "REVIEW",
        "isCompleted": true
      },
      "intercomUserHash": "<id>",
      "serviceEndsOn": 1792005061000,
      "termsStatus": "ACCEPTED",
      "id": "<id>"
    }
  }
}
```
