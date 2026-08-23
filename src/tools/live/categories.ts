/**
 * Live-mode get_categories_live tool.
 *
 * Fetches categories via GraphQL through the SnapshotCache<CategoryNode>
 * exposed by LiveCopilotDatabase (24h TTL). Always queries with
 * {budget: true} so PR #3 (Budgets) can project from the same cache.
 *
 * Output envelope mirrors the cache-mode get_categories shape (count,
 * categories) plus the freshness-envelope fields.
 *
 * v3 (#597 Tier 1): the embedded `budget` object ({current, histories} — a
 * full monthly series per category) is ~62% of a row and duplicates
 * get_budgets_live. It is EXCLUDED from the default row via the shared
 * field-selection engine (DEFAULT_CATEGORY_LIVE_FIELDS in
 * src/tools/field-selection.ts); the one number callers actually read,
 * `budget.current.amount`, is derived onto the row as `budget_amount` before
 * projection runs. `include_history` (unchanged) governs a separate
 * question — whether `budget.histories` is stripped when `budget` itself
 * ends up in the response, i.e. it only matters once a caller opts back in
 * via `fields: ["default", "budget"]`.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchCategories,
  type CategoryIcon,
  type CategoryBudget,
} from '../../core/graphql/queries/categories.js';
import type { ToolSchema } from '../tools.js';
import {
  DEFAULT_CATEGORY_LIVE_FIELDS,
  CATEGORY_LIVE_FIELDS_PARAM_SCHEMA,
  projectRows,
} from '../field-selection.js';

export interface GetCategoriesLiveArgs {
  excluded_only?: boolean;
  /**
   * Whether to include the per-category `budget.histories[]` array in the
   * response. Default: `false` — histories are stripped to keep the response
   * within the LLM tool-result token budget. The cache still stores the full
   * history; this only affects the serialized output. Set to `true` for
   * historical analysis or budget-trend charting.
   *
   * Orthogonal to `fields`: `budget` (the object this governs) is not on the
   * row at all unless `fields` explicitly asks for it (`"all"`/`"*"`, or
   * `["default", "budget"]`) — this flag only shapes it once it's there.
   */
  include_history?: boolean;
  fields?: string[];
}

// A `type` alias (not an interface) on purpose: type aliases carry an
// implicit index signature, so rows assign to the field-selection engine's
// `Record<string, unknown>` constraint without casts — same reasoning as
// EnrichedTransaction in src/tools/live/transactions.ts.
export type CategoryLiveRow = {
  id: string;
  parentId: string | null;
  name: string;
  templateId: string | null;
  colorName: string | null;
  icon: CategoryIcon | null;
  isExcluded: boolean;
  isRolloverDisabled: boolean;
  canBeDeleted: boolean;
  budget?: CategoryBudget | null;
  /** Derived from budget?.current?.amount before projection (#597 Tier 1). */
  budget_amount: number | null;
};

export interface GetCategoriesLiveResult {
  count: number;
  categories: CategoryLiveRow[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
  // Requested `fields` names that matched nothing (typos), when any.
  _field_warning?: string;
}

export class LiveCategoriesTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getCategories(args: GetCategoriesLiveArgs): Promise<GetCategoriesLiveResult> {
    const cache = this.live.getCategoriesCache();
    const startedAt = Date.now();
    const {
      rows: cached,
      fetched_at,
      hit,
    } = await cache.read(async () => {
      // Mirror the web app's per-user rollover-handling behavior: read the
      // user's actual `budgetingConfig.rolloversConfig.isEnabled` (cached
      // 24h on userCache) and forward it to the Categories query. See
      // audit finding C6.
      const rollovers = await this.live.resolveRolloversFlag();
      return fetchCategories(this.live.getClient(), { rollovers });
    });

    let rows = cached;
    if (args.excluded_only === true) {
      rows = rows.filter((c) => c.isExcluded === true);
    }

