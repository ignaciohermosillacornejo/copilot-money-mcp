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
import { TOOL_REGISTRY, type LiveToolContext } from './tools/registry/index.js';
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
  /** Live (GraphQL-backed) tool instances; present only with --live-reads. */
  private live?: LiveToolContext;

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
      const balanceHistory = new LiveBalanceHistoryTools(liveDb);
      const investmentPrices = new LiveInvestmentPricesTools(liveDb);
      this.live = {
        transactions: new LiveTransactionsTools(liveDb),
        accounts: new LiveAccountsTools(liveDb),
        categories: new LiveCategoriesTools(liveDb),
        tags: new LiveTagsTools(liveDb),
        budgets: new LiveBudgetsTools(liveDb),
        recurring: new LiveRecurringTools(liveDb),
        networth: new LiveNetworthTools(liveDb),
        upcomingRecurrings: new LiveUpcomingRecurringsTools(liveDb),
        monthlySpend: new LiveMonthlySpendTools(liveDb),
        holdings: new LiveHoldingsTools(liveDb),
        balanceHistory,
        investmentPrices,
        refreshCache: new RefreshCacheTool(liveDb, balanceHistory, investmentPrices),
      };
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
  async handleCallTool(name: string, typedArgs?: Record<string, unknown>): Promise<CallToolResult> {
    const toolDef = TOOL_REGISTRY.get(name);

    // Block write tools when not in write mode (before db check so the error
    // is clear). Write classification is derived from the registry — every
    // write tool is a `ToolDefinition` with `readOnly: false`.
    const isWriteTool = toolDef !== undefined && !toolDef.readOnly;
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

    // Block live-read tools when --live-reads is off (before db check — this
    // is a configuration issue independent of cache availability). Live
    // classification is derived from the registry (`requiresLiveReads`).
    if (toolDef?.requiresLiveReads && !this.live) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${name} is only available when the server runs with --live-reads.`,
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

    if (!toolDef) {
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

    try {
      const result = await toolDef.handler({ tools: this.tools, live: this.live }, typedArgs);

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
            text: toolDef.formatError ? toolDef.formatError(errorMessage) : `Error: ${errorMessage}`,
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
