/**
 * Unit tests for the CLI argument parser (src/cli-args.ts).
 *
 * The MCP registry schema defines a named argument as `--flag={value}`, while
 * hand-written configs use `--flag value`. Every value-taking flag must accept
 * both, every boolean flag must accept the bare form and the schema's
 * `=true` / `=false`, and nothing malformed may be dropped silently. These
 * tests walk `CLI_FLAGS` so a flag added to the table is covered by them
 * without a new test.
 */

import { describe, expect, test } from 'bun:test';
import {
  CLI_FLAGS,
  CliArgError,
  flagSpellings,
  parseCliArgs,
  type ParsedCliArgs,
  type ValueFlagName,
} from '../../src/cli-args.js';

// These callbacks must stay unannotated: TypeScript infers a type predicate
// from them, which narrows VALUE_FLAGS / BOOLEAN_FLAGS to the value-taking and
// on/off members. That is what lets `valueOf(parsed, flag.name)` and
// `booleans[flag.name]` typecheck below (this file is in tsconfig.tests.json).
const VALUE_FLAGS = CLI_FLAGS.filter((f) => f.takesValue);
const BOOLEAN_FLAGS = CLI_FLAGS.filter((f) => !f.takesValue);

/** A value each value-taking flag accepts. */
function sampleValue(name: string): string {
  return name === '--timeout' ? '5000' : '/tmp/some=path';
}

/** The value a flag was parsed to. */
function valueOf(parsed: ParsedCliArgs, name: ValueFlagName): string | undefined {
  return parsed.values[name];
}

function errorOf(argv: string[]): string {
  try {
    parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliArgError) return err.message;
    throw err;
  }
  throw new Error(`parseCliArgs(${JSON.stringify(argv)}) did not throw`);
}

