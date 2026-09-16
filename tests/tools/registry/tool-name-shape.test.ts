/**
 * Every tool name is `verb_noun` — i.e. contains an underscore.
 *
 * This is not documentation of a habit. `scripts/check-tool-counts.ts` uses
 * the shape as a **discriminator**: when `expectToolTable` finds a backticked
 * token in a table row that the registry does not know, it reports the token
 * as an unknown tool if it looks tool-shaped and treats it as prose otherwise.
 * That is what lets a typo (`get_transactons`) fail while an English word
 * (`merchant`) does not.
 *
 * The premise was incidental until this file existed. A tool named `networth`
 * would have slipped through `extra` silently — a doc could name a tool that
 * does not exist and the gate that reads that table would say nothing, which
 * is the exact failure `expectToolTable` was added to prevent. Now it breaks
 * here instead, loudly, at the point where the convention is broken rather
 * than at the surface that depends on it.
 *
 * Two premises, gated separately because they fail differently:
 *
 *   - **charset** (`/^[a-z_]+$/`) — the token regex `/`([a-z_]+)`/` cannot even
 *     see a name outside it, so `missing` reports the tool forever and no doc
 *     edit clears it.
 *   - **underscore** (`verb_noun`) — the discriminator that separates a typo
 *     from prose. Relax it and an unknown tool name goes unreported instead.
 *
 * Sibling of the same argument in `scripts/check-tracked-files.ts`: a guard
 * that reasons from a naming convention needs the convention gated, or the
 * guard is one rename away from being a no-op.
 */
import { describe, expect, test } from 'bun:test';

import {
  READ_TOOL_DEFS,
  LIVE_TOOL_DEFS,
  WRITE_TOOL_DEFS,
} from '../../../src/tools/registry/index.js';

const ALL_DEFS = [...READ_TOOL_DEFS, ...LIVE_TOOL_DEFS, ...WRITE_TOOL_DEFS];

describe('tool name shape', () => {
  // The token regex in `expectToolTable` is `/`([a-z_]+)`/`. A name outside
  // that charset — a digit, a hyphen, a capital — is not merely unmatched, it
  // is UNREPORTABLE: `missing` names it forever and no edit to the doc can
  // clear it, because the parser cannot see the token that would satisfy it.
  // `bun run check` stays red until someone reads the regex. That is a worse
  // failure than the one the underscore test prevents, and it is the half of
  // the convention that was not gated.
  test('every registry tool name is lowercase and underscores only', () => {
    const offShape = ALL_DEFS.map((d) => d.schema.name).filter((n) => !/^[a-z_]+$/.test(n));
    expect(offShape).toEqual([]);
  });

  test('every registry tool name contains an underscore', () => {
    const singleWord = ALL_DEFS.map((d) => d.schema.name).filter((n) => !n.includes('_'));
    expect(singleWord).toEqual([]);
  });

  // The sweep must actually have swept something — an empty registry would
  // satisfy the assertion above without observing anything. `> 0` states
  // exactly that; a larger floor would be a number with no source, and a
  // spurious failure the day the surface legitimately shrinks. (The sibling
  // script had a hardcoded 16 in a comment for the same reason, and it was
  // wrong.)
  test('the invariant is checked against a non-empty registry', () => {
    expect(ALL_DEFS.length).toBeGreaterThan(0);
  });
});
