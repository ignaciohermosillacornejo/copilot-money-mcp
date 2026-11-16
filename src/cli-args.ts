/**
 * Command-line flag table and parser for the CLI entry point.
 *
 * `CLI_FLAGS` is the one place a flag is declared. The parser reads it to know
 * which flags take a value, and `scripts/check-server-json.ts` reads it to
 * verify that `server.json` describes the same flags the same way, so a flag
 * cannot be added to one and not the other.
 *
 * Both spellings are accepted for every value-taking flag: `--flag value` (how
 * people write configs by hand) and `--flag=value` (how the MCP registry's
 * server.json schema defines a named argument). A boolean flag is given bare, as
 * `=true` / `=false` (the strings that schema renders booleans as), or followed
 * by a literal `true` / `false`.
 */

import { BROWSER_IDS } from './core/auth/browser-selection.js';

export interface CliFlag {
  /** Long name, including the leading dashes. */
  name: string;
  /** Short spellings that mean the same flag. */
  aliases?: readonly string[];
  /** True when the flag carries a value; false for an on/off switch. */
  takesValue: boolean;
  /** Listed in server.json's packageArguments for registry clients. */
  published: boolean;
  /** server.json `format` for a value-taking flag, when it is not a plain string. */
  format?: 'filepath' | 'number';
  /**
   * The canonical values the flag accepts, for server.json `choices`. Input
   * may also use an alias (`--browser operagx`); aliases are not advertised.
   */
  choices?: () => string[];
}

export const CLI_FLAGS = [
  { name: '--db-path', takesValue: true, published: true, format: 'filepath' },
  { name: '--timeout', takesValue: true, published: false, format: 'number' },
  { name: '--write', takesValue: false, published: true },
  { name: '--live-reads', takesValue: false, published: true },
  { name: '--browser', takesValue: true, published: true, choices: () => [...BROWSER_IDS] },
  { name: '--browser-profile', takesValue: true, published: true },
  { name: '--browser-data-dir', takesValue: true, published: true, format: 'filepath' },
  { name: '--verbose', aliases: ['-v'], takesValue: false, published: false },
  { name: '--help', aliases: ['-h'], takesValue: false, published: false },
] as const satisfies readonly CliFlag[];

type DeclaredFlag = (typeof CLI_FLAGS)[number];
/** Names of the flags that carry a value. */
export type ValueFlagName = Extract<DeclaredFlag, { takesValue: true }>['name'];
/** Names of the on/off flags. */
export type BooleanFlagName = Extract<DeclaredFlag, { takesValue: false }>['name'];

/** A command line that cannot be parsed; the message is shown as-is. */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

export interface ParsedCliArgs {
  /** Value per value-taking flag name; absent when not given. Last one wins. */
  values: Partial<Record<ValueFlagName, string>>;
  /** State per boolean flag name; false when not given. Last one wins. */
  booleans: Record<BooleanFlagName, boolean>;
  /** Arguments that were not understood and were skipped. */
  warnings: string[];
}

/** Every spelling a flag answers to: its name, then its aliases. */
export function flagSpellings(flag: CliFlag): string[] {
  return [flag.name, ...(flag.aliases ?? [])];
}

const BY_SPELLING = new Map<string, DeclaredFlag>();
for (const flag of CLI_FLAGS) {
  for (const spelling of flagSpellings(flag)) BY_SPELLING.set(spelling, flag);
}

/**
 * True when argv[i] asks for help: `--help` or `-h`, bare or `=true`, unless
 * switched off the way any boolean is (`=false`, or a following literal
 * `false`), in any case. A request at any position wins, so unlike the other
 * booleans a later `--help=false` does not override an earlier `--help`.
 */
function asksForHelp(arg: string, i: number, argv: readonly string[]): boolean {
  const eq = arg.indexOf('=');
  const spelling = eq === -1 ? arg : arg.slice(0, eq);
  if (BY_SPELLING.get(spelling)?.name !== '--help') return false;
  if (eq !== -1) return arg.slice(eq + 1).toLowerCase() === 'true';
  return argv[i + 1]?.toLowerCase() !== 'false';
}

