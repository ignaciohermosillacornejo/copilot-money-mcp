/**
 * Browser token extractor for Firebase refresh tokens.
 *
 * Searches Chromium browsers (Chrome, Arc, Edge, Brave, Vivaldi, Chromium,
 * Opera, Opera GX), Safari, and Firefox LevelDB/IndexedDB storage for Copilot
 * Money Firebase refresh tokens (prefixed with "AMf-").
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

/**
 * All refresh-token candidates discovered across browsers, plus the list of
 * browsers searched (for the actionable "no session" message).
 *
 * Why a *list*: the browser-wide `Local Storage/leveldb` fallback contains
 * EVERY site's storage, so any other Firebase-backed site's `AMf-` refresh
 * token shows up here too. We can't tell from disk alone which (if any)
 * belongs to Copilot's project (copilot-production-22904) — only the
 * securetoken exchange knows. So we surface every candidate and let the
 * exchange in `firebase-auth.ts` discard foreign-project ones
 * (PROJECT_NUMBER_MISMATCH) and keep trying.
 */
export interface TokenCandidates {
  candidates: TokenResult[];
  /** Browser names searched, in order — used to build the "no session" error. */
  checked: string[];
}

/** Firebase refresh token regex: AMf- followed by 100+ URL-safe base64 chars. */
const REFRESH_TOKEN_REGEX = /AMf-[A-Za-z0-9_-]{100,}/g;
const COPILOT_INDEXEDDB_DIR = 'IndexedDB/https_app.copilot.money_0.indexeddb.leveldb';
const LOCAL_STORAGE_DIR = 'Local Storage/leveldb';

/**
 * Build token search paths for Chromium profile directories.
 *
 * Chrome profile directory names are not guaranteed to be `Default`; once users
 * create/delete profiles, the sole active profile can be `Profile 1`,
 * `Profile 3`, etc. Firebase Web SDK v9+ stores Copilot auth in per-profile
 * IndexedDB, so scan all normal Chrome profile directories and prefer
 * IndexedDB before the older Local Storage fallback.
 */
export function getChromiumProfileStoragePaths(userDataDir: string): string[] {
  const profileDirs = new Set<string>(['Default']);
  if (existsSync(userDataDir)) {
    try {
      for (const entry of readdirSync(userDataDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Profile \d+$/.test(entry.name)) {
          profileDirs.add(entry.name);
        }
      }
    } catch {
      /* Fall back to Default below */
    }
  }

  const sortedProfiles = Array.from(profileDirs).sort((a, b) => {
    if (a === 'Default') return -1;
    if (b === 'Default') return 1;
    return Number(a.slice('Profile '.length)) - Number(b.slice('Profile '.length));
  });

  return sortedProfiles.flatMap((profile) => [
    join(userDataDir, profile, COPILOT_INDEXEDDB_DIR),
    join(userDataDir, profile, LOCAL_STORAGE_DIR),
  ]);
}

/**
 * Chromium-based browsers that use the standard Chrome user-data layout
 * (`Default` / `Profile N` subdirectories), keyed to their macOS user-data
 * directory relative to the home folder. They all store Copilot's Firebase
 * Web SDK session under per-profile IndexedDB/Local Storage, so they share
 * getChromiumProfileStoragePaths for multi-profile discovery.
 */
const CHROMIUM_USER_DATA_DIRS: ReadonlyArray<{ name: string; userDataDir: string }> = [
  { name: 'Chrome', userDataDir: 'Library/Application Support/Google/Chrome' },
  { name: 'Arc', userDataDir: 'Library/Application Support/Arc/User Data' },
  { name: 'Microsoft Edge', userDataDir: 'Library/Application Support/Microsoft Edge' },
  { name: 'Brave', userDataDir: 'Library/Application Support/BraveSoftware/Brave-Browser' },
  { name: 'Vivaldi', userDataDir: 'Library/Application Support/Vivaldi' },
  { name: 'Chromium', userDataDir: 'Library/Application Support/Chromium' },
];

/**
 * Opera-family browsers historically kept their single profile at the
 * user-data root (no `Default` subdirectory), but recent Chromium-based Opera
 * builds may use Chrome's `Default` / `Profile N` layout. We can't know which
 * a given install uses, so we search both: the storage dirs directly under the
 * user-data root plus the standard per-profile paths. Non-existent paths are
 * skipped cheaply at search time.
 */
const OPERA_USER_DATA_DIRS: ReadonlyArray<{ name: string; userDataDir: string }> = [
  { name: 'Opera', userDataDir: 'Library/Application Support/com.operasoftware.Opera' },
  { name: 'Opera GX', userDataDir: 'Library/Application Support/com.operasoftware.OperaGX' },
];

