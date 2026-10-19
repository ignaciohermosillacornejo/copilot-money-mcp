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
   * Joined from the categories list by `categoryId`, loading it when the
   * cache is cold (#848). `null` when the row has no category or
   * its `categoryId` was not found
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
export const UPCOMING_RECURRING_LIVE_KNOWN_FIELDS: ReadonlySet<string> = new Set(
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
  // Partial: projected rows, so `rule` and `payments` are absent by default.
  upcoming: Partial<GetUpcomingRecurringsLiveRow>[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
  // Set when the categories read failed; category_name is then null throughout.
  _category_warning?: string;
}

export class LiveUpcomingRecurringsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getUpcomingRecurrings(
    args: GetUpcomingRecurringsLiveArgs
  ): Promise<GetUpcomingRecurringsLiveResult> {
    const cache = this.live.getUpcomingRecurringsCache();
    const startedAt = Date.now();
    // The rows and the category names are independent reads, so a cold call
    // pays the slower of the two, not their sum. Latency logged below is the
    // rows read alone, as before. A categories failure degrades to
    // category_name null plus `_category_warning` instead of failing the tool.
    let rowsLatencyMs = 0;
    const [{ rows: cached, fetched_at, hit }, categories] = await Promise.all([
      cache
        .read(() => fetchUpcomingRecurrings(this.live.getClient()))
        .then((r) => {
          rowsLatencyMs = Date.now() - startedAt;
          return r;
        }),
      this.live.loadCategoryNameMapOrWarn(),
    ]);
    const categoryNameById = categories.names;

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
      latencyMs: rowsLatencyMs,
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
      ...(categories.warning && { _category_warning: categories.warning }),
    };
  }
}

export function createLiveUpcomingRecurringsToolSchema(): ToolSchema {
  return {
    name: 'get_upcoming_recurrings_live',
    description:
      'Get the next-due recurring/subscription items — the "about to bill" view ' +
      '(live, GraphQL-backed). Returns unpaid upcoming payments sorted by due date ' +
      '(soonest first). HORIZON (unverified, #844, parity row REC-07): one read returned ' +
      'only rows due within about 14 days, with most configured recurrings absent, so do ' +
      'not treat this as "every bill left this month"; for bills due later, use ' +
      "get_recurring_live's nextPaymentDate. DISTINCT from `get_recurring_live`, which returns the " +
      'full set of configured/historical recurrings; use this tool when the user ' +
      'asks "what\'s coming up" or "what bills am I about to pay". ' +
      'Each row carries a `category_name` resolved from the categories list (loaded on ' +
      'first use); `null` when the row has no category or its category was deleted, and on ' +
      'every row if the categories read fails, which `_category_warning` then reports. ' +
      'Default rows are terse: id, name, state, frequency, nextPaymentAmount, ' +
      'nextPaymentDate, categoryId, category_name, emoji. That excludes `rule` (the ' +
      'server-side matcher config) and `payments` (only the NEXT scheduled payment, not a ' +
      'history; for past charges use get_transactions_live and match recurring_id), plus ' +
      '`icon` (redundant with `emoji`). ' +
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
