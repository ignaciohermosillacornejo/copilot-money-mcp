/** Startup regressions run in child processes with synthetic HOME, never real finance data. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-startup-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(body: string): void {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { homedir } from 'node:os';
    import { CopilotDatabase, discoverCopilotDatabase } from './src/core/database.ts';
    import { CopilotMoneyServer } from './src/server.ts';
    const home = homedir();
    const main = home + '/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-test/main';
    fs.mkdirSync(main, {recursive:true}); fs.writeFileSync(main + '/000001.ldb', '');
    const original = fs.readdirSync;
    let walks = 0;
    let fault;
    fs.readdirSync = (...args) => {
      if (String(args[0]).startsWith(home)) {
        walks++;
        if (fault) throw Object.assign(new Error(fault), {code:fault});
      }
      return original(...args);
    };
    ${body}
  `,
    ],
    {
      env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, RUN_REAL_DB_TESTS: '0' },
      encoding: 'utf8',
      timeout: 15000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

test('construction and tools/list perform no ambient discovery', () => {
  run(`fault = 'EACCES';
    new CopilotDatabase();
    const server = new CopilotMoneyServer();
    assert.ok(server.handleListTools().tools.length > 0);
    assert.equal(walks, 0);`);
});

test('getDbPath discovers on demand; explicit paths never discover', () => {
  run(`const db = new CopilotDatabase(); assert.equal(walks, 0);
    assert.equal(db.getDbPath(), main); assert.ok(walks > 0);
    walks = 0; fault = 'EACCES';
    assert.equal(new CopilotDatabase('/synthetic/explicit').getDbPath(), '/synthetic/explicit');
    assert.equal(walks, 0);`);
});

test('first lookup preserves transient error and subsequent access retries', () => {
  run(`const db = new CopilotDatabase(); fault = 'EINTR';
    assert.equal(db.availability().lookupError.code, 'EINTR');
    const firstWalks = walks; assert.ok(firstWalks > 0);
    fault = undefined; assert.equal(db.getDbPath(), main); assert.ok(walks > firstWalks);`);
});

test('a transient first lookup makes exactly one discovery attempt, not a retry too', () => {
  run(`fault = 'EINTR';
    discoverCopilotDatabase(home); const oneAttempt = walks; assert.ok(oneAttempt > 0);
    walks = 0; assert.equal(new CopilotDatabase().availability().lookupError.code, 'EINTR');
    assert.equal(walks, oneAttempt);`);
});

test('settled absence does not rewalk', () => {
  run(`fs.rmSync(home + '/Library', {recursive:true});
    const db = new CopilotDatabase(); assert.equal(db.getDbPath(), undefined);
    walks = 0; fault = 'EINTR'; assert.deepEqual(db.availability(), {available:false, lookupError:undefined});
    assert.equal(walks, 0);`);
});

test('persistent permission error is retained without rewalking', () => {
  run(`const db = new CopilotDatabase(); fault = 'EPERM';
    assert.equal(db.availability().lookupError.code, 'EPERM');
    walks = 0; fault = undefined;
    assert.equal(db.availability().lookupError.code, 'EPERM'); assert.equal(walks, 0);`);
});

test('live read with a mocked provider never discovers the local cache', () => {
  run(`fault = 'EACCES'; let queries = 0;
    const client = {query: async () => { queries++; return {accounts:[]}; }};
    const server = new CopilotMoneyServer(undefined, undefined, false, true, client);
    assert.ok(server.handleListTools().tools.some(t => t.name === 'get_accounts_live'));
    const result = await server.handleCallTool('get_accounts_live', {});
    assert.notEqual(result.isError, true); assert.equal(queries, 1); assert.equal(walks, 0);`);
});
