import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { retryInterrupted } from '../fs-retry.js';

/**
 * Explicit browser / profile selection for `--live-reads` / `--write` auth.
 *
 * By default the token extractor searches every supported browser in a fixed
 * order and the first working session wins. On a machine where two people are
 * logged into Copilot in two different browsers that picks the same account
 * every time, whoever happens to come first. `--browser` / `--browser-profile`
 * (or `COPILOT_BROWSER` / `COPILOT_BROWSER_PROFILE`) pin the search to exactly
 * one browser, and optionally one profile of it, with no fallback.
 *
 * `--browser-data-dir` (`COPILOT_BROWSER_DATA_DIR`) points the selected
 * browser at a custom user-data root instead of its platform defaults.
 *
 * This module only resolves and validates the selection. Where each browser
 * keeps its data, and how a profile name maps to a directory, live in
 * `browser-token.ts`.
 */

/** Canonical id of every browser the extractor knows about. */
export type BrowserId =
  | 'chrome'
  | 'arc'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'chromium'
  | 'opera'
  | 'opera-gx'
  | 'safari'
  | 'firefox';

/** Canonical ids, in the default search order. */
export const BROWSER_IDS: readonly BrowserId[] = [
  'chrome',
  'arc',
  'edge',
  'brave',
  'vivaldi',
  'chromium',
  'opera',
  'opera-gx',
  'safari',
  'firefox',
];

/** Display name for each id — the same names `BrowserConfig.name` uses. */
export const BROWSER_DISPLAY_NAMES: Readonly<Record<BrowserId, string>> = {
  chrome: 'Chrome',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
  opera: 'Opera',
  'opera-gx': 'Opera GX',
  safari: 'Safari',
  firefox: 'Firefox',
};

/**
 * Aliases accepted on top of the canonical ids, after normalization
 * (lower-cased, spaces and underscores folded to `-`).
 */
const ALIASES: Readonly<Record<string, BrowserId>> = {
  'microsoft-edge': 'edge',
  operagx: 'opera-gx',
};

/** Browsers that exist only on macOS. */
const MACOS_ONLY: ReadonlySet<BrowserId> = new Set<BrowserId>(['arc', 'safari', 'opera-gx']);

/** Browsers with no notion of a selectable profile directory. */
const NO_PROFILES: ReadonlySet<BrowserId> = new Set<BrowserId>(['safari']);

/** A resolved, validated selection. */
export interface BrowserSelection {
  browser: BrowserId;
  /** Profile directory name or display name; undefined = every profile. */
  profile?: string;
  /**
   * Absolute user-data root replacing the browser's platform defaults
   * (Firefox: a profiles root, or one profile directory).
   */
  dataDir?: string;
}

/** A selection that cannot be honoured. The CLI turns this into exit 1. */
export class BrowserSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSelectionError';
  }
}

/** Every name `resolveBrowserName` accepts, for error messages and --help. */
export function validBrowserNames(): string[] {
  return [...BROWSER_IDS, ...Object.keys(ALIASES)];
}

/**
 * Resolve a user-supplied browser name to its canonical id.
 *
 * @throws BrowserSelectionError for an unknown name, listing the valid ones.
 */
export function resolveBrowserName(name: string): BrowserId {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if ((BROWSER_IDS as readonly string[]).includes(normalized)) return normalized as BrowserId;
  const alias = ALIASES[normalized];
  if (alias) return alias;
  throw new BrowserSelectionError(
    `Unknown browser "${name}". Valid names: ${validBrowserNames().join(', ')}.`
  );
}

/** True when the extractor has storage locations for `browser` on `platform`. */
export function isBrowserSupportedOn(browser: BrowserId, platform: NodeJS.Platform): boolean {
  return platform !== 'linux' || !MACOS_ONLY.has(browser);
}

