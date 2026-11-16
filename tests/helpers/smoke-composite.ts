/**
 * Static views of the `bun run smoke` composite, shared by the tests that hold
 * its members to the scheduled runner's contract (#818, #819).
 */

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.join(import.meta.dir, '..', '..');

/**
 * The script files `bun run smoke` runs, in order, following `bun run smoke:x`
 * aliases. Paths are repo-relative (`scripts/smoke/<name>.ts`).
 */
export function compositeMembers(): string[] {
  const scripts = (
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  // `stack` is the current path, not every alias seen so far: an alias used by
  // two steps is fine, and only one that reaches itself is a cycle.
  const walk = (name: string, stack: readonly string[] = []): string[] => {
    if (stack.includes(name)) {
      throw new Error(`package.json script cycle: ${[...stack, name].join(' -> ')}`);
    }
    const body = scripts[name];
    if (body === undefined) throw new Error(`package.json has no script "${name}"`);
    return body.split('&&').flatMap((part) => {
      const m = /^bun run (\S+)$/.exec(part.trim());
      if (!m) throw new Error(`unrecognised composite step in "${name}": ${part.trim()}`);
      const target = m[1] as string;
      return target.startsWith('scripts/') ? [target] : walk(target, [...stack, name]);
    });
  };
  return walk('smoke');
}

/**
 * The opening text of every string literal a smoke script prints as a line,
 * normalised to what reaches the output.
 *
 * Two forms count: the first argument of `console.error`/`console.log`
 * (leading `\n` escapes dropped), and the first argument of the harness
 * `log()`, which prepends `[smoke] ` itself. A copy of a marker in a comment
 * or docblock is not an argument, so it does not count.
 *
 * Interpolations are kept verbatim, so a line whose verdict word comes from a
 * variable reads as `[smoke] ${status} …` — which the callers reject, because
 * nothing static can tell what it prints.
 */
export function printedLines(source: string): string[] {
  const out: string[] = [];
  const re = /(console\.(?:error|log)|(?<![.\w])log)\(\s*(['"`])((?:\\n)*)([^'"`]*)/g;
  for (const m of source.matchAll(re)) {
    const text = m[4] as string;
    out.push(m[1] === 'log' ? `[smoke] ${text}` : text);
  }
  return out;
}
