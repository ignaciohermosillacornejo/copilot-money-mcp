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
 * identifies the user: the current home directory, matched literally (so a
 * space inside it is no obstacle) and only where it is not the start of a
 * longer name — see the two boundaries below — and any other `/Users/<name>`
 * or `/home/<name>` prefix. What follows the prefix is kept, because it is what says which file
 * failed.
 *
 * Not the same scrub as `scrubPaths` in `src/core/database.ts`, on purpose.
 * That one builds the dispatch gate's "could not read" message, which names an
 * errno and needs no path at all, so it replaces whole paths with `<path>`.
 * This one runs on errors whose path IS the useful part, so it keeps the path
 * and removes only the user.
 *
 * How the home is matched depends on where it lives, because the generic
 * prefix rule only sees `/Users` and `/home`:
 *
 *   - Under `/Users` or `/home`, the home matches only where a username
 *     segment ends (`SEGMENT_END`): before `/`, whitespace, a quote, `,` or
 *     `)`, or at the end of the text — the characters that end a path in an
 *     error message (`open '/Users/bob'`, `/Users/bob, …`, `cwd is /Users/bob
 *     and …`) — and also before `:`, `;`, `]`, `}`, `?` or `!`
 *     (`BOUNDARY_ONLY`), which no username can contain (`open /Users/bob:
 *     EACCES`, `[/Users/bob]`, `did you mean /Users/bob?`).
 *     Any sibling — `/Users/bob.smith`, `/Users/bob2`,
 *     `/Users/bob.bak` — is left to the prefix rule, which replaces the whole
 *     name segment. Matching more loosely here would turn `/Users/bob.smith/x`
 *     into `~.smith/x` and leak another user's name tail. The quote and the
 *     whitespace matter for a home containing a space: without them the prefix
 *     rule would stop at the space and leave the rest of the name behind
 *     (`/Users/<user> smith'`, `/Users/<user> smith and …`).
 *   - Anywhere else (`/var/root`, a container's home), the prefix rule is
 *     blind, so the home matches wherever it is not continued by a name
 *     character — any Unicode letter or digit, `_` or `-`. A sibling such as
 *     `${home}.bak/x` becomes `~.bak/x`: the path keeps its shape and loses the
 *     name.
 *
 * The strict boundary is built from the prefix rule's stop class on purpose.
 * The invariant: the boundary accepts exactly `SEGMENT_END` plus
 * `BOUNDARY_ONLY`, and the prefix rule stops exactly at `SEGMENT_END` — so the
 * boundary is a superset of the stop class. That is what makes the strict
 * boundary safe: everything it declines is handed to the prefix rule, which
 * never runs past a point where the boundary would have matched. Two
 * hand-kept classes could drift apart silently; a behavioural test pins the
 * invariant character by character.
 *
 * `BOUNDARY_ONLY` is not in the prefix rule's stop class because it does not
 * need to be: those characters cannot occur in a username (macOS short names
 * are letters, digits, `_`, `-` and `.`; Linux `useradd`/`adduser` defaults
 * are letters, digits, `_`, `-` and a trailing `$`, and `:` is the
 * `/etc/passwd` field separator). That is a proxy: what the boundary actually
 * meets is a directory name directly under `/Users` or `/home`, and all six
 * are legal in a filename. It holds because such a directory is in practice a
 * home named after a short name; where it does not, see the last limit below.
 * `.` is deliberately in neither: it IS a
 * username character, so the prefix rule must run through it
 * (`/Users/bob.smith` is one user) and the boundary must not stop at it.
 *
 * What remains, stated:
 *   - For a home outside `/Users` and `/home`, a sibling joined by a name
 *     character (`${home}-backup`, `${home}2`, `${home}ü`) keeps the name,
 *     because telling it apart from a different directory is exactly what a
 *     lookahead cannot do.
 *   - Under `/Users` and `/home`, another user whose name is the current
 *     home's name plus a space and more (`/Users/bob smith` while the home is
 *     `/Users/bob`) keeps the part after the space, as it would with no home
 *     at all: the prefix rule cannot tell a spaced name from the prose after
 *     it either. The prefix also becomes `~` (`~ smith/x`), so the output
 *     reads as the current user's home when it is someone else's path.
 *   - Under `/Users` and `/home`, a home containing whitespace followed by a
 *     character outside the boundary class (`.` above all, since it cannot be
 *     added; also `*`, `=`, …) keeps the part after the space: `could not open
 *     /Users/bob smith.` becomes `/Users/<user> smith.`. The boundary cannot
 *     accept `.` without turning `/Users/bob.smith/x` into `~.smith/x`, and
 *     the prefix rule stops at the space.
 *   - Under `/Users` and `/home`, a directory that is not a home and whose
 *     name continues after a boundary-only character (`/Users/bob!old` while
 *     the home is `/Users/bob`) keeps the continuation and reads as `~`:
 *     `~!old/x`, where the prefix rule alone would give `/Users/<user>/x`.
 *     The accepted cost of `BOUNDARY_ONLY`.
 *
 * Pinned by tests so changing either is a decision.
 */

import { homedir } from 'node:os';

/**
 * Characters that end a username segment: a separator, whitespace, a quote or
 * closing punctuation. Source text for a regex character class, shared by the
 * prefix rule (which stops at them) and the strict home boundary (which
 * accepts them) — see the module docblock.
 *
 * It is interpolated into both a negated and a positive class, so edit it as
 * class source: append only, and escape `-`, `]`, `^` and backslash (a bare
 * `-` makes a range, a leading `^` inverts the positive class, a bare `]` ends
 * it). In this template literal an escape is written doubled, as `\\s` is.
 * A trailing `-` is not safe either, though it looks it in the negated class:
 * `BOUNDARY_ONLY` is concatenated after this string, so the `-` stops being
 * last there and becomes a range (`)-:` would admit `.`, `/` and every digit).
 */
const SEGMENT_END = `/\\s'",)`;

/**
 * Characters the strict home boundary accepts on top of `SEGMENT_END`: ones no
 * username can contain, so stopping there cannot leak another user's name
 * tail. Same class-source rules as `SEGMENT_END` (escape any `-`). Never add
 * `.` — see the module docblock.
 */
const BOUNDARY_ONLY = `:;\\]}?!`;

const USER_PREFIX = new RegExp(`/(Users|home)/[^${SEGMENT_END}]+`, 'g');

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
    // See the module docblock: strict where the prefix rule can take over,
    // broad (and Unicode-aware) only where it cannot.
    const underUserRoot = /^\/(Users|home)\/[^/]+$/.test(home);
    const boundary = underUserRoot
      ? `(?=[${SEGMENT_END}${BOUNDARY_ONLY}]|$)`
      : '(?![\\p{L}\\p{N}_-])';
    cachedPattern = new RegExp(`${escapeRegExp(home)}${boundary}`, 'gu');
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
