/**
 * A database path for tests that construct a `CopilotDatabase` or
 * `CopilotMoneyServer` but never read the cache.
 *
 * Without one, the constructor hands `undefined` to `findCopilotDatabase()`,
 * which walks the user's real Copilot Money container. That walk is bimodal —
 * usually sub-millisecond, ~0.1% of the time a multi-second block ending in
 * `EINTR` — so it puts bun's default test timeout inside tests that never
 * wanted the filesystem (#756). `tests/no-ambient-database-discovery.test.ts`
 * forbids the no-path forms; this is the one spelling of the remedy, so the
 * reason has one home instead of a copy per test file.
 *
 * Under `/nonexistent` on purpose: nothing creates it, so a test that does
 * reach the filesystem with it finds plain absence, never someone's data.
 */
export const SYNTHETIC_DB_PATH = '/nonexistent/copilot-money-mcp/synthetic-db';
