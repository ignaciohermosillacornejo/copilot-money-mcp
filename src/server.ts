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
import { CopilotMoneyTools, createToolSchemas, createWriteToolSchemas } from './tools/index.js';
import { TOOL_REGISTRY } from './tools/registry/index.js';
import { GraphQLClient } from './core/graphql/client.js';
import { FirebaseAuth } from './core/auth/firebase-auth.js';
import { extractRefreshToken } from './core/auth/browser-token.js';
import { LiveCopilotDatabase, preflightLiveAuth } from './core/live-database.js';
import { LiveTransactionsTools, createLiveToolSchemas } from './tools/live/transactions.js';
import { LiveAccountsTools, createLiveAccountsToolSchema } from './tools/live/accounts.js';
import { LiveCategoriesTools, createLiveCategoriesToolSchema } from './tools/live/categories.js';
import { LiveTagsTools, createLiveTagsToolSchema } from './tools/live/tags.js';
import { LiveBudgetsTools, createLiveBudgetsToolSchema } from './tools/live/budgets.js';
import { LiveRecurringTools, createLiveRecurringToolSchema } from './tools/live/recurring.js';
import { LiveNetworthTools, createLiveNetworthToolSchema } from './tools/live/networth.js';
import {
  LiveUpcomingRecurringsTools,
  createLiveUpcomingRecurringsToolSchema,
} from './tools/live/upcoming-recurrings.js';
import {
  LiveMonthlySpendTools,
  createLiveMonthlySpendToolSchema,
} from './tools/live/monthly-spend.js';
import { LiveHoldingsTools, createLiveHoldingsToolSchema } from './tools/live/holdings.js';
import {
  LiveBalanceHistoryTools,
  createLiveBalanceHistoryToolSchema,
} from './tools/live/balance-history.js';
import {
  LiveInvestmentPricesTools,
  createLiveInvestmentPricesToolSchema,
} from './tools/live/investment-prices.js';
import { RefreshCacheTool, createRefreshCacheToolSchema } from './tools/live/refresh-cache.js';

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
  private writeEnabled: boolean;
  private liveReadsEnabled: boolean;
  private liveTools?: LiveTransactionsTools;
  private liveAccountsTools?: LiveAccountsTools;
  private liveCategoriesTools?: LiveCategoriesTools;
  private liveTagsTools?: LiveTagsTools;
  private liveBudgetsTools?: LiveBudgetsTools;
  private liveRecurringTools?: LiveRecurringTools;
  private liveNetworthTools?: LiveNetworthTools;
  private liveUpcomingRecurringsTools?: LiveUpcomingRecurringsTools;
  private liveMonthlySpendTools?: LiveMonthlySpendTools;
  private liveHoldingsTools?: LiveHoldingsTools;
  private liveBalanceHistoryTools?: LiveBalanceHistoryTools;
  private liveInvestmentPricesTools?: LiveInvestmentPricesTools;
  private refreshCacheTool?: RefreshCacheTool;

  /**
   * Initialize the MCP server.
   *
   * @param dbPath - Optional path to LevelDB database.
   *                If undefined, uses default Copilot Money location.
   * @param decodeTimeoutMs - Optional timeout for decode operations in milliseconds.
   * @param writeEnabled - If true, register write tools and enable GraphQL writes.
   */
  constructor(
    dbPath?: string,
    decodeTimeoutMs?: number,
    writeEnabled = false,
    liveReadsEnabled = false,
    injectedGraphqlClient?: GraphQLClient
  ) {
    this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
    this.writeEnabled = writeEnabled;
    this.liveReadsEnabled = liveReadsEnabled;

    let graphqlClient = injectedGraphqlClient;
    if ((writeEnabled || liveReadsEnabled) && !graphqlClient) {
      const auth = new FirebaseAuth(() => extractRefreshToken());
      graphqlClient = new GraphQLClient(auth);
    }

    let liveDb: LiveCopilotDatabase | undefined;
    if (liveReadsEnabled && graphqlClient) {
      liveDb = new LiveCopilotDatabase(graphqlClient, this.db);
      this.liveTools = new LiveTransactionsTools(liveDb);
      this.liveAccountsTools = new LiveAccountsTools(liveDb);
      this.liveCategoriesTools = new LiveCategoriesTools(liveDb);
      this.liveTagsTools = new LiveTagsTools(liveDb);
      this.liveBudgetsTools = new LiveBudgetsTools(liveDb);
      this.liveRecurringTools = new LiveRecurringTools(liveDb);
      this.liveNetworthTools = new LiveNetworthTools(liveDb);
      this.liveUpcomingRecurringsTools = new LiveUpcomingRecurringsTools(liveDb);
      this.liveMonthlySpendTools = new LiveMonthlySpendTools(liveDb);
      this.liveHoldingsTools = new LiveHoldingsTools(liveDb);
      this.liveBalanceHistoryTools = new LiveBalanceHistoryTools(liveDb);
      this.liveInvestmentPricesTools = new LiveInvestmentPricesTools(liveDb);
      this.refreshCacheTool = new RefreshCacheTool(
        liveDb,
        this.liveBalanceHistoryTools,
        this.liveInvestmentPricesTools
      );
    }

    this.tools = new CopilotMoneyTools(this.db, graphqlClient, liveDb);
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
    const readSchemas = createToolSchemas();
    // When --live-reads is on, the cache-mode reads in this list are swapped
    // out for their _live counterparts below. Keep this in sync with the
    // liveSchemas array — for every name removed here there must be a live
    // schema added below (and vice versa) so users see exactly one tool per
    // semantic read.
    // Note: `get_balance_history` is deliberately NOT swapped out for
    // `get_balance_history_live`. The live tool's GraphQL backing is
    // strictly narrower than cache mode — single-account, timeFrame-enum
    // only, no weekly/monthly downsampling, no name/limit enrichment. Both
    // tools coexist so callers can pick the right shape per use case.
    const filteredReads = this.liveReadsEnabled
      ? readSchemas.filter(
          (s) =>
            s.name !== 'get_transactions' &&
            s.name !== 'get_accounts' &&
            s.name !== 'get_categories' &&
            s.name !== 'get_budgets' &&
            s.name !== 'get_recurring_transactions' &&
            s.name !== 'get_holdings'
        )
      : readSchemas;
    const liveSchemas = this.liveReadsEnabled
      ? [
          ...createLiveToolSchemas(),
          createLiveAccountsToolSchema(),
          createLiveCategoriesToolSchema(),
          createLiveTagsToolSchema(),
          createLiveBudgetsToolSchema(),
          createLiveRecurringToolSchema(),
          createLiveNetworthToolSchema(),
          createLiveUpcomingRecurringsToolSchema(),
          createLiveMonthlySpendToolSchema(),
          createLiveHoldingsToolSchema(),
          createLiveBalanceHistoryToolSchema(),
          createLiveInvestmentPricesToolSchema(),
          createRefreshCacheToolSchema(),
        ]
      : [];
    const allSchemas = [
      ...filteredReads,
      ...liveSchemas,
      ...(this.writeEnabled ? createWriteToolSchemas() : []),
    ];

    const tools: Tool[] = allSchemas.map((schema) => ({
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
  /**
   * Write tools not yet migrated to the tool registry. Registry-migrated
   * tools derive their write classification from `ToolDefinition.readOnly`;
   * names shrink from this set as domains migrate (E1, #446).
   */
  private static readonly LEGACY_WRITE_TOOLS = new Set([
    'create_tag',
    'update_tag',
    'delete_tag',
    'create_category',
    'update_category',
    'delete_category',
    'set_budget',
    'set_recurring_state',
    'create_recurring',
    'update_recurring',
    'delete_recurring',
  ]);

  async handleCallTool(name: string, typedArgs?: Record<string, unknown>): Promise<CallToolResult> {
    const toolDef = TOOL_REGISTRY.get(name);

    // Block write tools when not in write mode (before db check so the error is clear)
    const isWriteTool = toolDef
      ? !toolDef.readOnly
      : CopilotMoneyServer.LEGACY_WRITE_TOOLS.has(name);
    if (isWriteTool && !this.writeEnabled) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Write operations require --write mode. Restart the server with --write flag.',
          },
        ],
        isError: true,
      };
    }

    // Block live-read tools when --live-reads is off (before db check — this is a
    // configuration issue independent of cache availability).
    if (name === 'get_transactions_live' && !this.liveTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_transactions_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_accounts_live' && !this.liveAccountsTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_accounts_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_categories_live' && !this.liveCategoriesTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_categories_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_tags_live' && !this.liveTagsTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_tags_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_budgets_live' && !this.liveBudgetsTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_budgets_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_recurring_live' && !this.liveRecurringTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_recurring_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_networth_live' && !this.liveNetworthTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_networth_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_upcoming_recurrings_live' && !this.liveUpcomingRecurringsTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_upcoming_recurrings_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_monthly_spend_live' && !this.liveMonthlySpendTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_monthly_spend_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_holdings_live' && !this.liveHoldingsTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_holdings_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_balance_history_live' && !this.liveBalanceHistoryTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_balance_history_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'get_investment_prices_live' && !this.liveInvestmentPricesTools) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'get_investment_prices_live is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

    if (name === 'refresh_cache' && !this.refreshCacheTool) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'refresh_cache is only available when the server runs with --live-reads.',
          },
        ],
        isError: true,
      };
    }

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

      // Registry-migrated tool: dispatch through its single definition.
      if (toolDef) {
        result = await toolDef.handler({ tools: this.tools }, typedArgs);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Legacy dispatch for tools not yet migrated to the registry (E1, #446).
      switch (name) {
        case 'get_transactions_live':
          // liveTools non-null invariant enforced by the early guard above.
          result = await this.liveTools!.getTransactions(
            (typedArgs as Parameters<NonNullable<typeof this.liveTools>['getTransactions']>[0]) ||
              {}
          );
          break;

        case 'get_accounts_live':
          // liveAccountsTools non-null invariant enforced by the early guard above.
          result = await this.liveAccountsTools!.getAccounts(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveAccountsTools>['getAccounts']
            >[0]) ?? {}
          );
          break;

        case 'get_categories_live':
          result = await this.liveCategoriesTools!.getCategories(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveCategoriesTools>['getCategories']
            >[0]) ?? {}
          );
          break;

        case 'get_tags_live':
          result = await this.liveTagsTools!.getTags(
            (typedArgs as Parameters<NonNullable<typeof this.liveTagsTools>['getTags']>[0]) ?? {}
          );
          break;

        case 'get_budgets_live':
          result = await this.liveBudgetsTools!.getBudgets(
            (typedArgs as Parameters<NonNullable<typeof this.liveBudgetsTools>['getBudgets']>[0]) ??
              {}
          );
          break;

        case 'get_recurring_live':
          result = await this.liveRecurringTools!.getRecurring(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveRecurringTools>['getRecurring']
            >[0]) ?? {}
          );
          break;

        case 'get_networth_live':
          // liveNetworthTools non-null invariant enforced by the early guard above.
          result = await this.liveNetworthTools!.getNetworth(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveNetworthTools>['getNetworth']
            >[0]) ?? {}
          );
          break;

        case 'get_upcoming_recurrings_live':
          // liveUpcomingRecurringsTools non-null invariant enforced by the early guard above.
          result = await this.liveUpcomingRecurringsTools!.getUpcomingRecurrings(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveUpcomingRecurringsTools>['getUpcomingRecurrings']
            >[0]) ?? {}
          );
          break;

        case 'get_monthly_spend_live':
          // liveMonthlySpendTools non-null invariant enforced by the early guard above.
          result = await this.liveMonthlySpendTools!.getMonthlySpend(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveMonthlySpendTools>['getMonthlySpend']
            >[0]) ?? {}
          );
          break;

        case 'get_holdings_live':
          // liveHoldingsTools non-null invariant enforced by the early guard above.
          result = await this.liveHoldingsTools!.getHoldings(
            (typedArgs as Parameters<
              NonNullable<typeof this.liveHoldingsTools>['getHoldings']
            >[0]) ?? {}
          );
          break;

        case 'get_balance_history_live':
          // liveBalanceHistoryTools non-null invariant enforced by the early guard above.
          // item_id and account_id are required by the schema; the runtime
          // validation (in getBalanceHistory) surfaces a clean error if a
          // caller bypasses the schema.
          result = await this.liveBalanceHistoryTools!.getBalanceHistory(
            (typedArgs ?? {}) as unknown as Parameters<
              NonNullable<typeof this.liveBalanceHistoryTools>['getBalanceHistory']
            >[0]
          );
          break;

        case 'get_investment_prices_live':
          // liveInvestmentPricesTools non-null invariant enforced by the early guard above.
          // security_id is required by the schema; the runtime validation
          // (in getInvestmentPrices) surfaces a clean error if a caller
          // bypasses the schema.
          result = await this.liveInvestmentPricesTools!.getInvestmentPrices(
            (typedArgs ?? {}) as unknown as Parameters<
              NonNullable<typeof this.liveInvestmentPricesTools>['getInvestmentPrices']
            >[0]
          );
          break;

        case 'refresh_cache':
          // refreshCacheTool non-null invariant enforced by the early guard above.
          try {
            result = await this.refreshCacheTool!.refresh(
              (typedArgs as Parameters<NonNullable<typeof this.refreshCacheTool>['refresh']>[0]) ??
                {}
            );
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: (err as Error).message }],
              isError: true,
            };
          }
          break;

        case 'get_cache_info':
          result = await this.tools.getCacheInfo();
          break;

        case 'refresh_database':
          result = await this.tools.refreshDatabase();
          break;

        case 'get_accounts':
          result = await this.tools.getAccounts(typedArgs);
          break;

        case 'get_connection_status':
          result = await this.tools.getConnectionStatus();
          break;

        case 'get_categories':
          result = await this.tools.getCategories(typedArgs || {});
          break;

        case 'get_recurring_transactions':
          result = await this.tools.getRecurringTransactions(typedArgs || {});
          break;

        case 'get_budgets':
          result = await this.tools.getBudgets(typedArgs || {});
          break;

        case 'get_goals':
          result = await this.tools.getGoals(typedArgs || {});
          break;

        case 'get_investment_prices':
          result = await this.tools.getInvestmentPrices(typedArgs || {});
          break;

        case 'get_investment_splits':
          result = await this.tools.getInvestmentSplits(typedArgs || {});
          break;

        case 'get_holdings':
          result = await this.tools.getHoldings(typedArgs || {});
          break;

        case 'get_balance_history':
          result = await this.tools.getBalanceHistory(
            (typedArgs as Parameters<typeof this.tools.getBalanceHistory>[0]) || {}
          );
          break;

        case 'get_goal_history':
          result = await this.tools.getGoalHistory(typedArgs || {});
          break;

        case 'create_tag':
          result = await this.tools.createTag(
            typedArgs as Parameters<typeof this.tools.createTag>[0]
          );
          break;

        case 'delete_tag':
          result = await this.tools.deleteTag(
            typedArgs as Parameters<typeof this.tools.deleteTag>[0]
          );
          break;

        case 'create_category':
          result = await this.tools.createCategory(
            typedArgs as Parameters<typeof this.tools.createCategory>[0]
          );
          break;

        case 'update_category':
          result = await this.tools.updateCategory(
            typedArgs as Parameters<typeof this.tools.updateCategory>[0]
          );
          break;

        case 'delete_category':
          result = await this.tools.deleteCategory(
            typedArgs as Parameters<typeof this.tools.deleteCategory>[0]
          );
          break;

        case 'set_budget':
          result = await this.tools.setBudget(
            typedArgs as Parameters<typeof this.tools.setBudget>[0]
          );
          break;

        case 'set_recurring_state':
          result = await this.tools.setRecurringState(
            typedArgs as Parameters<typeof this.tools.setRecurringState>[0]
          );
          break;

        case 'delete_recurring':
          result = await this.tools.deleteRecurring(
            typedArgs as Parameters<typeof this.tools.deleteRecurring>[0]
          );
          break;

        case 'update_tag':
          result = await this.tools.updateTag(
            typedArgs as Parameters<typeof this.tools.updateTag>[0]
          );
          break;

        case 'create_recurring':
          result = await this.tools.createRecurring(
            typedArgs as Parameters<typeof this.tools.createRecurring>[0]
          );
          break;

        case 'update_recurring':
          result = await this.tools.updateRecurring(
            typedArgs as Parameters<typeof this.tools.updateRecurring>[0]
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
 * @param decodeTimeoutMs - Optional timeout for decode operations in milliseconds.
 * @param writeEnabled - If true, register write tools and enable GraphQL writes.
 */
export async function runServer(
  dbPath?: string,
  decodeTimeoutMs?: number,
  writeEnabled = false,
  liveReadsEnabled = false
): Promise<void> {
  let graphqlClient: GraphQLClient | undefined;
  if (writeEnabled || liveReadsEnabled) {
    const auth = new FirebaseAuth(() => extractRefreshToken());
    graphqlClient = new GraphQLClient(auth);
  }

  if (liveReadsEnabled && graphqlClient) {
    try {
      await preflightLiveAuth(graphqlClient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[live-reads] preflight failed: ${msg}`);
      console.error(
        '[live-reads] ensure you are logged into app.copilot.money in your default browser, then restart.'
      );
      process.exit(1);
    }
  }

  const server = new CopilotMoneyServer(
    dbPath,
    decodeTimeoutMs,
    writeEnabled,
    liveReadsEnabled,
    graphqlClient
  );
  await server.run();
}
