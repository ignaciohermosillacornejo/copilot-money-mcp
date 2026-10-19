/**
 * Explicit browser / profile selection (`--browser`, `--browser-profile`,
 * `COPILOT_BROWSER`, `COPILOT_BROWSER_PROFILE`) and the platform tables the
 * extractor searches.
 *
 * The motivating case: two people logged into Copilot in two browsers on one
 * machine. Without a selection the fixed search order picks the same account
 * every run; with one, exactly the selected browser/profile is read and a
 * token planted anywhere else must stay invisible.
 *
 * Every browser directory here lives under a throwaway fake home. Tokens are
 * runtime-generated placeholders, never real values.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  BROWSER_IDS,
  BrowserSelectionError,
  describeBrowserSelection,
  parseBrowserSelection,
  resolveBrowserName,
  resolveDataDirPath,
  validBrowserNames,
} from '../../../src/core/auth/browser-selection.js';
import {
  BROWSER_CONFIGS,
  extractRefreshToken,
  extractRefreshTokenCandidates,
  getBrowserConfigs,
  getChromiumProfileStoragePaths,
  noCopilotSessionError,
  type BrowserConfig,
} from '../../../src/core/auth/browser-token.js';
import { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

const IDB = 'IndexedDB/https_app.copilot.money_0.indexeddb.leveldb';
const LS = 'Local Storage/leveldb';

/** An obviously fake refresh token, distinct per `tag`. */
function fakeToken(tag: string): string {
  return 'AMf-FAKE' + tag.replace(/[^A-Za-z0-9]/g, '') + 'x'.repeat(120);
}

/** Plant a fake token in a Chromium profile's Copilot IndexedDB dir. */
function plantChromium(userDataDir: string, profileDir: string, token: string): void {
  const dir = join(userDataDir, profileDir, IDB);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000003.log'), `prefix ${token} suffix`);
}

/** Plant a fake token in a Firefox profile's Copilot origin dir. */
function plantFirefox(profilesDir: string, profileDir: string, token: string): void {
  const dir = join(profilesDir, profileDir, 'storage/default/https+++app.copilot.money/idb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1234.sqlite'), `prefix ${token} suffix`);
}

function writeLocalState(userDataDir: string, infoCache: Record<string, { name: string }>): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'Local State'),
    JSON.stringify({ profile: { info_cache: infoCache }, unrelated: { key: 'ignored' } })
  );
}

describe('resolveBrowserName', () => {
  test('accepts every canonical id, case-insensitively', () => {
    for (const id of BROWSER_IDS) {
      expect(resolveBrowserName(id)).toBe(id);
      expect(resolveBrowserName(id.toUpperCase())).toBe(id);
    }
  });

  test('accepts the documented aliases', () => {
    expect(resolveBrowserName('microsoft-edge')).toBe('edge');
    expect(resolveBrowserName('Microsoft Edge')).toBe('edge');
    expect(resolveBrowserName('OperaGX')).toBe('opera-gx');
    expect(resolveBrowserName('opera_gx')).toBe('opera-gx');
    expect(resolveBrowserName(' Brave ')).toBe('brave');
  });

  test('rejects an unknown name, listing every valid one', () => {
    expect(() => resolveBrowserName('netscape')).toThrow(BrowserSelectionError);
    try {
      resolveBrowserName('netscape');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Unknown browser "netscape"');
      for (const name of validBrowserNames()) expect(message).toContain(name);
    }
  });
});

describe('parseBrowserSelection', () => {
  const mac = 'darwin' as const;

  test('nothing given → undefined (the default search)', () => {
    expect(parseBrowserSelection({ env: {}, platform: mac })).toBeUndefined();
  });

  test('reads COPILOT_BROWSER / COPILOT_BROWSER_PROFILE', () => {
    expect(
      parseBrowserSelection({
        env: { COPILOT_BROWSER: 'Brave', COPILOT_BROWSER_PROFILE: 'Default' },
        platform: mac,
      })
    ).toEqual({ browser: 'brave', profile: 'Default' });
  });

  test('each flag wins over its own environment variable', () => {
    expect(
      parseBrowserSelection({
        browserFlag: 'chrome',
        profileFlag: 'Profile 2',
        env: { COPILOT_BROWSER: 'brave', COPILOT_BROWSER_PROFILE: 'Default' },
        platform: mac,
      })
    ).toEqual({ browser: 'chrome', profile: 'Profile 2' });
    // Flag for the browser, env for the profile.
    expect(
      parseBrowserSelection({
        browserFlag: 'chrome',
        env: { COPILOT_BROWSER: 'brave', COPILOT_BROWSER_PROFILE: 'Work' },
        platform: mac,
      })
    ).toEqual({ browser: 'chrome', profile: 'Work' });
  });

  test('empty environment values count as unset', () => {
    expect(
      parseBrowserSelection({
        env: { COPILOT_BROWSER: '', COPILOT_BROWSER_PROFILE: '  ' },
        platform: mac,
      })
    ).toBeUndefined();
  });

  test('a profile without a browser is an error', () => {
    expect(() => parseBrowserSelection({ profileFlag: 'Default', env: {}, platform: mac })).toThrow(
      /--browser-profile .* requires --browser/
    );
    expect(() =>
      parseBrowserSelection({ env: { COPILOT_BROWSER_PROFILE: 'Default' }, platform: mac })
    ).toThrow(BrowserSelectionError);
  });

  test('an unknown browser is an error, from the flag or the environment', () => {
    expect(() => parseBrowserSelection({ browserFlag: 'lynx', env: {}, platform: mac })).toThrow(
      /Unknown browser "lynx"/
    );
    expect(() =>
      parseBrowserSelection({ env: { COPILOT_BROWSER: 'lynx' }, platform: mac })
    ).toThrow(/Unknown browser "lynx"/);
  });

  test('macOS-only browsers are refused on Linux', () => {
    for (const name of ['safari', 'arc', 'opera-gx']) {
      expect(() =>
        parseBrowserSelection({ browserFlag: name, env: {}, platform: 'linux' })
      ).toThrow(/not supported on this platform \(linux\)/);
      expect(parseBrowserSelection({ browserFlag: name, env: {}, platform: mac })).toBeDefined();
    }
  });

  test('Safari takes no profile', () => {
    expect(() =>
      parseBrowserSelection({ browserFlag: 'safari', profileFlag: 'x', env: {}, platform: mac })
    ).toThrow(/Safari has no selectable profiles/);
  });
});

