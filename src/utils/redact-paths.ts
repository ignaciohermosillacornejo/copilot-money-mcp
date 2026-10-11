/**
 * Remove the user's identity from paths in text bound for an MCP client.
 *
 * Errors thrown past the dispatch gate — an `EACCES` from the decoder, a
 * LevelDB open failure — carry absolute paths in their messages, and
 * `handleCallTool` relays the message to the client. On macOS those paths
 * start with `/Users/<name>/…`, so every such error disclosed the username.
 *
 * Deliberately narrow. A general "anything that looks like a path" scrub would
 * also eat text that only contains a slash — a category named `Food/Dining`,
 * a date, the GraphQL endpoint URL — and an error that has lost its subject is
 * worse than one that names a directory. So this replaces only the part that
 * identifies the user: the current home directory, wherever it appears as a
 * whole path segment (spaces in the rest of the path included, since the home
 * is matched literally), and any other `/Users/<name>` or `/home/<name>`
 * prefix. What follows the prefix is kept, because it is what says which file
 * failed.
 *
 * Not the same scrub as `scrubPaths` in `src/core/database.ts`, on purpose.
 * That one builds the dispatch gate's "could not read" message, which names an
 * errno and needs no path at all, so it replaces whole paths with `<path>`.
 * This one runs on errors whose path IS the useful part, so it keeps the path
 * and removes only the user.
 *
 * The home is matched wherever it is not continued by a name character
 * (a letter, digit, `_` or `-`). So `/home/runner2` and `/home/runner-backup`
 * are someone else's and fall to the generic prefix rule, while a sibling
 * named after the home — `${home}.bak/x` — becomes `~.bak/x`, which keeps the
 * path's shape and drops the name. That last case matters for a home outside
 * `/Users` and `/home` (`/var/root`, a container's home), which the generic
 * prefix rule cannot see.
 *
 * What remains, stated: for such a home, a sibling joined by a name character
 * (`${home}-backup`, `${home}2`) keeps the name. Telling that apart from a
 * different user's directory is exactly what the lookahead cannot do, and
 * under `/Users` and `/home` the prefix rule covers it anyway. Pinned by a
 * test so changing it is a decision.
 */

import { homedir } from 'node:os';

/** Characters that end a username segment: a separator, space, quote or closing punctuation. */
const USER_PREFIX = /\/(Users|home)\/[^/\s'",)]+/g;

export function redactUserPaths(text: string, home: string = safeHomedir()): string {
  let out = text;
  if (home && home !== '/') out = out.replace(homePattern(home), '~');
  return out.replace(USER_PREFIX, '/$1/<user>');
}

/**
 * The last home's pattern. In production the home is fixed for the process, so
 * one slot suffices; it is keyed only so that a caller passing an explicit home
 * (the tests do) is never served the previous home's pattern.
 */
let cachedHome: string | undefined;
let cachedPattern: RegExp | undefined;

function homePattern(home: string): RegExp {
  if (cachedHome !== home || !cachedPattern) {
    // Not continued by a name character: `/home/runner` must not rewrite
    // `/home/runner2/x` into the nonsense path `~2/x`.
    cachedPattern = new RegExp(`${escapeRegExp(home)}(?![\\w-])`, 'g');
    cachedHome = home;
  }
  // `replace` resets a global regex's lastIndex itself; resetting here too
  // keeps the shared instance safe if a later caller reaches for test()/exec().
  cachedPattern.lastIndex = 0;
  return cachedPattern;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}
