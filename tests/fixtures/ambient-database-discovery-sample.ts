/**
 * The shapes `tests/no-ambient-database-discovery.test.ts` exists to catch,
 * kept as a fixture so that gate can prove it still recognises them.
 *
 * Deliberately NOT named `*.test.ts`, and imported by nothing, so it is only
 * ever read as text — if `bun test` collected it, the constructions below
 * would do the very filesystem probe the gate forbids.
 *
 * Do not "fix" the constructions below. They are the specimen.
 */

import { CopilotDatabase } from '../../src/core/database.js';

const SOME_PATH = '/nonexistent/copilot-money-mcp/specimen';

// Shape 1 (#756): no argument at all, so the constructor runs
// `findCopilotDatabase()` against the real home directory.
export const implicit = new CopilotDatabase();

// Shape 2: the cheapest way to turn a naive "has an argument" gate green
// without changing what the constructor does. `undefined` is falsy, so this
// reaches discovery exactly as shape 1 does.
export const explicitUndefined = new CopilotDatabase(undefined);

// Shape 3: same falsiness, spelled as an empty string. Also flagged, because
// the constructor's `if (dbPath)` sends it down the discovery branch too.
export const emptyString = new CopilotDatabase('');

// Must NOT be flagged: an explicit path is the whole remedy.
export const explicitPath = new CopilotDatabase(SOME_PATH);

// Must NOT be flagged either: a second argument does not change the first.
export const explicitPathAndTimeout = new CopilotDatabase(SOME_PATH, 1000);
