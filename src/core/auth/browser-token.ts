/**
 * Browser token extractor for Firebase refresh tokens.
 *
 * Searches Chromium browsers (Chrome, Arc, Edge, Brave, Vivaldi, Chromium,
 * Opera, Opera GX), Safari, and Firefox LevelDB/IndexedDB storage for Copilot
 * Money Firebase refresh tokens (prefixed with "AMf-"). macOS locations are
 * the default; on Linux the Linux ones are searched instead. An explicit
 * `--browser` / `--browser-profile` selection (see `browser-selection.ts`)
 * restricts the search to one browser and profile.
 */

import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { retryInterrupted } from '../fs-retry.js';
import {
  BROWSER_DISPLAY_NAMES,
  describeBrowserSelection,
  isFirefoxProfileDir,
  matchesFirefoxProfileName,
  parseProfileQuery,
  type BrowserId,
  type BrowserSelection,
} from './browser-selection.js';

/** Configuration for a browser's token storage location. */
export interface BrowserConfig {
  name: string;
  paths: string[];
  /**
   * `firefox` paths are profiles roots (every profile under each is searched);
   * `firefox-profile` paths are single profile directories, which is what a
   * `--browser-profile` selection resolves to.
   */
  type: 'chromium' | 'safari' | 'firefox' | 'firefox-profile';
}

/** Result of a successful token extraction. */
export interface TokenResult {
  token: string;
  browser: string;
  /**
   * True when the token was read from a location only Copilot's own web
   * origin writes to (a per-origin IndexedDB / storage directory whose name
   * carries `app.copilot.money`); false for browser-wide stores every site
   * shares. This is provenance, NOT validation: a scoped token can still be
   * stale, and only the securetoken exchange knows which project a token
   * belongs to. It exists so the exchange budget in `firebase-auth.ts` can
   * spend on the high-probability pool first — see issue #722.
   */
  scoped: boolean;
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
  /**
   * De-duplicated candidates, Copilot-scoped ones first (see `TokenResult.scoped`),
   * discovery order preserved within each group.
   */
  candidates: TokenResult[];
  /** Browser names searched, in order — used to build the "no session" error. */
  checked: string[];
  /**
   * Present only for an explicit `--browser` selection: what was searched and,
   * if it was missing on disk, why — so the "no session" error can name it.
   */
  selection?: SelectionReport;
}

/** Firebase refresh token regex: AMf- followed by 100+ URL-safe base64 chars. */
const REFRESH_TOKEN_REGEX = /AMf-[A-Za-z0-9_-]{100,}/g;
const COPILOT_INDEXEDDB_DIR = 'IndexedDB/https_app.copilot.money_0.indexeddb.leveldb';
const LOCAL_STORAGE_DIR = 'Local Storage/leveldb';

/**
 * Copilot's web origin as browsers encode it into a storage directory name —
 * matched as a WHOLE HOST, not as a substring of a longer one.
 *
 * Every encoding wraps the host in characters that cannot occur inside a
 * hostname: Chromium writes `https_app.copilot.money_0.indexeddb.leveldb`,
 * Firefox writes `https+++app.copilot.money` (optionally followed by
 * `^partitionKey=…`), and Safari's legacy origin-named database directories
 * follow Chromium's shape. So requiring a non-hostname character on both sides
 * is enough to separate the real origin from a lookalike, without having to
 * enumerate the encodings — which would rot the day a browser adds a suffix.
 *
 * `app.copilot.money.example.com` and `evil-app.copilot.money` are the cases
 * this rules out: both contain the host as a substring, neither is delimited
 * by it. Getting that wrong is not a vulnerability — the exchange still
 * rejects a foreign token — but it would hand a lookalike a slot in the
 * high-priority pool it has no claim to.
 */
const COPILOT_ORIGIN_PATTERN = /(?:^|[^A-Za-z0-9.-])app\.copilot\.money(?![A-Za-z0-9.-])/;

/**
 * True when a storage path names Copilot's own web origin as a whole host.
 *
 * What that supports is "a browser wrote this directory for app.copilot.money,
 * so app.copilot.money is what put tokens in it" — not a property of the whole
 * path. Chromium and Safari are matched on the full path rather than on an
 * isolated origin component (Firefox passes the origin directory itself), so a
 * user-data directory living under a path component literally named
 * `app.copilot.money` would also match. That fails toward pre-#722 behaviour —
 * a candidate ranked higher than it earned, still rejected by the exchange —
 * and reads nothing extra from disk.
 *
 * Deliberately a test on the path rather than a per-browser flag: the three
 * searchers hand it different things (a Chromium search directory, a Firefox
 * origin directory, a Safari file path) and the property being asserted —
 * "this location belongs to Copilot's origin" — is the same one in all three.
 *
 * Provenance, NOT validation. It says who wrote the bytes, never whether the
 * token inside them is live or whose project it belongs to; only the exchange
 * knows that. Note the READ filter it feeds is far looser — Firefox visits any
 * storage origin whose directory name contains `copilot` — and this does not
 * change that. Exported for the ordering tests.
 */
export function isCopilotScopedPath(path: string): boolean {
  return COPILOT_ORIGIN_PATTERN.test(path);
}

