/**
 * App metadata schemas for small operational Firestore collections.
 *
 * These cover subscriptions, invites, user_items, feature_tracking, and support —
 * tiny collections (1-2 docs each) that store app-level configuration rather than
 * financial data. All use .passthrough() since the exact field set may evolve.
 */

import { z } from 'zod';

export const SubscriptionSchema = z
  .object({
    subscription_id: z.string(),
    product_id: z.string().optional(),
    provider: z.string().optional(),
    environment: z.string().optional(),
    price: z.number().optional(),
    user_id: z.string().optional(),
    will_auto_renew: z.boolean().optional(),
    is_eligible_for_initial_offer: z.boolean().optional(),
    expires_date_ms: z.string().optional(),
    created_timestamp: z.string().optional(),
    original_transaction_id: z.string().optional(),
  })
  .passthrough();
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const InviteSchema = z
  .object({
    invite_id: z.string(),
    code: z.string().optional(),
    inviter_id: z.string().optional(),
    is_available: z.boolean().optional(),
    is_unlimited: z.boolean().optional(),
    assigned: z.boolean().optional(),
    product_id: z.string().optional(),
    offer_reviewed: z.boolean().optional(),
  })
  .passthrough();
export type Invite = z.infer<typeof InviteSchema>;

export const UserItemsSchema = z
  .object({
    user_items_id: z.string(),
  })
  .passthrough();
export type UserItems = z.infer<typeof UserItemsSchema>;

export const FeatureTrackingSchema = z
  .object({
    feature_tracking_id: z.string(),
  })
  .passthrough();
export type FeatureTracking = z.infer<typeof FeatureTrackingSchema>;

export const SupportSchema = z
  .object({
    support_id: z.string(),
  })
  .passthrough();
export type Support = z.infer<typeof SupportSchema>;
