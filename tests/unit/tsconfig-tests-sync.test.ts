/**
 * Typecheck-gate sync: every test file that calls createMockGraphQLClient
 * must be listed in tsconfig.tests.json's include list, or its mock shapes
 * are not typechecked and the #433 gate silently doesn't apply to it.
 *
 * Same pattern as tests/unit/doc-sync.test.ts: the registration that a
 * human must remember (the include list) is asserted against the ground
 * truth derived from the tree (which files actually use the typed mock).
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import ts from 'typescript';

import { scriptKindFor, tsFilesUnder } from '../helpers/ts-files.js';

const repoRoot = join(import.meta.dir, '../..');

// Sorted for the same reason the pairing walk below is: `readdirSync` order is
// the filesystem's, it differs between a dev machine and CI, and both walks
// feed a `missing.join('\n  ')` failure message that gets read by diffing it
// against the one someone else saw.
function walk(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(rel);
      return rel.endsWith('.test.ts') ? [rel] : [];
    });
}

// tsconfig.tests.json is JSONC, so `JSON.parse` cannot read it directly.
// `ts.parseConfigFileTextToJson` is the compiler's own reader for exactly this
// file format — it is what `tsc -p` uses — so comments are handled by the
// thing that defines what a comment is in a tsconfig.
//
// This was a hand-rolled line-comment stripper, the fourth copy of the class
// #691 closed. It was the least wrong of the four (it required the marker to
// sit at line start or after whitespace, so `"https://x"` survived), but the
// guard was a heuristic about spacing, not about strings: a path value holding
// ` //` anywhere would still have been truncated, silently shortening the
// include list this test compares against. See
// tests/no-hand-rolled-comment-strippers.test.ts.
function readJsonc(path: string): { include: string[] } {
  const raw = readFileSync(join(repoRoot, path), 'utf-8');
  const parsed = ts.parseConfigFileTextToJson(path, raw);
  if (parsed.error !== undefined) {
    throw new Error(
      `${path} is not valid JSONC: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`
    );
  }
  return parsed.config as { include: string[] };
}

/**
 * One parse, read by both rules below. Written twice, they were two
 * derivations of one fact in one file — the shape `PINNED_TREES` in
 * tests/docs/jsdoc-stranding.test.ts exists to avoid.
 */
const included = new Set(readJsonc('tsconfig.tests.json').include);

