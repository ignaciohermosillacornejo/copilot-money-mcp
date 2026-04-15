# Subscription

- **Type:** query
- **Endpoint:** https://app.copilot.money/graphql
- **Fires on:** <fill in from flow docs>
- **Observations:** 1

## Query

```graphql
query Subscription {
  subscription {
    ...CopilotPaidSubscriptionFields
    ...CopilotGiftSubscriptionFields
    __typename
  }
}

fragment PlanFields on SubscriptionPlan {
  type
  amount
  interval
  id
  __typename
}

fragment CardPaymentMethodFields on CardPaymentMethod {
  id
  mask
  brand
  __typename
}

fragment DepositoryAccountPaymentMethodFields on DepositoryAccountPaymentMethod {
  id
  account {
    name
    mask
    institutionId
    __typename
  }
  __typename
}

fragment AppleAppStorePaymentMethodFields on AppleAppStorePaymentMethod {
  id
  __typename
}

fragment BillingFields on SubscriptionBilling {
  nextPeriodAmount
  nextPeriodInterval
  currentPeriodAmount
  currentPeriodEndsAt
  currentPeriodInterval
  paymentFailure {
    reason
    __typename
  }
  paymentMethod {
    ...CardPaymentMethodFields
    ...DepositoryAccountPaymentMethodFields
    ...AppleAppStorePaymentMethodFields
    __typename
  }
  __typename
}

fragment PromotionFields on SubscriptionPromotion {
  id
  code
  type
  value
  description {
    text
    emoji {
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
    __typename
  }
  __typename
}

fragment ClaimedPromotionFields on ClaimedSubscriptionPromotion {
  promotion {
    ...PromotionFields
    __typename
  }
  endsOn
  __typename
}

fragment CopilotPaidSubscriptionFields on CopilotPaidSubscription {
  id
  state
  plan {
    ...PlanFields
    __typename
  }
  billing {
    ...BillingFields
    __typename
  }
  promotions {
    ...ClaimedPromotionFields
    __typename
  }
  __typename
}

fragment CopilotGiftSubscriptionFields on CopilotGiftSubscription {
  id
  state
  currentPeriodEndsAt
  promotions {
    ...ClaimedPromotionFields
    __typename
  }
  __typename
}
```

## Variables

_(no variables)_

## Example request

```json
{"operationName":"Subscription","query":"query Subscription {\n  subscription {\n    ...CopilotPaidSubscriptionFields\n    ...CopilotGiftSubscriptionFields\n    __typename\n  }\n}\n\nfragment PlanFields on SubscriptionPlan {\n  type\n  amount\n  interval\n  id\n  __typename\n}\n\nfragment CardPaymentMethodFields on CardPaymentMethod {\n  id\n  mask\n  brand\n  __typename\n}\n\nfragment DepositoryAccountPaymentMethodFields on DepositoryAccountPaymentMethod {\n  id\n  account {\n    name\n    mask\n    institutionId\n    __typename\n  }\n  __typename\n}\n\nfragment AppleAppStorePaymentMethodFields on AppleAppStorePaymentMethod {\n  id\n  __typename\n}\n\nfragment BillingFields on SubscriptionBilling {\n  nextPeriodAmount\n  nextPeriodInterval\n  currentPeriodAmount\n  currentPeriodEndsAt\n  currentPeriodInterval\n  paymentFailure {\n    reason\n    __typename\n  }\n  paymentMethod {\n    ...CardPaymentMethodFields\n    ...DepositoryAccountPaymentMethodFields\n    ...AppleAppStorePaymentMethodFields\n    __typename\n  }\n  __typename\n}\n\nfragment PromotionFields on SubscriptionPromotion {\n  id\n  code\n  type\n  value\n  description {\n    text\n    emoji {\n      ... on EmojiUnicode {\n        unicode\n        __typename\n      }\n      ... on Genmoji {\n        id\n        src\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n  __typename\n}\n\nfragment ClaimedPromotionFields on ClaimedSubscriptionPromotion {\n  promotion {\n    ...PromotionFields\n    __typename\n  }\n  endsOn\n  __typename\n}\n\nfragment CopilotPaidSubscriptionFields on CopilotPaidSubscription {\n  id\n  state\n  plan {\n    ...PlanFields\n    __typename\n  }\n  billing {\n    ...BillingFields\n    __typename\n  }\n  promotions {\n    ...ClaimedPromotionFields\n    __typename\n  }\n  __typename\n}\n\nfragment CopilotGiftSubscriptionFields on CopilotGiftSubscription {\n  id\n  state\n  currentPeriodEndsAt\n  promotions {\n    ...ClaimedPromotionFields\n    __typename\n  }\n  __typename\n}","variables":{}}
```

## Example response

```json
{
  "data": {
    "subscription": {
      "__typename": "CopilotPaidSubscription",
      "id": "<id>",
      "state": "ACTIVE",
      "plan": {
        "__typename": "SubscriptionPlan",
        "type": "STANDARD",
        "amount": "<amount>",
        "interval": "YEAR",
        "id": "<id>"
      },
      "billing": {
        "__typename": "SubscriptionBilling",
        "nextPeriodAmount": "<amount>",
        "nextPeriodInterval": "YEAR",
        "currentPeriodAmount": "<amount>",
        "currentPeriodEndsAt": 1791918661000,
        "currentPeriodInterval": "YEAR",
        "paymentFailure": null,
        "paymentMethod": {
          "__typename": "AppleAppStorePaymentMethod",
          "id": "<id>"
        }
      },
      "promotions": []
    }
  }
}
```
