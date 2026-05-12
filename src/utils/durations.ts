/**
 * Centralized millisecond constants for TTLs and time arithmetic.
 * Imported by `LiveCopilotDatabase` and live-tool modules; do not duplicate
 * these constants in individual tools.
 */
export const FIVE_MIN_MS = 5 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;
export const SIX_HOURS_MS = 6 * ONE_HOUR_MS;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
export const ONE_WEEK_MS = 7 * ONE_DAY_MS;
