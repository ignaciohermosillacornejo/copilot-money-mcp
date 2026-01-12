/**
 * MCP server for Copilot Money.
 *
 * Exposes financial data through the Model Context Protocol.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CopilotDatabase } from "./core/database.js";
import { CopilotMoneyTools, createToolSchemas } from "./tools/index.js";

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
        name: "copilot-money-mcp",
        version: "1.0.0",
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
   * Register MCP protocol handlers.
   */
  private registerHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const schemas = createToolSchemas();
      const tools: Tool[] = schemas.map((schema) => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.inputSchema,
        annotations: schema.annotations,
      }));

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Check if database is available
      if (!this.db.isAvailable()) {
        return {
          content: [
            {
              type: "text",
              text:
                "Database not available. Please ensure Copilot Money is installed " +
                "and has created local data, or provide a custom database path.",
            },
          ],
        };
      }

      try {
        let result: any;

        // Route to appropriate tool handler
        switch (name) {
          case "get_transactions":
            result = this.tools.getTransactions(args || {});
            break;

          case "search_transactions":
            if (!args?.query) {
              throw new Error("Missing required parameter: query");
            }
            result = this.tools.searchTransactions(args.query, {
              limit: args.limit,
              period: args.period,
              start_date: args.start_date,
              end_date: args.end_date,
            });
            break;

          case "get_accounts":
            result = this.tools.getAccounts(args?.account_type);
            break;

          case "get_spending_by_category":
            result = this.tools.getSpendingByCategory(args || {});
            break;

          case "get_account_balance":
            if (!args?.account_id) {
              throw new Error("Missing required parameter: account_id");
            }
            result = this.tools.getAccountBalance(args.account_id);
            break;

          case "get_categories":
            result = this.tools.getCategories();
            break;

          case "get_recurring_transactions":
            result = this.tools.getRecurringTransactions(args || {});
            break;

          case "get_income":
            result = this.tools.getIncome(args || {});
            break;

          case "get_spending_by_merchant":
            result = this.tools.getSpendingByMerchant(args || {});
            break;

          case "compare_periods":
            if (!args?.period1 || !args?.period2) {
              throw new Error(
                "Missing required parameters: period1 and period2"
              );
            }
            result = this.tools.comparePeriods(args);
            break;

          default:
            return {
              content: [
                {
                  type: "text",
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
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        // Handle errors (validation, account not found, etc.)
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        return {
          content: [
            {
              type: "text",
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Run the MCP server using stdio transport.
   */
  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Handle process signals for graceful shutdown
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      await this.server.close();
      process.exit(0);
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