/** Raw inputs, before precedence and validation. */
export interface BrowserSelectionInput {
  /** `--browser` value, if the flag was given. */
  browserFlag?: string;
  /** `--browser-profile` value, if the flag was given. */
  profileFlag?: string;
  /** `--browser-data-dir` value, if the flag was given. */
  dataDirFlag?: string;
  /** Environment to read the `COPILOT_BROWSER*` variables from. */
  env?: Record<string, string | undefined>;
  /** Platform to validate against; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Base for a relative data dir; defaults to `process.cwd()`. */
  cwd?: string;
  /** Expansion of a leading `~`; defaults to `os.homedir()`. */
  home?: string;
  /** What is at a path; defaults to a (retried) `statSync`. */
  pathKind?: (path: string) => PathKind;
}

/** What {@link BrowserSelectionInput.pathKind} reports for a path. */
export type PathKind = 'directory' | 'file' | 'missing';

// Every error reads as "missing" here, which suits a startup existence check.
// `directoryState` in browser-token.ts deliberately differs (EACCES is
// "unusable", so an unreadable profile still counts toward ambiguity); do not
// merge the two.
function statPathKind(path: string): PathKind {
  try {
    return retryInterrupted(() => statSync(path)).isDirectory() ? 'directory' : 'file';
  } catch {
    return 'missing';
  }
}

/** Expand a leading `~` / `~/` and resolve a relative path against `cwd`. */
export function resolveDataDirPath(raw: string, cwd: string, home: string): string {
  const expanded = raw === '~' ? home : /^~[/\\]/.test(raw) ? join(home, raw.slice(2)) : raw;
  return resolve(cwd, expanded);
}

/**
 * True when `dir` is itself a Firefox profile rather than a profiles root:
 * it holds `storage/default`, `prefs.js` or `times.json`.
 */
export function isFirefoxProfileDir(dir: string): boolean {
  return ['storage/default', 'prefs.js', 'times.json'].some((entry) =>
    existsSync(join(dir, entry))
  );
}

/**
 * Which namespace a `--browser-profile` value is looked up in.
 *
 * `any` (no prefix): directory names and display names / `profiles.ini`
 * `Name=`, case-insensitively, refused when two profiles answer. `dir:<name>`:
 * the exact directory name only, case-sensitively — the escape hatch when the
 * plain name is ambiguous (on stock Microsoft Edge with three profiles, every
 * `Profile N` string is both a directory and another profile's display name).
 * `name:<name>`: display names / `profiles.ini` `Name=` only.
 */
export interface ProfileQuery {
  namespace: 'any' | 'dir' | 'name';
  value: string;
}

/** Split an optional `dir:` / `name:` prefix (case-insensitive) off a profile value. */
export function parseProfileQuery(profile: string): ProfileQuery {
  const prefixed = /^(dir|name):([\s\S]*)$/i.exec(profile);
  if (!prefixed) return { namespace: 'any', value: profile };
  return {
    namespace: (prefixed[1] as string).toLowerCase() as 'dir' | 'name',
    value: (prefixed[2] as string).trim(),
  };
}

/**
 * A Firefox profile dir name matches by itself or by its part after the first
 * dot, case-insensitively; with `dir:`, only by its exact name; with `name:`,
 * never (that namespace lives in `profiles.ini`).
 */
export function matchesFirefoxProfileName(dirName: string, profile: string): boolean {
  const { namespace, value } = parseProfileQuery(profile);
  if (namespace === 'dir') return dirName === value;
  if (namespace === 'name') return false;
  const lower = value.toLowerCase();
  const dot = dirName.indexOf('.');
  return (
    dirName.toLowerCase() === lower || (dot >= 0 && dirName.slice(dot + 1).toLowerCase() === lower)
  );
}

/** Treat an empty or whitespace-only value as "not given". */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Combine flags and environment into one validated selection.
 *
 * Each flag wins over its own environment variable. Returns undefined when no
 * browser was asked for — the default search over every browser.
 *
 * @throws BrowserSelectionError for an unknown browser, a browser this platform
 *   does not have, a profile for a browser without profiles, or a profile with
 *   no browser.
 */
