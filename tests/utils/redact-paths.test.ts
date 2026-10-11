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

  test('the home matches as a whole segment, not as a prefix of a longer name', () => {
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
    expect(redactUserPaths(`${home}-backup/x`, home)).toBe(`${home}-backup/x`);
  });

  test("under /Users, a home that is a prefix of another user's name never matches inside it", () => {
    // `/Users/bob` inside `/Users/bob.smith/...` must not become `~.smith/...`,
    // which would leak the other user's name tail. Under /Users and /home the
    // home matches only when followed by `/` or end of input, and the generic
    // prefix rule takes every sibling whole.
    const home = '/Users/bob';
    expect(redactUserPaths('/Users/bob.smith/x', home)).toBe('/Users/<user>/x');
    expect(redactUserPaths('/Users/bob.bak/x', home)).toBe('/Users/<user>/x');
    expect(redactUserPaths('/home/bob.smith/x', '/home/bob')).toBe('/home/<user>/x');
    expect(redactUserPaths('/Users/bob/x and /Users/bob', home)).toBe('~/x and ~');
  });

  test('a non-ASCII continuation is a different name, under /Users and outside it', () => {
    // `\w` is ASCII-only, so a name continued by `ü` would read as "not a name
    // character" to an ASCII lookahead and leak the tail as `~ü`.
    expect(redactUserPaths('/Users/bobü/x', '/Users/bob')).toBe('/Users/<user>/x');
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
