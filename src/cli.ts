#!/usr/bin/env node
/**
 * CLI entry point for Copilot Money MCP server.
 */

import { runServer } from './server.js';

/**
 * Parse command-line arguments.
 */
function parseArgs(): {
  dbPath?: string;
  verbose: boolean;
  timeoutMs?: number;
  writeFlagSeen: boolean;
  liveReadsEnabled: boolean;
} {
  const args = process.argv.slice(2);
  let dbPath: string | undefined;
  let verbose = false;
  let timeoutMs: number | undefined;
  let writeFlagSeen = false;
  let liveReadsEnabled = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--db-path' && i + 1 < args.length) {
      dbPath = args[i + 1];
      i++;
    } else if (arg === '--timeout' && i + 1 < args.length) {
      const rawValue = args[i + 1] as string;
      const ms = parseInt(rawValue, 10);
      if (!isNaN(ms) && ms > 0) {
        timeoutMs = ms;
      } else {
        console.error(
          `Invalid --timeout value: ${rawValue} (must be a positive integer in milliseconds)`
        );
        process.exit(1);
      }
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--write') {
      writeFlagSeen = true;
    } else if (arg === '--live-reads') {
      liveReadsEnabled = true;
    } else if (arg === '--help' || arg === '-h') {
      console.error(`
Copilot Money MCP Server - Expose financial data through MCP

Usage:
  copilot-money-mcp [options]

Options:
  --db-path <path>    Path to LevelDB database (default: Copilot Money's default location)
  --timeout <ms>      Decode timeout in milliseconds (default: 90000 = 90 seconds)
  --write             Enable write tools (sends authenticated requests to Copilot Money's GraphQL API)
  --live-reads        Enable GraphQL-backed get_transactions_live (replaces cache-backed get_transactions). Requires authenticated browser session at app.copilot.money.
  --verbose, -v       Enable verbose logging
  --help, -h          Show this help message

Environment:
  DECODE_TIMEOUT_MS   Override decode timeout (same as --timeout flag)
  The server uses stdio transport and logs to stderr.
  Claude Desktop will communicate with it via stdin/stdout.
`);
      process.exit(0);
    }
  }

  return { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled };
}

/**
 * Configure logging.
 */
function configureLogging(verbose: boolean): void {
  // Simple logger that writes to stderr (MCP uses stdout for protocol)
  const originalError = console.error;

  if (verbose) {
    // eslint-disable-next-line no-console -- CLI logging, redirected to stderr
    console.log = (...args: unknown[]) => {
      originalError('[LOG]', new Date().toISOString(), ...args);
    };
    console.error = (...args: unknown[]) => {
      originalError('[ERROR]', new Date().toISOString(), ...args);
    };
  } else {
    // In non-verbose mode, suppress console.log but keep console.error
    // eslint-disable-next-line no-console -- CLI logging configuration
    console.log = () => {};
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled } = parseArgs();

  configureLogging(verbose);

  try {
    if (verbose) {
      /* eslint-disable no-console -- CLI startup messages */
      console.log('Starting Copilot Money MCP Server...');
      if (dbPath) {
        console.log(`Using database path: ${dbPath}`);
      } else {
        console.log('Using default Copilot Money database location');
      }
      if (writeFlagSeen) {
        console.log('Write tools enabled (--write)');
      }
      if (liveReadsEnabled) {
        console.log('Live reads enabled (--live-reads)');
      }
      /* eslint-enable no-console */
    }

    await runServer(dbPath, timeoutMs, writeFlagSeen, liveReadsEnabled);
  } catch (error) {
    console.error('Server error:', error);
    process.exit(1);
  }
}

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

// Run the server
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
