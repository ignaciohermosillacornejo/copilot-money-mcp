/**
 * The shapes `tests/no-ambient-database-discovery.test.ts` exists to catch,
 * kept as a fixture so that gate can prove it still recognises them.
 *
 * Deliberately NOT named `*.test.ts`, and imported by nothing, so it is only
 * ever read as text — if `bun test` collected it, the constructions below
 * would do the very filesystem probe the gate forbids.
 *
 * EVERY member of that gate's `FALSY_FIRST_ARGS` appears below, one per line.
 * That is the point of the file rather than a tidiness rule: a member with no
 * specimen can be deleted from the set with the whole suite green, and the
 * resulting under-collection is indistinguishable from a pass — the
 * `silent-under-collecting-scan` shape this repo already has a class for.
 *
 * IN NO PROGRAM, stated because it is load-bearing in both directions. The
 * base `tsconfig.json` excludes `tests/`, `tsconfig.tests.json` does not list
 * this file, and `eslint.config.js` ignores `tests/**` — so nothing type-checks
 * or lints it. That is what lets `new CopilotDatabase(null)` sit here at all
 * (`null` is not assignable to `string | undefined`), and it is also the cost:
 * the two must-NOT-flag lines at the bottom will go on compiling in nobody's
 * program if the constructor's signature ever changes, so they can stop
 * representing it silently. The trade-off is not resolvable by adding the file
 * to a program — that would reject the `null` line — so it is written down.
 *
 * Do not "fix" the constructions below. They are the specimen.
 */

import { CopilotDatabase } from '../../src/core/database.js';

const SOME_PATH = '/nonexistent/copilot-money-mcp/specimen';

// Shape 1 (#756): no argument at all, so the constructor runs
// `findCopilotDatabase()` against the real home directory.
export const implicit = new CopilotDatabase();

// Shapes 2-6 are the falsy spellings, one per FALSY_FIRST_ARGS member. Each is
// a way to satisfy a gate that only asked for *an* argument while changing
// nothing about what the constructor does: `if (dbPath)` sends every one of
// them down the discovery branch exactly as shape 1 goes.
export const explicitUndefined = new CopilotDatabase(undefined);

export const explicitNull = new CopilotDatabase(null);

export const emptySingleQuoted = new CopilotDatabase('');

// `prettier-ignore` because this repo's prettier rewrites "" to '', and a
// specimen normalised into a copy of the line above would leave `'""'` in
// FALSY_FIRST_ARGS with no coverage — deletable with the suite green, which is
// the exact failure this file exists to prevent. The empty template literal
// below needs no such guard: prettier leaves it alone (checked).
// prettier-ignore
export const emptyDoubleQuoted = new CopilotDatabase("");

export const emptyTemplate = new CopilotDatabase(``);

// Must NOT be flagged: an explicit path is the whole remedy.
export const explicitPath = new CopilotDatabase(SOME_PATH);

// Must NOT be flagged either: a second argument does not change the first.
export const explicitPathAndTimeout = new CopilotDatabase(SOME_PATH, 1000);
