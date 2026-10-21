/**
 * `redactUserPaths` — the scrub at `handleCallTool`'s error boundary (#774
 * follow-up). Synthetic homes throughout; the real one is never asserted on.
 */

import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { redactUserPaths } from '../../src/utils/redact-paths.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { SYNTHETIC_DB_PATH } from '../helpers/synthetic-db-path.js';

const HOME = '/Users/synthetic-user';

describe('redactUserPaths', () => {
  test('replaces the home directory, spaces in the rest of the path included', () => {
    const text = `EACCES: permission denied, open '${HOME}/Library/Application Support/x/001.ldb'`;
    expect(redactUserPaths(text, HOME)).toBe(
      "EACCES: permission denied, open '~/Library/Application Support/x/001.ldb'"
    );
  });

  test("replaces another user's /Users or /home prefix", () => {
    expect(redactUserPaths("scandir '/Users/someone-else/x'", HOME)).toBe(
      "scandir '/Users/<user>/x'"
    );
    expect(redactUserPaths("scandir '/home/someone/x'", HOME)).toBe("scandir '/home/<user>/x'");
  });

  test('leaves slash-bearing text that is not a user path alone', () => {
    for (const text of [
      'Category not found: Food/Dining',
      'POST https://app.copilot.money/api/graphql failed',
      'date 2026/01/15 is out of range',
      "open '/tmp/copilot-leveldb-abc/CURRENT'",
    ]) {
      expect(redactUserPaths(text, HOME)).toBe(text);
    }
  });

  test('the home is not matched as the prefix of a longer name', () => {
    // `/Users/synthetic-user2` is someone else: it gets the generic prefix
    // redaction, never `~2`.
    expect(redactUserPaths("open '/Users/synthetic-user2/x'", HOME)).toBe("open '/Users/<user>/x'");
    expect(redactUserPaths(`cwd is ${HOME}`, HOME)).toBe('cwd is ~');
  });

  test('closing punctuation after a username is kept', () => {
    expect(redactUserPaths('(/home/bob)', HOME)).toBe('(/home/<user>)');
    expect(redactUserPaths('/Users/bob, and more', HOME)).toBe('/Users/<user>, and more');
  });

  test('the cached pattern follows the home it was given, and survives reuse', () => {
    // One cache slot: alternating homes must not leak the previous pattern,
    // and the `g` flag must not carry lastIndex between calls.
    const other = '/Users/another-synthetic';
    for (let i = 0; i < 3; i++) {
      expect(redactUserPaths(`${HOME}/a`, HOME)).toBe('~/a');
      expect(redactUserPaths(`${other}/b`, other)).toBe('~/b');
      expect(redactUserPaths(`${other}/b`, HOME)).toBe('/Users/<user>/b');
    }
  });

  test('a sibling named after a home outside /Users and /home loses the name too', () => {
    // The generic prefix rule cannot see `/var/...`, so this one rests on the
    // home pattern alone. It used to be a stated limit; the negative lookahead
    // closes it without giving up the `~2` case above.
    const home = '/var/synthetic-root';
    expect(redactUserPaths(`${home}/x`, home)).toBe('~/x');
    expect(redactUserPaths(`${home}.bak/x`, home)).toBe('~.bak/x');
  });

  test('stated limit: outside /Users and /home, a sibling joined by a name character keeps the name', () => {
    // The opposite outcome to the test above, pinned on its own so a failure
    // names which half broke. `-` is a name character, so `${home}-backup`
    // cannot be told apart from a different directory and is left alone.
    const home = '/var/synthetic-root';
    expect(redactUserPaths(`${home}-backup/x`, home)).toBe(`${home}-backup/x`);
  });

  test('under /Users and /home, a home with spaces or odd characters leaves nothing behind at any terminator', () => {
    // The class, not one instance: every home shape the literal match must
    // cover, crossed with every way a path can end in an error message. The
    // prefix rule stops at whitespace and quotes, so a terminator the strict
    // boundary did not accept would leave the name's tail in the output.
    const homes = [
      '/Users/bob smith',
      '/Users/bob  smith',
      '/Users/bob\tsmith',
      '/Users/bob.smith',
      "/Users/o'brien",
      '/Users/bob (work)',
      '/Users/josé garcía',
      '/home/bob smith',
    ];
    // `SEGMENT_END` (the prefix rule's stop class) plus the boundary-only
    // characters that cannot occur in a username; `.` is a stated limit below.
    const terminators = [
      '/x',
      '',
      "'",
      '"',
      ',',
      ')',
      ' and more',
      '\tmore',
      '\nmore',
      ': EACCES',
      '; more',
      ']',
      '}',
      '? Retry',
      '!',
    ];
    for (const home of homes) {
      // Fragments of one character are skipped (the `o` of `o'brien`), so this
      // leak scan is not total; the exact-output equality below is.
      const nameParts = (home.split('/')[2] ?? '')
        .split(/[\s'.()]+/)
        .filter((part) => part.length > 1);
      for (const terminator of terminators) {
        const out = redactUserPaths(`open ${home}${terminator}`, home);
        expect({ home, terminator, out }).toEqual({ home, terminator, out: `open ~${terminator}` });
        for (const part of nameParts) expect(out).not.toContain(part);
      }
    }
  });

  test('stated limit: under /Users, a spaced home before a character outside the boundary class keeps its tail', () => {
    // `.` is a username character, so the boundary cannot accept it without
    // turning `/Users/bob.smith/x` into `~.smith/x`; the prefix rule then stops
    // at the space. Pinned so changing it is a decision.
    const spaced = '/Users/bob smith';
    expect(redactUserPaths(`could not open ${spaced}.`, spaced)).toBe(
      'could not open /Users/<user> smith.'
    );
    // Any other character outside the boundary class behaves the same.
    expect(redactUserPaths(`${spaced}=1`, spaced)).toBe('/Users/<user> smith=1');
    expect(redactUserPaths('/Users/bob.smith/x', '/Users/bob')).toBe('/Users/<user>/x');
  });

  test('the home boundary accepts exactly the prefix stop class plus `:;]}?!`, character by character', () => {
    // The invariant the module docblock states, tested behaviourally so it
    // survives the shared constant being split back into two literals. For a
    // candidate c:
    //   - the prefix rule stops at c  iff  c is whitespace or one of / ' " , )
    //   - the home boundary accepts c iff  the prefix rule stops at c, or c is
    //     one of : ; ] } ? ! (characters no username can contain)
    // so the boundary is a superset of the stop class, and `.` is in neither.
    const prefixClass = (c: string) => /\s/.test(c) || `/'",)`.includes(c);
    const boundaryOnly = ':;]}?!';
    const candidates = [
      ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)),
      '\t',
      '\n',
      '\r',
      ' ',
      ' ',
      'é',
      'ü',
    ];
    const mismatches: string[] = [];
    for (const c of candidates) {
      const prefixStops = redactUserPaths(`/Users/carol${c}z`, '') === `/Users/<user>${c}z`;
      const homeAccepts = redactUserPaths(`/Users/bob${c}z`, '/Users/bob') === `~${c}z`;
      if (prefixStops !== prefixClass(c)) mismatches.push(`prefix ${JSON.stringify(c)}`);
      if (homeAccepts !== (prefixClass(c) || boundaryOnly.includes(c))) {
        mismatches.push(`boundary ${JSON.stringify(c)}`);
      }
      if (prefixStops && !homeAccepts) mismatches.push(`superset ${JSON.stringify(c)}`);
    }
    expect(mismatches).toEqual([]);
    expect(prefixClass('.') || boundaryOnly.includes('.')).toBe(false);
  });

  test('stated limit: under /Users, a non-home directory continuing after a boundary-only character reads as ~', () => {
    // The accepted cost of BOUNDARY_ONLY: the characters cannot be in a
    // username but can be in a directory name, so `/Users/bob!old` stops at
    // `!` and keeps `old`, where the prefix rule alone would take it whole.
    const home = '/Users/bob';
    expect(redactUserPaths('/Users/bob!old/x', home)).toBe('~!old/x');
    expect(redactUserPaths('/Users/bob:old/x', home)).toBe('~:old/x');
    expect(redactUserPaths('/Users/bob!old/x', '/Users/carol')).toBe('/Users/<user>/x');
  });

  test('stated limit: under /Users, another user named after the home plus a space keeps the tail', () => {
    // `/Users/bob smith` while the home is `/Users/bob`: the prefix rule cannot
    // tell a spaced name from the prose after it, so the part after the space
    // stays — with or without the home rule — and with the home rule the prefix
    // reads as `~` though the path is someone else's. Pinned so changing it is
    // a decision.
    expect(redactUserPaths('open /Users/bob smith/x', '/Users/bob')).toBe('open ~ smith/x');
    expect(redactUserPaths('open /Users/bob smith/x', '/Users/carol')).toBe(
      'open /Users/<user> smith/x'
    );
  });

  test("under /Users, a home that is a prefix of another user's name never matches inside it", () => {
    // `/Users/bob` inside `/Users/bob.smith/...` must not become `~.smith/...`,
    // which would leak the other user's name tail. Under /Users and /home the
    // home matches only before `/`, the end of input, or a quote or closing
    // punctuation, and the generic prefix rule takes every sibling whole.
    const home = '/Users/bob';
    expect(redactUserPaths('/Users/bob.smith/x', home)).toBe('/Users/<user>/x');
    expect(redactUserPaths('/Users/bob.bak/x', home)).toBe('/Users/<user>/x');
    expect(redactUserPaths('/home/bob.smith/x', '/home/bob')).toBe('/home/<user>/x');
    expect(redactUserPaths('/Users/bob/x and /Users/bob', home)).toBe('~/x and ~');
    // Rests on the STRICT boundary plus the prefix rule, not on the Unicode
    // class below: `ü` is simply not `/`, end of input, a quote or `,)`.
    expect(redactUserPaths('/Users/bobü/x', home)).toBe('/Users/<user>/x');
  });

  test('under /Users, the home collapses to ~ before a quote or closing punctuation', () => {
    // Without these in the boundary, `open '${HOME}'` fell to the prefix rule
    // (`/Users/<user>'`), and a home containing a space was cut at the space,
    // leaving the rest of the name behind: `/Users/<user> smith'`.
    expect(redactUserPaths(`open '${HOME}'`, HOME)).toBe("open '~'");
    expect(redactUserPaths(`${HOME}, then more`, HOME)).toBe('~, then more');
    expect(redactUserPaths(`(${HOME})`, HOME)).toBe('(~)');
    const spaced = '/Users/bob smith';
    expect(redactUserPaths(`open '${spaced}'`, spaced)).toBe("open '~'");
    expect(redactUserPaths(`open "${spaced}/x"`, spaced)).toBe('open "~/x"');
  });

  test('outside /Users and /home, a non-ASCII continuation counts as a name character', () => {
    // `\w` is ASCII-only, so an ASCII lookahead would read `ü` as "not a name
    // character" and rewrite `${home}ü` to `~ü`. This is the case the Unicode
    // class exists for; the /Users case above never reaches it.
    const home = '/var/synthetic-root';
    expect(redactUserPaths(`${home}ü/x`, home)).toBe(`${home}ü/x`);
    expect(redactUserPaths(`${home}.bak/x`, home)).toBe('~.bak/x');
  });

  test('an empty or root home is not used as a pattern', () => {
    expect(redactUserPaths('a/b /c', '')).toBe('a/b /c');
    expect(redactUserPaths('a/b /c', '/')).toBe('a/b /c');
  });
});

describe('handleCallTool relays a thrown error without the username', () => {
  test('an fs error thrown past the dispatch gate reaches the client redacted', async () => {
    const server = new CopilotMoneyServer(SYNTHETIC_DB_PATH);
    const db = new CopilotDatabase(SYNTHETIC_DB_PATH);
    db.availability = () => ({ available: true });
    const tools = new CopilotMoneyTools(db);
    const leaked = `${homedir()}/Library/Containers/x/main/000001.ldb`;
    (tools as unknown as { getAccounts: () => never }).getAccounts = () => {
      throw new Error(`EACCES: permission denied, open '${leaked}'`);
    };
    server._injectForTesting(db, tools);

    const response = await server.handleCallTool('get_accounts', {});
    const text = response.content[0]?.text ?? '';
    expect(response.isError).toBe(true);
    expect(text).toContain('EACCES');
    expect(text).toContain('~/Library/Containers/x/main/000001.ldb');
    expect(text).not.toContain(homedir());
  });
});
