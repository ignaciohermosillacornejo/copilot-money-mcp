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
} from '../../src/cli-args.js';

const VALUE_FLAGS = CLI_FLAGS.filter((f) => f.takesValue);
const BOOLEAN_FLAGS = CLI_FLAGS.filter((f) => !f.takesValue);

/** A value each value-taking flag accepts. */
function sampleValue(name: string): string {
  return name === '--timeout' ? '5000' : '/tmp/some=path';
}

/** The parsed field a flag sets, read back generically. */
function valueOf(parsed: ParsedCliArgs, name: string): unknown {
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
      expect.arrayContaining([
        '--db-path',
        '--timeout',
        '--browser',
        '--browser-profile',
        '--browser-data-dir',
      ])
    );
    expect(BOOLEAN_FLAGS.map((f) => f.name)).toEqual(
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
      expect(other.warnings).toEqual(['Ignoring unrecognised argument "no" (see --help)']);
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

  test('an unknown bare flag or stray token is reported, not silently dropped', () => {
    const parsed = parseCliArgs(['--frobnicate', 'stray', '--write']);
    expect(parsed.booleans['--write']).toBe(true);
    expect(parsed.warnings).toEqual([
      'Ignoring unrecognised argument "--frobnicate" (see --help)',
      'Ignoring unrecognised argument "stray" (see --help)',
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
    expect(parseCliArgs(['--help=false']).booleans['--help']).toBe(false);
  });
});