describe('tsconfig.tests.json stays in sync with typed-mock adoption', () => {
  // Adoption = importing the typed-mock helper module (merely naming the
  // function in prose is not adoption). The needle is split so this file's
  // own source doesn't match it.
  const needle = 'helpers/' + 'mock-graphql';
  const adopters = walk('tests').filter((file) =>
    readFileSync(join(repoRoot, file), 'utf-8').includes(needle)
  );

  test('the walker finds the known adopters (sanity floor)', () => {
    expect(adopters.length).toBeGreaterThanOrEqual(5);
  });

  test('every test file using createMockGraphQLClient is typechecked', () => {
    const missing = adopters
      .map((file) => relative(repoRoot, join(repoRoot, file)))
      .filter((file) => !included.has(file));
    expect(
      missing,
      `These files call createMockGraphQLClient but are not in tsconfig.tests.json's ` +
        `include list, so their mock shapes are NOT typechecked — add them:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The class behind #737, which was fixed one file at a time.
 *
 * `tests/helpers/ts-files.test.ts` sat outside every program in
 * `bun run check` — the base config excludes `tests/`, eslint reads `src/`
 * only, and it was not on the include list — so nothing read a line of it.
 * Its subject module WAS on the list. A helper judged worth typechecking whose
 * own contract test is not typechecked is the shape: the assertions that say
 * what the helper promises are the half nothing checks.
 *
 * Deliberately narrow, so it holds today rather than fighting the ~87
 * pre-existing errors the tsconfig header describes: it speaks only about
 * `tests/helpers/<name>.test.ts` next to a `tests/helpers/<name>.ts` it
 * actually imports, and only when the SUBJECT is already on the list. It says
 * nothing about the two scanners, which are off the list on purpose.
 */
describe('a typechecked helper brings its own contract test onto the list', () => {
  const HELPERS = 'tests/helpers';

  // Pairing is by name AND by import: `<name>.test.ts` beside `<name>.ts`,
  // where the test really imports the sibling. Name alone would pair a file
  // that merely shares a prefix.
  const pairs = readdirSync(join(repoRoot, HELPERS))
    .sort()
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({
      test: join(HELPERS, name),
      subject: join(HELPERS, name.replace(/\.test\.ts$/, '.ts')),
      specifier: `./${name.replace(/\.test\.ts$/, '')}.js`,
    }))
    .filter(
      ({ test, subject, specifier }) =>
        existsSync(join(repoRoot, subject)) &&
        readFileSync(join(repoRoot, test), 'utf-8').includes(specifier)
    );

  // The rule turns on this filter, not on `pairs`, so this is what has to be
  // non-vacuous.
  const typechecked = pairs.filter(({ subject }) => included.has(subject));

  test('the pairing walk finds the known helper contract tests (sanity floor)', () => {
    // A rule that paired nothing would pass the assertion below for the wrong
    // reason — the same non-vacuity argument the adopter floor above makes.
    const names = pairs.map((p) => p.test);
    expect(names).toContain(join(HELPERS, 'strip-comments.test.ts'));
    expect(names).toContain(join(HELPERS, 'ts-files.test.ts'));

    // ...and `pairs` being full is not enough, because `included` holds the
    // include list's LITERAL strings. The header of tsconfig.tests.json calls
    // expanding to `tests/**/*` tracked follow-up work; on that day every
    // `included.has(...)` goes false, the rule below checks nothing, and the
    // walk floor above stays green while it does. So floor the filter too.
    expect(
      typechecked.length,
      'No helper module paired with a contract test is on the include list, so the rule ' +
        'below is vacuous. (A glob include list would do that; the premise test below ' +
        'catches that case by name.)'
    ).toBeGreaterThanOrEqual(2);
  });

  test("a typechecked helper's contract test is typechecked too", () => {
    const missing = typechecked.map(({ test }) => test).filter((test) => !included.has(test));
    expect(
      missing,
      `These helper modules are on tsconfig.tests.json's include list but their own ` +
        `contract tests are not, so nothing in \`bun run check\` reads the assertions that ` +
        `say what the helper promises (#737) — add them:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The header's "who imports what" map, derived from the tree instead of read.
 *
 * tsconfig.tests.json enumerates the importers of the two #691 scanning
 * helpers, because a curated include list invites being read as a dependency
 * map and is not one. That enumeration was prose: nothing read it, and it
 * drifted twice inside the single PR whose subject was ratcheting exactly this
 * class of unchecked prose (#764).
 *
 * The map is PARSED out of the header rather than restated here. A copy in
 * this file would be the same defect one file over — the shape already
 * rejected in this repo once, when a header block added to delete a second
 * copy WAS a second copy.
 *
 * What is pinned below is which helpers must HAVE an entry, which is a
 * requirement rather than a second derivation of the same fact: without it,
 * deleting the enumeration is a passing remedy.
 */
const LINE_COMMENT = '//';

/** Separates a map entry's subject from its importer list. */
const IMPORTS_ARROW = ' <- ';

/** Where an importer may live. `scripts/` is swept too: it must not import
 *  from `tests/`, and a scan that never looks cannot say so. */
const IMPORTER_DIRS = ['tests', 'scripts'];

/**
 * The helpers the header must map. Not the whole include list and not every
 * `tests/helpers/` module: `mock-graphql.ts` is deliberately absent, because
 * the adoption rule at the top of this file already derives its importers and
 * a second mechanism over one fact is the thing this file keeps deleting.
 */
const MAPPED_HELPERS = ['tests/helpers/strip-comments.ts', 'tests/helpers/ts-files.ts'];

/**
 * The text of every `//` line in a file, marker removed.
 *
 * Assembled from a string constant and `startsWith`, not a regex: a regex
 * literal that recognises a whole comment is what
 * tests/no-hand-rolled-comment-strippers.test.ts flags, and rightly — though
 * the hazard that gate names does not apply here, since this reads comments
 * rather than removing them and a value mis-read as a comment can only add a
 * phantom entry, which the rule below reports rather than swallows.
 */
function commentBodies(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(LINE_COMMENT))
    .map((line) => line.slice(LINE_COMMENT.length).trim());
}

/**
 * `<subject> <- a, b, c` across as many comment lines as the list needs, where
 * a TRAILING COMMA is what says "continued below". Self-terminating, so the
 * prose after the map is not absorbed into it — and if someone drops the
 * comma discipline mid-list, the prose becomes phantom importers and the rule
 * below says so, rather than the parse silently shortening the list.
 */
function parseImporterMap(raw: string): Map<string, string[]> {
  const bodies = commentBodies(raw);
  const map = new Map<string, string[]>();
  for (let i = 0; i < bodies.length; i += 1) {
    const line = bodies[i];
    const arrow = line.indexOf(IMPORTS_ARROW);
    if (arrow === -1) continue;
    const subject = line.slice(0, arrow).trim();
    if (!subject.endsWith('.ts') || subject.includes(' ')) continue;
    let listed = line.slice(arrow + IMPORTS_ARROW.length).trim();
    while (listed.endsWith(',') && i + 1 < bodies.length) {
      i += 1;
      listed = `${listed} ${bodies[i]}`;
    }
    map.set(
      subject,
      listed
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .sort()
    );
  }
  return map;
}

/**
 * Every module specifier a file imports, from the PARSER rather than a text
 * search: a specifier named in a docblock is not an import, and five of the
 * files in play name these helpers in prose.
 */
function moduleSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    const fromDeclaration =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    if (fromDeclaration !== undefined && ts.isStringLiteral(fromDeclaration)) {
      specifiers.push(fromDeclaration.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteral(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Repo-relative importers of each subject, sorted, self-imports excluded. */
function realImporters(subjects: string[]): Map<string, string[]> {
  const bySubjectPath = new Map(subjects.map((subject) => [join(repoRoot, subject), subject]));
  const found = new Map(subjects.map((subject) => [subject, [] as string[]]));
  // An import of `<dir>/<name>.ts` necessarily spells `<name>` in its
  // specifier, so a file whose text holds no subject's basename cannot import
  // one. Parsing the rest of two trees to learn that is work every
  // `bun run check` would pay for nothing.
  const needles = subjects.map((subject) => basename(subject, '.ts'));
  for (const dir of IMPORTER_DIRS) {
    for (const file of tsFilesUnder(join(repoRoot, dir))) {
      const text = readFileSync(file, 'utf-8');
      if (!needles.some((needle) => text.includes(needle))) continue;
      const rel = relative(repoRoot, file);
      for (const specifier of moduleSpecifiers(file, text)) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        // Written `./x.js` throughout this repo, but an extensionless
        // specifier resolves to the same module and must not read as "nobody
        // imports it".
        const candidates = [
          target,
          target.endsWith('.js') ? `${target.slice(0, -'.js'.length)}.ts` : `${target}.ts`,
        ];
        for (const candidate of candidates) {
          const subject = bySubjectPath.get(candidate);
          if (subject === undefined || subject === rel) continue;
          const importers = found.get(subject);
          if (importers !== undefined && !importers.includes(rel)) importers.push(rel);
        }
      }
    }
  }
  for (const importers of found.values()) importers.sort();
  return found;
}

describe("the header's importer map says who really imports the #691 helpers", () => {
  const declared = parseImporterMap(readFileSync(join(repoRoot, 'tsconfig.tests.json'), 'utf-8'));
  const actual = realImporters(MAPPED_HELPERS);

  test('the header still carries an entry for each mapped helper', () => {
    // The cheapest way to turn the rule below green is to DELETE the
    // enumeration: `declared` empties, every comparison iterates nothing, and
    // the map this gate exists to keep honest is simply gone. So the entries
    // are required to exist before their contents are compared.
    expect(
      [...declared.keys()].sort(),
      `tsconfig.tests.json's header must carry a parseable "<helper> <- <importer>, ..." ` +
        `entry for each of these, continued across comment lines by a trailing comma. ` +
        `Deleting or reshaping the map does not satisfy the importer rule below — the map ` +
        `is what that rule checks:\n  ${MAPPED_HELPERS.join('\n  ')}`
    ).toEqual([...MAPPED_HELPERS].sort());

    // A rename should report itself here rather than as a scan that suddenly
    // finds no importers of a path that no longer exists.
    const offList = MAPPED_HELPERS.filter((helper) => !included.has(helper));
    expect(
      offList,
      `Mapped above but no longer on tsconfig.tests.json's include list — renamed, or ` +
        `dropped? Update MAPPED_HELPERS and the header map together:\n  ${offList.join('\n  ')}`
    ).toEqual([]);
  });

  test('the scan finds real importers for each mapped helper (sanity floor)', () => {
    // If specifier resolution broke, every real set would be empty and the
    // rule below would demand an empty map — loud, but blaming the header for
    // a bug in this file. This says which end is broken.
    const barren = MAPPED_HELPERS.filter((helper) => (actual.get(helper) ?? []).length === 0);
    expect(
      barren,
      `The import scan over ${IMPORTER_DIRS.map((dir) => `${dir}/`).join(' and ')} found NO ` +
        `importer of these, which is not a fact about the tree — both are imported. ` +
        `Specifier resolution here is broken, so the comparison below measures ` +
        `nothing:\n  ${barren.join('\n  ')}`
    ).toEqual([]);
  });

  test('each entry lists exactly the files that really import it', () => {
    const drift = MAPPED_HELPERS.flatMap((helper) => {
      const listed = declared.get(helper) ?? [];
      const real = actual.get(helper) ?? [];
      const unlisted = real.filter((file) => !listed.includes(file));
      const phantom = listed.filter((file) => !real.includes(file));
      if (unlisted.length === 0 && phantom.length === 0) return [];
      return [
        `${helper}\n    import it, unlisted: ${unlisted.join(', ') || '(none)'}` +
          `\n    listed, but do not import it: ${phantom.join(', ') || '(none)'}`,
      ];
    });
    expect(
      drift,
      `tsconfig.tests.json's header enumerates who imports each #691 scanning helper, and ` +
        `the enumeration no longer matches the tree. Readers use it to decide how far a ` +
        `change to one of these helpers reaches, and it drifted twice as unread prose ` +
        `before this rule existed — fix the header, not this test:\n  ${drift.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The entries whose MEMBERSHIP IS THE COVERAGE — nothing imports them, so
 * `tsc` cannot follow anything in, and deleting a line deletes the checking
 * rather than relocating it.
 *
 * The criterion, applied to all of tsconfig.tests.json's entries: not reached
 * by an import from anything (so `tsc` cannot pull it in), and not a
 * mock-GraphQL adopter (so the adoption rule above does not already cover it).
 * Every entry meeting it belongs here EXCEPT the tests/helpers/ contract
 * tests, which the helper-pairing rule above already holds — deliberately not
 * repeated, so each file is ratcheted once and by the rule that explains it.
 * The auth files are the sharpest case: the block heading their run in
 * tsconfig.tests.json justifies their membership with the exact #725 story
 * this pin exists to prevent a repeat of. (That reason sat in the file's
 * HEADER until #766 moved it onto the run — a second copy that had already
 * drifted, naming two of its three subjects.)
 *
 * Hand-maintained, like the header prose it mirrors. Deriving it would need a
 * real import graph rather than a grep; the two lists cross-reference each
 * other instead, so drifting apart is the intended failure direction — a file
 * genuinely leaving the include list should require editing both.
 *
 * One literal read by the assertion, the `PINNED_TREES` shape from
 * tests/docs/jsdoc-stranding.test.ts.
 */
const MEMBERSHIP_IS_THE_COVERAGE = [
  'tests/core/auth/browser-token.test.ts',
  'tests/core/auth/candidate-ordering.test.ts',
  'tests/core/auth/firebase-auth.test.ts',
  'tests/core/temp-db-suite-teardown.test.ts',
  'tests/exported-constants.test.ts',
  'tests/fixtures/temp-db-leak-probe.ts',
  'tests/integration/uid-transition-sweep.test.ts',
  'tests/no-collection-time-assertions.test.ts',
  'tests/no-hand-rolled-comment-strippers.test.ts',
  'tests/scripts/no-duplicate-schema-walks.test.ts',
  'tests/scripts/check-tracked-files.test.ts',
  'tests/scripts/mutation-guards.test.ts',
  'tests/setup/temp-db-teardown.ts',
  'tests/unit/live-auth-boot-nonfatal.test.ts',
  'tests/unit/tsconfig-tests-sync.test.ts',
];

/**
 * Membership neither rule above can reach — the helper-pairing one is scoped
 * to `tests/helpers/` on purpose, and none of these are there. Its own
 * `describe` rather than filed under a header about helper contract tests: a
 * failure should not print a title contradicting the test under it.
 */
describe('the entries whose membership is the coverage stay on the include list', () => {
  test('the pin names this file (keyed off the file, not a literal)', () => {
    // The self entry is pinned by identity rather than by spelling, so
    // renaming this file reports the rename here instead of surfacing as a
    // membership failure pointing at a path that no longer exists.
    expect(MEMBERSHIP_IS_THE_COVERAGE).toContain(relative(repoRoot, import.meta.path));
  });

  test('each of them is still there', () => {
    // Not vacuous, and not circular: `bun test` collects this file from the
    // filesystem regardless of any tsconfig, so removing an entry leaves this
    // assertion running and red.
    const gone = MEMBERSHIP_IS_THE_COVERAGE.filter((file) => !included.has(file));
    // A renamed file should say so rather than read as a deleted entry.
    const missingFromDisk = MEMBERSHIP_IS_THE_COVERAGE.filter(
      (file) => !existsSync(join(repoRoot, file))
    );
    expect(
      missingFromDisk,
      `Pinned above but not on disk — renamed or deleted? Update the pin and the ` +
        `tsconfig header together:\n  ${missingFromDisk.join('\n  ')}`
    ).toEqual([]);
    expect(
      gone,
      `These are on tsconfig.tests.json's include list because NOTHING IMPORTS THEM — no ` +
        `program reaches them any other way, so dropping a line drops the type checking ` +
        `entirely rather than moving it (#725, #737). Removed on purpose? Edit the pin ` +
        `above and the tsconfig header too.\n  ${gone.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The premise the include-list rules rest on — the four above and the negative
 * one below — asserted once instead of repeated as a caveat in each of their
 * failure messages.
 *
 * Each of them compares LITERAL paths against the include list, and the
 * tsconfig header calls expanding to `tests/**` tracked follow-up work. On
 * that day they break in three different ways, which is the reason this is one
 * test rather than three caveats:
 *
 *   - the adoption rule, the pairing FLOOR and the membership pin go red —
 *     loudly, but naming a cause that has nothing to do with what broke;
 *   - the pairing RULE goes vacuously green: `typechecked` is empty, so
 *     `missing` is `[]`. Its floor is what catches that, and is why the floor
 *     was put on the filtered list rather than the walk;
 *   - the negative membership rule goes green and NOTHING catches it —
 *     `has()` is false whether the file is genuinely absent or merely spelled
 *     by a glob.
 *
 * Only the last is silent end to end. The others are legible once you know to
 * look here, which is what this test is for.
 */
describe('the rules in this file assume literal include paths', () => {
  test('every include entry is a literal path to a file', () => {
    // Not just "contains no `*` or `?`". A tsconfig include entry that is a
    // bare DIRECTORY is tsc's own shorthand for recursive inclusion —
    // `"include": ["tests"]` means `tests/**/*` — and carries no wildcard
    // character at all. A glob-only check passes it while every rule here
    // compares file paths against a Set holding the single string `tests`,
    // which is the fail-open this test exists to prevent, reached by the
    // spelling the tracked follow-up is most likely to use.
    //
    // So assert the property the rules actually need: each entry names an
    // existing FILE. Non-vacuous by fact rather than by construction — every
    // entry today is one.
    const notLiteralFiles = [...included].filter((entry) => {
      if (/[*?]/.test(entry)) return true;
      const abs = join(repoRoot, entry);
      return !existsSync(abs) || !statSync(abs).isFile();
    });
    expect(
      notLiteralFiles,
      `tsconfig.tests.json's include list no longer names individual files — these entries ` +
        `are globs, directories (tsc reads a bare directory as \`<dir>/**/*\`), or missing. ` +
        `Every rule in this file compares literal file paths against that list, so they ` +
        `must resolve patterns before their verdicts mean anything:\n  ` +
        `${notLiteralFiles.join('\n  ')}`
    ).toEqual([]);
  });
});

/**
 * The negative of MEMBERSHIP_IS_THE_COVERAGE, in its own `describe` because
 * this one is about a file staying OFF the list — filed under the positive
 * rule's title, a failure would print a header contradicting the test.
 *
 * tests/tools/live/known-fields-wire-parity.test.ts places its MIRROR_IS_EXACT
 * pins in src/ rather than in itself, justified by "THIS FILE IS NOT
 * TYPECHECKED, so a type-level pin here would compile-check nothing". Adding it
 * to the include list would leave those pins in src/ resting on a premise that
 * had stopped holding, with nothing saying so. Its own comment called that
 * claim "checkable" — a property, not a promise, until something checks it.
 */
describe('a file whose argument rests on being absent stays absent', () => {
  test('known-fields-wire-parity is still outside every program', () => {
    // Meaningful only because the literal-paths premise above is asserted:
    // under a glob include list this would pass while the file was in fact
    // typechecked.
    const absent = 'tests/tools/live/known-fields-wire-parity.test.ts';
    expect(
      included.has(absent),
      `${absent} is now typechecked, which invalidates the reason its MIRROR_IS_EXACT pins ` +
        `live in src/ instead of in it. Either move those pins into it and delete this ` +
        `assertion, or take it back off the include list.`
    ).toBe(false);
  });
});