describe('getBrowserConfigs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('macOS: same ten browsers, same order, same paths as before', () => {
    const configs = getBrowserConfigs({ platform: 'darwin', home });
    const appSupport = join(home, 'Library/Application Support');
    const profileless = (dir: string): string[] => [
      join(dir, 'Default', IDB),
      join(dir, 'Default', LS),
    ];
    const opera = (dir: string): string[] => [join(dir, IDB), join(dir, LS), ...profileless(dir)];
    expect(configs).toEqual([
      { name: 'Chrome', type: 'chromium', paths: profileless(join(appSupport, 'Google/Chrome')) },
      { name: 'Arc', type: 'chromium', paths: profileless(join(appSupport, 'Arc/User Data')) },
      {
        name: 'Microsoft Edge',
        type: 'chromium',
        paths: profileless(join(appSupport, 'Microsoft Edge')),
      },
      {
        name: 'Brave',
        type: 'chromium',
        paths: profileless(join(appSupport, 'BraveSoftware/Brave-Browser')),
      },
      { name: 'Vivaldi', type: 'chromium', paths: profileless(join(appSupport, 'Vivaldi')) },
      { name: 'Chromium', type: 'chromium', paths: profileless(join(appSupport, 'Chromium')) },
      {
        name: 'Opera',
        type: 'chromium',
        paths: opera(join(appSupport, 'com.operasoftware.Opera')),
      },
      {
        name: 'Opera GX',
        type: 'chromium',
        paths: opera(join(appSupport, 'com.operasoftware.OperaGX')),
      },
      {
        name: 'Safari',
        type: 'safari',
        paths: [
          join(home, 'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'),
          join(home, 'Library/Safari/Databases'),
        ],
      },
      { name: 'Firefox', type: 'firefox', paths: [join(appSupport, 'Firefox/Profiles')] },
    ]);
  });

  test('BROWSER_CONFIGS is still the macOS table for the real home', () => {
    expect(BROWSER_CONFIGS.map((b) => b.name)).toEqual([
      'Chrome',
      'Arc',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Opera GX',
      'Safari',
      'Firefox',
    ]);
    expect(BROWSER_CONFIGS[0]!.paths[0]).toBe(
      join(homedir(), 'Library/Application Support/Google/Chrome/Default', IDB)
    );
  });

  test('macOS: multi-profile discovery is unchanged', () => {
    const chrome = join(home, 'Library/Application Support/Google/Chrome');
    mkdirSync(join(chrome, 'Profile 3'), { recursive: true });
    const config = getBrowserConfigs({ platform: 'darwin', home }).find((b) => b.name === 'Chrome');
    expect(config!.paths).toEqual(getChromiumProfileStoragePaths(chrome));
    expect(config!.paths).toContain(join(chrome, 'Profile 3', IDB));
  });

  test('Linux: no Arc, Safari or Opera GX; ~/.config, snap and flatpak locations', () => {
    const configs = getBrowserConfigs({ platform: 'linux', home, env: {} });
    expect(configs.map((b) => b.name)).toEqual([
      'Chrome',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Firefox',
    ]);
    const paths = (name: string): string[] => configs.find((b) => b.name === name)!.paths;
    const config = join(home, '.config');

    expect(paths('Chrome')).toEqual([
      join(config, 'google-chrome/Default', IDB),
      join(config, 'google-chrome/Default', LS),
      join(config, 'google-chrome-beta/Default', IDB),
      join(config, 'google-chrome-beta/Default', LS),
      join(config, 'google-chrome-unstable/Default', IDB),
      join(config, 'google-chrome-unstable/Default', LS),
    ]);
    expect(paths('Chromium')).toEqual([
      join(config, 'chromium/Default', IDB),
      join(config, 'chromium/Default', LS),
      join(home, 'snap/chromium/common/chromium/Default', IDB),
      join(home, 'snap/chromium/common/chromium/Default', LS),
    ]);
    expect(paths('Brave')).toContain(join(config, 'BraveSoftware/Brave-Browser/Default', IDB));
    expect(paths('Microsoft Edge')).toContain(join(config, 'microsoft-edge/Default', IDB));
    expect(paths('Vivaldi')).toContain(join(config, 'vivaldi/Default', IDB));
    expect(paths('Opera').slice(0, 2)).toEqual([
      join(config, 'opera', IDB),
      join(config, 'opera', LS),
    ]);
    expect(paths('Firefox')).toEqual([
      join(home, '.mozilla/firefox'),
      join(config, 'mozilla/firefox'),
      join(home, 'snap/firefox/common/.mozilla/firefox'),
      join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'),
    ]);
    expect(configs.flatMap((b) => b.paths).some((p) => p.includes('Library/'))).toBe(false);
  });

  test('Linux: an absolute XDG_CONFIG_HOME replaces ~/.config; a relative one is ignored', () => {
    const xdg = join(home, 'xdg');
    const withXdg = getBrowserConfigs({ platform: 'linux', home, env: { XDG_CONFIG_HOME: xdg } });
    const chrome = withXdg.find((b) => b.name === 'Chrome')!.paths;
    expect(chrome[0]).toBe(join(xdg, 'google-chrome/Default', IDB));
    const chromium = withXdg.find((b) => b.name === 'Chromium')!.paths;
    expect(chromium[0]).toBe(join(xdg, 'chromium/Default', IDB));
    // The snap location is not under XDG_CONFIG_HOME.
    expect(chromium).toContain(join(home, 'snap/chromium/common/chromium/Default', IDB));
    // Firefox's legacy ~/.mozilla stays first; its 147+ XDG root follows XDG_CONFIG_HOME.
    expect(withXdg.find((b) => b.name === 'Firefox')!.paths.slice(0, 2)).toEqual([
      join(home, '.mozilla/firefox'),
      join(xdg, 'mozilla/firefox'),
    ]);

    const relative = getBrowserConfigs({
      platform: 'linux',
      home,
      env: { XDG_CONFIG_HOME: 'relative/dir' },
    });
    expect(relative.find((b) => b.name === 'Chrome')!.paths[0]).toBe(
      join(home, '.config/google-chrome/Default', IDB)
    );
  });

  test('Linux: the default extraction finds a token in snap Firefox and ~/.config Chrome', async () => {
    plantChromium(join(home, '.config/google-chrome'), 'Profile 1', fakeToken('chrome'));
    plantFirefox(join(home, 'snap/firefox/common/.mozilla/firefox'), 'a1.default', fakeToken('ff'));
    const { candidates, checked, selection } = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
    });
    expect(selection).toBeUndefined();
    expect(checked).toEqual([
      'Chrome',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Firefox',
    ]);
    expect(candidates.map((c) => [c.browser, c.token])).toEqual([
      ['Chrome', fakeToken('chrome')],
      ['Firefox', fakeToken('ff')],
    ]);
  });

  test('Linux: the default extraction finds a Firefox 147+ profile under ~/.config/mozilla', async () => {
    plantFirefox(join(home, '.config/mozilla/firefox'), 'x1.default-release', fakeToken('xdg'));
    const { candidates } = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
    });
    expect(candidates.map((c) => [c.browser, c.token])).toEqual([['Firefox', fakeToken('xdg')]]);
  });
});

