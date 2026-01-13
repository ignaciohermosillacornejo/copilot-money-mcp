/**
 * MCP server for Copilot Money.
 *
 * Exposes financial data through the Model Context Protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CopilotDatabase } from './core/database.js';
import { CopilotMoneyTools, createToolSchemas } from './tools/index.js';

/**
 * MCP server for Copilot Money data.
 */
export class CopilotMoneyServer {
  private db: CopilotDatabase;
  private tools: CopilotMoneyTools;
  private server: Server;

  /**
   * Initialize the MCP server.
   *
   * @param dbPath - Optional path to LevelDB database.
   *                If undefined, uses default Copilot Money location.
   */
  constructor(dbPath?: string) {
    this.db = new CopilotDatabase(dbPath);
    this.tools = new CopilotMoneyTools(this.db);
    this.server = new Server(
      {
        name: 'copilot-money-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerHandlers();
  }

  /**
   * Handle list tools request.
   * Exposed for testing purposes.
   */
  handleListTools(): { tools: Tool[] } {
    const schemas = createToolSchemas();
    const tools: Tool[] = schemas.map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      annotations: schema.annotations,
    }));

    return { tools };
  }

  /**
   * Handle tool call request.
   * Exposed for testing purposes.
   *
   * @param name - Tool name
   * @param typedArgs - Tool arguments
   */
  handleCallTool(name: string, typedArgs?: Record<string, unknown>): CallToolResult {
    // Check if database is available
    if (!this.db.isAvailable()) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Database not available. Please ensure Copilot Money is installed ' +
              'and has created local data, or provide a custom database path.',
          },
        ],
      };
    }

    try {
      let result: unknown;

      // Route to appropriate tool handler
      switch (name) {
        case 'get_transactions':
          result = this.tools.getTransactions(
            (typedArgs as Parameters<typeof this.tools.getTransactions>[0]) || {}
          );
          break;

        case 'search_transactions': {
          const query = typedArgs?.query;
          if (typeof query !== 'string') {
            throw new Error('Missing required parameter: query');
          }
          result = this.tools.searchTransactions(query, {
            limit: typedArgs?.limit as number | undefined,
            period: typedArgs?.period as string | undefined,
            start_date: typedArgs?.start_date as string | undefined,
            end_date: typedArgs?.end_date as string | undefined,
          });
          break;
        }

        case 'get_accounts':
          result = this.tools.getAccounts(typedArgs?.account_type as string | undefined);
          break;

        case 'get_spending_by_category':
          result = this.tools.getSpendingByCategory(
            (typedArgs as Parameters<typeof this.tools.getSpendingByCategory>[0]) || {}
          );
          break;

        case 'get_account_balance': {
          const accountId = typedArgs?.account_id;
          if (typeof accountId !== 'string') {
            throw new Error('Missing required parameter: account_id');
          }
          result = this.tools.getAccountBalance(accountId);
          break;
        }

        case 'get_categories':
          result = this.tools.getCategories();
          break;

        case 'get_recurring_transactions':
          result = this.tools.getRecurringTransactions(
            (typedArgs as Parameters<typeof this.tools.getRecurringTransactions>[0]) || {}
          );
          break;

        case 'get_budgets':
          result = this.tools.getBudgets(
            (typedArgs as Parameters<typeof this.tools.getBudgets>[0]) || {}
          );
          break;

        case 'get_goals':
          result = this.tools.getGoals(
            (typedArgs as Parameters<typeof this.tools.getGoals>[0]) || {}
          );
          break;

        case 'get_goal_progress':
          result = this.tools.getGoalProgress(
            (typedArgs as Parameters<typeof this.tools.getGoalProgress>[0]) || {}
          );
          break;

        case 'get_goal_history': {
          const goalId = typedArgs?.goal_id;
          if (typeof goalId !== 'string') {
            throw new Error('Missing required parameter: goal_id');
          }
          result = this.tools.getGoalHistory({
            goal_id: goalId,
            start_month: typedArgs?.start_month as string | undefined,
            end_month: typedArgs?.end_month as string | undefined,
            limit: typedArgs?.limit as number | undefined,
          });
          break;
        }

        case 'estimate_goal_completion':
          result = this.tools.estimateGoalCompletion(
            (typedArgs as Parameters<typeof this.tools.estimateGoalCompletion>[0]) || {}
          );
          break;

        case 'get_goal_contributions': {
          const goalIdContrib = typedArgs?.goal_id;
          if (typeof goalIdContrib !== 'string') {
            throw new Error('Missing required parameter: goal_id');
          }
          result = this.tools.getGoalContributions({
            goal_id: goalIdContrib,
            start_month: typedArgs?.start_month as string | undefined,
            end_month: typedArgs?.end_month as string | undefined,
            limit: typedArgs?.limit as number | undefined,
          });
          break;
        }

        case 'get_income':
          result = this.tools.getIncome(
            (typedArgs as Parameters<typeof this.tools.getIncome>[0]) || {}
          );
          break;

        case 'get_spending_by_merchant':
          result = this.tools.getSpendingByMerchant(
            (typedArgs as Parameters<typeof this.tools.getSpendingByMerchant>[0]) || {}
          );
          break;

        case 'compare_periods': {
          const period1 = typedArgs?.period1;
          const period2 = typedArgs?.period2;
          if (typeof period1 !== 'string' || typeof period2 !== 'string') {
            throw new Error('Missing required parameters: period1 and period2');
          }
          result = this.tools.comparePeriods({
            period1,
            period2,
            exclude_transfers: typedArgs?.exclude_transfers as boolean | undefined,
          });
          break;
        }

        // ============================================
        // NEW TOOLS - Items 13-33
        // ============================================

        case 'get_foreign_transactions':
          result = this.tools.getForeignTransactions(
            (typedArgs as Parameters<typeof this.tools.getForeignTransactions>[0]) || {}
          );
          break;

        case 'get_refunds':
          result = this.tools.getRefunds(
            (typedArgs as Parameters<typeof this.tools.getRefunds>[0]) || {}
          );
          break;

        case 'get_duplicate_transactions':
          result = this.tools.getDuplicateTransactions(
            (typedArgs as Parameters<typeof this.tools.getDuplicateTransactions>[0]) || {}
          );
          break;

        case 'get_credits':
          result = this.tools.getCredits(
            (typedArgs as Parameters<typeof this.tools.getCredits>[0]) || {}
          );
          break;

        case 'get_spending_by_day_of_week':
          result = this.tools.getSpendingByDayOfWeek(
            (typedArgs as Parameters<typeof this.tools.getSpendingByDayOfWeek>[0]) || {}
          );
          break;

        case 'get_trips':
          result = this.tools.getTrips(
            (typedArgs as Parameters<typeof this.tools.getTrips>[0]) || {}
          );
          break;

        case 'get_transaction_by_id': {
          const transactionId = typedArgs?.transaction_id;
          if (typeof transactionId !== 'string') {
            throw new Error('Missing required parameter: transaction_id');
          }
          result = this.tools.getTransactionById(transactionId);
          break;
        }

        case 'get_top_merchants':
          result = this.tools.getTopMerchants(
            (typedArgs as Parameters<typeof this.tools.getTopMerchants>[0]) || {}
          );
          break;

        case 'get_unusual_transactions':
          result = this.tools.getUnusualTransactions(
            (typedArgs as Parameters<typeof this.tools.getUnusualTransactions>[0]) || {}
          );
          break;

        case 'export_transactions':
          result = this.tools.exportTransactions(
            (typedArgs as Parameters<typeof this.tools.exportTransactions>[0]) || {}
          );
          break;

        case 'get_hsa_fsa_eligible':
          result = this.tools.getHsaFsaEligible(
            (typedArgs as Parameters<typeof this.tools.getHsaFsaEligible>[0]) || {}
          );
          break;

        case 'get_spending_rate':
          result = this.tools.getSpendingRate(
            (typedArgs as Parameters<typeof this.tools.getSpendingRate>[0]) || {}
          );
          break;

        case 'get_data_quality_report':
          result = this.tools.getDataQualityReport(
            (typedArgs as Parameters<typeof this.tools.getDataQualityReport>[0]) || {}
          );
          break;

        case 'get_investment_prices':
          result = this.tools.getInvestmentPrices(
            (typedArgs as Parameters<typeof this.tools.getInvestmentPrices>[0]) || {}
          );
          break;

        case 'get_investment_price_history': {
          const tickerSymbol = typedArgs?.ticker_symbol;
          if (typeof tickerSymbol !== 'string') {
            throw new Error('Missing required parameter: ticker_symbol');
          }
          result = this.tools.getInvestmentPriceHistory({
            ticker_symbol: tickerSymbol,
            start_date: typedArgs?.start_date as string | undefined,
            end_date: typedArgs?.end_date as string | undefined,
            price_type: typedArgs?.price_type as 'daily' | 'hf' | undefined,
          });
          break;
        }

        case 'get_investment_splits':
          result = this.tools.getInvestmentSplits(
            (typedArgs as Parameters<typeof this.tools.getInvestmentSplits>[0]) || {}
          );
          break;

        case 'get_connected_institutions':
          result = this.tools.getConnectedInstitutions(
            (typedArgs as Parameters<typeof this.tools.getConnectedInstitutions>[0]) || {}
          );
          break;

        case 'get_category_hierarchy':
          result = this.tools.getCategoryHierarchy(
            (typedArgs as Parameters<typeof this.tools.getCategoryHierarchy>[0]) || {}
          );
          break;

        case 'get_subcategories': {
          const categoryId = typedArgs?.category_id;
          if (typeof categoryId !== 'string') {
            throw new Error('Missing required parameter: category_id');
          }
          result = this.tools.getSubcategories(categoryId);
          break;
        }

        case 'search_categories': {
          const searchQuery = typedArgs?.query;
          if (typeof searchQuery !== 'string') {
            throw new Error('Missing required parameter: query');
          }
          result = this.tools.searchCategoriesHierarchy(searchQuery);
          break;
        }

        // ============================================
        // PHASE 12: ANALYTICS TOOLS
        // ============================================

        // ---- Spending Trends ----

        case 'get_spending_over_time':
          result = this.tools.getSpendingOverTime(
            (typedArgs as Parameters<typeof this.tools.getSpendingOverTime>[0]) || {}
          );
          break;

        case 'get_average_transaction_size':
          result = this.tools.getAverageTransactionSize(
            (typedArgs as Parameters<typeof this.tools.getAverageTransactionSize>[0]) || {}
          );
          break;

        case 'get_category_trends':
          result = this.tools.getCategoryTrends(
            (typedArgs as Parameters<typeof this.tools.getCategoryTrends>[0]) || {}
          );
          break;

        case 'get_merchant_frequency':
          result = this.tools.getMerchantFrequency(
            (typedArgs as Parameters<typeof this.tools.getMerchantFrequency>[0]) || {}
          );
          break;

        // ---- Budget Analytics ----

        case 'get_budget_utilization':
          result = this.tools.getBudgetUtilization(
            (typedArgs as Parameters<typeof this.tools.getBudgetUtilization>[0]) || {}
          );
          break;

        case 'get_budget_vs_actual':
          result = this.tools.getBudgetVsActual(
            (typedArgs as Parameters<typeof this.tools.getBudgetVsActual>[0]) || {}
          );
          break;

        case 'get_budget_recommendations':
          result = this.tools.getBudgetRecommendations(
            (typedArgs as Parameters<typeof this.tools.getBudgetRecommendations>[0]) || {}
          );
          break;

        case 'get_budget_alerts':
          result = this.tools.getBudgetAlerts(
            (typedArgs as Parameters<typeof this.tools.getBudgetAlerts>[0]) || {}
          );
          break;

        // ============================================
        // PHASE 12.3: INVESTMENT ANALYTICS TOOLS
        // ============================================

        case 'get_portfolio_allocation':
          result = this.tools.getPortfolioAllocation(
            (typedArgs as Parameters<typeof this.tools.getPortfolioAllocation>[0]) || {}
          );
          break;

        case 'get_investment_performance':
          result = this.tools.getInvestmentPerformance(
            (typedArgs as Parameters<typeof this.tools.getInvestmentPerformance>[0]) || {}
          );
          break;

        case 'get_dividend_income':
          result = this.tools.getDividendIncome(
            (typedArgs as Parameters<typeof this.tools.getDividendIncome>[0]) || {}
          );
          break;

        case 'get_investment_fees':
          result = this.tools.getInvestmentFees(
            (typedArgs as Parameters<typeof this.tools.getInvestmentFees>[0]) || {}
          );
          break;

        // ============================================
        // PHASE 12.4: GOAL ANALYTICS TOOLS
        // ============================================

        case 'get_goal_projection':
          result = this.tools.getGoalProjection(
            (typedArgs as Parameters<typeof this.tools.getGoalProjection>[0]) || {}
          );
          break;

        case 'get_goal_milestones':
          result = this.tools.getGoalMilestones(
            (typedArgs as Parameters<typeof this.tools.getGoalMilestones>[0]) || {}
          );
          break;

        case 'get_goals_at_risk':
          result = this.tools.getGoalsAtRisk(
            (typedArgs as Parameters<typeof this.tools.getGoalsAtRisk>[0]) || {}
          );
          break;

        case 'get_goal_recommendations':
          result = this.tools.getGoalRecommendations(
            (typedArgs as Parameters<typeof this.tools.getGoalRecommendations>[0]) || {}
          );
          break;

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }

      // Format response
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      // Handle errors (validation, account not found, etc.)
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Inject database and tools for testing.
   * @internal
   */
  _injectForTesting(db: CopilotDatabase, tools: CopilotMoneyTools): void {
    this.db = db;
    this.tools = tools;
  }

  /**
   * Register MCP protocol handlers.
   */
  private registerHandlers(): void {
    // List available tools - delegates to handleListTools
    this.server.setRequestHandler(ListToolsRequestSchema, () => this.handleListTools());

    // Handle tool calls - delegates to handleCallTool
    this.server.setRequestHandler(CallToolRequestSchema, (request, _extra) => {
      const { name, arguments: typedArgs } = request.params;
      return this.handleCallTool(name, typedArgs);
    });
  }

  /**
   * Run the MCP server using stdio transport.
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Handle process signals for graceful shutdown
    process.on('SIGINT', () => {
      void this.server.close().then(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
      void this.server.close().then(() => process.exit(0));
    });
  }
}

/**
 * Run the Copilot Money MCP server.
 *
 * @param dbPath - Optional path to LevelDB database.
 *                If undefined, uses default Copilot Money location.
 */
export async function runServer(dbPath?: string): Promise<void> {
  const server = new CopilotMoneyServer(dbPath);
  await server.run();
}
