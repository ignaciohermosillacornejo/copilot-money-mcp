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
import { GraphQLClient } from './core/graphql/client.js';
import { FirebaseAuth } from './core/auth/firebase-auth.js';
import { extractRefreshToken } from './core/auth/browser-token.js';

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

  /**
   * Initialize the MCP server.
   *
   * @param dbPath - Optional path to LevelDB database.
   *                If undefined, uses default Copilot Money location.
   * @param decodeTimeoutMs - Optional timeout for decode operations in milliseconds.
   * @param writeEnabled - If true, register write tools and enable GraphQL writes.
   */
  constructor(dbPath?: string, decodeTimeoutMs?: number, writeEnabled = false) {
    this.db = new CopilotDatabase(dbPath, decodeTimeoutMs);
    this.writeEnabled = writeEnabled;

    let graphqlClient: GraphQLClient | undefined;
    if (writeEnabled) {
      const auth = new FirebaseAuth(() => extractRefreshToken());
      graphqlClient = new GraphQLClient(auth);
    }

    this.tools = new CopilotMoneyTools(this.db, graphqlClient);
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
    const allSchemas = this.writeEnabled
      ? [...readSchemas, ...createWriteToolSchemas()]
      : readSchemas;

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
  private static readonly WRITE_TOOLS = new Set([
    'create_transaction',
    'update_transaction',
    'review_transactions',
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
    // Block write tools when not in write mode (before db check so the error is clear)
    if (CopilotMoneyServer.WRITE_TOOLS.has(name) && !this.writeEnabled) {
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

        case 'get_cache_info':
          result = await this.tools.getCacheInfo();
          break;

        case 'refresh_database':
          result = await this.tools.refreshDatabase();
          break;

        case 'get_accounts':
          result = await this.tools.getAccounts(
            typedArgs as Parameters<typeof this.tools.getAccounts>[0]
          );
          break;

        case 'get_connection_status':
          result = await this.tools.getConnectionStatus();
          break;

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

        case 'get_holdings':
          result = await this.tools.getHoldings(
            (typedArgs as Parameters<typeof this.tools.getHoldings>[0]) || {}
          );
          break;

        case 'get_balance_history':
          result = await this.tools.getBalanceHistory(
            (typedArgs as Parameters<typeof this.tools.getBalanceHistory>[0]) || {}
          );
          break;

        case 'get_investment_performance':
          result = await this.tools.getInvestmentPerformance(
            (typedArgs as Parameters<typeof this.tools.getInvestmentPerformance>[0]) || {}
          );
          break;

        case 'get_twr_returns':
          result = await this.tools.getTwrReturns(
            (typedArgs as Parameters<typeof this.tools.getTwrReturns>[0]) || {}
          );
          break;

        case 'get_securities':
          result = await this.tools.getSecurities(
            (typedArgs as Parameters<typeof this.tools.getSecurities>[0]) || {}
          );
          break;

        case 'get_goal_history':
          result = await this.tools.getGoalHistory(
            (typedArgs as Parameters<typeof this.tools.getGoalHistory>[0]) || {}
          );
          break;

        case 'create_transaction':
          result = await this.tools.createTransaction(
            typedArgs as Parameters<typeof this.tools.createTransaction>[0]
          );
          break;

        case 'update_transaction':
          result = await this.tools.updateTransaction(
            typedArgs as Parameters<typeof this.tools.updateTransaction>[0]
          );
          break;
        case 'review_transactions':
          result = await this.tools.reviewTransactions(
            typedArgs as Parameters<typeof this.tools.reviewTransactions>[0]
          );
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
  writeEnabled = false
): Promise<void> {
  const server = new CopilotMoneyServer(dbPath, decodeTimeoutMs, writeEnabled);
  await server.run();
}
