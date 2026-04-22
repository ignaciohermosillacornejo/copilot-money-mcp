/**
 * Amazon integration models — Amazon order data linked to Copilot transactions.
 *
 * Firestore paths:
 *   amazon/{id}        — Amazon integration metadata per user
 *   amazon/{id}/orders — Individual order details
 */

import { z } from 'zod';

export const AmazonIntegrationSchema = z
  .object({
    amazon_id: z.string(),
  })
  .passthrough();

export type AmazonIntegration = z.infer<typeof AmazonIntegrationSchema>;

const AmazonOrderItemSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    price: z.number().optional(),
    quantity: z.number().optional(),
    link: z.string().optional(),
  })
  .passthrough();

export const AmazonOrderSchema = z
  .object({
    order_id: z.string(),
    // Copilot also stores the same ID under `id` on the order doc — preserved
    // verbatim so downstream consumers that dereference the raw doc still work.
    id: z.string().optional(),
    // Copilot's linked transaction ID. Set once Copilot matches this Amazon
    // order to a posted transaction; used to join item-level receipts to spend.
    copilot_tx: z.string().optional(),
    amazon_user_id: z.string().optional(),
    date: z.string().optional(),
    account_id: z.string().optional(),
    match_state: z.string().optional(),
    items: z.array(AmazonOrderItemSchema).optional(),
    details: z
      .object({
        beforeTax: z.number().optional(),
        shipping: z.number().optional(),
        subtotal: z.number().optional(),
        tax: z.number().optional(),
        total: z.number().optional(),
      })
      .passthrough()
      .optional(),
    payment: z
      .object({
        card: z.string().optional(),
      })
      .passthrough()
      .optional(),
    transactions: z.array(z.string()).optional(),
  })
  .passthrough();

export type AmazonOrder = z.infer<typeof AmazonOrderSchema>;
