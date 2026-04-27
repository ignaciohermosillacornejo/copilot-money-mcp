/**
 * MCP tool: refresh_cache (live-mode only).
 *
 * Flushes the in-memory live cache by scope. Does NOT touch LevelDB —
 * refresh_database is the LevelDB equivalent and remains untouched.
 *
 * See docs/superpowers/specs/2026-04-24-graphql-live-tiered-cache-design.md
 * §"Refresh API".
 */

import type { LiveCopilotDatabase } from '../../core/live-database.js';

const VALID_SCOPES = [
  'all',
  'transactions',
  'accounts',
  'categories',
  'tags',
  'budgets',
  'recurring',
] as const;

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type Scope = (typeof VALID_SCOPES)[number];

export interface RefreshCacheArgs {
  scope?: Scope;
  months?: string[];
}

export interface RefreshCacheResult {
  flushed: {
    accounts?: boolean;
    categories?: boolean;
    tags?: boolean;
    budgets?: boolean;
    recurring?: boolean;
    transactions_months?: string[] | 'all';
  };
}

export class RefreshCacheTool {
  constructor(private readonly live: LiveCopilotDatabase) {}

  refresh(args: RefreshCacheArgs): Promise<RefreshCacheResult> {
    const scope: Scope = args.scope ?? 'all';
    if (!VALID_SCOPES.includes(scope)) {
      return Promise.reject(
        new Error(`Unknown scope '${scope}'. Valid scopes: ${VALID_SCOPES.join(', ')}.`)
      );
    }

    if (args.months) {
      const bad = args.months.find((m) => !YEAR_MONTH_RE.test(m));
      if (bad !== undefined) {
        return Promise.reject(
          new Error(`Invalid month format '${bad}'. Expected YYYY-MM (e.g., '2026-04').`)
        );
      }
    }

    const flushed: RefreshCacheResult['flushed'] = {};

    const flushSnapshots = () => {
      this.live.getAccountsCache().invalidate();
      flushed.accounts = true;
      this.live.getCategoriesCache().invalidate();
      flushed.categories = true;
      this.live.getTagsCache().invalidate();
      flushed.tags = true;
      this.live.getBudgetsCache().invalidate();
      flushed.budgets = true;
      this.live.getRecurringCache().invalidate();
      flushed.recurring = true;
    };

    const flushTransactions = () => {
      const months = args.months;
      this.live.getTransactionsWindowCache().invalidate(months ?? 'all');
      flushed.transactions_months = months ?? 'all';
    };

    switch (scope) {
      case 'all':
        flushSnapshots();
        flushTransactions();
        break;
      case 'transactions':
        flushTransactions();
        break;
      case 'accounts':
        this.live.getAccountsCache().invalidate();
        flushed.accounts = true;
        break;
      case 'categories':
        this.live.getCategoriesCache().invalidate();
        flushed.categories = true;
        break;
      case 'tags':
        this.live.getTagsCache().invalidate();
        flushed.tags = true;
        break;
      case 'budgets':
        this.live.getBudgetsCache().invalidate();
        flushed.budgets = true;
        break;
      case 'recurring':
        this.live.getRecurringCache().invalidate();
        flushed.recurring = true;
        break;
    }

    return Promise.resolve({ flushed });
  }
}

export function createRefreshCacheToolSchema() {
  return {
    name: 'refresh_cache',
    description:
      'Flush the in-memory live cache by scope. Use when the user explicitly wants fresh data despite TTLs. Does not touch LevelDB (use refresh_database for that). Live-reads mode only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: VALID_SCOPES,
          description: 'Which slice of the live cache to flush. Default: all.',
          default: 'all',
        },
        months: {
          type: 'array',
          items: { type: 'string' },
          description: 'YYYY-MM month list. Only meaningful when scope is "all" or "transactions".',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
    },
  };
}