describe('extraction with a selection', () => {
  let home: string;
  let appSupport: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-extract-'));
    appSupport = join(home, 'Library/Application Support');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const mac = (selection: Parameters<typeof extractRefreshTokenCandidates>[1] = {}) => ({
    platform: 'darwin' as const,
    home,
    env: {},
    ...selection,
  });

  test('--browser searches only that browser: a token in another browser stays unseen', async () => {
    // Chrome comes first in the default order, so without a selection it wins.
    plantChromium(join(appSupport, 'Google/Chrome'), 'Default', fakeToken('chrome'));
    plantChromium(join(appSupport, 'BraveSoftware/Brave-Browser'), 'Default', fakeToken('brave'));

    const unselected = await extractRefreshToken(undefined, mac());
    expect(unselected.browser).toBe('Chrome');

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave' } })
    );
    expect(result.checked).toEqual(['Brave']);
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('brave')]);
    expect(result.selection).toEqual({ label: 'Brave', browser: 'Brave' });
  });

  test('a selected browser with no session does not fall back to others', async () => {
    plantChromium(join(appSupport, 'Google/Chrome'), 'Default', fakeToken('chrome'));
    mkdirSync(join(appSupport, 'BraveSoftware/Brave-Browser/Default'), { recursive: true });

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave', profile: 'Default' } })
    );
    expect(result.candidates).toEqual([]);
    expect(result.checked).toEqual(['Brave']);
    await expect(
      extractRefreshToken(undefined, mac({ selection: { browser: 'brave', profile: 'Default' } }))
    ).rejects.toThrow(
      'No Copilot Money session found in Brave (profile "Default"). ' +
        'Please log into https://app.copilot.money in Brave (profile "Default")'
    );
  });

  test('Chromium profile by directory name, case-insensitively', async () => {
    const brave = join(appSupport, 'BraveSoftware/Brave-Browser');
    plantChromium(brave, 'Default', fakeToken('default'));
    plantChromium(brave, 'Profile 2', fakeToken('profile2'));

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave', profile: 'profile 2' } })
    );
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('profile2')]);
    expect(result.selection?.problem).toBeUndefined();
  });

  test('Chromium profile by its Local State display name', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('first'));
    plantChromium(chrome, 'Profile 1', fakeToken('second'));
    writeLocalState(chrome, { Default: { name: 'Person A' }, 'Profile 1': { name: 'Person B' } });

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'chrome', profile: 'person b' } })
    );
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('second')]);
    expect(result.selection?.label).toBe('Chrome (profile "person b")');
  });

  test('an unknown Chromium profile names the browser, the profile and what exists', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('default'));

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'chrome', profile: 'Nope' } })
    );
    expect(result.candidates).toEqual([]);
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('No Copilot Money session found in Chrome (profile "Nope").');
    expect(message).toContain('No Chrome profile named "Nope" was found (available: Default;');
    expect(message).toContain(chrome);
    expect(message).not.toContain(fakeToken('default'));
  });

  test('a missing browser directory is reported as missing, with the paths checked', async () => {
    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'vivaldi' } })
    );
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('No Copilot Money session found in Vivaldi.');
    expect(message).toContain(
      `Vivaldi's data directory was not found (checked: ${join(appSupport, 'Vivaldi')}).`
    );

    const withProfile = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'vivaldi', profile: 'Default' } })
    );
    expect(noCopilotSessionError(withProfile.checked, withProfile.selection).message).toContain(
      "Vivaldi's data directory was not found"
    );
  });

  test('Firefox profile by directory name, by suffix, and by profiles.ini Name', async () => {
    const root = join(appSupport, 'Firefox');
    const profiles = join(root, 'Profiles');
    plantFirefox(profiles, 'abc123.default-release', fakeToken('release'));
    plantFirefox(profiles, 'def456.work', fakeToken('work'));
    writeFileSync(
      join(root, 'profiles.ini'),
      [
        '[General]',
        'StartWithLastProfile=1',
        '',
        '[Profile0]',
        'Name=Personal Stuff',
        'IsRelative=1',
        'Path=Profiles/abc123.default-release',
        '',
        '[Profile1]',
        'Name=Job',
        'IsRelative=1',
        'Path=Profiles/def456.work',
        '',
      ].join('\n')
    );

    const tokensFor = async (profile: string): Promise<string[]> =>
      (
        await extractRefreshTokenCandidates(
          undefined,
          mac({ selection: { browser: 'firefox', profile } })
        )
      ).candidates.map((c) => c.token);

    expect(await tokensFor('abc123.default-release')).toEqual([fakeToken('release')]);
    expect(await tokensFor('DEFAULT-RELEASE')).toEqual([fakeToken('release')]);
    expect(await tokensFor('work')).toEqual([fakeToken('work')]);
    expect(await tokensFor('personal stuff')).toEqual([fakeToken('release')]);
    expect(await tokensFor('Job')).toEqual([fakeToken('work')]);
    expect(await tokensFor('nobody')).toEqual([]);
  });

  test('Linux Firefox profile in the flatpak tree, selected by profiles.ini Name', async () => {
    const flatpak = join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox');
    plantFirefox(flatpak, 'zz9.default', fakeToken('flatpak'));
    writeFileSync(
      join(flatpak, 'profiles.ini'),
      '[Profile0]\nName=Everyday\nIsRelative=1\nPath=zz9.default\n'
    );
    // A token in a different browser must not be found.
    plantChromium(join(home, '.config/google-chrome'), 'Default', fakeToken('chrome'));

    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'firefox', profile: 'everyday' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('flatpak')]);
    expect(result.checked).toEqual(['Firefox']);
  });

  test('Linux Chromium selection covers the snap tree', async () => {
    plantChromium(join(home, 'snap/chromium/common/chromium'), 'Default', fakeToken('snap'));
    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'chromium', profile: 'default' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('snap')]);
  });

  test('selecting a browser this platform lacks finds nothing and says why', async () => {
    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'safari' },
    });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.problem).toContain('not supported on this platform (linux)');
  });

  test('with overrides, a selection narrows them to the selected browser', async () => {
    const a = join(home, 'a');
    const b = join(home, 'b');
    for (const [dir, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '000001.ldb'), fakeToken(tag));
    }
    const overrides: BrowserConfig[] = [
      { name: 'Chrome', paths: [a], type: 'chromium' },
      { name: 'Brave', paths: [b], type: 'chromium' },
    ];
    const result = await extractRefreshTokenCandidates(overrides, {
      selection: { browser: 'brave' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
  });
});

/**
 * A `--browser-profile` value is looked up in several namespaces at once —
 * Chromium directory names and `Local State` display names; Firefox directory
 * names, their post-dot suffix, and `profiles.ini` `Name=`. Whenever two
 * DIFFERENT profiles answer to the value, through any pair of namespaces, the
 * selection must refuse and search nothing: picking one by precedence can hand
 * over someone else's session (Edge's built-in display names are off by one
 * from its directories). The sweep below builds every pair, so a namespace
 * added later without the check fails here rather than silently picking.
 */
