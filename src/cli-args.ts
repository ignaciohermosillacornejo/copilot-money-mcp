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

import { validBrowserNames } from './core/auth/browser-selection.js';

export interface CliFlag {
  /** Long name, including the leading dashes. */
  name: string;
  /** Short spellings that mean the same flag (bare form only). */
  aliases?: readonly string[];
  /** True when the flag carries a value; false for an on/off switch. */
  takesValue: boolean;
  /** Listed in server.json's packageArguments for registry clients. */
  published: boolean;
  /** server.json `format` for a value-taking flag, when it is not a plain string. */
  format?: 'filepath' | 'number';
  /** The only values the flag accepts, for server.json `choices`. */
  choices?: () => string[];
}

export const CLI_FLAGS = [
  { name: '--db-path', takesValue: true, published: true, format: 'filepath' },
  { name: '--timeout', takesValue: true, published: false, format: 'number' },
  { name: '--write', takesValue: false, published: true },
  { name: '--live-reads', takesValue: false, published: true },
  { name: '--browser', takesValue: true, published: true, choices: validBrowserNames },
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

const BY_SPELLING = new Map<string, DeclaredFlag>();
for (const flag of CLI_FLAGS) {
  BY_SPELLING.set(flag.name, flag);
  if ('aliases' in flag) for (const alias of flag.aliases) BY_SPELLING.set(alias, flag);
}

/**
 * Parse argv (without the node/script prefix).
 *
 * @throws CliArgError for a value-taking flag with no value, a boolean flag with
 *   a value other than true/false, or an unknown `--flag=value`. An unknown bare
 *   argument is skipped with a warning rather than refused, so a config carrying a
 *   flag this version does not know still starts (it was skipped silently before).
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const values: Partial<Record<ValueFlagName, string>> = {};
  const booleans = Object.fromEntries(
    CLI_FLAGS.filter((f) => !f.takesValue).map((f) => [f.name, false])
  ) as Record<BooleanFlagName, boolean>;
  const warnings: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const spelling = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const flag = BY_SPELLING.get(spelling);

    if (!flag) {
      if (inline !== undefined) {
        throw new CliArgError(`Unknown option ${spelling} (in "${arg}"). Run with --help.`);
      }
      warnings.push(`Ignoring unrecognised argument "${arg}" (see --help)`);
      continue;
    }

    if (flag.takesValue) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        // A following flag is not a value: `--db-path --write` must not read
        // "--write" as the path.
        if (next !== undefined && !next.startsWith('--')) {
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

    let state = inline;
    // A client may render a boolean the way it renders a value, as
    // `--write false`. Reading that as a bare `--write` followed by a stray
    // "false" would turn writes ON, so a following literal true/false is
    // taken as the flag's value.
    if (state === undefined && (argv[i + 1] === 'true' || argv[i + 1] === 'false')) {
      state = argv[i + 1];
      i++;
    }
    if (state === undefined || state === 'true') {
      booleans[flag.name] = true;
    } else if (state === 'false') {
      booleans[flag.name] = false;
    } else {
      throw new CliArgError(`${flag.name} takes no value, or =true / =false (got "${state}")`);
    }
    // Help is answered as soon as it is asked for, whatever follows.
    if (flag.name === '--help' && booleans[flag.name]) break;
  }

  return { values, booleans, warnings };
}
