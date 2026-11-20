import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Narrowing accessors for a `handleCallTool` result. `content[0].text` does
 * not typecheck — `content` is a union of text, image, audio and resource
 * blocks, and only the text block has `.text` — so reading it directly yields
 * an error-typed value that every type-aware lint rule treats as `any` (#919).
 */

/** The first content block's text, or '' when there is no text block. */
export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

/** The first content block's text, asserting it IS a text block. */
export function firstText(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Expected first content block to be text, got: ${first?.type ?? 'none'}`);
  }
  return first.text;
}

/**
 * The first text block parsed as JSON, typed as the shape the caller reads.
 * The type parameter is a declaration, not a check: it names every field the
 * test goes on to read, so an undeclared one fails to compile rather than
 * flowing on as `any`.
 */
export function parseToolJson<T = Record<string, unknown>>(result: CallToolResult): T {
  return JSON.parse(firstText(result)) as T;
}
