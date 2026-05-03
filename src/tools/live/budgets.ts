/**
 * Live-mode get_budgets_live tool.
 *
 * Projects per-category budgets from the SnapshotCache<CategoryNode>
 * (already populated by fetchCategories({budget: true}) — see
 * src/core/graphql/queries/categories.ts). No separate GraphQL query;
 * Copilot's GraphQL schema models budget as a field on Category, not a
 * top-level entity. The Phase 2 SnapshotCache<Budget> was a Firestore
 * artifact and is removed in this PR.
 *
 * Output envelope mirrors the cache-mode get_budgets shape (count,
 * total_budgeted, budgets[]) plus the freshness-envelope fields.
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';
import {
  fetchCategories,
  type CategoryNode,
} from '../../core/graphql/queries/categories.js';
import { roundAmount } from '../../utils/round.js';

export interface GetBudgetsLiveArgs {
  // Reserved for future filters (e.g., active_only).
}

export interface GetBudgetsLiveBudget {
  budget_id: string;
  category_id: string;
  category_name: string;
  amount?: number;
  amounts?: Record<string, number>;
}

export interface GetBudgetsLiveResult {
  count: number;
  total_budgeted: number;
  budgets: GetBudgetsLiveBudget[];
  _cache_oldest_fetched_at: string;
  _cache_newest_fetched_at: string;
  _cache_hit: boolean;
}

function parseAmount(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function projectCategory(cat: CategoryNode): GetBudgetsLiveBudget | null {
  const budget = cat.budget;
  if (!budget) return null;

  const amount = parseAmount(budget.current?.amount);
  const amounts: Record<string, number> = {};
  if (budget.current?.month) {
    const a = parseAmount(budget.current.amount);
    if (a !== undefined) amounts[budget.current.month] = a;
  }
  for (const h of budget.histories) {
    const a = parseAmount(h.amount);
    if (a !== undefined) amounts[h.month] = a;
  }

  // Skip rows with neither current nor history amounts (entirely empty)
  if (amount === undefined && Object.keys(amounts).length === 0) return null;

  return {
    budget_id: cat.id, // GraphQL has no per-budget id; use category id as the stable key
    category_id: cat.id,
    category_name: cat.name,
    ...(amount !== undefined ? { amount } : {}),
    ...(Object.keys(amounts).length > 0 ? { amounts } : {}),
  };
}

export class LiveBudgetsTools {
  constructor(private readonly live: LiveCopilotDatabase) {}

  async getBudgets(_args: GetBudgetsLiveArgs): Promise<GetBudgetsLiveResult> {
    const cache = this.live.getCategoriesCache();
    const startedAt = Date.now();
    const { rows: cats, fetched_at, hit } = await cache.read(() =>
      fetchCategories(this.live.getClient())
    );

    const projected: GetBudgetsLiveBudget[] = [];
    let totalBudgeted = 0;
    for (const cat of cats) {
      const row = projectCategory(cat);
      if (!row) continue;
      projected.push(row);
      if (row.amount !== undefined) totalBudgeted += row.amount;
    }

    // Sort by category_name for stable output (mirrors LiveCategoriesTools convention).
    projected.sort((a, b) => a.category_name.localeCompare(b.category_name));

    // Log after projection so `rows` reflects what's returned to the caller.
    this.live.logReadCall({
      op: 'Budgets',
      pages: hit ? 0 : 1,
      latencyMs: Date.now() - startedAt,
      rows: projected.length,
      cache_hit: hit,
    });

    const fetchedAtIso = new Date(fetched_at).toISOString();
    return {
      count: projected.length,
      total_budgeted: roundAmount(totalBudgeted),
      budgets: projected,
      _cache_oldest_fetched_at: fetchedAtIso,
      _cache_newest_fetched_at: fetchedAtIso,
      _cache_hit: hit,
    };
  }
}

export function createLiveBudgetsToolSchema() {
  return {
    name: 'get_budgets_live',
    description:
      "Get budgets from Copilot's native budget tracking (live, GraphQL-backed). " +
      'Projects per-category budgets from the categories cache — the same fetch that ' +
      'powers get_categories_live populates this. Replaces get_budgets when --live-reads is on.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  };
}