/** A token plus where it came from, before it is attributed to a browser. */
interface FoundToken {
  token: string;
  scoped: boolean;
}

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
      for (const entry of retryInterrupted(() =>
        readdirSync(userDataDir, { withFileTypes: true })
      )) {
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
 * Where one browser keeps its data on one platform, before it is turned into
 * the flat search-path list a {@link BrowserConfig} carries. Kept separately
 * because selecting a profile needs the user-data roots, which the flat list
 * has already expanded away.
 */
type BrowserLocation =
  | {
      id: BrowserId;
      /**
       * `chromium`: Chrome's `Default` / `Profile N` layout. `opera`: the
       * same, plus the storage dirs directly under the root (see
       * OPERA_USER_DATA_DIRS).
       */
      kind: 'chromium' | 'opera';
      userDataDirs: string[];
    }
  | { id: BrowserId; kind: 'safari'; paths: string[] }
  | {
      id: BrowserId;
      kind: 'firefox';
      /** `root` holds `profiles.ini`; `profilesDir` holds the profile dirs. */
      installs: Array<{ root: string; profilesDir: string }>;
    };

/**
 * Chromium-based browsers that use the standard Chrome user-data layout
 * (`Default` / `Profile N` subdirectories), keyed to their macOS user-data
 * directory relative to the home folder. They all store Copilot's Firebase
 * Web SDK session under per-profile IndexedDB/Local Storage, so they share
 * getChromiumProfileStoragePaths for multi-profile discovery.
 */
const CHROMIUM_USER_DATA_DIRS: ReadonlyArray<{ id: BrowserId; userDataDir: string }> = [
  { id: 'chrome', userDataDir: 'Library/Application Support/Google/Chrome' },
  { id: 'arc', userDataDir: 'Library/Application Support/Arc/User Data' },
  { id: 'edge', userDataDir: 'Library/Application Support/Microsoft Edge' },
  { id: 'brave', userDataDir: 'Library/Application Support/BraveSoftware/Brave-Browser' },
  { id: 'vivaldi', userDataDir: 'Library/Application Support/Vivaldi' },
  { id: 'chromium', userDataDir: 'Library/Application Support/Chromium' },
];

/**
 * Opera-family browsers historically kept their single profile at the
 * user-data root (no `Default` subdirectory), but recent Chromium-based Opera
 * builds may use Chrome's `Default` / `Profile N` layout. We can't know which
 * a given install uses, so we search both: the storage dirs directly under the
 * user-data root plus the standard per-profile paths. Non-existent paths are
 * skipped cheaply at search time.
 */
const OPERA_USER_DATA_DIRS: ReadonlyArray<{ id: BrowserId; userDataDir: string }> = [
  { id: 'opera', userDataDir: 'Library/Application Support/com.operasoftware.Opera' },
  { id: 'opera-gx', userDataDir: 'Library/Application Support/com.operasoftware.OperaGX' },
];

/** macOS locations — the original, and still the non-Linux default, table. */
function macosLocations(home: string): BrowserLocation[] {
  const firefoxRoot = join(home, 'Library/Application Support/Firefox');
  return [
    ...CHROMIUM_USER_DATA_DIRS.map(({ id, userDataDir }): BrowserLocation => ({
      id,
      kind: 'chromium',
      userDataDirs: [join(home, userDataDir)],
    })),
    ...OPERA_USER_DATA_DIRS.map(({ id, userDataDir }): BrowserLocation => ({
      id,
      kind: 'opera',
      userDataDirs: [join(home, userDataDir)],
    })),
    {
      id: 'safari',
      kind: 'safari',
      paths: [
        // Safari 17+ stores IndexedDB in the app container with hashed directory names
        join(home, 'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'),
        join(home, 'Library/Safari/Databases'),
      ],
    },
    {
      id: 'firefox',
      kind: 'firefox',
      installs: [{ root: firefoxRoot, profilesDir: join(firefoxRoot, 'Profiles') }],
    },
  ];
}

/**
 * Linux locations. Arc, Safari and Opera GX do not exist there. The
 * `~/.config` ones honour `XDG_CONFIG_HOME` (only when absolute, as the XDG
 * spec requires); the snap and flatpak sandboxes keep their own trees.
 * Firefox keeps `profiles.ini` and the profile dirs side by side, so `root`
 * and `profilesDir` are the same directory.
 */
function linuxLocations(home: string, env: Record<string, string | undefined>): BrowserLocation[] {
  const xdg = env.XDG_CONFIG_HOME;
  const config = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
  const firefox = (dir: string): { root: string; profilesDir: string } => ({
    root: dir,
    profilesDir: dir,
  });
  return [
    {
      id: 'chrome',
      kind: 'chromium',
      userDataDirs: [
        join(config, 'google-chrome'),
        join(config, 'google-chrome-beta'),
        join(config, 'google-chrome-unstable'),
      ],
    },
    { id: 'edge', kind: 'chromium', userDataDirs: [join(config, 'microsoft-edge')] },
    {
      id: 'brave',
      kind: 'chromium',
      userDataDirs: [join(config, 'BraveSoftware/Brave-Browser')],
    },
    { id: 'vivaldi', kind: 'chromium', userDataDirs: [join(config, 'vivaldi')] },
    {
      id: 'chromium',
      kind: 'chromium',
      userDataDirs: [join(config, 'chromium'), join(home, 'snap/chromium/common/chromium')],
    },
    { id: 'opera', kind: 'opera', userDataDirs: [join(config, 'opera')] },
    {
      id: 'firefox',
      kind: 'firefox',
      installs: [
        firefox(join(home, '.mozilla/firefox')),
        // Firefox 147+ follows the XDG Base Directory spec ("Firefox now
        // supports the Freedesktop.org XDG Base Directory Specification",
        // 147.0 release notes; bug 259356): with no legacy ~/.mozilla it
        // creates its profiles root at $XDG_CONFIG_HOME/<vendor>/<app>, i.e.
        // ~/.config/mozilla/firefox, ignoring a relative XDG_CONFIG_HOME
        // (toolkit/xre/nsXREDirProvider.cpp, GetLegacyOrXDGHomePath and
        // GetLegacyOrXDGConfigHome). Legacy first, as Firefox itself prefers it.
        firefox(join(config, 'mozilla/firefox')),
        firefox(join(home, 'snap/firefox/common/.mozilla/firefox')),
        firefox(join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')),
      ],
    },
  ];
}

/** Platform, home and environment the browser tables are built from. */
export interface BrowserEnvironment {
  /** Defaults to `process.platform`. Anything but `linux` gets the macOS table. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  home?: string;
  /** Defaults to `process.env`; only `XDG_CONFIG_HOME` is read. */
  env?: Record<string, string | undefined>;
}

function browserLocations(opts: BrowserEnvironment = {}): BrowserLocation[] {
  const home = opts.home ?? homedir();
  return (opts.platform ?? process.platform) === 'linux'
    ? linuxLocations(home, opts.env ?? process.env)
    : macosLocations(home);
}

/** The flat search list for one location, every profile included. */
function locationToConfig(location: BrowserLocation): BrowserConfig {
  const name = BROWSER_DISPLAY_NAMES[location.id];
  switch (location.kind) {
    case 'chromium':
      return {
        name,
        paths: location.userDataDirs.flatMap(getChromiumProfileStoragePaths),
        type: 'chromium',
      };
    case 'opera':
      return {
        name,
        // Root layout (older builds) first, then the Chrome-style Default/Profile
        // N layout (recent builds) via the shared multi-profile discovery.
        paths: location.userDataDirs.flatMap((root) => [
          join(root, COPILOT_INDEXEDDB_DIR),
          join(root, LOCAL_STORAGE_DIR),
          ...getChromiumProfileStoragePaths(root),
        ]),
        type: 'chromium',
      };
    case 'safari':
      return { name, paths: location.paths, type: 'safari' };
    case 'firefox':
      return { name, paths: location.installs.map((i) => i.profilesDir), type: 'firefox' };
  }
}

/**
 * Browser search configs for a platform, in default search order.
 *
 * macOS (and every non-Linux platform, as before Linux support existed):
 * Chrome, Arc, Edge, Brave, Vivaldi, Chromium, Opera, Opera GX, Safari,
 * Firefox. Linux: Chrome, Edge, Brave, Vivaldi, Chromium, Opera, Firefox.
 * Platform, home and environment are injectable so either table can be built
 * and tested from any OS.
 */
export function getBrowserConfigs(opts: BrowserEnvironment = {}): BrowserConfig[] {
  return browserLocations(opts).map(locationToConfig);
}

/** Default browser configurations for macOS. Kept for compatibility. */
export const BROWSER_CONFIGS: BrowserConfig[] = getBrowserConfigs({ platform: 'darwin' });

let linuxDefaultConfigs: BrowserConfig[] | undefined;

/**
 * What an extraction with no overrides and no selection searches. Outside
 * Linux that is exactly {@link BROWSER_CONFIGS}, built once at module load,
 * as it always was; on Linux the Linux table, built once on first use.
 */
function defaultBrowserConfigs(): BrowserConfig[] {
  if (process.platform !== 'linux') return BROWSER_CONFIGS;
  linuxDefaultConfigs ??= getBrowserConfigs();
  return linuxDefaultConfigs;
}

/**
 * Why an explicit selection may have nothing to search, carried to the "no
 * session" error so it can name the browser and profile instead of a list.
 */
export interface SelectionReport {
  /** e.g. `Brave` or `Brave (profile "Default")`. */
  label: string;
  /** Display name alone, e.g. `Brave`. */
  browser: string;
  profile?: string;
  /** The custom `--browser-data-dir`, when one replaced the defaults. */
  dataDir?: string;
  /**
   * Set when the browser's data or the profile was not found on disk, or the
   * profile name was ambiguous (then nothing was searched).
   */
  problem?: string;
  /**
   * Set when the problem is the selection itself, so logging in cannot help:
   * `ambiguous` (nothing was searched), `no-such-profile`, or
   * `unusable-profile` (the one match is a file or unreadable; see `notes`).
   */
  selectionError?: 'ambiguous' | 'no-such-profile' | 'unusable-profile';
  /**
   * Facts about the lookup worth stating whatever happened next: a
   * `profiles.ini` path that is missing or unreadable, display names that
   * could not be read.
   */
  notes?: string[];
  /** A likely misconfiguration worth naming if no session turns up. */
  hint?: string;
}

/** Directory entries, or null when the directory cannot be listed (absent). */
function listDir(dir: string): Dirent[] | null {
  try {
    return retryInterrupted(() => readdirSync(dir, { withFileTypes: true }));
  } catch {
    return null;
  }
}

/**
 * What is at `path`, telling "absent" apart from "there but unusable": an
 * unreadable or non-directory profile still names a profile, so it must still
 * count when deciding whether a name is ambiguous.
 *
 * Deliberately NOT `statPathKind` in `browser-selection.ts`, which folds every
 * error into "missing": here an EACCES must stay "unusable", or an unreadable
 * second profile would turn an ambiguous name into a silent pick.
 */
function directoryState(path: string): 'directory' | 'missing' | 'unusable' {
  try {
    return retryInterrupted(() => statSync(path)).isDirectory() ? 'directory' : 'unusable';
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unusable';
  }
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Profile names in a stable, human order: `Default`, `Profile 2`, `Profile 10`, … */
function sortProfileNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** `a`, `a and b`, `a, b and c` (or `or`). */
function joinList(items: string[], conjunction: 'and' | 'or' = 'and'): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

/** One profile a `--browser-profile` value matched, and how. */
interface ProfileMatch {
  /** e.g. `directory "Default"`, `the display name of directory "Profile 1"`. */
  how: string;
  /**
   * A `--browser-profile` value that selects exactly this profile, offered in
   * the refusal: `dir:<directory>` when the directory is one the lookup lists
   * (so `dir:` can see it), else `name:<Name=>` (a Firefox profile that
   * `profiles.ini` keeps outside the listed profiles dir).
   */
  pick: string;
  /**
   * The profile's absolute directory. Only Firefox can produce two matches
   * that share a `pick` (the same directory name in both listing dirs of one
   * root, or two out-of-root `profiles.ini` entries with one `Name=`); no
   * `--browser-profile` value tells those apart, so the refusal names them by
   * this path, for `--browser-data-dir`, which accepts a single Firefox
   * profile. Required so that path is always there to print.
   */
  path: string;
}

/**
 * The refusal for a `--browser-profile` that names more than one profile. It
 * names directories, never display names (often a person's real name), and
 * offers, for each match, a value that selects exactly that one: a prefixed
 * `--browser-profile`, or — when two matches would share that value — the
 * profile's path for `--browser-data-dir`.
 */
function ambiguousProfileMessage(
  profile: string,
  browser: string,
  matches: ProfileMatch[],
  root?: string
): string {
  const count = new Map<string, number>();
  for (const m of matches) count.set(m.pick, (count.get(m.pick) ?? 0) + 1);
  const unique = matches.filter((m) => count.get(m.pick) === 1);
  const shared = matches.filter((m) => count.get(m.pick) !== 1);
  const offers: string[] = [];
  if (unique.length > 0) {
    const choices = sortProfileNames(unique.map((m) => `"${m.pick}"`));
    offers.push(`Pick exactly one with --browser-profile ${joinList(choices, 'or')}.`);
  }
  // One clause per shared value: two different shared values ARE told apart
  // by name, only the matches within one group are not.
  const groups = new Map<string, string[]>();
  for (const m of shared) {
    const group = groups.get(m.pick) ?? [];
    group.push(`"${m.path}"`);
    groups.set(m.pick, group);
  }
  for (const paths of groups.values()) {
    offers.push(`No --browser-profile value tells ${joinList(sortProfileNames(paths))} apart.`);
  }
  if (groups.size > 0) {
    // Dropping --browser-profile matters: a name: value never matches a
    // single profile directory, so keeping it would be refused at startup.
    offers.push(
      'Select one by dropping --browser-profile and pointing --browser-data-dir at one of ' +
        'those paths.'
    );
  }
  // Matches that share a value would read identically ("directory "a1.work"
  // and directory "a1.work""), so those carry their path — unless the
  // description already holds it (an absolute profiles.ini Path=).
  const described = matches.map((m) =>
    count.get(m.pick) !== 1 && !m.how.includes(`"${m.path}"`) ? `${m.how} at "${m.path}"` : m.how
  );
  return (
    `--browser-profile "${profile}" is ambiguous in ${browser}${root ? ` (${root})` : ''}: ` +
    `it matches ${joinList(described)}. ${offers.join(' ')}`
  );
}

/**
 * Profile display names from a Chromium user-data dir's `Local State`:
 * `profile.info_cache[<dir>].name`. Nothing else in the file is used.
 *
 * A missing `Local State` is normal (directory names still match) and leaves
 * `unavailable` unset; one that exists but cannot be read or parsed sets it,
 * so a "no such profile" error can say display names were not consulted.
 */
function chromiumProfileDisplayNames(userDataDir: string): {
  names: Map<string, string>;
  unavailable?: string;
} {
  const names = new Map<string, string>();
  const path = join(userDataDir, 'Local State');
  let text: string;
  try {
    text = retryInterrupted(() => readFileSync(path, 'utf8'));
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT'
      ? { names }
      : { names, unavailable: `"${path}" could not be read` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { names, unavailable: `"${path}" could not be parsed` };
  }
  const infoCache = (parsed as { profile?: { info_cache?: unknown } } | null)?.profile?.info_cache;
  if (infoCache && typeof infoCache === 'object') {
    for (const [dir, info] of Object.entries(infoCache as Record<string, unknown>)) {
      const name = (info as { name?: unknown } | null)?.name;
      if (typeof name === 'string') names.set(dir, name);
    }
  }
  return { names };
}

/** `[Profile*]` sections of a Firefox `profiles.ini`: Name, Path, IsRelative. */
function firefoxIniProfiles(
  iniPath: string
): Array<{ name: string; path: string; isRelative: boolean }> {
  let text: string;
  try {
    text = retryInterrupted(() => readFileSync(iniPath, 'utf8'));
  } catch {
    return [];
  }
  const profiles: Array<{ name: string; path: string; isRelative: boolean }> = [];
  let current: Record<string, string> | null = null;
  const flush = (): void => {
    if (current?.Name && current.Path) {
      profiles.push({
        name: current.Name,
        path: current.Path,
        isRelative: current.IsRelative !== '0',
      });
    }
  };
  // A leading BOM (some Windows editors write one) would otherwise hide the
  // first section header.
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      flush();
      current = /^Profile\d+$/i.test(section[1] as string) ? {} : null;
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  flush();
  return profiles;
}

/**
 * What a profile lookup found. `ambiguous` is set when the name matched more
 * than one profile, and then `paths` is empty: nothing is searched. `notes`
 * explain matches that could not be used (a `profiles.ini` path that is
 * missing or unreadable, display names that could not be read).
 */
interface ProfilePick {
  paths: string[];
  existingRoots: number;
  available: string[];
  ambiguous?: string;
  notes: string[];
  /** Every matched profile exists but is unusable (a file, or unreadable). */
  unusableOnly?: boolean;
}

/**
 * Search paths for the named profile of a Chromium/Opera location.
 *
 * Without a prefix the name is compared with every profile directory AND every
 * `Local State` display name, and must match exactly one directory per
 * user-data root. Display names are not unique, and Edge's built-in ones are
 * off by one from the directories (`Default` is shown as "Profile 1",
 * `Profile 1` as "Profile 2"), so a name that hits a directory and a different
 * directory's display name — or two display names — is refused rather than
 * resolved by precedence: either answer could be someone else's session. A
 * directory whose own display name is the same string is one match, not two.
 * `dir:` / `name:` restrict the lookup to one namespace (see
 * {@link parseProfileQuery}); `dir:` is exact, so it always names one profile.
 *
 * Each root is checked on its own: the same `Default` in Chrome's stable,
 * beta and unstable roots on Linux is one profile per channel, all searched.
 * An ambiguity inside any one root refuses the whole selection.
 */
function selectChromiumProfile(
  userDataDirs: string[],
  profile: string,
  browser: string
): ProfilePick {
  const { namespace, value } = parseProfileQuery(profile);
  const paths: string[] = [];
  const available: string[] = [];
  const notes: string[] = [];
  let ambiguous: string | undefined;
  const listed = userDataDirs.flatMap((root) => {
    const entries = listDir(root);
    return entries ? [{ root, entries }] : [];
  });
  for (const { root: userDataDir, entries } of listed) {
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const { names: displayNames, unavailable } = chromiumProfileDisplayNames(userDataDir);
    available.push(
      ...dirs.filter((d) => d === 'Default' || /^Profile \d+$/.test(d) || displayNames.has(d))
    );
    // dir -> how it matched; a directory matched both ways counts once.
    const matches = new Map<string, ProfileMatch>();
    const byDir =
      namespace === 'dir'
        ? dirs.filter((d) => d === value)
        : namespace === 'any'
          ? dirs.filter((d) => sameName(d, value))
          : [];
    // Every match here is a listed directory, so `dir:` can always reach it.
    for (const dir of sortProfileNames(byDir)) {
      matches.set(dir, {
        how: `directory "${dir}"`,
        pick: `dir:${dir}`,
        path: join(userDataDir, dir),
      });
    }
    const byDisplayName =
      namespace === 'dir'
        ? []
        : [...displayNames]
            .filter(([dir, name]) => sameName(name, value) && dirs.includes(dir))
            .map(([dir]) => dir);
    for (const dir of sortProfileNames(byDisplayName)) {
      if (!matches.has(dir)) {
        matches.set(dir, {
          how: `the display name of directory "${dir}"`,
          pick: `dir:${dir}`,
          path: join(userDataDir, dir),
        });
      }
    }
    if (unavailable && namespace !== 'dir' && matches.size === 0) {
      notes.push(`Display names were unavailable: ${unavailable}.`);
    }
    // mutation-guard: an ambiguous Chromium profile name is refused
    if (matches.size > 1) {
      ambiguous ??= ambiguousProfileMessage(
        profile,
        browser,
        [...matches.values()],
        listed.length > 1 ? userDataDir : undefined
      );
      continue;
    }
    for (const dir of matches.keys()) {
      paths.push(
        join(userDataDir, dir, COPILOT_INDEXEDDB_DIR),
        join(userDataDir, dir, LOCAL_STORAGE_DIR)
      );
    }
  }
  const existingRoots = listed.length;
  return ambiguous
    ? { paths: [], existingRoots, available, ambiguous, notes }
    : { paths, existingRoots, available, notes };
}

/**
 * Profile directories for the named profile of a Firefox location.
 *
 * Same rule as Chromium: without a prefix the name is compared with every
 * directory name, the part of it after the first dot, and every
 * `profiles.ini` `Name=`, and must resolve to exactly one profile directory
 * per `profiles.ini` root (a custom data dir lists profiles both directly and
 * under `Profiles/`, so one root can have two listing dirs). `dir:` matches the
 * exact directory name only, `name:` only `Name=`.
 *
 * `profiles.ini` is read even when the profiles dir is absent, since its
 * `IsRelative=0` paths can point anywhere. A `Name=` whose `Path=` does not
 * exist is not a match, and is noted; one that exists but cannot be used (a
 * file, or unreadable) still counts as a match — it names a profile, so
 * dropping it could turn an ambiguous name into a silent pick — and is noted.
 */
function selectFirefoxProfile(
  installs: Array<{ root: string; profilesDir: string }>,
  profile: string
): ProfilePick {
  const { namespace, value } = parseProfileQuery(profile);
  const available: string[] = [];
  const notes: string[] = [];
  // root -> absolute profile dir -> how it first matched
  const byRoot = new Map<string, Map<string, ProfileMatch>>();
  const existing = new Set<string>();
  // Every directory a listing showed, so a profiles.ini match knows whether
  // `dir:` can reach it.
  const listedPaths = new Set<string>();
  // Pass 1: the listed profile directories of every install.
  for (const { root, profilesDir } of installs) {
    const matches = byRoot.get(root) ?? new Map<string, ProfileMatch>();
    byRoot.set(root, matches);
    const entries = listDir(profilesDir);
    if (!entries) continue;
    existing.add(root);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // Profile dirs are `<salt>.<name>`; `Crash Reports` and friends are not.
    available.push(...dirs.filter((d) => d.includes('.')));
    for (const dir of dirs) {
      const path = resolve(profilesDir, dir);
      listedPaths.add(path);
      if (matchesFirefoxProfileName(dir, profile) && !matches.has(path)) {
        matches.set(path, { how: `directory "${dir}"`, pick: `dir:${dir}`, path });
      }
    }
  }
  // Pass 2: each root's profiles.ini, once.
  const unusable = new Set<string>();
  for (const [root, matches] of byRoot) {
    const ini = firefoxIniProfiles(join(root, 'profiles.ini'));
    if (ini.length > 0) existing.add(root);
    if (namespace === 'dir') continue;
    for (const entry of ini) {
      if (!sameName(entry.name, value)) continue;
      const path = resolve(entry.isRelative ? join(root, entry.path) : entry.path);
      const state = directoryState(path);
      const at = `profiles.ini in "${root}" names "${entry.name}" at "${path}"`;
      if (state === 'missing') {
        notes.push(`${at}, which does not exist.`);
        continue;
      }
      if (state === 'unusable') {
        notes.push(`${at}, which is not a readable directory.`);
        unusable.add(path);
      }
      if (!matches.has(path)) {
        matches.set(path, {
          how: `the profiles.ini Name= of "${entry.path}"`,
          path,
          pick: listedPaths.has(path) ? `dir:${basename(path)}` : `name:${entry.name}`,
        });
      }
    }
  }
  const paths: string[] = [];
  for (const [root, matches] of byRoot) {
    // mutation-guard: an ambiguous Firefox profile name is refused
    if (matches.size > 1) {
      return {
        paths: [],
        existingRoots: existing.size,
        available,
        notes,
        ambiguous: ambiguousProfileMessage(
          profile,
          'Firefox',
          [...matches.values()],
          existing.size > 1 ? root : undefined
        ),
      };
    }
    paths.push(...matches.keys());
  }
  const unusableOnly = paths.length > 0 && paths.every((p) => unusable.has(p));
  return { paths, existingRoots: existing.size, available, notes, unusableOnly };
}

/**
 * True when `dir` looks like one Chromium profile (`Default`, `Profile 3`, or
 * anything holding a `Preferences` file) rather than the user-data root above
 * it — the usual mistake with `--browser-data-dir`.
 */
function looksLikeChromiumProfileDir(dir: string): boolean {
  if (/^(Default|Profile \d+)$/.test(basename(dir))) return true;
  return (listDir(dir) ?? []).some((e) => e.isFile() && e.name === 'Preferences');
}

/**
 * The same browser rooted at a custom `--browser-data-dir` instead of its
 * platform defaults. A Firefox profiles root may keep its profiles directly
 * (Linux layout) or under `Profiles/` (macOS layout); both are searched, with
 * `profiles.ini` read from the root either way. Safari never gets here.
 */
function customLocation(location: BrowserLocation, dataDir: string): BrowserLocation {
  switch (location.kind) {
    case 'chromium':
    case 'opera':
      return { ...location, userDataDirs: [dataDir] };
    case 'firefox': {
      const nested = join(dataDir, 'Profiles');
      return {
        ...location,
        installs: [
          { root: dataDir, profilesDir: dataDir },
          ...(listDir(nested) ? [{ root: dataDir, profilesDir: nested }] : []),
        ],
      };
    }
    case 'safari':
      return location;
  }
}

/** Every root directory a location would read from, for the "not found" message. */
function locationRoots(location: BrowserLocation): string[] {
  switch (location.kind) {
    case 'chromium':
    case 'opera':
      return location.userDataDirs;
    case 'safari':
      return location.paths;
    case 'firefox':
      return location.installs.map((i) => i.profilesDir);
  }
}

/**
 * Build the search config for an explicit selection: exactly one browser and,
 * when a profile is named, exactly that profile. Never anything else — a
 * selection that finds nothing reports why rather than widening the search.
 *
 * A Chromium profile matches by directory name (`Default`, `Profile 2`) or by
 * the display name in `Local State`; a Firefox profile by directory name, the
 * part of it after the first dot (`default-release`), or `Name=` in
 * `profiles.ini`. All comparisons are case-insensitive. A name that matches
 * more than one profile is refused, never resolved by precedence: the report
 * names every match and nothing is searched. A `dir:` prefix matches the exact
 * directory name only, and `name:` only display names / `Name=`.
 */
export function resolveBrowserSelection(
  selection: BrowserSelection,
  opts: BrowserEnvironment = {}
): { configs: BrowserConfig[]; report: SelectionReport } {
  const platform = opts.platform ?? process.platform;
  const browser = BROWSER_DISPLAY_NAMES[selection.browser];
  const report: SelectionReport = {
    label: describeBrowserSelection(selection),
    browser,
    ...(selection.profile ? { profile: selection.profile } : {}),
  };
  const platformLocation = browserLocations(opts).find((l) => l.id === selection.browser);
  if (!platformLocation) {
    report.problem = `${browser} is not supported on this platform (${platform}).`;
    return { configs: [], report };
  }
  if (selection.dataDir) {
    report.dataDir = selection.dataDir;
    if (platformLocation.kind === 'safari') {
      report.problem = 'Safari does not support a custom data directory.';
      return { configs: [], report };
    }
    if (platformLocation.kind === 'firefox' && isFirefoxProfileDir(selection.dataDir)) {
      // A single profile: it IS the selection (parse already refused a
      // --browser-profile that names a different one).
      if (
        selection.profile &&
        !matchesFirefoxProfileName(basename(selection.dataDir), selection.profile)
      ) {
        report.problem =
          `The data directory is the Firefox profile "${basename(selection.dataDir)}", ` +
          `not "${selection.profile}".`;
        return { configs: [], report };
      }
      return {
        configs: [{ name: browser, paths: [selection.dataDir], type: 'firefox-profile' }],
        report,
      };
    }
  }
  const location = selection.dataDir
    ? customLocation(platformLocation, selection.dataDir)
    : platformLocation;
  // Not for `opera`: an older Opera keeps its single profile at the user-data
  // root itself, so a valid Opera root holds `Preferences` and would trip this.
  if (
    selection.dataDir &&
    location.kind === 'chromium' &&
    looksLikeChromiumProfileDir(selection.dataDir)
  ) {
    const profileDir = basename(selection.dataDir);
    report.hint =
      `"${selection.dataDir}" looks like a single ${browser} profile directory, not the ` +
      `user-data root that holds "Local State": point --browser-data-dir at its parent ` +
      `("${dirname(selection.dataDir)}") and pick the profile with --browser-profile ` +
      `"dir:${profileDir}".`;
  }

  const roots = locationRoots(location);
  const notFound = `${browser}'s data directory was not found (checked: ${roots.join(', ')}).`;

  if (!selection.profile || location.kind === 'safari') {
    if (!roots.some((root) => listDir(root) !== null)) report.problem = notFound;
    return { configs: [locationToConfig(location)], report };
  }

  const profile = selection.profile;
  const picked =
    location.kind === 'firefox'
      ? selectFirefoxProfile(location.installs, profile)
      : selectChromiumProfile(location.userDataDirs, profile, browser);
  if (picked.notes.length > 0) report.notes = picked.notes;
  if (picked.existingRoots === 0) {
    report.problem = notFound;
  } else if (picked.ambiguous) {
    report.problem = picked.ambiguous;
    report.selectionError = 'ambiguous';
  } else if (picked.paths.length === 0) {
    // Directory names only: display names and profiles.ini names are often
    // people's real names, and this message travels back to the MCP client.
    // With a prefix, say which namespace the list is in.
    const available = sortProfileNames(picked.available);
    const listing = available.length ? available.join(', ') : 'none';
    const { namespace } = parseProfileQuery(profile);
    const names = location.kind === 'firefox' ? 'profiles.ini names' : 'display names';
    const listed =
      namespace === 'any'
        ? `available: ${listing}`
        : `${namespace === 'name' ? `${names} are not listed; ` : ''}` +
          (available.length
            ? `profile directories include: ${listing}; select one with "dir:<directory>"`
            : 'no profile directories were recognized');
    report.problem =
      `No ${browser} profile named "${profile}" was found ` +
      `(${listed}; checked: ${roots.join(', ')}).`;
    report.selectionError = 'no-such-profile';
  } else if (picked.unusableOnly) {
    report.selectionError = 'unusable-profile';
  }
  return {
    configs: [
      {
        name: browser,
        paths: picked.paths,
        type: location.kind === 'firefox' ? 'firefox-profile' : 'chromium',
      },
    ],
    report,
  };
}

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
function searchLevelDBDir(dirPath: string): FoundToken[] {
  // No `existsSync` first (#774): it reports any error — an interrupt included —
  // as absence. A missing directory throws ENOENT into the same `return []`.
  let files: string[];
  try {
    files = retryInterrupted(() => readdirSync(dirPath));
  } catch {
    return [];
  }

  // Provenance is a property of the SEARCH DIRECTORY here: a Chromium config
  // lists the per-profile Copilot IndexedDB dir and the browser-wide Local
  // Storage dir side by side, so the same browser yields both kinds.
  const scoped = isCopilotScopedPath(dirPath);
  const targetFiles = files.filter((f) => f.endsWith('.ldb') || f.endsWith('.log'));
  return targetFiles.flatMap((file) =>
    tokensInFile(join(dirPath, file)).map((token) => ({ token, scoped }))
  );
}

/**
 * Search one Firefox profile directory, appending to `found`. Throws on an
 * unreadable directory; the callers decide whether that ends the search.
 */
function searchFirefoxProfileInto(profileDir: string, found: FoundToken[]): void {
  const idbBase = join(profileDir, 'storage/default');
  if (!existsSync(idbBase)) return;
  const origins = retryInterrupted(() => readdirSync(idbBase, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.includes('copilot'))
    .map((d) => d.name);
  for (const origin of origins) {
    const idbDir = join(idbBase, origin, 'idb');
    if (!existsSync(idbDir)) continue;
    // The read filter above is `includes('copilot')`, which is looser than
    // Copilot's actual origin — so classify on the origin dir, not on the
    // fact that we read it. A `copilot-something-else.com` origin is still
    // read (unchanged behaviour) but ranks with the browser-wide pool.
    const scoped = isCopilotScopedPath(origin);
    for (const file of retryInterrupted(() => readdirSync(idbDir))) {
      found.push(...tokensInFile(join(idbDir, file)).map((token) => ({ token, scoped })));
    }
  }
}

/** Search Firefox profiles for refresh tokens. */
function searchFirefoxProfiles(profilesDir: string): FoundToken[] {
  // No outer `existsSync` (#774): a missing directory throws ENOENT into the
  // `catch` below, which returns the same empty list. The inner ones stay —
  // there a throw would abort the whole profile loop instead of skipping one.
  const found: FoundToken[] = [];
  try {
    const profiles = retryInterrupted(() => readdirSync(profilesDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const profile of profiles) {
      searchFirefoxProfileInto(join(profilesDir, profile), found);
    }
  } catch {
    /* Skip */
  }
  return found;
}

/** Search a single, explicitly selected Firefox profile directory. */
function searchFirefoxProfile(profileDir: string): FoundToken[] {
  const found: FoundToken[] = [];
  try {
    searchFirefoxProfileInto(profileDir, found);
  } catch {
    /* Skip */
  }
  return found;
}

/** Search Safari databases for refresh tokens. */
function searchSafariDatabases(dbDir: string): FoundToken[] {
  if (!existsSync(dbDir)) return [];
  const found: FoundToken[] = [];
  try {
    const searchDir = (dir: string, depth: number): void => {
      if (depth > 4) return;
      const entries = retryInterrupted(() => readdirSync(dir, { withFileTypes: true }));
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          searchDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            if (retryInterrupted(() => statSync(fullPath)).size > 10_000_000) continue;
          } catch {
            continue;
          }
          // Safari 17+ hashes its WebsiteData dirs, so this is normally
          // unscoped; the legacy `Library/Safari/Databases` tree can still
          // carry origin-named dirs, and those rank as scoped.
          const scoped = isCopilotScopedPath(fullPath);
          found.push(...tokensInFile(fullPath).map((token) => ({ token, scoped })));
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
function searchBrowser(browser: BrowserConfig): FoundToken[] {
  const search: (path: string) => FoundToken[] =
    browser.type === 'chromium'
      ? searchLevelDBDir
      : browser.type === 'firefox'
        ? searchFirefoxProfiles
        : browser.type === 'firefox-profile'
          ? searchFirefoxProfile
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
 *
 * With an explicit selection the message names that browser (and profile)
 * instead of a list, says when its data was not on disk at all, and points at
 * the flags — the search deliberately never fell back to another browser.
 */
export function noCopilotSessionError(checked: string[], selection?: SelectionReport): Error {
  if (selection) {
    const details = [selection.problem, ...(selection.notes ?? []), selection.hint]
      .filter((part): part is string => Boolean(part))
      .map((part) => ` ${part}`)
      .join('');
    const flags =
      '--browser / --browser-profile / --browser-data-dir ' +
      '(COPILOT_BROWSER / COPILOT_BROWSER_PROFILE / COPILOT_BROWSER_DATA_DIR)';
    // When the selection itself is the problem, logging in cannot help, so the
    // last sentence is the one that can.
    if (selection.selectionError === 'ambiguous') {
      return new Error(
        `Did not search ${selection.label} for a Copilot Money session.${details} ` +
          `Other browsers were not searched.`
      );
    }
    if (selection.selectionError === 'no-such-profile') {
      return new Error(
        `No Copilot Money session found in ${selection.label}.${details} ` +
          `Name an existing profile, or another browser, with ${flags}. ` +
          'Other browsers were not searched.'
      );
    }
    if (selection.selectionError === 'unusable-profile') {
      return new Error(
        `No Copilot Money session found in ${selection.label}.${details} ` +
          `Make that profile directory readable or fix its profiles.ini Path=, or name ` +
          `another profile or browser with ` +
          `${flags}. Other browsers were not searched.`
      );
    }
    return new Error(
      `No Copilot Money session found in ${selection.label}.${details} ` +
        `Please log into https://app.copilot.money in ${selection.label}, then try again — ` +
        `or select a different browser/profile with ${flags}. Other browsers were not searched.`
    );
  }
  return new Error(
    `No Copilot Money session found. Searched: ${checked.join(', ')}. ` +
      'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
  );
}

/**
 * Collapse repeated sightings of one token into a single candidate (#722).
 *
 * A LevelDB directory holds the same record many times over — every `.log`
 * append and every compaction leaves a copy — so one token can easily be found
 * ten times. Against a bounded exchange budget that is indistinguishable from
 * ten different foreign tokens: it starves whatever sits behind it.
 *
 * Keeps the FIRST sighting's position and browser, and lifts `scoped` if any
 * later sighting came from Copilot's own origin — otherwise a token first seen
 * in a browser-wide store would stay pinned to the low-probability pool after
 * turning up in the scoped one. Returns new objects rather than mutating, so
 * callers never share state through a candidate.
 *
 * Exported because both the extractor and the exchange budget in
 * `firebase-auth.ts` apply it, for the same reason they both apply
 * {@link orderByProvenance}.
 */
export function dedupeByToken(candidates: readonly TokenResult[]): TokenResult[] {
  const byToken = new Map<string, TokenResult>();
  for (const candidate of candidates) {
    const existing = byToken.get(candidate.token);
    if (!existing) {
      byToken.set(candidate.token, candidate);
    } else if (candidate.scoped && !existing.scoped) {
      // Map.set on an existing key keeps its original insertion position.
      byToken.set(candidate.token, { ...existing, scoped: true });
    }
  }
  return [...byToken.values()];
}

/**
 * Hoist Copilot-scoped candidates ahead of browser-wide ones (issue #722).
 *
 * A stable partition, not a comparator sort: within each group the existing
 * discovery order — browser order, and longest-token-first within a file — is
 * a real preference and must survive untouched.
 *
 * Exported because BOTH the extractor and the exchange budget in
 * `firebase-auth.ts` apply it, and they must agree on what "first" means. They
 * still apply it independently: the budget's safety cannot rest on its
 * collaborator having called this, only on the ordering being the same one.
 */
export function orderByProvenance(candidates: readonly TokenResult[]): TokenResult[] {
  return [...candidates.filter((c) => c.scoped), ...candidates.filter((c) => !c.scoped)];
}

/** Options for {@link extractRefreshTokenCandidates}. */
export interface ExtractOptions extends BrowserEnvironment {
  /** Restrict the search to one browser (and optionally one profile). */
  selection?: BrowserSelection;
}

/**
 * Which configs one extraction searches. Without a selection: the overrides,
 * else the table for the injected platform, else the process default. With
 * one, the selection is resolved afresh on every call, so a profile created
 * after startup is found by the next cold extraction.
 */
function browsersToSearch(
  browserOverrides: BrowserConfig[] | undefined,
  opts: ExtractOptions
): { browsers: BrowserConfig[]; selection?: SelectionReport } {
  const { selection, ...environment } = opts;
  if (!selection) {
    const injected =
      opts.platform !== undefined || opts.home !== undefined || opts.env !== undefined;
    return {
      browsers:
        browserOverrides ?? (injected ? getBrowserConfigs(environment) : defaultBrowserConfigs()),
    };
  }
  if (browserOverrides) {
    const name = BROWSER_DISPLAY_NAMES[selection.browser];
    return {
      browsers: browserOverrides.filter((b) => b.name === name),
      selection: {
        label: describeBrowserSelection(selection),
        browser: name,
        ...(selection.profile ? { profile: selection.profile } : {}),
        ...(selection.dataDir ? { dataDir: selection.dataDir } : {}),
      },
    };
  }
  const { configs, report } = resolveBrowserSelection(selection, environment);
  return { browsers: configs, selection: report };
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
 * Two orderings matter, and they are NOT the same one (issue #722):
 *
 * - **Discovery order** is per browser, then per configured path. Chromium
 *   configs interleave `<profile>/IndexedDB/https_app.copilot.money_0…` with
 *   `<profile>/Local Storage/leveldb`, so "prefer the Copilot store" holds
 *   only *within* a profile — a later profile's real token lands behind an
 *   earlier profile's browser-wide noise.
 * - **Returned order** therefore hoists every Copilot-scoped candidate ahead
 *   of every browser-wide one, stably. The caller's exchange budget is finite,
 *   so without this a bounded cap can discard the one candidate that would
 *   have worked; with it, the cap can only ever discard low-probability
 *   candidates.
 *
 * Nothing about WHICH files are read changes here — only the order candidates
 * come back in, and the provenance flag that explains that order.
 *
 * With `opts.selection` only the selected browser — and profile, if named —
 * is searched, never any other (see {@link resolveBrowserSelection}), and the
 * result carries a {@link SelectionReport} for the "no session" error.
 *
 * @param browserOverrides - Override browser configs for testing. With a
 *   selection, narrowed to the config whose name is the selected browser's.
 * @param opts - Selection, plus platform/home/env for building the tables.
 */
// Returns a Promise (the TokenExtractor contract is async) but the body is
// fully synchronous — all browser reads are sync readFileSync. It is NOT
// declared `async` on purpose: `async` with no `await` trips
// @typescript-eslint/require-await, so the explicit Promise.resolve() is the
// lint-clean way to satisfy the async signature. (Reviewed: #482.)
export function extractRefreshTokenCandidates(
  browserOverrides?: BrowserConfig[],
  opts: ExtractOptions = {}
): Promise<TokenCandidates> {
  const { browsers, selection } = browsersToSearch(browserOverrides, opts);
  const checked: string[] = [];
  const found: TokenResult[] = [];

  for (const browser of browsers) {
    checked.push(browser.name);
    for (const { token, scoped } of searchBrowser(browser)) {
      found.push({ token, browser: browser.name, scoped });
    }
  }

  const candidates = orderByProvenance(dedupeByToken(found));
  return Promise.resolve(selection ? { candidates, checked, selection } : { candidates, checked });
}

/**
 * Extract the first Firebase refresh-token candidate from browser storage.
 *
 * Thin wrapper over {@link extractRefreshTokenCandidates} that returns the
 * first candidate — Copilot-scoped if any scoped candidate exists — and throws
 * the actionable "no session" error when none exist. Note: this does NOT
 * validate that the token belongs to Copilot's project — callers that need
 * foreign-project rejection should consume the full candidate list and drive
 * the exchange-and-discard loop (see `FirebaseAuth`). Retained for backward
 * compatibility.
 *
 * @param browserOverrides - Override browser configs for testing
 * @param opts - Same as {@link extractRefreshTokenCandidates}.
 * @throws Error if no token is found in any browser
 */
export async function extractRefreshToken(
  browserOverrides?: BrowserConfig[],
  opts: ExtractOptions = {}
): Promise<TokenResult> {
  const { candidates, checked, selection } = await extractRefreshTokenCandidates(
    browserOverrides,
    opts
  );
  const [first] = candidates;
  if (!first) throw noCopilotSessionError(checked, selection);
  return first;
}