export function parseBrowserSelection(input: BrowserSelectionInput): BrowserSelection | undefined {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const browserName = present(input.browserFlag) ?? present(env.COPILOT_BROWSER);
  const profile = present(input.profileFlag) ?? present(env.COPILOT_BROWSER_PROFILE);
  const rawDataDir = present(input.dataDirFlag) ?? present(env.COPILOT_BROWSER_DATA_DIR);

  if (!browserName) {
    if (profile) {
      throw new BrowserSelectionError(
        '--browser-profile (COPILOT_BROWSER_PROFILE) requires --browser (COPILOT_BROWSER): ' +
          'a profile name only means something within one browser.'
      );
    }
    if (rawDataDir) {
      throw new BrowserSelectionError(
        '--browser-data-dir (COPILOT_BROWSER_DATA_DIR) requires --browser (COPILOT_BROWSER): ' +
          'say which browser the data directory belongs to.'
      );
    }
    return undefined;
  }

  const browser = resolveBrowserName(browserName);
  const display = BROWSER_DISPLAY_NAMES[browser];
  if (!isBrowserSupportedOn(browser, platform)) {
    throw new BrowserSelectionError(`${display} is not supported on this platform (${platform}).`);
  }
  if (profile && NO_PROFILES.has(browser)) {
    throw new BrowserSelectionError(
      `${display} has no selectable profiles; drop --browser-profile (COPILOT_BROWSER_PROFILE).`
    );
  }
  if (profile && !parseProfileQuery(profile).value) {
    throw new BrowserSelectionError(
      `--browser-profile (COPILOT_BROWSER_PROFILE) "${profile}" has a prefix but no name ` +
        'after it, e.g. "dir:Profile 1".'
    );
  }

  let dataDir: string | undefined;
  if (rawDataDir) {
    if (browser === 'safari') {
      throw new BrowserSelectionError(
        'Safari does not support --browser-data-dir (COPILOT_BROWSER_DATA_DIR): ' +
          'its website-data locations are fixed by macOS.'
      );
    }
    dataDir = resolveDataDirPath(rawDataDir, input.cwd ?? process.cwd(), input.home ?? homedir());
    const kind = (input.pathKind ?? statPathKind)(dataDir);
    if (kind !== 'directory') {
      throw new BrowserSelectionError(
        `--browser-data-dir (COPILOT_BROWSER_DATA_DIR) "${dataDir}" ` +
          (kind === 'missing' ? 'does not exist.' : 'is not a directory.')
      );
    }
    if (
      browser === 'firefox' &&
      profile &&
      isFirefoxProfileDir(dataDir) &&
      !matchesFirefoxProfileName(basename(dataDir), profile)
    ) {
      throw new BrowserSelectionError(
        `--browser-data-dir "${dataDir}" is a single Firefox profile ("${basename(dataDir)}"), ` +
          `which does not match --browser-profile "${profile}". Drop --browser-profile, or ` +
          'point --browser-data-dir at the profiles root.'
      );
    }
  }

  return {
    browser,
    ...(profile ? { profile } : {}),
    ...(dataDir ? { dataDir } : {}),
  };
}

/**
 * Human-readable label, e.g. `Brave (profile "Default")` or
 * `Chrome (profile "Work", data dir "/home/me/chrome")`.
 */
export function describeBrowserSelection(selection: BrowserSelection): string {
  const display = BROWSER_DISPLAY_NAMES[selection.browser];
  const details = [
    ...(selection.profile ? [`profile "${selection.profile}"`] : []),
    ...(selection.dataDir ? [`data dir "${selection.dataDir}"`] : []),
  ];
  return details.length ? `${display} (${details.join(', ')})` : display;
}