    // Sort by templateId then name. Categories with null templateId
    // (user-created, no system template) are pushed to the end via the
    // `￿` sentinel — system-template categories (Food, Rent, etc.) are
    // the primary grouping axis, with user-created categories as the long
    // tail. Empty arrays sort identically; this is intentional.
    rows = [...rows].sort((a, b) => {
      const t = (a.templateId ?? '￿').localeCompare(b.templateId ?? '￿');
      return t !== 0 ? t : a.name.localeCompare(b.name);
    });

    // Log after filter+sort so `rows` reflects what's returned to the caller,
    // not the raw cached count. Mirrors the LiveAccountsTools convention.
    this.live.logReadCall({
      op: 'Categories',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: rows.length,
      cache_hit: hit,
    });

    const includeHistory = args.include_history === true;
    // Default-strip budget.histories to keep response under the LLM token
    // budget (~25 KB). The cache still holds the full history — this is a
    // read-side projection only. Critical: shallow clone each row's budget
    // so we never mutate the cached references.
    const budgetShaped = includeHistory
      ? rows
      : rows.map((c) => (c.budget ? { ...c, budget: { ...c.budget, histories: [] } } : c));

    // Derive budget_amount BEFORE projectRows: the default preset excludes
    // `budget` entirely (#597 Tier 1), and once excluded the source is gone
    // — this is the derive-before-project rule, same pattern as
    // getInvestmentPrices in src/tools/tools.ts. Reads from budgetShaped so
    // it reflects whatever `budget.current` ended up being; current.amount
    // is unaffected by the histories-only strip above either way.
    const withBudgetAmount: CategoryLiveRow[] = budgetShaped.map((c) => ({
      ...c,
      budget_amount: c.budget?.current?.amount ?? null,
    }));

    // v3: omitting `fields` yields the terse preset (no `budget` object) —
    // request it explicitly with fields: ["default", "budget"], or take
    // everything with "all"/"*".
    const { rows: categories, warning } = projectRows(
      withBudgetAmount,
      args.fields ?? ['default'],
      {
        preset: DEFAULT_CATEGORY_LIVE_FIELDS,
        validFieldsHint:
          'the category row fields (id, parentId, name, templateId, colorName, icon, ' +
          'isExcluded, isRolloverDisabled, canBeDeleted, budget) plus the derived budget_amount',
      }
    );

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: categories.length,
      categories,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
      ...(warning && { _field_warning: warning }),
    };
  }
}

export function createLiveCategoriesToolSchema(): ToolSchema {
  return {
    name: 'get_categories_live',
    description:
      'Get user categories (live, GraphQL-backed), including each category id, parentId, and a ' +
      'derived `budget_amount`. IMPORTANT: `budget_amount` is the BUDGETED amount for the ' +
      'month — NOT the amount spent. To find actual spending in a category, call ' +
      'get_transactions_live with that category id and sum the transaction amounts; do not ' +
      'report the budget as spend. The budget data here is the same cache get_budgets_live ' +
      'reads from. Each row carries a `parentId` field: `null` for top-level categories ' +
      '(parents AND standalones), or the parent category id for children. To detect a parent ' +
      'specifically: build a Set of parent ids from the rows where `parentId !== null`. ' +
      'Default rows exclude the full `budget` object ({current, histories}) — see `fields` ' +
      'for how to get it back, and `include_history` for what it contains once you do. ' +
      'Replaces get_categories when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        excluded_only: {
          type: 'boolean',
          description: 'Return only categories marked as excluded. Default: false.',
          default: false,
        },
        include_history: {
          type: 'boolean',
          description:
            'Include per-category budget.histories array (multi-year monthly data) when the ' +
            '`budget` object is present in the response (it is not, by default — see `fields`). ' +
            'Default: false — stripped to keep the `budget` object under the LLM tool-result ' +
            'token budget. Set to true for trend analysis or budget-history queries.',
          default: false,
        },
        fields: CATEGORY_LIVE_FIELDS_PARAM_SCHEMA,
      },
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
