/**
 * Investment Performance model for Copilot Money data.
 *
 * Represents investment performance metadata and time-weighted return (TWR)
 * holding data stored in Copilot's Firestore collections:
 * - /investment_performance (top-level metadata)
 * - /investment_performance/{hash} (per-security docs)
 * - /investment_performance/{hash}/twr_holding (monthly TWR data)
 */

import { z } from 'zod';

/**
 * Investment Performance schema for top-level and per-security docs.
 *
 * Contains metadata about investment performance tracking,
 * including security identification and access control.
 */
export const InvestmentPerformanceSchema = z
  .object({
    performance_id: z.string(),
    security_id: z.string().optional(),
    type: z.string().optional(),
    user_id: z.string().optional(),
    access: z.array(z.string()).optional(),
    position: z.number().optional(),
    last_update: z.string().optional(),
  })
  .passthrough();

export type InvestmentPerformance = z.infer<typeof InvestmentPerformanceSchema>;

/**
 * TWR (Time-Weighted Return) Holding schema for monthly performance data.
 *
 * Each document represents one month of TWR data for a specific security,
 * with history containing epoch-ms keyed entries mapping to { value: number }.
 */
export const TwrHoldingSchema = z
  .object({
    twr_id: z.string(),
    security_id: z.string().optional(),
    month: z.string().optional(),
    history: z.record(z.string(), z.object({ value: z.number() }).passthrough()).optional(),
  })
  .passthrough();

export type TwrHolding = z.infer<typeof TwrHoldingSchema>;
