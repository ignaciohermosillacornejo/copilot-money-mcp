/**
 * Shared helper for the LevelDB decoder. Returns null on Zod failure
 * (preserving caller contract) but emits a structured `console.warn` to
 * stderr so schema drops become auditable instead of silent.
 */

import type { ZodType } from 'zod';

export type DecodeContext = {
  collection: string;
  docId: string;
};

// Dedupe key = `${collection}::${firstIssue.path.join('.')}::${firstIssue.code}`.
// One warn per unique key per process. Prevents log flood when Copilot ships
// a new field shape that affects every doc in a collection. Note: only the
// first docId that hits a given key is logged — all subsequent docs with the
// same issue are silently dropped. If you need every offending docId, grep
// the cache with the logged path/code.
const warnedKeys = new Set<string>();

export function validateOrWarn<T>(schema: ZodType<T>, data: unknown, ctx: DecodeContext): T | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  // Zod always provides ≥1 issue on failure; guard is defensive only.
  const first = result.error.issues[0];
  if (first) {
    const pathStr = first.path.join('.');
    const key = `${ctx.collection}::${pathStr}::${first.code}`;
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      // console.warn writes to stderr in Node, safe for MCP stdio transport.
      // console.log would corrupt the JSON-RPC protocol on stdout.
      // `message` may include the received value for enum issues; current
      // schemas only enum over system-controlled strings (account_type,
      // frequency, etc.), and stderr stays local to the user's machine.
      console.warn(
        `[copilot-money-mcp] schema drop: collection=${ctx.collection} docId=${ctx.docId} path=${pathStr} code=${first.code} message="${first.message}"`
      );
    }
  }
  return null;
}

// Exposed for tests only.
export function __resetWarnedKeys(): void {
  warnedKeys.clear();
}
