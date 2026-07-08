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
import { CopilotMoneyTools } from './tools/index.js';
import { ALL_TOOL_DEFS, TOOL_REGISTRY, type LiveToolContext } from './tools/registry/index.js';
import { GraphQLClient } from './core/graphql/client.js';
import { FirebaseAuth } from './core/auth/firebase-auth.js';
import { extractRefreshTokenCandidates } from './core/auth/browser-token.js';
import { LiveCopilotDatabase, preflightLiveAuth } from './core/live-database.js';
import { LiveTransactionsTools } from './tools/live/transactions.js';
import { LiveAccountsTools } from './tools/live/accounts.js';
import { LiveCategoriesTools } from './tools/live/categories.js';
import { LiveTagsTools } from './tools/live/tags.js';
import { LiveBudgetsTools } from './tools/live/budgets.js';
import { LiveRecurringTools } from './tools/live/recurring.js';
import { LiveNetworthTools } from './tools/live/networth.js';
import { LiveUpcomingRecurringsTools } from './tools/live/upcoming-recurrings.js';
import { LiveMonthlySpendTools } from './tools/live/monthly-spend.js';
import { LiveHoldingsTools } from './tools/live/holdings.js';
import { LiveBalanceHistoryTools } from './tools/live/balance-history.js';
import { LiveInvestmentPricesTools } from './tools/live/investment-prices.js';
import { RefreshCacheTool } from './tools/live/refresh-cache.js';

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
      const auth = new FirebaseAuth(() => extractRefreshTokenCandidates());
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

      // Mid-session re-auth as a DIFFERENT account (#521): without this,
      // every live cache keeps serving the previous login's data until TTL.
      // One chokepoint, one sweep: reuse refresh_cache's full flush, which
      // already enumerates every live cache — caches added there later join
      // this sweep automatically. Feature-check because injected test
      // doubles are structural casts without the method (they have no real
      // auth, so no transitions can occur).
      const refreshCache = this.live.refreshCache;
      if (typeof graphqlClient.setUidTransitionListener === 'function') {
        graphqlClient.setUidTransitionListener(() => {
          console.warn(
            '[copilot-money-mcp] authenticated uid changed mid-session — flushing all live caches'
          );
          refreshCache.refresh({ scope: 'all' }).catch(() => {
            // scope:'all' cannot reject today; guard future rejectable awaits.
          });
        });
      }
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
    // The list is fully derived from the registry: write tools require
    // --write, live tools require --live-reads, and cache-mode reads with a
    // `_live` replacement (`swappedOutInLiveMode`) are hidden when
    // --live-reads is on, so users see exactly one tool per semantic read.
    const tools: Tool[] = ALL_TOOL_DEFS.filter((def) => {
      if (!def.readOnly && !this.writeEnabled) return false;
      if (def.requiresLiveReads && !this.liveReadsEnabled) return false;
      if (def.swappedOutInLiveMode && this.liveReadsEnabled) return false;
      return true;
    }).map(({ schema }) => ({
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
            text: toolDef.formatError
              ? toolDef.formatError(errorMessage)
              : `Error: ${errorMessage}`,
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
    const auth = new FirebaseAuth(() => extractRefreshTokenCandidates());
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
