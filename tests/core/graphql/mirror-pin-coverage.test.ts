/**
 * Mirror-pin coverage ratchet (PR #703 review, round eight).
 *
 * A wire node under `src/core/graphql/queries/` is declared TWICE by hand: as a
 * TS interface (which row types in `src/tools/live/` spread) and as a zod
 * mirror (which the wire-parity tests compare against). Nothing links the two,
 * and `read-response-validation.ts` uses `z.looseObject` precisely so NEW
 * server fields flow through without warnings — so a field added to the
 * operation document and the interface, with the mirror edit forgotten, drifts
 * silently into every caller's row. `*_MIRROR_IS_EXACT` pins close that hop.
 *
 * Pinning the twins by hand is what this ratchet exists to replace: round seven
 * of that review found three unpinned twins by grep, and the commit that fixed
 * them still left nothing detecting the NEXT one. This walks the query modules
 * and fails when a named `*NodeSchema` has no matching pin in the same file.
 *
 * SCOPE — deliberately the EXPORTED `*NodeSchema` mirrors only, which is
 * narrower than "named": `RecurringIconSchema` (queries/recurrings.ts) is a
 * named mirror of an exported interface, but it is module-private and not
 * `Node`-suffixed, so it escapes on both counts. Out of scope on the merits —
 * the field-selection engine projects only top-level keys, so a nested twin's
 * drift cannot produce the false `Unknown field name(s) ignored` warning this
 * class exists to prevent (same reasoning that excuses RecurringRuleNode and
 * RecurringPaymentNode). Of the `export interface *Node`
 * declarations under queries/, most are twinned with an ANONYMOUS
 * `z.looseObject` literal nested inside their `*ResponseSchema` (see
 * `tags.ts`), which has no name to pin against and is out of scope until
 * extracted. Exposure there is lower: those tools build known-field sets from
 * per-tool renaming maps rather than an object spread, so a drifted field does
 * not reach a caller's row the way the spread-based ones do.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const QUERIES_DIR = join(import.meta.dir, '../../../src/core/graphql/queries');

/**
 * `export const FooNodeSchema = ...` — the named zod mirrors.
 *
 * Anchored to line start (#705). Unanchored, a mirror NAMED IN PROSE counted
 * as a declaration — a JSDoc usage example, a migration note, a `//` TODO — so
 * the ratchet could believe a mirror exists where none does.
 *
 * What anchoring reaches: line-prefixed comments (`//`, ` * `) and indented
 * drafts. What it does NOT reach: a `/* ... *\/` block whose body sits at
 * column 0. No such instance exists today, and full comment-stripping is more
 * machinery than a ratchet warrants — but do not read `^` as "comments are
 * handled". A phantom MIRROR is the more annoying direction: it demands a pin
 * that cannot exist, failing CI until someone forges one.
 */
const NAMED_MIRROR = /^export const (\w+NodeSchema)\b/gm;
/**
 * `export const FOO_NODE_MIRROR_IS_EXACT: ExactKeys<...>` — the pins.
 *
 * The `: ExactKeys<` is part of the pattern on purpose. Matching the NAME
 * alone would make this ratchet's own remedy fakeable: when it fails, the
 * shortest edit that silences it is a bare `export const X_MIRROR_IS_EXACT =
 * true;`, which satisfies the regex while pinning nothing — the vacuous-guard
 * shape this PR has already removed four times elsewhere. Requiring the
 * annotation is where a regex's reach ends: it cannot check that the two type
 * arguments name the right interface/mirror pair, and it does not need to —
 * typechecking a correct annotation is what does the real work. This only
 * guarantees the annotation is there to typecheck.
 *
 * Anchored to line start (#705), and this one had a live phantom: the
 * `Usage —` example in `_shared.ts`'s own JSDoc reads
 * `export const FOO_NODE_MIRROR_IS_EXACT: ExactKeys<`, which the unanchored
 * regex counted as a real pin. Nothing declares a `FooNodeSchema` today, so it
 * satisfied no mirror and the ratchet stayed correct by luck — the doc block
 * teaching people the pattern was also forging one.
 */
const PIN = /^export const (\w+_MIRROR_IS_EXACT):\s*ExactKeys</gm;

/** SecurityNodeSchema -> SECURITY_NODE_MIRROR_IS_EXACT */
function expectedPinName(mirror: string): string {
  const base = mirror.replace(/Schema$/, ''); // SecurityNode
  const screaming = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return `${screaming}_MIRROR_IS_EXACT`;
}

interface ModuleScan {
  file: string;
  mirrors: string[];
  pins: string[];
}

function scanQueryModules(): ModuleScan[] {
  return readdirSync(QUERIES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => {
      const source = readFileSync(join(QUERIES_DIR, file), 'utf8');
      return {
        file,
        mirrors: [...source.matchAll(NAMED_MIRROR)].map((m) => m[1] as string),
        pins: [...source.matchAll(PIN)].map((m) => m[1] as string),
      };
    });
}

