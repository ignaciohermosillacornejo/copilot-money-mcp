/**
 * Live-mode get_recurring_live tool.
 *
 * Fetches user-confirmed recurring/subscription items via GraphQL through
 * the SnapshotCache<RecurringNode> exposed by LiveCopilotDatabase (6h TTL).
 *
 * NOTE: This is a strict subset of the cache-mode get_recurring_transactions
 * tool. The cache-mode tool combines (1) pattern-based detection from
 * transactions and (2) user-confirmed Copilot subscriptions. The GraphQL
 * Recurrings query exposes only (2). Pattern-based detection is not
 * available in --live-reads mode; users who need it should run without
 * --live-reads or use get_transactions_live + their own grouping.
 *
 * v3 (#597 Tier 1): `rule` (the server-side matcher config) and `payments`
 * (the full payment history, which duplicates get_transactions) are, per
 * the #597 audit, together ~45% of a row. Both are EXCLUDED from the
 * default row via the shared field-selection engine
 * (DEFAULT_RECURRING_LIVE_FIELDS in src/tools/field-selection.ts); `icon` is
 * also dropped since `emoji` already carries the display character.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchRecurrings,
  type RecurringIcon,
  type RecurringRuleNode,
  type RecurringPaymentNode,
} from '../../core/graphql/queries/recurrings.js';
import type { ToolSchema } from '../tools.js';
import {
  DEFAULT_RECURRING_LIVE_FIELDS,
  RECURRING_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';

export interface GetRecurringLiveArgs {
  // No filters yet; reserved for future args (e.g., state filter).
  fields?: string[];
}

// A `type` alias written as a flat object literal (not `RecurringNode &
// {...}`, and not an interface) on purpose: a plain object-literal type
// carries an implicit index signature, so rows assign to the
// field-selection engine's `Record<string, unknown>` constraint without
// casts. An intersection with an interface (`RecurringNode & {...}`) does
// NOT get this treatment — TypeScript still requires an explicit index
// signature on the intersected interface side — so the fields are spelled
// out here rather than intersected. Same reasoning as EnrichedTransaction in
// src/tools/live/transactions.ts and CategoryLiveRow in
// src/tools/live/categories.ts.
export type GetRecurringLiveRow = {
  id: string;
  name: string;
  state: string;
  frequency: string;
  nextPaymentAmount: number | null;
  nextPaymentDate: string | null;
  categoryId: string | null;
  emoji: string | null;
  icon: RecurringIcon | null;
  rule: RecurringRuleNode | null;
  payments: RecurringPaymentNode[];
  /**
   * Joined from `categoriesCache.peek()` by `categoryId`. `null` if the
   * categories cache is cold (no fetch is triggered to populate it) or
   * if the category for this recurring's `categoryId` was not found
   * (e.g., deleted upstream). Mirrors `get_transactions_live`'s same join.
   */
  category_name: string | null;
};

/**
 * Every selectable field name on a recurring row, derived from
 * {@link GetRecurringLiveRow} itself (not a sample row) via a mapped-type
 * record: the `[K in keyof ...]-?: true` shape forces this object literal to
 * carry exactly the interface's keys, so a forgotten or renamed field is a
 * compile error instead of a silent runtime desync. Without an explicit
 * knownFields set, projectRows falls back to row-key detection, which
 * cannot warn on a typo'd field name when the result set is empty — same
 * reasoning as TOP_MOVER_KNOWN_FIELDS in src/tools/live/top-movers.ts.
 */
const RECURRING_LIVE_FIELD_NAMES: { [K in keyof GetRecurringLiveRow]-?: true } = {
  id: true,
  name: true,
  state: true,
  frequency: true,
  nextPaymentAmount: true,
  nextPaymentDate: true,
  categoryId: true,
  emoji: true,
  icon: true,
  rule: true,
  payments: true,
  category_name: true,
};
export const RECURRING_LIVE_KNOWN_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(RECURRING_LIVE_FIELD_NAMES)
);

/**
 * Built FROM the known-field set rather than hand-listed — see the identical
 * reasoning on CATEGORY_LIVE_VALID_FIELDS_HINT in src/tools/live/categories.ts.
 */
const RECURRING_LIVE_VALID_FIELDS_HINT =
  `the recurring node fields (${[...RECURRING_LIVE_KNOWN_FIELDS].join(', ')}) — ` +
  'category_name is derived from a categoriesCache join; the rest come from the wire';

export interface GetRecurringLiveResult {
  count: number;
  // Partial: projected rows, so `rule` and `payments` are absent by default.
  recurring: Partial<GetRecurringLiveRow>[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
}

export class LiveRecurringTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getRecurring(args: GetRecurringLiveArgs): Promise<GetRecurringLiveResult> {
    const cache = this.live.getRecurringCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchRecurrings(this.live.getClient()));

    const categoryNameById = this.live.peekCategoryNameMap();

    const rows: GetRecurringLiveRow[] = cached
      .map((r) => ({
        ...r,
        category_name: r.categoryId ? (categoryNameById.get(r.categoryId) ?? null) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.live.logReadCall({
      op: 'Recurrings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    // v3: omitting `fields` yields the terse preset (no `rule`/`payments`) —
    // request them explicitly with fields: ["default", "rule", "payments"],
    // or take everything with "all"/"*".
    const { rows: recurring, warning } = projectRows(rows, args.fields ?? ['default'], {
      preset: DEFAULT_RECURRING_LIVE_FIELDS,
      knownFields: RECURRING_LIVE_KNOWN_FIELDS,
      validFieldsHint: RECURRING_LIVE_VALID_FIELDS_HINT,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: recurring.length,
      recurring,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
      ...(warning && { _field_warning: warning }),
    };
  }
}

export function createLiveRecurringToolSchema(): ToolSchema {
  return {
    name: 'get_recurring_live',
    description:
      'Get user-confirmed recurring/subscription items (live, GraphQL-backed). ' +
      'Replaces get_recurring_transactions when --live-reads is on. ' +
      "NOTE: pattern-based detection from transactions is NOT included — only Copilot's " +
      'native subscription tracking. Run without --live-reads if you need pattern detection. ' +
      'Each row carries a `category_name` field joined from the categories cache; ' +
      '`null` if the cache is cold or the category was deleted upstream. ' +
      'To guarantee `category_name` is populated, call `get_categories_live` first ' +
      'in the same session to warm the cache. ' +
      'Default rows are terse: id, name, state, frequency, nextPaymentAmount, ' +
      'nextPaymentDate, categoryId, category_name, emoji. That excludes `rule` (the ' +
      'server-side matcher config) and `payments` (full payment history — the same charges ' +
      'are queryable via get_transactions_live), plus `icon` (redundant with `emoji`). ' +
      'See `fields` for how to get any of them back.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fields: RECURRING_FIELDS_PARAM_SCHEMA,
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
