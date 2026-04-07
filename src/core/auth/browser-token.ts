/**
 * Browser token extractor for Firebase refresh tokens.
 *
 * Searches Chrome, Arc, Safari, and Firefox LevelDB/IndexedDB storage
 * for Copilot Money Firebase refresh tokens (prefixed with "AMf-").
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Configuration for a browser's token storage location. */
export interface BrowserConfig {
  name: string;
  paths: string[];
  type: 'chromium' | 'safari' | 'firefox';
}

/** Result of a successful token extraction. */
export interface TokenResult {
  token: string;
  browser: string;
}

/** Firebase refresh token regex: AMf- followed by 100+ URL-safe base64 chars. */
const REFRESH_TOKEN_REGEX = /AMf-[A-Za-z0-9_-]{100,}/g;

/** Default browser configurations for macOS. */
export const BROWSER_CONFIGS: BrowserConfig[] = [
  {
    name: 'Chrome',
    paths: [
      // Firebase Web SDK v9+ stores auth tokens in IndexedDB, not Local Storage.
      // Search the Copilot Money IndexedDB first (most reliable source).
      join(
        homedir(),
        'Library/Application Support/Google/Chrome/Default/IndexedDB/https_app.copilot.money_0.indexeddb.leveldb'
      ),
      join(homedir(), 'Library/Application Support/Google/Chrome/Default/Local Storage/leveldb'),
      join(homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Local Storage/leveldb'),
    ],
    type: 'chromium',
  },
  {
    name: 'Arc',
    paths: [
      join(
        homedir(),
        'Library/Application Support/Arc/User Data/Default/IndexedDB/https_app.copilot.money_0.indexeddb.leveldb'
      ),
      join(homedir(), 'Library/Application Support/Arc/User Data/Default/Local Storage/leveldb'),
    ],
    type: 'chromium',
  },
  {
    name: 'Safari',
    paths: [
      // Safari 17+ stores IndexedDB in the app container with hashed directory names
      join(
        homedir(),
        'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'
      ),
      join(homedir(), 'Library/Safari/Databases'),
    ],
    type: 'safari',
  },
  {
    name: 'Firefox',
    paths: [join(homedir(), 'Library/Application Support/Firefox/Profiles')],
    type: 'firefox',
  },
];

/** Search a directory for .ldb and .log files containing refresh tokens. */
function searchLevelDBDir(dirPath: string): string | undefined {
  if (!existsSync(dirPath)) return undefined;
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return undefined;
  }

  const targetFiles = files.filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));
  for (const file of targetFiles) {
    try {
      const content = readFileSync(join(dirPath, file), 'latin1');
      const matches = content.match(REFRESH_TOKEN_REGEX);
      if (matches && matches.length > 0) {
        // Pick the longest match — newer Firebase tokens tend to be longer
        return matches.reduce((a, b) => (a.length >= b.length ? a : b));
      }
    } catch {
      /* Skip unreadable files */
    }
  }
  return undefined;
}

/** Search Firefox profiles for refresh tokens. */
function searchFirefoxProfiles(profilesDir: string): string | undefined {
  if (!existsSync(profilesDir)) return undefined;
  try {
    const profiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const profile of profiles) {
      const idbBase = join(profilesDir, profile, 'storage/default');
      if (!existsSync(idbBase)) continue;
      const origins = readdirSync(idbBase, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.includes('copilot'))
        .map((d) => d.name);
      for (const origin of origins) {
        const idbDir = join(idbBase, origin, 'idb');
        if (!existsSync(idbDir)) continue;
        const files = readdirSync(idbDir);
        for (const file of files) {
          try {
            const content = readFileSync(join(idbDir, file), 'latin1');
            const matches = content.match(REFRESH_TOKEN_REGEX);
            if (matches && matches.length > 0) {
              // Pick the longest match — newer Firebase tokens tend to be longer
              return matches.reduce((a, b) => (a.length >= b.length ? a : b));
            }
          } catch {
            /* Skip */
          }
        }
      }
    }
  } catch {
    /* Skip */
  }
  return undefined;
}

/** Search Safari databases for refresh tokens. */
function searchSafariDatabases(dbDir: string): string | undefined {
  if (!existsSync(dbDir)) return undefined;
  try {
    const searchDir = (dir: string, depth: number): string | undefined => {
      if (depth > 4) return undefined;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = searchDir(fullPath, depth + 1);
          if (found) return found;
        } else if (entry.isFile()) {
          try {
            if (statSync(fullPath).size > 10_000_000) continue;
            const content = readFileSync(fullPath, 'latin1');
            const matches = content.match(REFRESH_TOKEN_REGEX);
            if (matches && matches.length > 0) {
              // Pick the longest match — newer Firebase tokens tend to be longer
              return matches.reduce((a, b) => (a.length >= b.length ? a : b));
            }
          } catch {
            /* Skip */
          }
        }
      }
      return undefined;
    };
    return searchDir(dbDir, 0);
  } catch {
    return undefined;
  }
}

/**
 * Extract a Firebase refresh token from browser local storage.
 * Searches browsers in order: Chrome, Arc, Safari, Firefox.
 * @param browserOverrides - Override browser configs for testing
 * @throws Error if no token is found in any browser
 */
export function extractRefreshToken(browserOverrides?: BrowserConfig[]): Promise<TokenResult> {
  const browsers = browserOverrides ?? BROWSER_CONFIGS;
  const checked: string[] = [];

  for (const browser of browsers) {
    checked.push(browser.name);
    for (const searchPath of browser.paths) {
      let token: string | undefined;
      switch (browser.type) {
        case 'chromium':
          token = searchLevelDBDir(searchPath);
          break;
        case 'firefox':
          token = searchFirefoxProfiles(searchPath);
          break;
        case 'safari':
          token = searchSafariDatabases(searchPath);
          break;
      }
      if (token) return Promise.resolve({ token, browser: browser.name });
    }
  }

  return Promise.reject(
    new Error(
      `No Copilot Money session found. Searched: ${checked.join(', ')}. ` +
        'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
    )
  );
}
