import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  extractRefreshToken,
  BROWSER_CONFIGS,
  type BrowserConfig,
} from '../../../src/core/auth/browser-token.js';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, chmodSync } from 'fs';
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
    // Create a file > 10MB using a sparse buffer to avoid 10MB heap allocation
    const filePath = join(tempDir, 'big.sqlite');
    writeFileSync(filePath, Buffer.alloc(10_000_001));
    const { appendFileSync } = await import('fs');
    appendFileSync(filePath, fakeToken);

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

  test('chromium handles empty directory gracefully', async () => {
    const ldbDir = join(tempDir, 'leveldb');
    mkdirSync(ldbDir, { recursive: true });
    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('chromium: handles unreadable directory (readdirSync catch)', async () => {
    // Create a file where a directory is expected — readdirSync will throw ENOTDIR
    const fakeDirPath = join(tempDir, 'not-a-dir');
    writeFileSync(fakeDirPath, 'I am a file, not a directory');

    const overrides: BrowserConfig[] = [
      { name: 'TestBrowser', paths: [fakeDirPath], type: 'chromium' },
    ];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('chromium: handles unreadable .ldb file (readFileSync catch)', async () => {
    const ldbDir = join(tempDir, 'leveldb-unreadable');
    mkdirSync(ldbDir, { recursive: true });
    // Create a symlink to a non-existent file — readFileSync will throw ENOENT
    symlinkSync('/nonexistent/target/file', join(ldbDir, '000001.ldb'));

    const overrides: BrowserConfig[] = [{ name: 'TestBrowser', paths: [ldbDir], type: 'chromium' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('firefox: handles unreadable IDB file (readFileSync catch)', async () => {
    const profileDir = join(tempDir, 'profile.default');
    const idbDir = join(profileDir, 'storage/default/https+++app.copilot.money/idb');
    mkdirSync(idbDir, { recursive: true });
    // Create a symlink to a non-existent file
    symlinkSync('/nonexistent/target', join(idbDir, 'data.sqlite'));

    const overrides: BrowserConfig[] = [{ name: 'Firefox', paths: [tempDir], type: 'firefox' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('firefox: handles unreadable profiles dir (outer catch)', async () => {
    // Point to a file instead of directory — readdirSync with withFileTypes will throw
    const fakePath = join(tempDir, 'firefox-file');
    writeFileSync(fakePath, 'not a directory');

    // But existsSync will return true — the outer catch should handle the ENOTDIR
    const overrides: BrowserConfig[] = [{ name: 'Firefox', paths: [fakePath], type: 'firefox' }];

    await expect(extractRefreshToken(overrides)).rejects.toThrow('No Copilot Money session found');
  });

  test('safari: handles unreadable file (readFileSync/statSync catch)', async () => {
    const safariDir = join(tempDir, 'safari-unreadable');
    mkdirSync(safariDir, { recursive: true });
    // Create a real file then revoke read permission — statSync succeeds but readFileSync throws EACCES
    const filePath = join(safariDir, 'token.db');
    writeFileSync(filePath, 'some content');
    chmodSync(filePath, 0o000);

    const overrides: BrowserConfig[] = [{ name: 'Safari', paths: [safariDir], type: 'safari' }];

    try {
      await expect(extractRefreshToken(overrides)).rejects.toThrow(
        'No Copilot Money session found'
      );
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

  test('safari: handles unreadable top-level dir (outer catch)', async () => {
    // Point to a file instead of directory
    const fakePath = join(tempDir, 'safari-file');
    writeFileSync(fakePath, 'not a directory');

    const overrides: BrowserConfig[] = [{ name: 'Safari', paths: [fakePath], type: 'safari' }];

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
