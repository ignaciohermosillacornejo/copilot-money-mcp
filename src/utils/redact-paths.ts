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
 * One stated limit: a home outside `/Users` and `/home` (`/var/root`, a
 * container's home) is redacted only where it appears as a whole segment, so
 * a SIBLING directory named after it — `${home}.bak/x` — matches neither the
 * anchored home nor the generic prefix, and keeps the name. Contrived, and
 * the price of not rewriting `/home/runner2` into `~2`; written down so it is
 * a choice rather than a surprise.
 */

import { homedir } from 'node:os';

/** Characters that end a username segment: a separator, space, quote or closing punctuation. */
const USER_PREFIX = /\/(Users|home)\/[^/\s'",)]+/g;

export function redactUserPaths(text: string, home: string = safeHomedir()): string {
  let out = text;
  if (home && home !== '/') out = out.replace(homePattern(home), '~');
  return out.replace(USER_PREFIX, '/$1/<user>');
}

/** The last home's pattern. The home does not change within a process, so one slot suffices. */
let cachedHome: string | undefined;
let cachedPattern: RegExp | undefined;

function homePattern(home: string): RegExp {
  if (cachedHome !== home || !cachedPattern) {
    // A whole-segment match only: `/home/runner` must not rewrite
    // `/home/runner2/x` into the nonsense path `~2/x`. Safe to reuse with the
    // `g` flag: `String.prototype.replace` resets `lastIndex` on every call.
    cachedPattern = new RegExp(`${escapeRegExp(home)}(?=$|[/\\s'",)])`, 'g');
    cachedHome = home;
  }
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