describe('ambiguous --browser-profile', () => {
  let home: string;
  let appSupport: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-ambiguous-'));
    appSupport = join(home, 'Library/Application Support');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const mac = (selection: NonNullable<ReturnType<typeof parseBrowserSelection>>) =>
    extractRefreshTokenCandidates(undefined, { platform: 'darwin', home, env: {}, selection });

  /**
   * A refusal is only useful if what it suggests works: every prefixed value
   * it offers must select exactly one profile, and together they must cover
   * every profile the ambiguous name matched.
   */
  async function expectSuggestionsResolve(
    browser: 'chrome' | 'edge' | 'firefox',
    problem: string | undefined,
    expectedTokens: string[]
  ): Promise<void> {
    const picks = [...(problem ?? '').matchAll(/"((?:dir|name):[^"]+)"/g)].map((m) => m[1]!);
    expect(picks).toHaveLength(expectedTokens.length);
    const got: string[] = [];
    for (const pick of picks) {
      const result = await mac({ browser, profile: pick });
      expect(result.candidates).toHaveLength(1);
      got.push(result.candidates[0]!.token);
    }
    expect(got.sort()).toEqual([...expectedTokens].sort());
  }

  test('Edge off-by-one display names: a directory name that is another profile’s display name is refused', async () => {
    const edge = join(appSupport, 'Microsoft Edge');
    plantChromium(edge, 'Default', fakeToken('default'));
    plantChromium(edge, 'Profile 1', fakeToken('profile1'));
    writeLocalState(edge, { Default: { name: 'Profile 1' }, 'Profile 1': { name: 'Profile 2' } });

    const result = await mac({ browser: 'edge', profile: 'Profile 1' });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.problem).toBe(
      '--browser-profile "Profile 1" is ambiguous in Microsoft Edge: it matches directory ' +
        '"Profile 1" and the display name of directory "Default". Pick exactly one with ' +
        '--browser-profile "dir:Default" or "dir:Profile 1".'
    );
    // The README quotes this exact refusal; keep the two from drifting apart.
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(`\`${result.selection?.problem}\``);
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toStartWith(
      'Did not search Microsoft Edge (profile "Profile 1") for a Copilot Money session. ' +
        '--browser-profile "Profile 1" is ambiguous'
    );
    // Nothing was searched, so logging in is not the remedy.
    expect(message).not.toContain('Please log into');
    expect(message).not.toContain(fakeToken('default'));

    // The suggested dir: form picks exactly the directory, case-sensitively.
    const exact = await mac({ browser: 'edge', profile: 'dir:Profile 1' });
    expect(exact.candidates.map((c) => c.token)).toEqual([fakeToken('profile1')]);
    const wrongCase = await mac({ browser: 'edge', profile: 'dir:profile 1' });
    expect(wrongCase.candidates).toEqual([]);

    // Unambiguous names still resolve: "Profile 2" is only a display name,
    // "Default" only a directory.
    const two = await mac({ browser: 'edge', profile: 'Profile 2' });
    expect(two.candidates.map((c) => c.token)).toEqual([fakeToken('profile1')]);
    const dflt = await mac({ browser: 'edge', profile: 'default' });
    expect(dflt.candidates.map((c) => c.token)).toEqual([fakeToken('default')]);
  });

  test('two profiles with the same display name are refused, not both searched', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('a'));
    plantChromium(chrome, 'Profile 3', fakeToken('b'));
    writeLocalState(chrome, { 'Profile 3': { name: 'Work' }, Default: { name: 'work' } });

    const result = await mac({ browser: 'chrome', profile: 'Work' });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.problem).toBe(
      '--browser-profile "Work" is ambiguous in Chrome: it matches the display name of ' +
        'directory "Default" and the display name of directory "Profile 3". Pick exactly one with ' +
        '--browser-profile "dir:Default" or "dir:Profile 3".'
    );
    // name: does not make a duplicate display name unique.
    const named = await mac({ browser: 'chrome', profile: 'name:Work' });
    expect(named.candidates).toEqual([]);
    expect(named.selection?.selectionError).toBe('ambiguous');
  });

  test('stock Edge with three profiles: every directory stays selectable with dir:', async () => {
    const edge = join(appSupport, 'Microsoft Edge');
    const layout: Array<[string, string]> = [
      ['Default', 'Profile 1'],
      ['Profile 1', 'Profile 2'],
      ['Profile 2', 'Profile 3'],
    ];
    for (const [dir] of layout) plantChromium(edge, dir, fakeToken(dir));
    writeLocalState(edge, Object.fromEntries(layout.map(([dir, name]) => [dir, { name }])));

    // Every middle "Profile N" names a directory and another profile's display name.
    for (const [typed, a, b] of [
      ['Profile 1', 'Default', 'Profile 1'],
      ['Profile 2', 'Profile 1', 'Profile 2'],
    ] as const) {
      const refused = await mac({ browser: 'edge', profile: typed });
      expect(refused.selection?.selectionError).toBe('ambiguous');
      await expectSuggestionsResolve('edge', refused.selection?.problem, [
        fakeToken(a),
        fakeToken(b),
      ]);
    }
    for (const [dir, name] of layout) {
      const byDir = await mac({ browser: 'edge', profile: `dir:${dir}` });
      expect(byDir.candidates.map((c) => c.token)).toEqual([fakeToken(dir)]);
      const byName = await mac({ browser: 'edge', profile: `name:${name}` });
      expect(byName.candidates.map((c) => c.token)).toEqual([fakeToken(dir)]);
    }
  });

  test('a directory whose own display name is the same string is one match', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('a'));
    plantChromium(chrome, 'Profile 2', fakeToken('b'));
    writeLocalState(chrome, { Default: { name: 'Person A' }, 'Profile 2': { name: 'Profile 2' } });

    const result = await mac({ browser: 'chrome', profile: 'profile 2' });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
    expect(result.selection?.problem).toBeUndefined();
  });

  test('Linux Chrome channels are separate roots: the same directory in each is not ambiguous', async () => {
    const config = join(home, '.config');
    plantChromium(join(config, 'google-chrome'), 'Default', fakeToken('stable'));
    plantChromium(join(config, 'google-chrome-beta'), 'Default', fakeToken('beta'));

    const ok = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'chrome', profile: 'Default' },
    });
    expect(ok.candidates.map((c) => c.token).sort()).toEqual(
      [fakeToken('beta'), fakeToken('stable')].sort()
    );

    // An ambiguity inside one channel refuses the whole selection and names that root.
    plantChromium(join(config, 'google-chrome-beta'), 'Profile 1', fakeToken('beta1'));
    writeLocalState(join(config, 'google-chrome-beta'), { 'Profile 1': { name: 'Default' } });
    const refused = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'chrome', profile: 'Default' },
    });
    expect(refused.candidates).toEqual([]);
    expect(refused.selection?.problem).toContain(
      `is ambiguous in Chrome (${join(config, 'google-chrome-beta')}): it matches directory ` +
        '"Default" and the display name of directory "Profile 1".'
    );
  });

  test('Firefox: a suffix match and a different profile’s Name= are refused', async () => {
    const root = join(appSupport, 'Firefox');
    const profiles = join(root, 'Profiles');
    plantFirefox(profiles, 'a1.work', fakeToken('a'));
    plantFirefox(profiles, 'b2.default-release', fakeToken('b'));
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=Work\nIsRelative=1\nPath=Profiles/b2.default-release\n'
    );

    const result = await mac({ browser: 'firefox', profile: 'work' });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.problem).toBe(
      '--browser-profile "work" is ambiguous in Firefox: it matches directory "a1.work" and ' +
        'the profiles.ini Name= of "Profiles/b2.default-release". Pick exactly one with ' +
        '--browser-profile "dir:a1.work" or "dir:b2.default-release".'
    );
    // Both suggested forms resolve, as does name: for the ini entry.
    const viaDir = await mac({ browser: 'firefox', profile: 'dir:b2.default-release' });
    expect(viaDir.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
    const viaName = await mac({ browser: 'firefox', profile: 'name:work' });
    expect(viaName.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
    // The full directory name is unambiguous.
    const exact = await mac({ browser: 'firefox', profile: 'a1.work' });
    expect(exact.candidates.map((c) => c.token)).toEqual([fakeToken('a')]);
  });

  test('Firefox: a Name= kept outside the profiles dir is offered as name:, which resolves', async () => {
    const root = join(appSupport, 'Firefox');
    plantFirefox(join(root, 'Profiles'), 'a1.work', fakeToken('listed'));
    const elsewhere = join(home, 'relocated');
    plantFirefox(elsewhere, 'other', fakeToken('relocated'));
    writeFileSync(
      join(root, 'profiles.ini'),
      `[Profile0]\nName=work\nIsRelative=0\nPath=${join(elsewhere, 'other')}\n`
    );

    const result = await mac({ browser: 'firefox', profile: 'work' });
    expect(result.selection?.selectionError).toBe('ambiguous');
    // dir: cannot see a directory outside the listing, so it is not offered.
    expect(result.selection?.problem).toContain('"dir:a1.work" or "name:work"');
    expect(result.selection?.problem).not.toContain('"dir:other"');
    await expectSuggestionsResolve('firefox', result.selection?.problem, [
      fakeToken('listed'),
      fakeToken('relocated'),
    ]);
  });

  test('Firefox: a sole match that is unusable ends with the remedy, not a login prompt', async () => {
    const root = join(appSupport, 'Firefox');
    const profiles = join(root, 'Profiles');
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, 'b2.broken'), 'not a directory');
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=Broken\nIsRelative=1\nPath=Profiles/b2.broken\n'
    );
    const result = await mac({ browser: 'firefox', profile: 'broken' });
    expect(result.selection?.selectionError).toBe('unusable-profile');
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('which is not a readable directory.');
    expect(message).toContain('Make that profile directory readable');
    expect(message).not.toContain('Please log into');
  });

  test('a name: miss says the listed names are directories, for dir:', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('a'));
    writeLocalState(chrome, { Default: { name: 'Person A' } });
    const result = await mac({ browser: 'chrome', profile: 'name:Nobody' });
    expect(result.selection?.problem).toContain(
      'display names are not listed; profile directories include: Default; select one with "dir:<directory>";'
    );
    expect(result.selection?.problem).not.toContain('Person A');

    // dir: misses list the same thing, in the same terms.
    const dirMiss = await mac({ browser: 'chrome', profile: 'dir:Nobody' });
    expect(dirMiss.selection?.problem).toContain(
      '(profile directories include: Default; select one with "dir:<directory>";'
    );
  });

  test('a Firefox name: miss speaks of profiles.ini names, not display names', async () => {
    const root = join(appSupport, 'Firefox');
    plantFirefox(join(root, 'Profiles'), 'abc.default-release', fakeToken('a'));
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=Someone\nIsRelative=1\nPath=Profiles/abc.default-release\n'
    );
    const result = await mac({ browser: 'firefox', profile: 'name:Nope' });
    expect(result.selection?.problem).toContain(
      'profiles.ini names are not listed; profile directories include: abc.default-release; ' +
        'select one with "dir:<directory>";'
    );
    expect(result.selection?.problem).not.toContain('display names');

    // With nothing to list, there is nothing to select with dir: either.
    const empty = join(home, 'empty-ff');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'profiles.ini'), '[Profile0]\nName=Gone\nIsRelative=1\nPath=gone\n');
    const none = await extractRefreshTokenCandidates(undefined, {
      platform: 'darwin',
      home,
      env: {},
      selection: { browser: 'firefox', profile: 'dir:x', dataDir: empty },
    });
    expect(none.selection?.problem).toContain('(no profile directories were recognized;');
    expect(none.selection?.problem).not.toContain('dir:<directory>');
    expect(result.selection?.problem).not.toContain('Someone');
  });

  test('Firefox: a suffix and the same profile’s own Name= are one match', async () => {
    const root = join(appSupport, 'Firefox');
    plantFirefox(join(root, 'Profiles'), 'a1.work', fakeToken('a'));
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=work\nIsRelative=1\nPath=Profiles/a1.work\n'
    );
    const result = await mac({ browser: 'firefox', profile: 'WORK' });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('a')]);
    expect(result.selection?.problem).toBeUndefined();
  });

  describe('every pair of namespaces, both browsers', () => {
    type ChromiumKind = 'dir' | 'display';
    type FirefoxKind = 'dir' | 'suffix' | 'name';
    const TARGET = 'Target';

    /** Make Chromium profile `i` answer to TARGET through `kind`. */
    function chromiumProfile(
      root: string,
      i: number,
      kind: ChromiumKind,
      names: Record<string, { name: string }>
    ): string {
      const dir = kind === 'dir' ? TARGET : `Profile ${i}`;
      plantChromium(root, dir, fakeToken(`c${i}`));
      names[dir] = { name: kind === 'display' ? TARGET : `Person ${i}` };
      return fakeToken(`c${i}`);
    }

    /** Make Firefox profile `i` answer to TARGET through `kind`; returns its ini section. */
    function firefoxProfile(profiles: string, i: number, kind: FirefoxKind): string {
      const dir =
        kind === 'dir' ? TARGET : kind === 'suffix' ? `s${i}.${TARGET}` : `n${i}.other${i}`;
      plantFirefox(profiles, dir, fakeToken(`f${i}`));
      const name = kind === 'name' ? TARGET : `Person ${i}`;
      return `[Profile${i}]\nName=${name}\nIsRelative=1\nPath=Profiles/${dir}\n`;
    }

    const chromiumKinds: ChromiumKind[] = ['dir', 'display'];
    const firefoxKinds: FirefoxKind[] = ['dir', 'suffix', 'name'];

    for (const kind of chromiumKinds) {
      test(`Chromium: one profile matched by ${kind} resolves`, async () => {
        const root = join(appSupport, 'Google/Chrome');
        const names: Record<string, { name: string }> = {};
        const token = chromiumProfile(root, 1, kind, names);
        writeLocalState(root, names);
        const result = await mac({ browser: 'chrome', profile: TARGET.toLowerCase() });
        expect(result.candidates.map((c) => c.token)).toEqual([token]);
      });
    }

    for (const [a, b] of [
      ['dir', 'display'],
      ['display', 'display'],
    ] as Array<[ChromiumKind, ChromiumKind]>) {
      test(`Chromium pair is refused: ${a} + ${b} on two profiles`, async () => {
        const root = join(appSupport, 'Google/Chrome');
        const names: Record<string, { name: string }> = {};
        chromiumProfile(root, 1, a, names);
        chromiumProfile(root, 2, b, names);
        writeLocalState(root, names);
        const result = await mac({ browser: 'chrome', profile: TARGET });
        expect(result.candidates).toEqual([]);
        expect(result.selection?.problem).toContain(`"${TARGET}" is ambiguous in Chrome`);
        await expectSuggestionsResolve('chrome', result.selection?.problem, [
          fakeToken('c1'),
          fakeToken('c2'),
        ]);
      });
    }

    for (const kind of firefoxKinds) {
      test(`Firefox: one profile matched by ${kind} resolves`, async () => {
        const root = join(appSupport, 'Firefox');
        const ini = [firefoxProfile(join(root, 'Profiles'), 1, kind)];
        writeFileSync(join(root, 'profiles.ini'), ini.join('\n'));
        const result = await mac({ browser: 'firefox', profile: TARGET.toLowerCase() });
        expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('f1')]);
      });
    }

    for (let x = 0; x < firefoxKinds.length; x++) {
      for (let y = x; y < firefoxKinds.length; y++) {
        const [a, b] = [firefoxKinds[x]!, firefoxKinds[y]!];
        // Two directories cannot both be named exactly TARGET.
        if (a === 'dir' && b === 'dir') continue;
        test(`Firefox pair is refused: ${a} + ${b} on two profiles`, async () => {
          const root = join(appSupport, 'Firefox');
          const profiles = join(root, 'Profiles');
          const ini = [firefoxProfile(profiles, 1, a), firefoxProfile(profiles, 2, b)];
          writeFileSync(join(root, 'profiles.ini'), ini.join('\n'));
          const result = await mac({ browser: 'firefox', profile: TARGET });
          expect(result.candidates).toEqual([]);
          expect(result.selection?.problem).toContain(`"${TARGET}" is ambiguous in Firefox`);
          await expectSuggestionsResolve('firefox', result.selection?.problem, [
            fakeToken('f1'),
            fakeToken('f2'),
          ]);
        });
      }
    }
  });
});

