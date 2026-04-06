import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  extractRefreshToken,
  BROWSER_CONFIGS,
  type BrowserConfig,
} from '../../../src/core/auth/browser-token.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('BROWSER_CONFIGS', () => {
  test('defines configs for Chrome, Arc, Safari, and Firefox', () => {
    const names = BROWSER_CONFIGS.map((b) => b.name);
    expect(names).toContain('Chrome');
    expect(names).toContain('Arc');
    expect(names).toContain('Safari');
    expect(names).toContain('Firefox');
    expect(names).toHaveLength(4);
  });
});

describe('extractRefreshToken', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'browser-token-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('extracts token from .ldb file containing refresh token', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const fakeToken = 'AMf-' + 'a'.repeat(200);
    writeFileSync(join(ldbDir, '000001.ldb'), `some data ${fakeToken} more data`);

    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
    expect(result.browser).toBe('TestBrowser');
  });

  test('extracts token from .log file', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const fakeToken = 'AMf-' + 'B'.repeat(150);
    writeFileSync(join(ldbDir, '000001.log'), `prefix ${fakeToken} suffix`);

    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
  });

  test('returns error when no token found in any browser', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    writeFileSync(join(ldbDir, '000001.ldb'), 'no tokens here');

    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('returns error when directory does not exist', async () => {
    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: ['/nonexistent/path'], type: 'chromium' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('skips invalid tokens that are too short', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const shortToken = 'AMf-' + 'a'.repeat(50);
    writeFileSync(join(ldbDir, '000001.ldb'), shortToken);

    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('tries multiple browsers in order, returns first match', async () => {
    const dir1 = join(tempDir, 'browser1');
    const dir2 = join(tempDir, 'browser2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const token1 = 'AMf-' + 'X'.repeat(200);
    const token2 = 'AMf-' + 'Y'.repeat(200);
    writeFileSync(join(dir1, '000001.ldb'), token1);
    writeFileSync(join(dir2, '000001.ldb'), token2);

    const overrides: BrowserConfig[] = [
      { name: 'FirstBrowser', paths: [dir1], type: 'chromium' },
      { name: 'SecondBrowser', paths: [dir2], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(token1);
    expect(result.browser).toBe('FirstBrowser');
  });

  test('skips first browser if no token, finds in second', async () => {
    const dir1 = join(tempDir, 'browser1');
    const dir2 = join(tempDir, 'browser2');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    writeFileSync(join(dir1, '000001.ldb'), 'no tokens');
    const token2 = 'AMf-' + 'Z'.repeat(200);
    writeFileSync(join(dir2, '000001.ldb'), token2);

    const overrides: BrowserConfig[] = [
      { name: 'EmptyBrowser', paths: [dir1], type: 'chromium' },
      { name: 'HasToken', paths: [dir2], type: 'chromium' },
    ];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(token2);
    expect(result.browser).toBe('HasToken');
  });
});