describe('parseCliArgs', () => {
  test('the flag table has value-taking and boolean flags', () => {
    expect(VALUE_FLAGS.map((f) => f.name)).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- bun-types returns `any` from asymmetric matchers.
      expect.arrayContaining([
        '--db-path',
        '--timeout',
        '--browser',
        '--browser-profile',
        '--browser-data-dir',
      ])
    );
    expect(BOOLEAN_FLAGS.map((f) => f.name)).toEqual(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- bun-types returns `any` from asymmetric matchers.
      expect.arrayContaining(['--write', '--live-reads', '--verbose', '--help'])
    );
  });

  describe('every value-taking flag', () => {
    for (const flag of VALUE_FLAGS) {
      const value = sampleValue(flag.name);

      test(`${flag.name} <value> and ${flag.name}=<value> parse the same`, () => {
        const spaced = parseCliArgs([flag.name, value]);
        const equals = parseCliArgs([`${flag.name}=${value}`]);
        expect(valueOf(spaced, flag.name)).toBe(value);
        expect(valueOf(equals, flag.name)).toBe(value);
        expect(spaced.warnings).toEqual([]);
        expect(equals.warnings).toEqual([]);
      });

      test(`${flag.name}= splits on the first "=" only`, () => {
        if (flag.name === '--timeout') return;
        expect(valueOf(parseCliArgs([`${flag.name}=a=b`]), flag.name)).toBe('a=b');
      });

      test(`a bare ${flag.name} at the end is refused`, () => {
        expect(errorOf([flag.name])).toBe(`${flag.name} requires a value`);
      });

      test(`${flag.name} followed by another flag is refused, not consumed`, () => {
        expect(errorOf([flag.name, '--write'])).toBe(`${flag.name} requires a value`);
      });

      test(`${flag.name} followed by any other flag's spelling, short ones included, is refused`, () => {
        for (const other of CLI_FLAGS) {
          if (other.name === '--help') continue; // help wins; covered below
          for (const spelling of flagSpellings(other)) {
            expect(errorOf([flag.name, spelling])).toBe(`${flag.name} requires a value`);
          }
        }
      });

      test(`${flag.name} followed by a flag in another case or dash count is refused`, () => {
        for (const other of ['-V', '-Write', '-H']) {
          expect(errorOf([flag.name, other])).toBe(`${flag.name} requires a value`);
        }
        // A non-dashed word that happens to spell a flag is still a value.
        expect(valueOf(parseCliArgs([flag.name, 'WRITE']), flag.name)).toBe('WRITE');
      });

      test(`an empty ${flag.name}= is refused`, () => {
        expect(errorOf([`${flag.name}=`])).toBe(`${flag.name} requires a value`);
        expect(errorOf([`${flag.name}=  `])).toBe(`${flag.name} requires a value`);
      });
    }
  });

  describe('every boolean flag', () => {
    for (const flag of BOOLEAN_FLAGS) {
      test(`bare ${flag.name}, ${flag.name}=true and ${flag.name}=false`, () => {
        expect(parseCliArgs([flag.name]).booleans[flag.name]).toBe(true);
        expect(parseCliArgs([`${flag.name}=true`]).booleans[flag.name]).toBe(true);
        expect(parseCliArgs([`${flag.name}=false`]).booleans[flag.name]).toBe(false);
        expect(parseCliArgs([]).booleans[flag.name]).toBe(false);
      });

      test(`${flag.name}=<anything else> is refused, not ignored`, () => {
        expect(errorOf([`${flag.name}=yes`])).toBe(
          `${flag.name} takes no value, or =true / =false (got "yes")`
        );
        expect(errorOf([`${flag.name}=`])).toBe(
          `${flag.name} takes no value, or =true / =false (got "")`
        );
      });
    }

    test('a following literal true/false is the flag value, so "--write false" stays off', () => {
      const off = parseCliArgs(['--write', 'false']);
      expect(off.booleans['--write']).toBe(false);
      expect(off.warnings).toEqual([]);
      expect(parseCliArgs(['--live-reads', 'true']).booleans['--live-reads']).toBe(true);
      // Anything else after a boolean flag is not its value.
      const other = parseCliArgs(['--write', 'no']);
      expect(other.booleans['--write']).toBe(true);
      expect(other.warnings).toEqual(['Ignoring unrecognised argument #2 (see --help)']);
    });

    test('the last occurrence wins', () => {
      expect(parseCliArgs(['--write', '--write=false']).booleans['--write']).toBe(false);
      expect(parseCliArgs(['--write=false', '--write']).booleans['--write']).toBe(true);
    });

    test('short aliases set their long flag, bare or with =true / =false', () => {
      expect(parseCliArgs(['-v']).booleans['--verbose']).toBe(true);
      expect(parseCliArgs(['-v=true']).booleans['--verbose']).toBe(true);
      expect(parseCliArgs(['-v=false']).booleans['--verbose']).toBe(false);
      expect(parseCliArgs(['-v=true']).warnings).toEqual([]);
      expect(parseCliArgs(['-h']).booleans['--help']).toBe(true);
      expect(parseCliArgs(['-h=true']).booleans['--help']).toBe(true);
    });

    test('true / false are read in any case', () => {
      expect(parseCliArgs(['--write=TRUE']).booleans['--write']).toBe(true);
      expect(parseCliArgs(['--write=False']).booleans['--write']).toBe(false);
      expect(parseCliArgs(['--write', 'FALSE']).booleans['--write']).toBe(false);
    });
  });

  test('an unknown --flag=value is refused without echoing the value', () => {
    const message = errorOf(['--db-paht=/Users/someone/secret']);
    expect(message).toContain('Unknown option --db-paht');
    expect(message).not.toContain('secret');
  });

  test('every spelling in the table is unique, so none shadows another', () => {
    const spellings = CLI_FLAGS.flatMap((f) => flagSpellings(f));
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  test('a negative number after --timeout is read as its (invalid) value, not as a flag', () => {
    expect(parseCliArgs(['--timeout', '-5']).values['--timeout']).toBe('-5');
  });

  test('a known flag written without its dashes is named, with the real spelling', () => {
    expect(parseCliArgs(['write']).warnings).toEqual([
      'Ignoring unrecognised argument "write" (did you mean --write?)',
    ]);
    expect(parseCliArgs(['v']).warnings).toEqual([
      'Ignoring unrecognised argument "v" (did you mean --verbose?)',
    ]);
    // A wrong number of dashes gets the same hint.
    expect(parseCliArgs(['-write']).warnings).toEqual([
      'Ignoring unrecognised argument "-write" (did you mean --write?)',
    ]);
    expect(parseCliArgs(['--v']).warnings).toEqual([
      'Ignoring unrecognised argument "--v" (did you mean --verbose?)',
    ]);
    // So does a capital, matching the case-insensitive boolean values.
    expect(parseCliArgs(['--Write']).warnings).toEqual([
      'Ignoring unrecognised argument "--Write" (did you mean --write?)',
    ]);
  });

  test('a mistyped flag carrying a value gets the hint on the error, without its value', () => {
    for (const [arg, flag] of [
      ['-write=true', '--write'],
      ['-db-path=/Users/someone/secret', '--db-path'],
      ['--DB-PATH=/Users/someone/secret', '--db-path'],
    ] as const) {
      let message = '';
      try {
        parseCliArgs([arg]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`Did you mean ${flag}?`);
      expect(message).not.toContain('secret');
      expect(message).not.toContain('=');
    }
  });

  test('a stray non-dashed token is reported by position, never echoed', () => {
    const parsed = parseCliArgs(['--write', '/Users/someone/secret-profile']);
    expect(parsed.warnings).toEqual(['Ignoring unrecognised argument #2 (see --help)']);
    expect(parsed.warnings.join('')).not.toContain('secret');
  });

  test('an unknown bare flag or stray token is reported, not silently dropped', () => {
    const parsed = parseCliArgs(['--frobnicate', 'stray', '--write']);
    expect(parsed.booleans['--write']).toBe(true);
    expect(parsed.warnings).toEqual([
      'Ignoring unrecognised argument "--frobnicate" (see --help)',
      'Ignoring unrecognised argument #2 (see --help)',
    ]);
  });

  test('a value given with "=" may start with "--"', () => {
    expect(parseCliArgs(['--browser-profile=--odd']).values['--browser-profile']).toBe('--odd');
  });

  test('a help request anywhere wins, so no other argument can fail it', () => {
    for (const argv of [
      ['--help', '--timeout'],
      ['--db-path', '--help'],
      ['--db-path', '-h'],
      ['--write=yes', '--help=true'],
      ['--db-paht=/x', '-h'],
    ]) {
      expect(parseCliArgs(argv).booleans['--help']).toBe(true);
    }
    // Switched off like any boolean, in both spellings.
    expect(parseCliArgs(['--help=false']).booleans['--help']).toBe(false);
    expect(parseCliArgs(['--help', 'false']).booleans['--help']).toBe(false);
    expect(parseCliArgs(['-h', 'FALSE', '--write']).booleans['--write']).toBe(true);
  });
});