/** Default browser configurations for macOS. */
export const BROWSER_CONFIGS: BrowserConfig[] = [
  ...CHROMIUM_USER_DATA_DIRS.map(
    ({ name, userDataDir }): BrowserConfig => ({
      name,
      paths: getChromiumProfileStoragePaths(join(homedir(), userDataDir)),
      type: 'chromium',
    })
  ),
  ...OPERA_USER_DATA_DIRS.map(({ name, userDataDir }): BrowserConfig => {
    const root = join(homedir(), userDataDir);
    return {
      name,
      // Root layout (older builds) first, then the Chrome-style Default/Profile
      // N layout (recent builds) via the shared multi-profile discovery.
      paths: [
        join(root, COPILOT_INDEXEDDB_DIR),
        join(root, LOCAL_STORAGE_DIR),
        ...getChromiumProfileStoragePaths(root),
      ],
      type: 'chromium',
    };
  }),
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

/**
 * Extract every refresh token from a file's raw bytes.
 *
 * Returns ALL matches (longest first), not just the longest one: on disk we
 * cannot tell which `AMf-` token belongs to Copilot's Firebase project, so we
 * surface every candidate and let the securetoken exchange reject foreign
 * ones. The longest-first ordering preserves the old "newer tokens tend to be
 * longer" heuristic as a try-order preference, not a hard pick.
 */
function tokensInFile(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, 'latin1');
    const matches = content.match(REFRESH_TOKEN_REGEX);
    if (!matches || matches.length === 0) return [];
    return [...matches].sort((a, b) => b.length - a.length);
  } catch {
    /* Skip unreadable files */
    return [];
  }
}

/** Search a directory for .ldb and .log files containing refresh tokens. */
function searchLevelDBDir(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  let files: string[];
  try {
    files = readdirSync(dirPath);
  } catch {
    return [];
  }

  const targetFiles = files.filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));
  return targetFiles.flatMap((file) => tokensInFile(join(dirPath, file)));
}

/** Search Firefox profiles for refresh tokens. */
function searchFirefoxProfiles(profilesDir: string): string[] {
  if (!existsSync(profilesDir)) return [];
  const found: string[] = [];
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
        for (const file of readdirSync(idbDir)) {
          found.push(...tokensInFile(join(idbDir, file)));
        }
      }
    }
  } catch {
    /* Skip */
  }
  return found;
}

/** Search Safari databases for refresh tokens. */
function searchSafariDatabases(dbDir: string): string[] {
  if (!existsSync(dbDir)) return [];
  const found: string[] = [];
  try {
    const searchDir = (dir: string, depth: number): void => {
      if (depth > 4) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            if (statSync(fullPath).size > 10_000_000) continue;
          } catch {
            continue;
          }
          found.push(...tokensInFile(fullPath));
        }
      }
    };
    searchDir(dbDir, 0);
  } catch {
    /* Skip */
  }
  return found;
}

/** Search one browser config's paths, returning every token found. */
function searchBrowser(browser: BrowserConfig): string[] {
  const search: (path: string) => string[] =
    browser.type === 'chromium'
      ? searchLevelDBDir
      : browser.type === 'firefox'
        ? searchFirefoxProfiles
        : searchSafariDatabases;
  return browser.paths.flatMap(search);
}

/**
 * Build the actionable "no Copilot session" error from the searched browsers.
 * Used both when zero `AMf-` tokens exist anywhere AND when every discovered
 * token turned out to belong to a foreign Firebase project (the exchange in
 * firebase-auth.ts rejected them all with PROJECT_NUMBER_MISMATCH). Both states
 * mean the same thing to the user: log in. This is AUTH_FAILED /
 * user-action-required, never schema/API drift.
 */
export function noCopilotSessionError(checked: string[]): Error {
  return new Error(
    `No Copilot Money session found. Searched: ${checked.join(', ')}. ` +
      'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
  );
}

/**
 * Extract ALL Firebase refresh-token candidates from browser local storage.
 *
 * Searches browsers in order: the Chromium family (Chrome, Arc, Edge, Brave,
 * Vivaldi, Chromium, Opera, Opera GX), then Safari, then Firefox — and within
 * each, every configured path. Returns every distinct `AMf-` token discovered,
 * because the browser-wide Local Storage fallback contains other sites' tokens
 * too; only the securetoken exchange can tell which belongs to Copilot's
 * project. Does NOT throw on empty — returns `{ candidates: [], checked }` so
 * the caller can attempt exchanges and build a single, consistent error.
 *
 * @param browserOverrides - Override browser configs for testing
 */
export function extractRefreshTokenCandidates(
  browserOverrides?: BrowserConfig[]
): Promise<TokenCandidates> {
  const browsers = browserOverrides ?? BROWSER_CONFIGS;
  const checked: string[] = [];
  const candidates: TokenResult[] = [];
  const seen = new Set<string>();

  for (const browser of browsers) {
    checked.push(browser.name);
    for (const token of searchBrowser(browser)) {
      if (seen.has(token)) continue;
      seen.add(token);
      candidates.push({ token, browser: browser.name });
    }
  }

  return Promise.resolve({ candidates, checked });
}

/**
 * Extract the first Firebase refresh-token candidate from browser storage.
 *
 * Thin wrapper over {@link extractRefreshTokenCandidates} that returns the
 * first candidate and throws the actionable "no session" error when none
 * exist. Note: this does NOT validate that the token belongs to Copilot's
 * project — callers that need foreign-project rejection should consume the
 * full candidate list and drive the exchange-and-discard loop (see
 * `FirebaseAuth`). Retained for backward compatibility.
 *
 * @param browserOverrides - Override browser configs for testing
 * @throws Error if no token is found in any browser
 */
export async function extractRefreshToken(
  browserOverrides?: BrowserConfig[]
): Promise<TokenResult> {
  const { candidates, checked } = await extractRefreshTokenCandidates(browserOverrides);
  const [first] = candidates;
  if (!first) throw noCopilotSessionError(checked);
  return first;
}
