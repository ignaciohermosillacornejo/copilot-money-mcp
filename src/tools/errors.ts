import { GraphQLError } from '../core/graphql/client.js';

/**
 * Appended when a mutation failed in a way that does not prove the write
 * went unprocessed (timeout after send, mid-flight reset, 5xx). The client
 * never auto-retries these (issue #443); the caller must verify first.
 */
const WRITE_AMBIGUITY_WARNING =
  'WARNING: this was a write and it may or may not have applied on the server — ' +
  'verify the current state (re-read the entity) before retrying.';

/** "after N attempts" fragment when the client already retried (issue #443). */
function attemptsNote(e: GraphQLError): string {
  return e.attempts > 1 ? ` after ${e.attempts} attempts` : '';
}

/**
 * Map a classified GraphQLError to a user-facing message with the RIGHT
 * attribution (issue #441):
 *  - SCHEMA_ERROR        → this tool's model of the API may be outdated
 *  - USER_ACTION_REQUIRED → the server rejected the request (server's reason)
 *  - NETWORK             → transient, retry
 *
 * Every branch surfaces the server's raw error text (already truncated by the
 * GraphQL client) so failures are diagnosable without re-running with logging.
 */
export function graphQLErrorToMcpError(e: GraphQLError): string {
  switch (e.code) {
    case 'AUTH_FAILED':
      return `Authentication with Copilot failed. Sign in to the Copilot web app and try again. (server said: ${e.message})`;
    case 'SCHEMA_ERROR':
      return (
        "This tool's model of Copilot's API may be outdated — run `bun run smoke` " +
        `and report this issue with the text below.\nServer said: ${e.message}`
      );
    case 'USER_ACTION_REQUIRED':
      return `Copilot's server rejected the request: ${e.message}`;
    case 'SERVER_ERROR': {
      const base = `Copilot's server failed to process the request (HTTP ${e.httpStatus ?? 'unknown'})${attemptsNote(e)}.`;
      const advice = e.writeMayHaveApplied
        ? ` ${WRITE_AMBIGUITY_WARNING}`
        : ' This may be transient — retry.';
      return `${base}${advice} Server said: ${e.message}`;
    }
    case 'NETWORK':
      if (e.writeMayHaveApplied) {
        return `Network failure while sending a write to Copilot. ${WRITE_AMBIGUITY_WARNING} (${e.message})`;
      }
      return `Transient network problem contacting Copilot${attemptsNote(e)} — retry. (${e.message})`;
    case 'UNKNOWN':
    default:
      return `Copilot API request failed: ${e.message}`;
  }
}

/**
 * Arguments removed in v3, mapped to the migration hint for each. Consumed
 * by {@link rejectRemovedArgs}; `get_accounts`' retired `include_logos` is
 * the only entry (#597 Tier 2). Tool-scoped on purpose: `get_transactions`'
 * retired `compact` reuses {@link rejectRemovedArgs}, the generic half, and
 * carries its own {@link REMOVED_TRANSACTION_ARGS} rather than widening this
 * map, whose name would then be a lie about what a caller of `get_accounts`
 * can trip over.
 */
export const REMOVED_ACCOUNT_ARGS = {
  // Covers BOTH audiences, because the guard fires on PRESENCE: a caller
  // passing `include_logos: false` (the pre-v3 default — "keep logos out")
  // already has what it wants and needs to hear "drop the argument", not
  // "turn logos on". An earlier revision said only the latter, which
  // misadvised the larger half of the callers it fires on.
  include_logos:
    'logos are excluded by default now, so drop the argument; ' +
    'pass fields: ["default", "logo", "logo_content_type"] to include them',
} as const;

/**
 * Arguments removed from `get_transactions` in v3 (#604). Sibling of
 * {@link REMOVED_ACCOUNT_ARGS} rather than an entry in it: the two tools
 * retire different arguments, and a `compact` key inside a map named
 * `..._ACCOUNT_ARGS` would make that name a lie. {@link rejectRemovedArgs} is
 * the half that is shared.
 */
export const REMOVED_TRANSACTION_ARGS = {
  // Both audiences again (see REMOVED_ACCOUNT_ARGS): the guard fires on
  // PRESENCE, so `compact: false` throws too — and that caller was asking for
  // FULL rows, which is now the one shape omitting `fields` does not give.
  // Hence the hint leads with the token that restores what each caller had:
  // "all" for the compact:false caller, the default preset for compact:true.
  compact:
    'rows are terse by default now, so a caller that passed compact: true can just drop ' +
    'the argument; pass fields: ["all"] for the full document, or name the fields you want ' +
    'with fields: ["default", "user_note", ...]',
} as const;

/**
 * Throw a migration error when a caller passes an argument removed in v3.
 *
 * Nothing else enforces this: `additionalProperties: false` sits only on
 * write-tool schemas and the server runs no input validator, so a removed
 * argument would otherwise be dropped in silence — an out-of-date caller
 * would just see their fields disappear with no explanation. Call this at
 * the top of a tool handler, before any other argument handling.
 */
export function rejectRemovedArgs(
  args: Record<string, unknown>,
  removed: Record<string, string>
): void {
  for (const [name, hint] of Object.entries(removed)) {
    if (name in args) {
      throw new Error(`\`${name}\` was removed in v3.0.0 — ${hint}.`);
    }
  }
}
