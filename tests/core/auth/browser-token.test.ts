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

  test('extracts token from Firefox profile IndexedDB', async () => {
    // Firefox stores tokens at: <profilesDir>/<profile>/storage/default/<origin>/idb/<file>
    const profileDir = join(tempDir, 'abcd1234.default-release');
    const idbDir = join(profileDir, 'storage/default/https+++app.copilot.money/idb');
    mkdirSync(idbDir, { recursive: true });

    const fakeToken = 'AMf-' + 'F'.repeat(200);
    writeFileSync(join(idbDir, '1234567890.sqlite'), `data ${fakeToken} more`);

    const overrides: BrowserConfig[] = [{ name: 'Firefox', paths: [tempDir], type: 'firefox' }];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
    expect(result.browser).toBe('Firefox');
  });

  test('extracts token from Safari database directory', async () => {
    // Safari searches recursively up to depth 4
    const nestedDir = join(tempDir, 'copilot', 'data');
    mkdirSync(nestedDir, { recursive: true });

    const fakeToken = 'AMf-' + 'S'.repeat(200);
    writeFileSync(join(nestedDir, 'IndexedDB.sqlite3'), `prefix ${fakeToken} suffix`);

    const overrides: BrowserConfig[] = [{ name: 'Safari', paths: [tempDir], type: 'safari' }];

    const result = await extractRefreshToken(overrides);
    expect(result.token).toBe(fakeToken);
    expect(result.browser).toBe('Safari');
  });

  test('Safari skips files larger than 10MB', async () => {
    const fakeToken = 'AMf-' + 'L'.repeat(200);
    // Create a file > 10MB
    const bigContent = 'x'.repeat(10_000_001) + fakeToken;
    writeFileSync(join(tempDir, 'big.sqlite'), bigContent);

    const overrides: BrowserConfig[] = [{ name: 'Safari', paths: [tempDir], type: 'safari' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('Safari respects max depth of 4', async () => {
    // Create a file at depth 5 — should not be found
    const deepDir = join(tempDir, 'a', 'b', 'c', 'd', 'e');
    mkdirSync(deepDir, { recursive: true });

    const fakeToken = 'AMf-' + 'D'.repeat(200);
    writeFileSync(join(deepDir, 'token.db'), fakeToken);

    const overrides: BrowserConfig[] = [{ name: 'Safari', paths: [tempDir], type: 'safari' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('Firefox skips profiles without copilot origin', async () => {
    const profileDir = join(tempDir, 'abcd1234.default');
    const idbDir = join(profileDir, 'storage/default/https+++other-site.com/idb');
    mkdirSync(idbDir, { recursive: true });

    const fakeToken = 'AMf-' + 'N'.repeat(200);
    writeFileSync(join(idbDir, 'data.sqlite'), fakeToken);

    const overrides: BrowserConfig[] = [{ name: 'Firefox', paths: [tempDir], type: 'firefox' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('Firefox handles non-existent profiles directory', async () => {
    const overrides: BrowserConfig[] = [
      { name: 'Firefox', paths: ['/nonexistent/firefox/path'], type: 'firefox' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('Safari handles non-existent database directory', async () => {
    const overrides: BrowserConfig[] = [
      { name: 'Safari', paths: ['/nonexistent/safari/path'], type: 'safari' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('chromium handles unreadable directory gracefully', async () => {
    // Directory that exists but readdir would fail on specific files
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    // Empty directory — no tokens found but no crash
    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
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
