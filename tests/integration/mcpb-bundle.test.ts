/**
 * Regression test for the .mcpb bundle shipped to end users.
 *
 * The bundle is executed by Claude Desktop's built-in Node runtime after being
 * extracted to an arbitrary directory. It must start and respond to the MCP
 * `initialize` RPC without relying on anything outside the extracted directory
 * — in particular, the repository's own `node_modules` is not visible there.
 *
 * The v1.6.0 and v1.6.1 bundles shipped broken because `classic-level` was
 * marked `--external` at build time but `node_modules/` was excluded from the
 * bundle via `.mcpbignore`. This test runs the packed bundle under the same
 * constraints Claude Desktop does (extracted, isolated from the repo) so that
 * kind of regression is caught before release.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountDb } from '../helpers/test-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const bundlePath = join(repoRoot, 'copilot-money-mcp.mcpb');

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function readResponse(
  proc: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 5000
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (msg.id === id) {
              cleanup();
              resolve(msg);
              return;
            }
          } catch {
            // ignore non-JSON lines
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Server exited with code ${code} before responding to id=${id}\n` +
            `stdout buffer: ${buffer}\nstderr: ${stderr}`
        )
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timeout waiting for response id=${id}\nstdout: ${buffer}\nstderr: ${stderr}`)
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onStderr);
    proc.once('exit', onExit);
  });
}

function send(proc: ChildProcessWithoutNullStreams, msg: object): void {
  proc.stdin.write(JSON.stringify(msg) + '\n');
}

async function startAndInitialize(
  extractDir: string,
  cliArgs: string[] = []
): Promise<{ proc: ChildProcessWithoutNullStreams; initializeResult: JsonRpcResponse }> {
  const proc = spawn('node', [join(extractDir, 'dist/cli.js'), ...cliArgs], {
    cwd: extractDir,
    env: { ...process.env, NODE_PATH: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    send(proc, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcpb-regression-test', version: '0.0.0' },
      },
    });
    const initializeResult = await readResponse(proc, 0, 10_000);
    return { proc, initializeResult };
  } catch (err) {
    // The caller never receives `proc`, so kill it here instead of leaking it.
    proc.kill('SIGTERM');
    throw err;
  }
}

// Firestore-shaped opaque ID (trivial IDs mask resolution bugs).
const SYNTHETIC_ACCOUNT_ID = 'qZx8Kw2nRfTb6Lm1Vc3PYd0a';

describe('mcpb bundle', () => {
  let extractDir: string;
  let syntheticDbDir: string;
  let bundledVersion: string;

  beforeAll(async () => {
    // `unzip` is used to extract the bundle the way Claude Desktop does.
    // Pre-flight so the failure is clear on minimal images (e.g. Alpine).
    try {
      execSync('unzip -v', { stdio: 'ignore' });
    } catch {
      throw new Error('unzip binary is required to run this test');
    }

    execSync('bun run pack:mcpb', { cwd: repoRoot, stdio: 'inherit' });
    if (!existsSync(bundlePath)) {
      throw new Error(`pack:mcpb did not produce a bundle at ${bundlePath}`);
    }
    extractDir = mkdtempSync(join(tmpdir(), 'copilot-mcpb-test-'));
    execSync(`unzip -q ${JSON.stringify(bundlePath)} -d ${JSON.stringify(extractDir)}`);
    bundledVersion = JSON.parse(readFileSync(join(extractDir, 'package.json'), 'utf8')).version;

    // Synthetic LevelDB for the tools/call round-trip test. Built here (in the
    // test process) and handed to the spawned bundle via --db-path.
    syntheticDbDir = mkdtempSync(join(tmpdir(), 'copilot-mcpb-db-'));
    await createAccountDb(syntheticDbDir, [
      {
        account_id: SYNTHETIC_ACCOUNT_ID,
        name: 'Synthetic Checking',
        account_type: 'depository',
        subtype: 'checking',
        current_balance: 100,
        iso_currency_code: 'USD',
      },
    ]);
  }, 120_000);

  afterAll(() => {
    if (extractDir) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    if (syntheticDbDir) {
      rmSync(syntheticDbDir, { recursive: true, force: true });
    }
  });

  test('extracted bundle has a dist/cli.js entry point', () => {
    expect(existsSync(join(extractDir, 'dist/cli.js'))).toBe(true);
  });

  test('server starts and responds to initialize with matching version', async () => {
    const { proc, initializeResult } = await startAndInitialize(extractDir);
    try {
      expect(initializeResult.error).toBeUndefined();
      const result = initializeResult.result as { serverInfo: { name: string; version: string } };
      expect(result.serverInfo.name).toBe('copilot-money-mcp');
      expect(result.serverInfo.version).toBe(bundledVersion);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);

  test('server advertises the expected number of tools', async () => {
    const { proc } = await startAndInitialize(extractDir);
    try {
      send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
      send(proc, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      const response = await readResponse(proc, 1, 10_000);
      const tools = (response.result as { tools: unknown[] }).tools;
      expect(Array.isArray(tools)).toBe(true);
      // Bundled CLI runs read-only; write tools are excluded.
      expect(tools.length).toBe(14);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);

  test('tools/call round-trips a well-formed result over stdio', async () => {
    const { proc } = await startAndInitialize(extractDir, ['--db-path', syntheticDbDir]);
    try {
      send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });
      send(proc, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_accounts', arguments: {} },
      });
      const response = await readResponse(proc, 2, 10_000);

      expect(response.error).toBeUndefined();
      const result = response.result as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();

      // A well-formed MCP result carries text content blocks whose payload is
      // valid JSON — this is where non-serializable tool output would surface.
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      const block = result.content[0];
      expect(block.type).toBe('text');

      const payload = JSON.parse(block.text) as {
        count: number;
        accounts: Array<{ account_id: string; name?: string; current_balance?: number }>;
      };
      expect(payload.count).toBe(1);
      expect(payload.accounts[0].account_id).toBe(SYNTHETIC_ACCOUNT_ID);
      expect(payload.accounts[0].name).toBe('Synthetic Checking');
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);
});
