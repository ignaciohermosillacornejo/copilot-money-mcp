import { describe, test, expect } from 'bun:test';
import { parse } from 'graphql';

// Import the transform function. It must be exported for testability.
// (This task also requires making addTypenameToSelectionSets and extractQueryBlock
// named exports in scripts/generate-graphql-operations.ts.)
import {
  addTypenameToSelectionSets,
  extractQueryBlock,
} from '../../scripts/generate-graphql-operations.js';

describe('addTypenameToSelectionSets', () => {
  test('injects __typename into a flat selection set', () => {
    const input = `mutation M { editThing(id: "x") { id name } }`;
    const out = addTypenameToSelectionSets(input);
    const ast = parse(out);
    const queryField = (ast.definitions[0] as any).selectionSet.selections[0];
    const selectionNames = queryField.selectionSet.selections.map((s: any) => s.name.value);
    expect(selectionNames).toContain('__typename');
    expect(selectionNames).toContain('id');
    expect(selectionNames).toContain('name');
    // Exactly one __typename — no operation-root injection.
    expect((out.match(/__typename/g) ?? []).length).toBe(1);
  });

  test('injects __typename into nested selection sets', () => {
    const input = `mutation M { editThing(id: "x") { id nested { a b } } }`;
    const out = addTypenameToSelectionSets(input);
    // Should contain __typename twice: once for outer, once for nested.
    expect((out.match(/__typename/g) ?? []).length).toBe(2);
  });

  test('does not inject __typename at the operation root (matches Apollo documentTransform)', () => {
    const input = `mutation M { editThing(id: "x") { id } }`;
    const out = addTypenameToSelectionSets(input);
    const ast = parse(out);
    const op = ast.definitions[0] as any;
    const rootSelections = op.selectionSet.selections.map((s: any) => s.name.value);
    expect(rootSelections).not.toContain('__typename');
    // But the field's selection set should have __typename.
    const fieldSelections = op.selectionSet.selections[0].selectionSet.selections.map(
      (s: any) => s.name.value
    );
    expect(fieldSelections).toContain('__typename');
  });

  test('does not duplicate __typename if already present', () => {
    const input = `mutation M { editThing(id: "x") { __typename id } }`;
    const out = addTypenameToSelectionSets(input);
    expect((out.match(/__typename/g) ?? []).length).toBe(1);
  });

  test('preserves inline fragment selections', () => {
    const input = `mutation M { editThing(id: "x") { icon { ... on EmojiUnicode { unicode } } } }`;
    const out = addTypenameToSelectionSets(input);
    // __typename injected in: editThing's set, icon's set, and EmojiUnicode inline fragment's set.
    expect((out.match(/__typename/g) ?? []).length).toBe(3);
  });

  test('strips @client directives from selections', () => {
    const input = `mutation M { editThing(id: "x") { id datetime @client } }`;
    const out = addTypenameToSelectionSets(input);
    expect(out).not.toContain('@client');
    expect(out).not.toContain('datetime');
  });

  test('strips @client fields with nested selection sets', () => {
    const input = `mutation M { editThing(id: "x") { id category @client { name } } }`;
    const out = addTypenameToSelectionSets(input);
    expect(out).not.toContain('@client');
    expect(out).not.toContain('category');
  });

  test('still injects __typename after stripping @client fields', () => {
    // The @client field removal must not break __typename injection on sibling
    // object-typed selections. Here `nested` stays and should get __typename.
    const input = `mutation M { editThing(id: "x") { id datetime @client nested { a } } }`;
    const out = addTypenameToSelectionSets(input);
    expect(out).not.toContain('@client');
    expect(out).not.toContain('datetime');
    // __typename injected in: editThing's set + nested's set.
    expect((out.match(/__typename/g) ?? []).length).toBe(2);
  });
});

describe('extractQueryBlock', () => {
  test('extracts query from a standard capture markdown', () => {
    const md = [
      '# SomeOp',
      '',
      '## Query',
      '',
      '```graphql',
      'mutation SomeOp($id: ID!) {',
      '  doThing(id: $id)',
      '}',
      '```',
      '',
      '## Variables',
    ].join('\n');
    const out = extractQueryBlock(md, 'SomeOp');
    expect(out).toContain('mutation SomeOp($id: ID!)');
    expect(out).toContain('doThing(id: $id)');
    expect(out).not.toContain('```');
  });

  test('throws when no graphql block under ## Query', () => {
    expect(() => extractQueryBlock('# Foo\n\n## Variables\n', 'Foo')).toThrow(/no graphql block/);
  });
});
