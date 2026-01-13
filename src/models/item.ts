/**
 * Item model for Copilot Money data.
 *
 * Represents Plaid item connections stored in Copilot's /users/{user_id}/items/{item_id}
 * Firestore collection. Each item represents a connection to a financial institution
 * (bank, credit union, brokerage) via Plaid.
 *
 * Items are the link between the user's accounts and the institution:
 * - One item can have multiple accounts (e.g., checking + savings at same bank)
 * - Items need periodic re-authentication when credentials change
 * - Items track connection health and error states
 */

import { z } from 'zod';

/**
 * Known connection statuses for Plaid items.
 */
export const CONNECTION_STATUSES = ['active', 'error', 'disconnected', 'pending'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * Known Plaid error codes that may affect items.
 * @see https://plaid.com/docs/errors/
 */
export const KNOWN_ERROR_CODES = [
  'ITEM_LOGIN_REQUIRED',
  'INVALID_CREDENTIALS',
  'INVALID_MFA',
  'ITEM_LOCKED',
  'ITEM_NO_ERROR',
  'ITEM_NOT_SUPPORTED',
  'NO_ACCOUNTS',
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NO_LONGER_SUPPORTED',
] as const;
export type PlaidErrorCode = (typeof KNOWN_ERROR_CODES)[number];

/**
 * Item schema with validation.
 *
 * Represents a Plaid item connection to a financial institution.
 */
export const ItemSchema = z
  .object({
    // Identification
    item_id: z.string(), // Plaid item ID (document ID in Firestore)
    user_id: z.string().optional(), // User who owns this item
    institution_id: z.string().optional(), // Plaid institution ID (e.g., "ins_3")
    institution_name: z.string().optional(), // Human-readable name (e.g., "Chase", "Wells Fargo")

    // Connection status
    connection_status: z.string().optional(), // "active", "error", "disconnected"
    last_successful_update: z.string().optional(), // ISO timestamp of last successful sync
    last_failed_update: z.string().optional(), // ISO timestamp of last failed sync
    consent_expiration_time: z.string().optional(), // When user consent expires

    // Error information
    error_code: z.string().optional(), // Plaid error code
    error_message: z.string().optional(), // Human-readable error message
    error_type: z.string().optional(), // Error type (e.g., "ITEM_ERROR")
    needs_update: z.boolean().optional(), // Flag indicating re-authentication needed

    // Account linkage
    accounts: z.array(z.string()).optional(), // Array of account IDs linked to this item
    account_count: z.number().optional(), // Number of accounts

    // Metadata
    available_products: z.array(z.string()).optional(), // Available Plaid products
    billed_products: z.array(z.string()).optional(), // Products billed for this item
    created_at: z.string().optional(), // When item was created
    updated_at: z.string().optional(), // Last update timestamp
    webhook: z.string().optional(), // Webhook URL for updates
  })
  .passthrough(); // Allow additional fields we haven't discovered yet

export type Item = z.infer<typeof ItemSchema>;

/**
 * Get the display name for an item (institution name or fallback).
 *
 * @param item - Item record
 * @returns Institution name or fallback string
 */
export function getItemDisplayName(item: Item): string {
  return item.institution_name ?? item.institution_id ?? item.item_id;
}

/**
 * Check if an item connection is healthy (active and no errors).
 *
 * @param item - Item record
 * @returns true if item is healthy
 */
export function isItemHealthy(item: Item): boolean {
  // Check explicit status
  if (item.connection_status) {
    if (item.connection_status !== 'active') {
      return false;
    }
  }

  // Check for error states
  if (item.needs_update === true) {
    return false;
  }

  if (item.error_code && item.error_code !== 'ITEM_NO_ERROR') {
    return false;
  }

  return true;
}

/**
 * Check if an item requires user attention (re-authentication needed).
 *
 * @param item - Item record
 * @returns true if item needs user attention
 */
export function itemNeedsAttention(item: Item): boolean {
  // Explicit needs_update flag
  if (item.needs_update === true) {
    return true;
  }

  // Error status
  if (item.connection_status === 'error' || item.connection_status === 'disconnected') {
    return true;
  }

  // Login required errors
  const loginRequiredCodes = ['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_MFA'];
  if (item.error_code && loginRequiredCodes.includes(item.error_code)) {
    return true;
  }

  return false;
}

/**
 * Get a human-readable status description for an item.
 *
 * @param item - Item record
 * @returns Status description string
 */
export function getItemStatusDescription(item: Item): string {
  if (isItemHealthy(item)) {
    return 'Connected';
  }

  if (item.error_code === 'ITEM_LOGIN_REQUIRED') {
    return 'Re-authentication required';
  }

  if (item.error_code === 'INVALID_CREDENTIALS') {
    return 'Invalid credentials';
  }

  if (item.error_code === 'INSTITUTION_DOWN') {
    return 'Institution temporarily unavailable';
  }

  if (item.error_code === 'INSTITUTION_NOT_RESPONDING') {
    return 'Institution not responding';
  }

  if (item.connection_status === 'disconnected') {
    return 'Disconnected';
  }

  if (item.connection_status === 'error') {
    return item.error_message ?? 'Connection error';
  }

  if (item.needs_update) {
    return 'Update required';
  }

  return item.connection_status ?? 'Unknown status';
}

/**
 * Get the number of accounts linked to an item.
 *
 * @param item - Item record
 * @returns Number of accounts
 */
export function getItemAccountCount(item: Item): number {
  if (item.account_count !== undefined) {
    return item.account_count;
  }
  if (item.accounts) {
    return item.accounts.length;
  }
  return 0;
}

/**
 * Format the last successful update time.
 *
 * @param item - Item record
 * @returns Formatted date string or undefined
 */
export function formatLastUpdate(item: Item): string | undefined {
  const timestamp = item.last_successful_update ?? item.updated_at;
  if (!timestamp) {
    return undefined;
  }

  try {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

/**
 * Check if item consent is expiring soon (within 30 days).
 *
 * @param item - Item record
 * @returns true if consent expires within 30 days
 */
export function isConsentExpiringSoon(item: Item): boolean {
  if (!item.consent_expiration_time) {
    return false;
  }

  try {
    const expirationDate = new Date(item.consent_expiration_time);
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    return expirationDate <= thirtyDaysFromNow;
  } catch {
    return false;
  }
}
