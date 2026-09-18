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
import { GraphQLClient, GraphQLError } from './core/graphql/client.js';
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
import { LiveInvestmentAllocationTools } from './tools/live/investment-allocation.js';
import { LiveTopMoversTools } from './tools/live/top-movers.js';
import { LiveAggregatedHoldingsTools } from './tools/live/aggregated-holdings.js';
import { LiveInvestmentBalanceTools } from './tools/live/investment-balance.js';
import { RefreshCacheTool } from './tools/live/refresh-cache.js';
import { stripTypename } from './tools/strip-typename.js';
import { graphQLErrorToMcpError } from './tools/errors.js';

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
        investmentAllocation: new LiveInvestmentAllocationTools(liveDb),
        topMovers: new LiveTopMoversTools(liveDb),
        aggregatedHoldings: new LiveAggregatedHoldingsTools(liveDb),
        investmentBalance: new LiveInvestmentBalanceTools(liveDb),
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
          refreshCache.refresh({ scope: 'all' }).catch((e: unknown) => {
            // scope:'all' cannot reject today; keep future rejections visible.
            console.warn('[copilot-money-mcp] cache sweep after uid transition failed:', e);
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

    // The local-cache gate is scoped to tools whose dispatch actually reads
    // the LevelDB cache (#640): live tools run entirely on GraphQL, and
    // live-mode writes resolve live-first — they touch the cache only via
    // null-guarded patchCached* write-through, which no-ops when the cache
    // never loaded. Cache-mode reads and degraded-mode writes (write tools
    // with no live layer — test-only, since --write implies --live-reads)
    // still need the cache present. `this.live` rather than
    // `this.liveReadsEnabled` on purpose: the skip is justified by the live
    // resolution layer existing (the object handlers and the write path
    // actually use), not by the flag that requests it — the constructor
    // makes them equivalent today, but if that ever drifts, the object is
    // the one that degrades safely.
    const needsLocalCache = !toolDef.requiresLiveReads && (toolDef.readOnly || !this.live);
    if (needsLocalCache && !this.db.isAvailable()) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Database not available. Please ensure Copilot Money is installed ' +
              'and has created local data, or provide a custom database path.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await toolDef.handler({ tools: this.tools, live: this.live }, typedArgs);

      // Format response. stripTypename drops GraphQL `__typename` keys here
      // (#597 Tier 0) — the single serialization site covers every live tool
      // and write-tool echo without touching per-tool mappers.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(stripTypename(result)),
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
 * Render a boot-preflight failure for the stderr diagnostic.
 *
 * `GraphQLError` gets the same attribution the tool handlers use
 * (`graphQLErrorToMcpError`) so the host log and the client-facing error
 * agree on WHOSE fault it is; anything else — notably the plain
 * `No Copilot Money session found …` thrown before a request is ever sent —
 * already carries its own remedy and is passed through.
 */
function describeBootFailure(err: unknown): string {
  if (err instanceof GraphQLError) return graphQLErrorToMcpError(err);
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the live-reads boot probe, and REPORT rather than die on failure (#708).
 *
 * This used to `process.exit(1)`. That put the one fact the user needed —
 * "log into app.copilot.money" — in the one place they never look: the MCP
 * host's stderr log. The host reports a closed transport, the agent sees no
 * tools at all, and it cannot tell the user what to do because it was never
 * told. That is how #708 was found: an external user read it out of the logs.
 *
 * Staying up fixes exactly that. The live tools stay listed, and the first
 * call returns the auth failure as an `isError` result, so the AGENT reads
 * "Please log into Copilot Money at https://app.copilot.money in your
 * browser" and can relay it. Nothing is served stale in the meantime: a live
 * tool with no session fails, it does not fall back to the cache.
 *
 * It also makes the state recoverable without a restart. After a failed cold
 * extraction `FirebaseAuth` has cached no token, so the next call re-runs
 * browser extraction and picks up the session the user just created.
 * Exiting made every failure permanent, including the transient ones — no
 * network at launch, laptop asleep, Copilot 5xx.
 *
 * Deliberately NOT classified by error code: a SCHEMA_ERROR or a NETWORK
 * failure at boot has the same remedy shape as an auth one — surface it to
 * the caller in its own words rather than killing the transport that would
 * carry it. The stderr lines stay for host-log diagnosis.
 *
 * Exported for tests: this resolving (rather than exiting) IS the fix, and
 * `runServer` cannot be called in-process without claiming stdio.
 */
export async function preflightLiveAuthOrWarn(client: GraphQLClient): Promise<void> {
  try {
    await preflightLiveAuth(client);
  } catch (err) {
    console.error(`[live-reads] preflight failed: ${describeBootFailure(err)}`);
    console.error(
      '[live-reads] starting anyway — live tools will report this error to the client ' +
        'on first use. If it is an auth failure, log into app.copilot.money in your ' +
        'browser; no restart needed.'
    );
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

  const server = new CopilotMoneyServer(
    dbPath,
    decodeTimeoutMs,
    writeEnabled,
    liveReadsEnabled,
    graphqlClient
  );

  // Connect FIRST, probe after. The probe used to run before this line, which
  // was defensible while it could refuse to start the server — and is not now
  // that its only product on the failure path is a log line.
  //
  // The wait is not small. An offline boot is four 30s attempts plus backoff
  // (`DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY_DELAYS_MS`) ≈ 125s, on top of
  // browser-storage extraction across every profile. Blocking the transport
  // for that long reproduces #708's symptom by another route: if the host's
  // startup timeout fires first the user sees a closed transport and the agent
  // sees no tools, which is the thing this change exists to prevent.
  await server.run();

  // Fire-and-forget, deliberately. What the probe still buys is a stderr
  // diagnostic for host-log debugging and a warm token cache for the first
  // real call; neither needs to gate anything. `void` is safe because
  // `preflightLiveAuthOrWarn` catches everything and never rejects — there is
  // no unhandled rejection to leak, and if that ever stops being true the
  // no-floating-promises lint fires here.
  if (liveReadsEnabled && graphqlClient) {
    void preflightLiveAuthOrWarn(graphqlClient);
  }
}
