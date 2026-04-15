# EditUser

- **Type:** mutation
- **Endpoint:** https://app.copilot.money/api/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 11

## Query

```graphql
mutation EditUser($input: EditUserInput) {
  editUser(input: $input) {
    budgetingConfig {
      isEnabled
      rolloversConfig {
        isEnabled
        startDate
        categories {
          id
        }
      }
    }
    onboarding {
      ...OnboardingFields
    }
    termsStatus
    id
  }
}

fragment OnboardingFields on Onboarding {
  lastCompletedStep
  isCompleted
}
```

## Variables

| Name | Type | Required | Example |
|------|------|----------|---------|
| input | object | true | `{"budgetingConfig":{"isEnabled":true}}` |

## Example request

```json
{"operationName":"EditUser","query":"mutation EditUser($input: EditUserInput) {\n  editUser(input: $input) {\n    budgetingConfig {\n      isEnabled\n      rolloversConfig {\n        isEnabled\n        startDate\n        categories {\n          id\n        }\n      }\n    }\n    onboarding {\n      ...OnboardingFields\n    }\n    termsStatus\n    id\n  }\n}\n\nfragment OnboardingFields on Onboarding {\n  lastCompletedStep\n  isCompleted\n}","variables":{"input":{"budgetingConfig":{"isEnabled":true}}}}
```

## Example response

```json
{
  "data": {
    "editUser": {
      "budgetingConfig": {
        "isEnabled": true,
        "rolloversConfig": {
          "isEnabled": true,
          "startDate": "2024-02-28",
          "categories": [
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            },
            {
              "id": "<id>",
              "__typename": "Category"
            }
          ],
          "__typename": "RolloversConfig"
        },
        "__typename": "BudgetingConfig"
      },
      "onboarding": {
        "lastCompletedStep": "REVIEW",
        "isCompleted": true,
        "__typename": "Onboarding"
      },
      "termsStatus": "ACCEPTED",
      "id": "<id>",
      "__typename": "User"
    }
  }
}
```