describe('every named zod mirror has a compile-time pin to its interface', () => {
  const scans = scanQueryModules();
  const allMirrors = scans.flatMap((s) => s.mirrors);

  test('guards the gate: discovery finds the known mirrors, so a broken regex fails loudly', () => {
    // Without this, a regex that stops matching turns the whole ratchet into a
    // vacuous pass over an empty list — the exact failure class PR #703 spent
    // three rounds removing from other guards.
    expect(scans.length).toBeGreaterThan(5);
    expect(allMirrors.length).toBeGreaterThanOrEqual(5);
    expect(allMirrors).toContain('AccountNodeSchema');
    expect(allMirrors).toContain('RecurringNodeSchema');
    expect(allMirrors).toContain('SecurityNodeSchema');
  });

  /** Re-run a discovery regex against a string, with its own flags. */
  const matches = (re: RegExp, text: string): string[] =>
    [...text.matchAll(new RegExp(re.source, re.flags))].map((m) => m[1] as string);

  test('a bare `= true` const is NOT counted as a pin', () => {
    // The remedy for a failure here must not be fakeable. Discovery requires
    // the ExactKeys annotation, so the lazy edit that silences the message
    // does not satisfy the ratchet.
    const bare = 'export const TAG_NODE_MIRROR_IS_EXACT = true;';
    const annotated =
      'export const TAG_NODE_MIRROR_IS_EXACT: ExactKeys<keyof TagNode, keyof typeof TagNodeSchema.shape> = true;';
    expect(matches(PIN, bare)).toHaveLength(0);
    expect(matches(PIN, annotated)).toHaveLength(1);
  });

  test('a pin or mirror written in PROSE is not a declaration (#705)', () => {
    // The other half of "not fakeable", and the half that was open: the
    // remedy must not be satisfiable by TALKING about a pin. Both regexes
    // were unanchored, so any line that merely CONTAINED the text counted —
    // a JSDoc usage example, a migration note, a commented-out draft.
    //
    // This was not hypothetical. `_shared.ts`'s own `Usage —` block, the doc
    // that teaches the pattern, reads `export const FOO_NODE_MIRROR_IS_EXACT:
    // ExactKeys<` and was being counted as a real pin. It satisfied no mirror
    // only because nothing declares a `FooNodeSchema`, so the ratchet was
    // correct by luck rather than by construction.
    const prose = [
      ' * Usage — one line per interface/mirror twin, assigned `true`:',
      ' *',
      ' *   export const FOO_NODE_MIRROR_IS_EXACT: ExactKeys<',
      ' *     keyof FooNode,',
      ' *   > = true;',
      '// TODO: export const BAR_NODE_MIRROR_IS_EXACT: ExactKeys<...> = true;',
      '  // export const BazNodeSchema = z.looseObject({});',
      ' * and then export const QuuxNodeSchema = ... would need a pin too',
    ].join('\n');

    expect(
      matches(PIN, prose),
      'a pin named inside a comment must not count as a declared pin'
    ).toEqual([]);
    expect(
      matches(NAMED_MIRROR, prose),
      'a mirror named inside a comment must not count as a declared mirror'
    ).toEqual([]);

    // ...and the real thing at line start still counts, both ways, so the
    // anchoring did not simply break discovery.
    const real = [
      'export const QuuxNodeSchema = z.looseObject({ id: z.string() });',
      'export const QUUX_NODE_MIRROR_IS_EXACT: ExactKeys<keyof QuuxNode, keyof typeof QuuxNodeSchema.shape> = true;',
    ].join('\n');
    expect(matches(NAMED_MIRROR, real)).toEqual(['QuuxNodeSchema']);
    expect(matches(PIN, real)).toEqual(['QUUX_NODE_MIRROR_IS_EXACT']);
  });

  test('the phantom in _shared.ts is gone, and the real pins survive', () => {
    // The live instance, asserted against the file rather than a fixture, so
    // this fails if the anchoring is ever reverted while that doc block stands.
    //
    // Guards the gate on the OTHER half of that sentence: if the `Usage —`
    // block is ever reworded or moved, the phantom text disappears and the
    // assertion below starts passing for the wrong reason. Assert the subject
    // still exists — and still is not at line start, which is the only reason
    // anchoring excludes it.
    const sharedSource = readFileSync(join(QUERIES_DIR, '_shared.ts'), 'utf8');
    expect(
      sharedSource,
      'the Usage example this test is about has moved — re-point it or delete the test'
    ).toContain('export const FOO_NODE_MIRROR_IS_EXACT: ExactKeys<');
    expect(
      /^export const FOO_NODE_MIRROR_IS_EXACT/m.test(sharedSource),
      'the Usage example is now at column 0, so anchoring no longer excludes it'
    ).toBe(false);

    const shared = scans.find((s) => s.file === '_shared.ts');
    expect(shared, '_shared.ts is no longer in the queries dir').toBeDefined();
    expect(
      shared!.pins,
      'FOO_NODE_MIRROR_IS_EXACT comes from the Usage example in _shared.ts JSDoc, not from code'
    ).not.toContain('FOO_NODE_MIRROR_IS_EXACT');
    // Guards the gate: the file does declare real pins, so the assertion above
    // is not passing because discovery found nothing at all.
    expect(shared!.pins.length).toBeGreaterThan(0);
  });

  test('the name mapping is what the pins actually use', () => {
    expect(expectedPinName('SecurityNodeSchema')).toBe('SECURITY_NODE_MIRROR_IS_EXACT');
    expect(expectedPinName('InvestmentBalanceNodeSchema')).toBe(
      'INVESTMENT_BALANCE_NODE_MIRROR_IS_EXACT'
    );
  });

  test('no named mirror is missing its pin', () => {
    const missing: string[] = [];
    for (const { file, mirrors, pins } of scans) {
      for (const mirror of mirrors) {
        const expected = expectedPinName(mirror);
        if (!pins.includes(expected)) missing.push(`${file}: ${mirror} needs ${expected}`);
      }
    }
    expect(
      missing,
      `Named zod mirrors without a *_MIRROR_IS_EXACT pin in the same module:\n  ${missing.join('\n  ')}\n` +
        'Add one beside the mirror (see src/core/graphql/queries/_shared.ts for ExactKeys usage).'
    ).toEqual([]);
  });
});