describe('profile lookup errors and file formats', () => {
  let home: string;
  let appSupport: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-formats-'));
    appSupport = join(home, 'Library/Application Support');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const mac = (selection: NonNullable<ReturnType<typeof parseBrowserSelection>>) =>
    extractRefreshTokenCandidates(undefined, { platform: 'darwin', home, env: {}, selection });

  test('profiles.ini with CRLF line endings and a BOM still parses', async () => {
    const root = join(appSupport, 'Firefox');
    plantFirefox(join(root, 'Profiles'), 'abc.default-release', fakeToken('crlf'));
    writeFileSync(
      join(root, 'profiles.ini'),
      '\uFEFF[Profile0]\r\nName=Windows Edited\r\nIsRelative=1\r\n' +
        'Path=Profiles/abc.default-release\r\n\r\n[General]\r\nVersion=2\r\n'
    );
    const result = await mac({ browser: 'firefox', profile: 'windows edited' });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('crlf')]);
  });

  test('IsRelative=0 uses Path= as an absolute directory, with no Profiles/ dir at all', async () => {
    const root = join(appSupport, 'Firefox');
    // Deliberately no Profiles/ directory: profiles.ini alone must be enough.
    mkdirSync(root, { recursive: true });
    const elsewhere = join(home, 'elsewhere');
    plantFirefox(elsewhere, 'zz.custom', fakeToken('absolute'));
    writeFileSync(
      join(root, 'profiles.ini'),
      `[Profile0]\nName=Moved\nIsRelative=0\nPath=${join(elsewhere, 'zz.custom')}\n`
    );
    const result = await mac({ browser: 'firefox', profile: 'moved' });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('absolute')]);
  });

  test('a profiles.ini Name= whose directory is missing is named in the error', async () => {
    const root = join(appSupport, 'Firefox');
    plantFirefox(join(root, 'Profiles'), 'abc.default-release', fakeToken('other'));
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=Gone\nIsRelative=1\nPath=Profiles/deleted.gone-profile\n'
    );
    const result = await mac({ browser: 'firefox', profile: 'Gone' });
    expect(result.candidates).toEqual([]);
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('No Firefox profile named "Gone" was found');
    expect(message).toContain(
      `profiles.ini in "${root}" names "Gone" at "${join(root, 'Profiles/deleted.gone-profile')}", ` +
        'which does not exist.'
    );
    // The profile does not exist, so the remedy is the selection, not a login.
    expect(message).not.toContain('Please log into');
    expect(message).toContain('Name an existing profile, or another browser');
  });

  test('a profiles.ini Name= that is not a readable directory still counts toward ambiguity', async () => {
    const root = join(appSupport, 'Firefox');
    const profiles = join(root, 'Profiles');
    plantFirefox(profiles, 'a1.work', fakeToken('a'));
    // Name=Work points at a FILE: unusable, but it still names a second profile.
    writeFileSync(join(profiles, 'b2.broken'), 'not a directory');
    writeFileSync(
      join(root, 'profiles.ini'),
      '[Profile0]\nName=Work\nIsRelative=1\nPath=Profiles/b2.broken\n'
    );

    const result = await mac({ browser: 'firefox', profile: 'work' });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.selectionError).toBe('ambiguous');
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain(
      `at "${join(profiles, 'b2.broken')}", which is not a readable directory.`
    );
  });

  test('malformed Local State: directory names still match, and the error says display names were unavailable', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('default'));
    writeFileSync(join(chrome, 'Local State'), '{"profile": {"info_cache": ');

    const byDir = await mac({ browser: 'chrome', profile: 'Default' });
    expect(byDir.candidates.map((c) => c.token)).toEqual([fakeToken('default')]);

    const byName = await mac({ browser: 'chrome', profile: 'Person A' });
    expect(byName.candidates).toEqual([]);
    expect(noCopilotSessionError(byName.checked, byName.selection).message).toContain(
      `Display names were unavailable: "${join(chrome, 'Local State')}" could not be parsed.`
    );
  });

  test('a missing Local State is not reported as a problem', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('default'));
    const result = await mac({ browser: 'chrome', profile: 'Nope' });
    expect(result.selection?.notes).toBeUndefined();
    expect(noCopilotSessionError(result.checked, result.selection).message).not.toContain(
      'Display names were unavailable'
    );
  });

  test('dir: is exact and case-sensitive, so case-twin directories are each selectable', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Work', fakeToken('upper'));
    // A case-insensitive filesystem (default macOS) cannot hold both twins.
    const caseSensitive = !existsSync(join(chrome, 'work'));
    if (caseSensitive) {
      plantChromium(chrome, 'work', fakeToken('lower'));
      const plain = await mac({ browser: 'chrome', profile: 'work' });
      expect(plain.selection?.selectionError).toBe('ambiguous');
      const lower = await mac({ browser: 'chrome', profile: 'dir:work' });
      expect(lower.candidates.map((c) => c.token)).toEqual([fakeToken('lower')]);
    } else {
      // Exact means exact even where the filesystem would accept either case.
      const wrongCase = await mac({ browser: 'chrome', profile: 'dir:work' });
      expect(wrongCase.candidates).toEqual([]);
    }
    const upper = await mac({ browser: 'chrome', profile: 'dir:Work' });
    expect(upper.candidates.map((c) => c.token)).toEqual([fakeToken('upper')]);
  });

  test('a prefix with no name after it is refused at parse time', () => {
    for (const profile of ['dir:', 'NAME:  ']) {
      expect(() =>
        parseBrowserSelection({
          browserFlag: 'chrome',
          profileFlag: profile,
          env: {},
          platform: 'darwin',
        })
      ).toThrow('has a prefix but no name after it');
    }
  });

  test('the available profile list is sorted', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    for (const dir of ['Profile 10', 'Profile 2', 'Default']) {
      plantChromium(chrome, dir, fakeToken(dir));
    }
    const result = await mac({ browser: 'chrome', profile: 'Nope' });
    expect(result.selection?.problem).toContain('(available: Default, Profile 2, Profile 10;');
  });
});