/**
 * The flag a dashed token names under dash and case folding (`-write`,
 * `--Write`, `-V` all name a real flag), or undefined. The result is always a
 * CLI_FLAGS member, so printing its name echoes nothing from argv.
 */
function foldedFlag(token: string): CliFlag | undefined {
  const bare = (token.split('=')[0] ?? '').replace(/^-+/, '').toLowerCase();
  return BY_SPELLING.get(`--${bare}`) ?? BY_SPELLING.get(`-${bare}`);
}

/** A single-dash token that is a flag, not a value such as `-5`. */
function namesAFlag(token: string): boolean {
  return token.startsWith('-') && foldedFlag(token) !== undefined;
}

/**
 * Parse argv (without the node/script prefix).
 *
 * @throws CliArgError for a value-taking flag with no value, a boolean flag with
 *   a value other than true/false, or an unknown `--flag=value`. An unknown bare
 *   argument is skipped with a warning rather than refused, so a config carrying a
 *   flag this version does not know still starts (it was skipped silently before).
 *   A help request anywhere wins over every other argument, so `--db-path --help`
 *   prints help rather than failing on the missing path.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const values: Partial<Record<ValueFlagName, string>> = {};
  const booleans = Object.fromEntries(
    CLI_FLAGS.filter((f) => !f.takesValue).map((f) => [f.name, false])
  ) as Record<BooleanFlagName, boolean>;
  const warnings: string[] = [];

  if (argv.some(asksForHelp)) {
    booleans['--help'] = true;
    return { values, booleans, warnings };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // Any dashed token may carry "=value", short aliases included (`-v=true`).
    const eq = arg.startsWith('-') ? arg.indexOf('=') : -1;
    const spelling = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const flag = BY_SPELLING.get(spelling);

    if (!flag) {
      // The hint looks the name up with its dashes normalised and its case
      // folded, so a missing, extra or doubled dash (`write`, `-write`, `--v`)
      // or a capital (`--Write`) is caught too. The suggestion is always a
      // CLI_FLAGS member, a closed set, so printing it echoes nothing new.
      const meant = foldedFlag(spelling);
      if (inline !== undefined) {
        // The value is not echoed: it may be a secret or a path with a username.
        const hint = meant ? ` Did you mean ${meant.name}?` : '';
        throw new CliArgError(`Unknown option ${spelling}.${hint} Run with --help.`);
      }
      // A dashed token is echoed (it cannot carry "=value" here: that threw
      // above), and so is a known flag written without its dashes, since that
      // is a closed set. Anything else may be a path or a secret, so it is
      // named by position only.
      warnings.push(
        meant
          ? `Ignoring unrecognised argument "${arg}" (did you mean ${meant.name}?)`
          : arg.startsWith('-')
            ? `Ignoring unrecognised argument "${arg}" (see --help)`
            : `Ignoring unrecognised argument #${i + 1} (see --help)`
      );
      continue;
    }

    if (flag.takesValue) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        // A following flag is not a value: `--db-path --write` or `--db-path -v`
        // must not read the flag as the path. A single-dash token counts as a
        // flag when it names one under the same dash and case folding the hint
        // uses (`-V`, `-Write`), so `--timeout -5` is still read and refused
        // as an invalid value, and a non-dashed value (`--db-path WRITE`) is
        // always consumed.
        if (next !== undefined && !next.startsWith('--') && !namesAFlag(next)) {
          value = next;
          i++;
        }
      }
      if (value === undefined || !value.trim()) {
        throw new CliArgError(`${flag.name} requires a value`);
      }
      values[flag.name] = value;
      continue;
    }

    let state = inline?.toLowerCase();
    // A client may render a boolean the way it renders a value, as
    // `--write false`. Reading that as a bare `--write` followed by a stray
    // "false" would turn writes ON, so a following literal true/false is
    // taken as the flag's value.
    const following = argv[i + 1]?.toLowerCase();
    if (state === undefined && (following === 'true' || following === 'false')) {
      state = following;
      i++;
    }
    if (state === undefined || state === 'true') {
      booleans[flag.name] = true;
    } else if (state === 'false') {
      booleans[flag.name] = false;
    } else {
      throw new CliArgError(`${flag.name} takes no value, or =true / =false (got "${inline}")`);
    }
  }

  return { values, booleans, warnings };
}
