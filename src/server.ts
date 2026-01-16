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

// Read version from package.json
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

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
        version: SERVER_VERSION,
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
  async handleCallTool(name: string, typedArgs?: Record<string, unknown>): Promise<CallToolResult> {
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
          result = await this.tools.getTransactions(
            (typedArgs as Parameters<typeof this.tools.getTransactions>[0]) || {}
          );
          break;

        case 'get_accounts':
          result = await this.tools.getAccounts(
            typedArgs as Parameters<typeof this.tools.getAccounts>[0]
          );
          break;

        case 'get_spending': {
          const groupBy = typedArgs?.group_by;
          if (typeof groupBy !== 'string') {
            throw new Error('Missing required parameter: group_by');
          }
          result = await this.tools.getSpending(
            typedArgs as Parameters<typeof this.tools.getSpending>[0]
          );
          break;
        }

        case 'get_account_analytics': {
          const analysis = typedArgs?.analysis;
          if (typeof analysis !== 'string') {
            throw new Error('Missing required parameter: analysis');
          }
          result = await this.tools.getAccountAnalytics(
            typedArgs as Parameters<typeof this.tools.getAccountAnalytics>[0]
          );
          break;
        }

        case 'get_budget_analytics': {
          const analysis = typedArgs?.analysis;
          if (typeof analysis !== 'string') {
            throw new Error('Missing required parameter: analysis');
          }
          result = await this.tools.getBudgetAnalytics(
            typedArgs as Parameters<typeof this.tools.getBudgetAnalytics>[0]
          );
          break;
        }

        case 'get_goal_analytics': {
          const analysis = typedArgs?.analysis;
          if (typeof analysis !== 'string') {
            throw new Error('Missing required parameter: analysis');
          }
          result = await this.tools.getGoalAnalytics(
            typedArgs as Parameters<typeof this.tools.getGoalAnalytics>[0]
          );
          break;
        }

        case 'get_goal_details':
          result = await this.tools.getGoalDetails(
            (typedArgs as Parameters<typeof this.tools.getGoalDetails>[0]) || {}
          );
          break;

        case 'get_investment_analytics': {
          const analysis = typedArgs?.analysis;
          if (typeof analysis !== 'string') {
            throw new Error('Missing required parameter: analysis');
          }
          result = await this.tools.getInvestmentAnalytics(
            typedArgs as Parameters<typeof this.tools.getInvestmentAnalytics>[0]
          );
          break;
        }

        case 'get_merchant_analytics': {
          const sortBy = typedArgs?.sort_by;
          if (typeof sortBy !== 'string') {
            throw new Error('Missing required parameter: sort_by');
          }
          result = await this.tools.getMerchantAnalytics(
            typedArgs as Parameters<typeof this.tools.getMerchantAnalytics>[0]
          );
          break;
        }

        case 'get_account_balance': {
          const accountId = typedArgs?.account_id;
          if (typeof accountId !== 'string') {
            throw new Error('Missing required parameter: account_id');
          }
          result = await this.tools.getAccountBalance(accountId);
          break;
        }

        case 'get_categories':
          result = await this.tools.getCategories(
            (typedArgs as Parameters<typeof this.tools.getCategories>[0]) || {}
          );
          break;

        case 'get_recurring_transactions':
          result = await this.tools.getRecurringTransactions(
            (typedArgs as Parameters<typeof this.tools.getRecurringTransactions>[0]) || {}
          );
          break;

        case 'get_budgets':
          result = await this.tools.getBudgets(
            (typedArgs as Parameters<typeof this.tools.getBudgets>[0]) || {}
          );
          break;

        case 'get_goals':
          result = await this.tools.getGoals(
            (typedArgs as Parameters<typeof this.tools.getGoals>[0]) || {}
          );
          break;

        case 'get_income':
          result = await this.tools.getIncome(
            (typedArgs as Parameters<typeof this.tools.getIncome>[0]) || {}
          );
          break;

        case 'compare_periods': {
          const period1 = typedArgs?.period1;
          const period2 = typedArgs?.period2;
          if (typeof period1 !== 'string' || typeof period2 !== 'string') {
            throw new Error('Missing required parameters: period1 and period2');
          }
          result = await this.tools.comparePeriods({
            period1,
            period2,
            exclude_transfers: typedArgs?.exclude_transfers as boolean | undefined,
          });
          break;
        }

        case 'get_trips':
          result = await this.tools.getTrips(
            (typedArgs as Parameters<typeof this.tools.getTrips>[0]) || {}
          );
          break;

        case 'get_unusual_transactions':
          result = await this.tools.getUnusualTransactions(
            (typedArgs as Parameters<typeof this.tools.getUnusualTransactions>[0]) || {}
          );
          break;

        case 'export_transactions':
          result = await this.tools.exportTransactions(
            (typedArgs as Parameters<typeof this.tools.exportTransactions>[0]) || {}
          );
          break;

        case 'get_data_quality_report':
          result = await this.tools.getDataQualityReport(
            (typedArgs as Parameters<typeof this.tools.getDataQualityReport>[0]) || {}
          );
          break;

        case 'get_investment_prices':
          result = await this.tools.getInvestmentPrices(
            (typedArgs as Parameters<typeof this.tools.getInvestmentPrices>[0]) || {}
          );
          break;

        case 'get_investment_splits':
          result = await this.tools.getInvestmentSplits(
            (typedArgs as Parameters<typeof this.tools.getInvestmentSplits>[0]) || {}
          );
          break;

        case 'get_connected_institutions':
          result = await this.tools.getConnectedInstitutions(
            (typedArgs as Parameters<typeof this.tools.getConnectedInstitutions>[0]) || {}
          );
          break;

        case 'get_average_transaction_size':
          result = await this.tools.getAverageTransactionSize(
            (typedArgs as Parameters<typeof this.tools.getAverageTransactionSize>[0]) || {}
          );
          break;

        case 'get_category_trends':
          result = await this.tools.getCategoryTrends(
            (typedArgs as Parameters<typeof this.tools.getCategoryTrends>[0]) || {}
          );
          break;

        case 'get_portfolio_allocation':
          result = await this.tools.getPortfolioAllocation(
            (typedArgs as Parameters<typeof this.tools.getPortfolioAllocation>[0]) || {}
          );
          break;

        case 'get_goal_milestones':
          result = await this.tools.getGoalMilestones(
            (typedArgs as Parameters<typeof this.tools.getGoalMilestones>[0]) || {}
          );
          break;

        case 'get_year_over_year':
          result = await this.tools.getYearOverYear(
            (typedArgs as Parameters<typeof this.tools.getYearOverYear>[0]) || {}
          );
          break;

        case 'get_net_worth':
          result = await this.tools.getNetWorth(
            (typedArgs as Parameters<typeof this.tools.getNetWorth>[0]) || {}
          );
          break;

        case 'get_savings_rate':
          result = await this.tools.getSavingsRate(
            (typedArgs as Parameters<typeof this.tools.getSavingsRate>[0]) || {}
          );
          break;

        case 'get_cash_flow':
          result = await this.tools.getCashFlow(
            (typedArgs as Parameters<typeof this.tools.getCashFlow>[0]) || {}
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
