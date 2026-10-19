#!/usr/bin/env node
/**
 * CLI entry point for Copilot Money MCP server.
 */

import { runServer } from './server.js';
import {
  BrowserSelectionError,
  describeBrowserSelection,
  parseBrowserSelection,
  validBrowserNames,
  type BrowserSelection,
} from './core/auth/browser-selection.js';

/** Print a fatal argument error to stderr and exit 1. */
function failArgs(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Parse command-line arguments.
 */
function parseArgs(): {
  dbPath?: string;
  verbose: boolean;
  timeoutMs?: number;
  writeFlagSeen: boolean;
  liveReadsEnabled: boolean;
  browserSelection?: BrowserSelection;
} {
  const args = process.argv.slice(2);
  let dbPath: string | undefined;
  let verbose = false;
  let timeoutMs: number | undefined;
  let writeFlagSeen = false;
  let liveReadsEnabled = false;
  let browserFlag: string | undefined;
  let profileFlag: string | undefined;
  let dataDirFlag: string | undefined;

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
    } else if (arg === '--browser' || arg === '--browser-profile' || arg === '--browser-data-dir') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--') || !value.trim()) {
        failArgs(`${arg} requires a value`);
      }
      if (arg === '--browser') browserFlag = value;
      else if (arg === '--browser-profile') profileFlag = value;
      else dataDirFlag = value;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.error(`
Copilot Money MCP Server - Expose financial data through MCP

Usage:
  copilot-money-mcp [options]

Options:
  --db-path <path>    Path to LevelDB database (default: Copilot Money's default location)
  --timeout <ms>      Decode timeout in milliseconds (default: 90000 = 90 seconds)
  --write             Enable write tools (implies --live-reads)
  --live-reads        Enable GraphQL-backed get_transactions_live (replaces cache-backed get_transactions). Requires authenticated browser session at app.copilot.money.
  --browser <name>    Read the Copilot session from this browser only (no fallback to others).
                      One of: ${validBrowserNames().join(', ')}
  --browser-profile <name>
                      With --browser: read only this profile — a directory name
                      ("Default", "Profile 2") or the profile's display name
                      (Firefox: directory, its suffix like "default-release", or profiles.ini Name)
  --browser-data-dir <path>
                      With --browser: use this user-data root instead of the browser's default
                      locations (the folder holding "Local State" and Default/Profile N; Firefox:
                      a profiles root or a single profile dir). Not supported for Safari.
                      Prefer an absolute path: MCP hosts often start the server in /.
                      The --browser* options only apply with --live-reads or --write; without
                      them they are ignored with a warning (an invalid one stops startup only
                      when it applies).
  --verbose, -v       Enable verbose logging
  --help, -h          Show this help message

Environment:
  DECODE_TIMEOUT_MS   Override decode timeout (same as --timeout flag)
  COPILOT_BROWSER     Same as --browser (the flag wins)
  COPILOT_BROWSER_PROFILE
                      Same as --browser-profile (the flag wins)
  COPILOT_BROWSER_DATA_DIR
                      Same as --browser-data-dir (the flag wins)
  The server uses stdio transport and logs to stderr.
  Claude Desktop will communicate with it via stdin/stdout.
`);
      process.exit(0);
    }
  }

  if (writeFlagSeen) {
    liveReadsEnabled = true;
  }

  const browserSelection = resolveSelection(
    { browserFlag, profileFlag, dataDirFlag },
    liveReadsEnabled
  );

  return { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled, browserSelection };
}

const IGNORED_SUFFIX = 'it only applies with --live-reads or --write.';

/**
 * Validate the browser selection only where it applies.
 *
 * With `--live-reads` / `--write` the selection decides whose session is read,
 * so an invalid one (from a flag or from `COPILOT_BROWSER*`) stops the server.
 * In cache-only mode nothing reads a browser at all, so a selection — valid or
 * not, flag or environment — is ignored with a one-line stderr warning instead
 * of failing startup: a `COPILOT_BROWSER_DATA_DIR` left in a shared MCP config
 * must not take down a server that never uses it.
 */
function resolveSelection(
  flags: { browserFlag?: string; profileFlag?: string; dataDirFlag?: string },
  applies: boolean
): BrowserSelection | undefined {
  let selection: BrowserSelection | undefined;
  try {
    selection = parseBrowserSelection(flags);
  } catch (err) {
    if (!(err instanceof BrowserSelectionError)) throw err;
    if (applies) failArgs(err.message);
    console.error(`Browser selection ignored: ${IGNORED_SUFFIX} (As given: ${err.message})`);
    return undefined;
  }
  if (selection && !applies) {
    console.error(
      `Browser selection ${describeBrowserSelection(selection)} ignored: ${IGNORED_SUFFIX}`
    );
    return undefined;
  }
  return selection;
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
  const { dbPath, verbose, timeoutMs, writeFlagSeen, liveReadsEnabled, browserSelection } =
    parseArgs();

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
      // A selection in cache-only mode was already reported as ignored.
      if (browserSelection) {
        console.log(`Browser session: ${describeBrowserSelection(browserSelection)} only`);
      }
      /* eslint-enable no-console */
    }

    await runServer(dbPath, timeoutMs, writeFlagSeen, liveReadsEnabled, {}, { browserSelection });
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