describe('noCopilotSessionError', () => {
  test('without a selection the message is unchanged', () => {
    expect(noCopilotSessionError(['Chrome', 'Firefox']).message).toBe(
      'No Copilot Money session found. Searched: Chrome, Firefox. ' +
        'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
    );
  });

  test('with a selection the hint names every selection flag and variable', () => {
    const message = noCopilotSessionError(['Brave'], { label: 'Brave', browser: 'Brave' }).message;
    expect(message).toContain('--browser / --browser-profile / --browser-data-dir');
    expect(message).toContain(
      '(COPILOT_BROWSER / COPILOT_BROWSER_PROFILE / COPILOT_BROWSER_DATA_DIR)'
    );
    expect(message).toContain('Other browsers were not searched.');
  });

  test('FirebaseAuth surfaces the selection-specific message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'browser-select-auth-'));
    try {
      mkdirSync(join(home, '.config/BraveSoftware/Brave-Browser/Default'), { recursive: true });
      const auth = new FirebaseAuth(() =>
        extractRefreshTokenCandidates(undefined, {
          platform: 'linux',
          home,
          env: {},
          selection: { browser: 'brave', profile: 'Default' },
        })
      );
      await expect(auth.getIdToken()).rejects.toThrow(
        'No Copilot Money session found in Brave (profile "Default").'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('--browser-data-dir', () => {
  let home: string;
  let custom: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-datadir-home-'));
    custom = join(home, 'chrome-profile/Fork-18');
    mkdirSync(custom, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const parse = (input: Parameters<typeof parseBrowserSelection>[0]) =>
    parseBrowserSelection({ env: {}, platform: 'linux', cwd: home, home, ...input });

  const linux = (selection: NonNullable<ReturnType<typeof parseBrowserSelection>>) =>
    extractRefreshTokenCandidates(undefined, { platform: 'linux', home, env: {}, selection });

  describe('parsing', () => {
    test('the flag wins over COPILOT_BROWSER_DATA_DIR', () => {
      const other = join(home, 'other');
      mkdirSync(other);
      expect(
        parse({
          browserFlag: 'chrome',
          dataDirFlag: custom,
          env: { COPILOT_BROWSER_DATA_DIR: other },
        })
      ).toEqual({ browser: 'chrome', dataDir: custom });
      expect(
        parse({ env: { COPILOT_BROWSER: 'chrome', COPILOT_BROWSER_DATA_DIR: other } })
      ).toEqual({ browser: 'chrome', dataDir: other });
    });

    test('an empty value counts as unset', () => {
      expect(parse({ browserFlag: 'chrome', env: { COPILOT_BROWSER_DATA_DIR: '  ' } })).toEqual({
        browser: 'chrome',
      });
    });

    test('requires a browser', () => {
      expect(() => parse({ dataDirFlag: custom })).toThrow(
        /--browser-data-dir \(COPILOT_BROWSER_DATA_DIR\) requires --browser/
      );
      expect(() => parse({ env: { COPILOT_BROWSER_DATA_DIR: custom } })).toThrow(
        BrowserSelectionError
      );
    });

    test('a missing path or a file is refused at parse time', () => {
      const missing = join(home, 'nope');
      expect(() => parse({ browserFlag: 'chrome', dataDirFlag: missing })).toThrow(
        `"${missing}" does not exist.`
      );
      const file = join(home, 'file');
      writeFileSync(file, 'x');
      expect(() => parse({ browserFlag: 'chrome', dataDirFlag: file })).toThrow(
        'is not a directory.'
      );
    });

    test('the existence check is injectable', () => {
      const seen: string[] = [];
      expect(
        parse({
          browserFlag: 'brave',
          dataDirFlag: '/virtual/brave',
          pathKind: (p) => {
            seen.push(p);
            return 'directory';
          },
        })
      ).toEqual({ browser: 'brave', dataDir: '/virtual/brave' });
      expect(seen).toEqual(['/virtual/brave']);
      expect(() =>
        parse({ browserFlag: 'brave', dataDirFlag: '/virtual/x', pathKind: () => 'missing' })
      ).toThrow('does not exist');
    });

    test('a leading ~ expands to home and a relative path resolves against cwd', () => {
      const ok = () => 'directory' as const;
      expect(
        parse({ browserFlag: 'chrome', dataDirFlag: '~/chrome-profile/Fork-18', pathKind: ok })
          ?.dataDir
      ).toBe(custom);
      expect(parse({ browserFlag: 'chrome', dataDirFlag: '~', pathKind: ok })?.dataDir).toBe(home);
      expect(
        parse({ browserFlag: 'chrome', dataDirFlag: 'chrome-profile/Fork-18', pathKind: ok })
          ?.dataDir
      ).toBe(custom);
      expect(
        parse({
          browserFlag: 'chrome',
          dataDirFlag: './x/../chrome-profile/Fork-18',
          cwd: home,
          pathKind: ok,
        })?.dataDir
      ).toBe(custom);
    });

    test('a Windows-style ~\\ prefix expands to home too', () => {
      expect(resolveDataDirPath('~\\chrome-profile', '/', home)).toBe(join(home, 'chrome-profile'));
      // Not a home reference: ~user and a bare ~ inside a name resolve as relative paths.
      expect(resolveDataDirPath('~other', home, '/unused')).toBe(join(home, '~other'));
      expect(resolveDataDirPath('a~/b', home, '/unused')).toBe(join(home, 'a~/b'));
    });

    test('Safari refuses a data dir', () => {
      expect(() =>
        parseBrowserSelection({
          browserFlag: 'safari',
          dataDirFlag: custom,
          env: {},
          platform: 'darwin',
        })
      ).toThrow(/Safari does not support --browser-data-dir/);
    });

    test('a direct Firefox profile dir with a non-matching --browser-profile is refused', () => {
      const profileDir = join(home, 'ff/abc.default-release');
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, 'prefs.js'), '');
      expect(() =>
        parse({ browserFlag: 'firefox', dataDirFlag: profileDir, profileFlag: 'work' })
      ).toThrow(/is a single Firefox profile \("abc\.default-release"\).*"work"/);
      expect(
        parse({ browserFlag: 'firefox', dataDirFlag: profileDir, profileFlag: 'default-release' })
      ).toEqual({ browser: 'firefox', profile: 'default-release', dataDir: profileDir });
    });

    test('the label names the data dir', () => {
      expect(describeBrowserSelection({ browser: 'chrome', dataDir: '/d' })).toBe(
        'Chrome (data dir "/d")'
      );
      expect(describeBrowserSelection({ browser: 'chrome', profile: 'Work', dataDir: '/d' })).toBe(
        'Chrome (profile "Work", data dir "/d")'
      );
    });
  });

  describe('extraction', () => {
    test('Chromium: the custom root is searched and the default location is not', async () => {
      plantChromium(custom, 'Default', fakeToken('custom'));
      plantChromium(join(home, '.config/google-chrome'), 'Default', fakeToken('default'));

      const result = await linux({ browser: 'chrome', dataDir: custom });
      expect(result.checked).toEqual(['Chrome']);
      expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('custom')]);
      expect(result.selection?.label).toBe(`Chrome (data dir "${custom}")`);
      expect(result.selection?.dataDir).toBe(custom);
    });

    test('Chromium: custom root + profile by directory name', async () => {
      plantChromium(custom, 'Default', fakeToken('a'));
      plantChromium(custom, 'Profile 4', fakeToken('b'));
      const result = await linux({ browser: 'chrome', profile: 'profile 4', dataDir: custom });
      expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
    });

    test('Chromium: custom root + profile by Local State display name', async () => {
      plantChromium(custom, 'Default', fakeToken('a'));
      plantChromium(custom, 'Profile 1', fakeToken('b'));
      writeLocalState(custom, { Default: { name: 'Person A' }, 'Profile 1': { name: 'Fork' } });
      // The default location's Local State must not be consulted.
      writeLocalState(join(home, '.config/google-chrome'), { Default: { name: 'Fork' } });
      const result = await linux({ browser: 'chrome', profile: 'FORK', dataDir: custom });
      expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
    });

    test('Opera: the custom root keeps the root-layout storage', async () => {
      const dir = join(custom, IDB);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '000001.ldb'), fakeToken('opera'));
      const result = await linux({ browser: 'opera', dataDir: custom });
      expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('opera')]);
    });

    test('Firefox: a profiles root, with profiles.ini relative paths resolved against it', async () => {
      const root = join(home, 'ff-root');
      plantFirefox(join(root, 'Profiles'), 'q1.default-release', fakeToken('nested'));
      plantFirefox(root, 'q2.side', fakeToken('flat'));
      writeFileSync(
        join(root, 'profiles.ini'),
        '[Profile0]\nName=Main\nIsRelative=1\nPath=Profiles/q1.default-release\n\n' +
          '[Profile1]\nName=Side\nIsRelative=1\nPath=q2.side\n'
      );
      plantFirefox(join(home, '.mozilla/firefox'), 'z.default', fakeToken('default'));

      const all = await linux({ browser: 'firefox', dataDir: root });
      expect(all.candidates.map((c) => c.token).sort()).toEqual(
        [fakeToken('flat'), fakeToken('nested')].sort()
      );
      const main = await linux({ browser: 'firefox', profile: 'main', dataDir: root });
      expect(main.candidates.map((c) => c.token)).toEqual([fakeToken('nested')]);
      const side = await linux({ browser: 'firefox', profile: 'side', dataDir: root });
      expect(side.candidates.map((c) => c.token)).toEqual([fakeToken('flat')]);
    });

    test('Firefox: a direct profile dir is searched on its own, no profile needed', async () => {
      const profiles = join(home, 'ff-direct');
      plantFirefox(profiles, 'p1.default', fakeToken('direct'));
      plantFirefox(profiles, 'p2.other', fakeToken('sibling'));
      const profileDir = join(profiles, 'p1.default');

      const result = await linux({ browser: 'firefox', dataDir: profileDir });
      expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('direct')]);
      const named = await linux({ browser: 'firefox', profile: 'default', dataDir: profileDir });
      expect(named.candidates.map((c) => c.token)).toEqual([fakeToken('direct')]);
      const exact = await linux({
        browser: 'firefox',
        profile: 'dir:p1.default',
        dataDir: profileDir,
      });
      expect(exact.candidates.map((c) => c.token)).toEqual([fakeToken('direct')]);
      const wrong = await linux({ browser: 'firefox', profile: 'other', dataDir: profileDir });
      expect(wrong.candidates).toEqual([]);
      expect(wrong.selection?.problem).toContain('is the Firefox profile "p1.default"');
    });

    test('Firefox: the same directory name in both listing dirs is told apart by path, via --browser-data-dir', async () => {
      const root = join(home, 'ff-merged');
      const flat = join(root, 'a1.work');
      const nested = join(root, 'Profiles/a1.work');
      plantFirefox(root, 'a1.work', fakeToken('flat'));
      plantFirefox(join(root, 'Profiles'), 'a1.work', fakeToken('nested'));

      const result = await linux({ browser: 'firefox', profile: 'work', dataDir: root });
      expect(result.candidates).toEqual([]);
      expect(result.selection?.selectionError).toBe('ambiguous');
      const problem = result.selection?.problem ?? '';
      // "dir:a1.work" would itself be ambiguous, so it must not be offered.
      expect(problem).not.toContain('"dir:a1.work"');
      // Either order: the pair's order is a collation detail.
      const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const [f, n] = [esc(flat), esc(nested)];
      // Both orders spelled out, so the same path twice cannot match.
      expect(problem).toMatch(
        new RegExp(
          `No --browser-profile value tells (?:"${f}" and "${n}"|"${n}" and "${f}") apart\\.`
        )
      );
      expect(problem).toContain(
        'Select one by dropping --browser-profile and pointing --browser-data-dir at one of ' +
          'those paths.'
      );
      expect(problem).toContain(`directory "a1.work" at "${flat}"`);
      // And the offered remedy works for each.
      for (const [path, tag] of [
        [flat, 'flat'],
        [nested, 'nested'],
      ] as const) {
        const one = await linux({ browser: 'firefox', dataDir: path });
        expect(one.candidates.map((c) => c.token)).toEqual([fakeToken(tag)]);
      }
    });

    test('Firefox: two out-of-root profiles.ini entries sharing a Name= are offered by path, without --browser-profile', async () => {
      const root = join(home, 'ff-ini');
      mkdirSync(root, { recursive: true });
      const one = join(home, 'elsewhere-one/p1.one');
      const two = join(home, 'elsewhere-two/p2.two');
      plantFirefox(join(home, 'elsewhere-one'), 'p1.one', fakeToken('one'));
      plantFirefox(join(home, 'elsewhere-two'), 'p2.two', fakeToken('two'));
      writeFileSync(
        join(root, 'profiles.ini'),
        `[Profile0]\nName=Work\nIsRelative=0\nPath=${one}\n\n` +
          `[Profile1]\nName=Work\nIsRelative=0\nPath=${two}\n`
      );

      const result = await linux({ browser: 'firefox', profile: 'work', dataDir: root });
      expect(result.selection?.selectionError).toBe('ambiguous');
      const problem = result.selection?.problem ?? '';
      // Both would be "name:Work", which is itself ambiguous: offered by path instead.
      expect(problem).not.toContain('"name:Work"');
      expect(problem).toContain('dropping --browser-profile');
      // Following the advice literally — no --browser-profile — selects each one.
      for (const [path, tag] of [
        [one, 'one'],
        [two, 'two'],
      ] as const) {
        // Named twice — once in its match, once in the "tells … apart" clause —
        // never doubled up as `of "<path>" at "<path>"`.
        expect(problem.split(`"${path}"`).length - 1).toBe(2);
        const selected = parse({ browserFlag: 'firefox', dataDirFlag: path });
        const found = await linux(selected!);
        expect(found.candidates.map((c) => c.token)).toEqual([fakeToken(tag)]);
      }
      // Keeping a name: profile with a single-profile dir is what dropping avoids.
      expect(() =>
        parse({ browserFlag: 'firefox', profileFlag: 'name:Work', dataDirFlag: one })
      ).toThrow('does not match --browser-profile');
    });

    test('two separate shared values get one clause each', async () => {
      const root = join(home, 'ff-two-groups');
      for (const dir of ['a1.work', 'b2.work']) {
        plantFirefox(root, dir, fakeToken(`flat-${dir}`));
        plantFirefox(join(root, 'Profiles'), dir, fakeToken(`nested-${dir}`));
      }
      const result = await linux({ browser: 'firefox', profile: 'work', dataDir: root });
      const clauses = (result.selection?.problem ?? '').match(/No --browser-profile value tells/g);
      expect(clauses).toHaveLength(2);
    });

    test('Safari: a data dir reaching extraction finds nothing and says why', async () => {
      plantChromium(custom, 'Default', fakeToken('x'));
      const result = await extractRefreshTokenCandidates(undefined, {
        platform: 'darwin',
        home,
        env: {},
        selection: { browser: 'safari', dataDir: custom },
      });
      expect(result.candidates).toEqual([]);
      expect(result.selection?.problem).toBe('Safari does not support a custom data directory.');
    });

    test('no session in the custom dir: the error names it, with no fallback', async () => {
      plantChromium(join(home, '.config/google-chrome'), 'Default', fakeToken('default'));
      mkdirSync(join(custom, 'Default'), { recursive: true });

      const result = await linux({ browser: 'chrome', dataDir: custom });
      expect(result.candidates).toEqual([]);
      const message = noCopilotSessionError(result.checked, result.selection).message;
      expect(message).toContain(`No Copilot Money session found in Chrome (data dir "${custom}").`);
      expect(message).not.toContain(fakeToken('default'));
    });

    test('Chromium: a data dir that is one profile, not the user-data root, is named in the error', async () => {
      // By name: the Default directory itself.
      const profileDir = join(custom, 'Default');
      plantChromium(custom, 'Default', fakeToken('x'));
      const byName = await linux({ browser: 'chrome', dataDir: profileDir });
      expect(byName.candidates).toEqual([]);
      const message = noCopilotSessionError(byName.checked, byName.selection).message;
      expect(message).toContain(
        `"${profileDir}" looks like a single Chrome profile directory, not the user-data root`
      );
      expect(message).toContain(`its parent ("${custom}")`);
      expect(message).toContain('--browser-profile "dir:Default"');

      // By content: any name, holding a Preferences file.
      const copied = join(home, 'copied-profile');
      mkdirSync(copied, { recursive: true });
      writeFileSync(join(copied, 'Preferences'), '{}');
      const byFile = await linux({ browser: 'chrome', dataDir: copied });
      expect(byFile.selection?.hint).toContain(`"${copied}" looks like a single Chrome profile`);
    });

    test('Chromium: a real user-data root gets no profile-dir hint', async () => {
      plantChromium(custom, 'Default', fakeToken('x'));
      writeLocalState(custom, { Default: { name: 'Person A' } });
      const result = await linux({ browser: 'chrome', dataDir: custom });
      expect(result.selection?.hint).toBeUndefined();
    });

    test('a data dir removed after startup is reported as missing', async () => {
      const gone = join(home, 'gone');
      const result = await linux({ browser: 'chrome', profile: 'Default', dataDir: gone });
      const message = noCopilotSessionError(result.checked, result.selection).message;
      expect(message).toContain(`Chrome (profile "Default", data dir "${gone}")`);
      expect(message).toContain(`Chrome's data directory was not found (checked: ${gone}).`);
    });
  });
});
