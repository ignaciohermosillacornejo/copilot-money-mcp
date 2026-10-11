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

  test('an empty or root home is not used as a pattern', () => {
    expect(redactUserPaths('a/b /c', '')).toBe('a/b /c');
    expect(redactUserPaths('a/b /c', '/')).toBe('a/b /c');
  });
});

describe('handleCallTool relays a thrown error without the username', () => {
  test('an fs error thrown past the dispatch gate reaches the client redacted', async () => {
    const server = new CopilotMoneyServer('/nonexistent/copilot-money-mcp/redact-test');
    const db = new CopilotDatabase('/nonexistent/copilot-money-mcp/redact-test');
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
