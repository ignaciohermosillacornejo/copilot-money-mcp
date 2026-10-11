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
 * identifies the user: the current home directory, wherever it appears
 * (spaces in the path included, since it is matched literally), and any other
 * `/Users/<name>` or `/home/<name>` prefix. What follows the prefix is kept,
 * because it is what says which file failed.
 */

import { homedir } from 'node:os';

const USER_PREFIX = /\/(Users|home)\/[^/\s'"]+/g;

export function redactUserPaths(text: string, home: string = safeHomedir()): string {
  let out = text;
  if (home && home !== '/') out = out.split(home).join('~');
  return out.replace(USER_PREFIX, '/$1/<user>');
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}
