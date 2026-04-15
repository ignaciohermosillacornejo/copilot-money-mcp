/**
 * Generate src/core/graphql/operations.generated.ts from the captured
 * mutation docs in docs/graphql-capture/operations/mutations/.
 *
 * Parses each in-scope mutation's query string, injects __typename into
 * every selection set (matching Apollo's documentTransform behavior
 * required by Copilot's GraphQL server), and emits typed string constants.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse, print, visit, Kind } from 'graphql';

const IN_SCOPE_MUTATIONS = [
  'EditTransaction',
  'CreateCategory',
  'EditCategory',
  'DeleteCategory',
  'CreateTag',
  'EditTag',
  'DeleteTag',
  'CreateRecurring',
  'EditRecurring',
  'DeleteRecurring',
  'EditBudget',
  'EditBudgetMonthly',
  'EditAccount',
] as const;

const CAPTURE_DIR = 'docs/graphql-capture/operations/mutations';
const OUTPUT_PATH = 'src/core/graphql/operations.generated.ts';

function extractQueryBlock(markdown: string, mutationName: string): string {
  // Find the ```graphql fenced block under the ## Query heading.
  const match = markdown.match(/##\s*Query\s*\n+```graphql\s*\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`${mutationName}: no graphql block under ## Query`);
  }
  return match[1];
}

function addTypenameToSelectionSets(query: string): string {
  const ast = parse(query);
  const transformed = visit(ast, {
    SelectionSet(node) {
      const hasTypename = node.selections.some(
        (sel) => sel.kind === Kind.FIELD && sel.name.value === '__typename'
      );
      if (hasTypename) return undefined; // no change
      return {
        ...node,
        selections: [
          { kind: Kind.FIELD, name: { kind: Kind.NAME, value: '__typename' } },
          ...node.selections,
        ],
      };
    },
  });
  return print(transformed);
}

function constName(mutationName: string): string {
  // EditTransaction -> EDIT_TRANSACTION
  return mutationName.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase();
}

function main(): void {
  const lines: string[] = [
    '// AUTO-GENERATED — do not edit.',
    '// Regenerate with: bun run generate:graphql',
    '/* eslint-disable */',
    '',
  ];

  for (const name of IN_SCOPE_MUTATIONS) {
    const path = resolve(CAPTURE_DIR, `${name}.md`);
    const md = readFileSync(path, 'utf8');
    const rawQuery = extractQueryBlock(md, name);
    const transformed = addTypenameToSelectionSets(rawQuery);
    lines.push(`export const ${constName(name)} = ${JSON.stringify(transformed)};`);
    lines.push('');
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  console.log(`Wrote ${OUTPUT_PATH} with ${IN_SCOPE_MUTATIONS.length} operations`);
}

main();
