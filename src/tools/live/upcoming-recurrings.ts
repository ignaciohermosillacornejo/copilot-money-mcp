/**
 * Live-mode get_upcoming_recurrings_live tool.
 *
 * Fetches the next-due recurring/subscription items ("about to bill" view)
 * via the GraphQL UpcomingRecurrings query through a SnapshotCache with a
 * 1h TTL. Items move out of this view as bills get paid throughout the day,
 * so the TTL is intentionally shorter than the configured/historical
 * recurringCache (6h).
 *
 * This is distinct from get_recurring_live, which exposes the full set of
 * user-confirmed recurrings (configured/historical view). Use this tool to
 * answer "what's about to bill", and use get_recurring_live to answer
 * "what subscriptions do I have".
 *
 * v3 (#597 Tier 1): same row shape as get_recurring_live, and the same
 * `rule`/`payments`/`icon` exclusions apply — see the rationale in
 * src/tools/live/recurring.ts. The `fields` schema fragment
 * (RECURRING_FIELDS_PARAM_SCHEMA) is shared verbatim with that tool so the
 * two descriptions cannot drift.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import { fetchUpcomingRecurrings } from '../../core/graphql/queries/upcoming-recurrings.js';
import type {
  RecurringIcon,
  RecurringRuleNode,
  RecurringPaymentNode,
} from '../../core/graphql/queries/recurrings.js';
import type { ToolSchema } from '../tools.js';
import {
  DEFAULT_RECURRING_LIVE_FIELDS,
  RECURRING_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';

export interface GetUpcomingRecurringsLiveArgs {
  // No filters yet; reserved for future args.
  fields?: string[];
}

// A `type` alias written as a flat object literal (not `UpcomingRecurringNode
// & {...}`, and not an interface) on purpose — an intersection with an
// interface does NOT carry an implicit index signature, so rows would fail
// to assign to the field-selection engine's `Record<string, unknown>`
// constraint. Same reasoning as GetRecurringLiveRow in
// src/tools/live/recurring.ts (structurally identical row shape — kept as a
// separate type so each tool's known-field set stays self-contained).
export type GetUpcomingRecurringsLiveRow = {
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
   * if the category for this row's `categoryId` was not found
   * (e.g., deleted upstream). Mirrors `get_recurring_live`'s same join.
   */
  category_name: string | null;
};

/**
 * Every selectable field name on an upcoming-recurring row, derived from
 * {@link GetUpcomingRecurringsLiveRow} itself via a mapped-type record — same
 * reasoning as RECURRING_LIVE_FIELD_NAMES in src/tools/live/recurring.ts.
 */
const UPCOMING_RECURRING_LIVE_FIELD_NAMES: {
  [K in keyof GetUpcomingRecurringsLiveRow]-?: true;
} = {
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
const UPCOMING_RECURRING_LIVE_KNOWN_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(UPCOMING_RECURRING_LIVE_FIELD_NAMES)
);

/**
 * Built FROM the known-field set rather than hand-listed — see the identical
 * reasoning on CATEGORY_LIVE_VALID_FIELDS_HINT in src/tools/live/categories.ts.
 */
const UPCOMING_RECURRING_LIVE_VALID_FIELDS_HINT =
  `the upcoming-recurring row fields (${[...UPCOMING_RECURRING_LIVE_KNOWN_FIELDS].join(', ')}) — ` +
  'category_name is derived from a categoriesCache join; the rest come from the wire';

export interface GetUpcomingRecurringsLiveResult {
  count: number;
  upcoming: GetUpcomingRecurringsLiveRow[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
}

export class LiveUpcomingRecurringsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getUpcomingRecurrings(
    args: GetUpcomingRecurringsLiveArgs
  ): Promise<GetUpcomingRecurringsLiveResult> {
    const cache = this.live.getUpcomingRecurringsCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(() => fetchUpcomingRecurrings(this.live.getClient()));

    const categoryNameById = this.live.peekCategoryNameMap();

    const rows: GetUpcomingRecurringsLiveRow[] = cached
      .map((r) => ({
        ...r,
        category_name: r.categoryId ? (categoryNameById.get(r.categoryId) ?? null) : null,
      }))
      .sort((a, b) => {
        // Soonest-due first; rows with null nextPaymentDate sort to the end.
        if (a.nextPaymentDate === null && b.nextPaymentDate === null) return 0;
        if (a.nextPaymentDate === null) return 1;
        if (b.nextPaymentDate === null) return -1;
        return a.nextPaymentDate.localeCompare(b.nextPaymentDate);
      });

    this.live.logReadCall({
      op: 'UpcomingRecurrings',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    // v3: omitting `fields` yields the terse preset (no `rule`/`payments`) —
    // request them explicitly with fields: ["default", "rule", "payments"],
    // or take everything with "all"/"*".
    const { rows: upcoming, warning } = projectRows(rows, args.fields ?? ['default'], {
      preset: DEFAULT_RECURRING_LIVE_FIELDS,
      knownFields: UPCOMING_RECURRING_LIVE_KNOWN_FIELDS,
      validFieldsHint: UPCOMING_RECURRING_LIVE_VALID_FIELDS_HINT,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: upcoming.length,
      upcoming,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
      ...(warning && { _field_warning: warning }),
    };
  }
}

export function createLiveUpcomingRecurringsToolSchema(): ToolSchema {
  return {
    name: 'get_upcoming_recurrings_live',
    description:
      'Get the next-due recurring/subscription items — the "about to bill" view ' +
      '(live, GraphQL-backed). Returns unpaid upcoming payments sorted by due date ' +
      '(soonest first). DISTINCT from `get_recurring_live`, which returns the ' +
      'full set of configured/historical recurrings; use this tool when the user ' +
      'asks "what\'s coming up" or "what bills am I about to pay". ' +
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
