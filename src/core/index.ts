/**
 * Core functionality for Copilot Money data access.
 */

export { CopilotDatabase } from "./database.js";
export {
  decodeTransactions,
  decodeAccounts,
  decodeVarint,
  extractStringValue,
  extractDoubleValue,
  extractBooleanValue,
} from "./decoder.js";
