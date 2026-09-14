/**
 * The contract of tests/helpers/strip-comments.ts, pinned directly.
 *
 * Every property here is one that a source-scanning guard elsewhere in this
 * repo depends on, and each was broken by the hand-rolled stripper this helper
 * replaced (#691). They are pinned here rather than left to the scanners
 * because the scanners only exercise the shapes their own input happens to
 * contain: the decoder's field lists hold no URLs, so a stripper that mangles
 * one passes every test in tests/core/decoder-field-completeness.test.ts. A
 * guard whose coverage is an accident of its input is the bug class this whole
 * corner of the suite exists for.
 */

import { describe, expect, test } from 'bun:test';
import { stripComments } from './strip-comments.js';

describe('stripComments is parser-owned, not pattern-matched', () => {
  test('removes the comments it is for (non-vacuity)', () => {
    const source = ['/* a block */', 'const a = 1; // a line', '/** a doc */'].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).not.toContain('a block');
    expect(stripped).not.toContain('a line');
    expect(stripped).not.toContain('a doc');
  });

  test('a comment marker inside a string literal is content, not syntax', () => {
    // The live shape: `export const U = ['https://x'] as const` did not survive
    // the old stripper, because the URL's slashes read as a line comment and
    // took the rest of the declaration — `] as const` included — with them.
    const source = "const url = 'https://example.invalid/a'; const after = 1;";
    expect(stripComments(source)).toBe(source);
  });

  test('a block-comment opener inside a string literal opens nothing', () => {
    const source = "const s = 'a /* b'; const after = 2;";
    expect(stripComments(source)).toBe(source);
  });

  test('a block-comment opener inside a LINE comment opens nothing', () => {
    // The old stripper ran its block pass FIRST, so an opener sitting inside a
    // line comment let that pass run forward to the next closer and delete
    // every declaration in between.
    const source = [
      '// mentions an opener: /*',
      'const kept = 1;',
      '/* a real block */',
      'const alsoKept = 2;',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('const kept = 1;');
    expect(stripped).toContain('const alsoKept = 2;');
    expect(stripped).not.toContain('a real block');
  });

  test('a template literal keeps its content on both sides of a substitution', () => {
    // Why this is parser-owned rather than scanner-owned: a raw token scanner
    // does not re-scan the tail of a template after `${...}`, so it reads the
    // rest of the template as code and blanks anything comment-shaped inside
    // it while missing a real comment after it.
    const source = 'const q = `a // b ${x} /* c */`;\nconst after = 3; // gone';
    const stripped = stripComments(source);
    expect(stripped).toContain('`a // b ${x} /* c */`');
    expect(stripped).not.toContain('gone');
  });

  test('a regex literal containing slashes is not a comment', () => {
    const source = 'const r = /a\\/\\/b/; const after = 4;';
    expect(stripComments(source)).toBe(source);
  });

  test('an unterminated block comment is blanked to the end of the text', () => {
    // Callers that slice a character window strip the SLICE, so a window whose
    // end lands inside a block comment has no closer. The compiler treats such
    // a comment as running to EOF and so does this; tests/core/dedup-identity
    // bought the same property with a third regex pass before #691.
    const source = 'const a = 1;\n/** a doc comment cut in half by a window\n  const decoy = 2;';
    const stripped = stripComments(source);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).not.toContain('decoy');
  });

  test('offsets are preserved: same length, same line count', () => {
    // tests/core/decoder-field-completeness.test.ts strips once and then walks
    // the stripped text with index arithmetic that used to run on raw source.
    // That swap is only safe because stripping does not move anything.
    const source = [
      '/* a block comment */',
      'function f() {',
      '  const x = 1; // trailing',
      '  /** doc',
      '   * more',
      '   */',
      '  return x;',
      '}',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped.length).toBe(source.length);
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped.indexOf('return x;')).toBe(source.indexOf('return x;'));
  });
});

describe('stripComments parses under the ScriptKind its file name implies', () => {
  // The "ScriptKind follows the extension" invariant the two scanners hold used
  // to stop at this helper, which hardcoded ScriptKind.TS. This snippet is the
  // demonstration that the name is load-bearing rather than decorative: parsed
  // as TSX it is a JSX element followed by a line comment, parsed as TS it is
  // not, and the trailing comment survives the TS parse untouched.
  const jsx = 'const el = <div className="a">{/* note */}</div>; // tail\nconst after = 1;';

  test('a .tsx name is honoured, and its comments are stripped', () => {
    const stripped = stripComments(jsx, 'widget.tsx');
    expect(stripped).not.toContain('note');
    expect(stripped).not.toContain('tail');
    expect(stripped).toContain('const after = 1;');
  });

  test('the same text under a .ts name does NOT see the trailing comment', () => {
    // Not a defect — it is the point. A helper that cannot be told its input's
    // extension hands this result back as a comment map, which is the misparse
    // the `fileName` parameter exists to let a caller avoid.
    expect(stripComments(jsx, 'widget.ts')).toContain('// tail');
  });

  test('the default is the non-JSX .ts behaviour, so existing callers are unchanged', () => {
    expect(stripComments(jsx)).toBe(stripComments(jsx, 'widget.ts'));
  });
});
