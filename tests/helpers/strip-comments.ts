/**
 * Remove TypeScript comments from source text using the TypeScript parser,
 * leaving string literals, template literals and regex literals intact.
 *
 * WHY THIS EXISTS
 *
 * Three test files scanned source with a hand-rolled stripper: one regex that
 * deleted from a block-comment opener to the next closer, then a second that
 * deleted from a line-comment marker to end of line.
 *
 * A pair of regexes does not know what a string literal is, so:
 *
 *   - a line-comment marker inside a URL literal reads as a comment and deletes
 *     the rest of that line, including the `] as const` that ends a
 *     declaration (#691)
 *   - a block-comment opener inside a LINE comment lets the block pass run
 *     forward to the next closer and delete every declaration in between,
 *     because block comments were stripped before line comments (#691)
 *
 * Both failures are SILENT in the direction that matters: the scan sees less
 * source, finds fewer declarations, and a discovery scan that under-collects is
 * indistinguishable from one that found everything.
 *
 * WHAT THIS GUARANTEES
 *
 *   - Comment ranges come from the parser, so string/template/regex contents
 *     are never mistaken for comment syntax.
 *   - An unterminated block comment (a window sliced mid-comment) is blanked to
 *     the end of the text, which is what the compiler does with it too. Callers
 *     that scan character windows therefore need no extra pass of their own.
 *   - The input is parsed under the `ScriptKind` its FILE NAME implies, so a
 *     caller scanning a `.tsx` must pass its name (see the `fileName`
 *     parameter). The default assumes non-JSX `.ts`.
 *   - OFFSETS ARE PRESERVED. Comment characters are replaced by spaces rather
 *     than deleted, and line breaks inside a comment are kept, so the returned
 *     string has the same length and the same line/column map as the input.
 *     Callers may mix stripped and raw offsets freely, and a bracket-counting
 *     walk can run on the stripped text while reporting positions into the raw
 *     one.
 *
 * SHARED, not duplicated per call site. The three copies were duplicated on
 * purpose, so that one file's PARSING RULES could not be changed out from under
 * another. That reason dies here: there are no local parsing rules left to
 * drift — the rule is "whatever the TypeScript parser calls a comment". What
 * replaced it is a shared correctness property, and three copies of a correct
 * lexer is only three places to fix the next time it is wrong.
 *
 * `scripts/check-privacy-endpoints.ts` keeps its own copy of this same routine
 * (it is where this pattern started). Deliberate: `scripts/` is a separate
 * tsconfig project that must not import from `tests/`.
 */

import ts from 'typescript';

import { scriptKindFor } from './ts-files.js';

/**
 * `fileName` exists only to pick the `ScriptKind`, and it is where the
 * "ScriptKind follows the extension" invariant the two scanners now hold would
 * otherwise stop: parsing a `.tsx` as `.ts` misreads `<T>(x) => x` as JSX, and
 * a helper that cannot be told its input's extension would hand that misparse
 * back as a comment map. The default keeps every existing caller unchanged —
 * both of them slice `src/core/decoder.ts`, which is `.ts`.
 */
export function stripComments(src: string, fileName = 'strip-comments-input.ts'): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName)
  );

  const comments = new Map<string, ts.CommentRange>();
  const collect = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) comments.set(`${range.pos}:${range.end}`, range);
  };

  const nodes: ts.Node[] = [sourceFile];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) continue;
    collect(ts.getLeadingCommentRanges(src, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(src, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) nodes.push(child);
  }

  const out: string[] = [];
  let cursor = 0;
  const ranges = [...comments.values()].sort((a, b) => a.pos - b.pos || a.end - b.end);
  for (const range of ranges) {
    if (range.pos < cursor) continue;
    out.push(src.slice(cursor, range.pos));
    // Blank rather than delete, and keep the line breaks: same length in, same
    // length out, so every offset a caller already holds stays valid. U+2028 /
    // U+2029 are in the class because TypeScript counts them as line
    // terminators too — blanking them would leave the OFFSET map exact (all
    // that callers actually use) while quietly shifting the LINE map, and the
    // header above claims both.
    out.push(src.slice(range.pos, range.end).replace(/[^\r\n\u2028\u2029]/g, ' '));
    cursor = range.end;
  }
  out.push(src.slice(cursor));
  return out.join('');
}
