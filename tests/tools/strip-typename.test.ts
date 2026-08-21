import { describe, expect, test } from 'bun:test';
import { stripTypename } from '../../src/tools/strip-typename.js';

describe('stripTypename', () => {
  test('removes __typename at every depth without mutating the input', () => {
    const input = {
      __typename: 'Query',
      tags: [{ __typename: 'Tag', id: 't1', name: 'travel' }],
      category: { __typename: 'Category', icon: { __typename: 'EmojiUnicode', unicode: '☕' } },
    };
    const out = stripTypename(input);
    expect(out).toEqual({
      tags: [{ id: 't1', name: 'travel' }],
      category: { icon: { unicode: '☕' } },
    });
    expect(input.tags[0].__typename).toBe('Tag'); // input untouched
  });

  test('passes through primitives, null, and empty arrays unchanged', () => {
    expect(stripTypename(null)).toBeNull();
    expect(stripTypename(5)).toBe(5);
    expect(stripTypename([])).toEqual([]);
  });

  test('does not copy a hostile __proto__ key', () => {
    // JSON.parse creates __proto__ as an OWN key; a naive `out[key] = value`
    // copy would assign through the inherited setter and repoint `out`'s own
    // prototype instead of copying data (same guard, and same regression
    // shape, as projectRows — see field-selection.test.ts).
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "id": "a"}');
    const out = stripTypename(hostile) as Record<string, unknown>;
    // Property access (not Object.keys) so an inherited `polluted` from a
    // repointed prototype is caught via the lookup chain.
    expect(out.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.id).toBe('a');
  });
});
