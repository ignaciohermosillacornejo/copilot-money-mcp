#!/usr/bin/env node
/**
 * CLI entry point for Copilot Money MCP server.
 */

import { runServer } from "./server.js";

/**
 * Parse command-line arguments.
 */
function parseArgs(): { dbPath?: string; verbose: boolean } {
  const args = process.argv.slice(2);
  let dbPath: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--db-path" && i + 1 < args.length) {
      dbPath = args[i + 1];
      i++;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.error(`
Copilot Money MCP Server - Expose financial data through MCP

Usage:
  copilot-money-mcp [options]

Options:
  --db-path <path>    Path to LevelDB database (default: Copilot Money's default location)
  --verbose, -v       Enable verbose logging
  --help, -h          Show this help message

Environment:
  The server uses stdio transport and logs to stderr.
  Claude Desktop will communicate with it via stdin/stdout.
`);
      process.exit(0);
    }
  }

  return { dbPath, verbose };
}

/**
 * Configure logging.
 */
function configureLogging(verbose: boolean): void {
  // Simple logger that writes to stderr (MCP uses stdout for protocol)
  const originalLog = console.log;
  const originalError = console.error;

  if (verbose) {
    console.log = (...args: any[]) => {
      originalError("[LOG]", new Date().toISOString(), ...args);
    };
    console.error = (...args: any[]) => {
      originalError("[ERROR]", new Date().toISOString(), ...args);
    };
  } else {
    // In non-verbose mode, suppress console.log but keep console.error
    console.log = () => {};
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { dbPath, verbose } = parseArgs();

  // Configure logging
  configureLogging(verbose);

  try {
    if (verbose) {
      console.log("Starting Copilot Money MCP Server...");
      if (dbPath) {
        console.log(`Using database path: ${dbPath}`);
      } else {
        console.log("Using default Copilot Money database location");
      }
    }

    // Run the server
    await runServer(dbPath);
  } catch (error) {
    console.error("Server error:", error);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  process.exit(1);
});

// Run the server
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
