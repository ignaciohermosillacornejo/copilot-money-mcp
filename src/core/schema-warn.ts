/**
 * Shared helper for the LevelDB decoder. Replaces silent
 * `safeParse → return null` patterns with a version that still returns
 * null on failure (preserving caller contract) but emits a structured
 * `console.warn` to stderr so schema drops become auditable.
 *
 * Motivation: PR #302 / issue #306 were latent for months because
 * `processAccount` silently dropped accounts on Zod failure, with zero
 * signal anywhere. See issue #309 for the full background.
 */

import type { ZodType } from 'zod';

export type DecodeContext = {
  collection: string;
  docId: string;
};

// Dedupe key = `${collection}::${firstIssue.path.join('.')}::${firstIssue.code}`.
// One warn per unique key per process. Prevents log flood when Copilot ships
// a new field shape that affects every doc in a collection.
const warnedKeys = new Set<string>();

export function validateOrWarn<T>(schema: ZodType<T>, data: unknown, ctx: DecodeContext): T | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const first = result.error.issues[0];
  if (first) {
    const pathStr = first.path.join('.');
    const key = `${ctx.collection}::${pathStr}::${first.code}`;
    if (!warnedKeys.has(key)) {
      warnedKeys.add(key);
      // console.warn writes to stderr in Node, safe for MCP stdio transport.
      // console.log would corrupt the JSON-RPC protocol on stdout.
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
