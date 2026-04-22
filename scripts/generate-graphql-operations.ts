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
  'CreateTransaction',
  'EditTransaction',
  'DeleteTransaction',
  'AddTransactionToRecurring',
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

export function extractQueryBlock(markdown: string, mutationName: string): string {
  // Find the ```graphql fenced block under the ## Query heading.
  const match = markdown.match(/##\s*Query\s*\n+```graphql\s*\n([\s\S]*?)\n```/);
  if (!match) {
    throw new Error(`${mutationName}: no graphql block under ## Query`);
  }
  return match[1];
}

export function addTypenameToSelectionSets(query: string): string {
  // Pass 1: strip Field selections carrying the `@client` directive. Apollo's
  // documentTransform normally removes these client-only fields (local resolvers
  // for fields that don't exist in the server schema) before the wire send, so
  // forwarding them unstripped would cause the server to reject the query.
  let ast = parse(query);
  ast = visit(ast, {
    Field(node) {
      if (node.directives?.some((d) => d.name.value === 'client')) {
        return null; // removes this field from the AST
      }
      return undefined;
    },
  });

  // Pass 2: inject __typename into every non-root selection set (matches
  // Apollo's documentTransform behavior required by Copilot's GraphQL server).
  let transformed = visit(ast, {
    SelectionSet(node, _key, parent) {
      // Skip the operation-level selection set (directly under OperationDefinition).
      // __typename is only meaningful on concrete object type selection sets (fields).
      if (parent && !Array.isArray(parent) && parent.kind === Kind.OPERATION_DEFINITION) {
        return undefined; // no change
      }
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

  // Pass 3: remove orphan fragment definitions. After stripping `@client`
  // fields, fragments that were only referenced inside those fields become
  // dangling. The server enforces the spec rule "all defined fragments must be
  // used" — Apollo's browser transform drops these automatically; we do the
  // same here. Iterate until stable, since removing one fragment may make
  // another (that it referenced) unused in turn.
  let changed = true;
  while (changed) {
    changed = false;
    const referenced = new Set<string>();
    visit(transformed, {
      FragmentSpread(node) {
        referenced.add(node.name.value);
      },
    });
    transformed = visit(transformed, {
      FragmentDefinition(node) {
        if (!referenced.has(node.name.value)) {
          changed = true;
          return null; // drop
        }
        return undefined;
      },
    });
  }

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

if (import.meta.main) {
  main();
}
