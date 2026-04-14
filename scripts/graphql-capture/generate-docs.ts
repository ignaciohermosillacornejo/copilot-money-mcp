import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RawEntry } from './scrub';

export interface OperationGroup {
  kind: 'query' | 'mutation';
  entries: RawEntry[];
}

export interface VariableSchema {
  name: string;
  type: string;
  required: boolean;
  example: unknown;
}

interface ParsedBody {
  operationName?: string;
  query?: string;
  variables?: Record<string, unknown>;
}

function parseBody(entry: RawEntry): ParsedBody | null {
  if (!entry.requestBody) return null;
  try {
    return JSON.parse(entry.requestBody) as ParsedBody;
  } catch {
    return null;
  }
}

function detectKind(query: string | undefined): 'query' | 'mutation' {
  if (!query) return 'query';
  const trimmed = query.trimStart();
  return trimmed.startsWith('mutation') ? 'mutation' : 'query';
}

export function groupByOperation(entries: RawEntry[]): Map<string, OperationGroup> {
  const groups = new Map<string, OperationGroup>();
  for (const e of entries) {
    const body = parseBody(e);
    if (!body?.operationName) continue;
    const kind = detectKind(body.query);
    const existing = groups.get(body.operationName);
    if (existing) {
      existing.entries.push(e);
    } else {
      groups.set(body.operationName, { kind, entries: [e] });
    }
  }
  return groups;
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function inferVariableSchema(entries: RawEntry[]): VariableSchema[] {
  const seenInAll = new Map<string, { types: Set<string>; example: unknown; seenCount: number }>();
  for (const e of entries) {
    const body = parseBody(e);
    const vars = body?.variables ?? {};
    for (const [k, v] of Object.entries(vars)) {
      const entry = seenInAll.get(k) ?? { types: new Set(), example: v, seenCount: 0 };
      entry.types.add(jsType(v));
      entry.seenCount += 1;
      seenInAll.set(k, entry);
    }
  }
  const total = entries.length;
  return [...seenInAll.entries()].map(([name, info]) => ({
    name,
    type: [...info.types].join(' | '),
    required: info.seenCount === total,
    example: info.example,
  }));
}

export function renderOperationMarkdown(
  opName: string,
  kind: 'query' | 'mutation',
  entries: RawEntry[],
): string {
  const first = entries[0];
  const body = parseBody(first);
  const query = body?.query ?? '';
  const vars = inferVariableSchema(entries);
  const screens = '<fill in from flow docs>';
  const endpoint = first.url;

  const varTable = vars.length
    ? [
        '| Name | Type | Required | Example |',
        '|------|------|----------|---------|',
        ...vars.map((v) => `| ${v.name} | ${v.type} | ${v.required} | \`${JSON.stringify(v.example)}\` |`),
      ].join('\n')
    : '_(no variables)_';

  const exampleRequest = first.requestBody ?? '';
  const exampleResponse = JSON.stringify(first.response, null, 2);

  return [
    `# ${opName}`,
    '',
    `- **Type:** ${kind}`,
    `- **Endpoint:** ${endpoint}`,
    `- **Fires on:** ${screens}`,
    `- **Observations:** ${entries.length}`,
    '',
    '## Query',
    '',
    '```graphql',
    query,
    '```',
    '',
    '## Variables',
    '',
    varTable,
    '',
    '## Example request',
    '',
    '```json',
    exampleRequest,
    '```',
    '',
    '## Example response',
    '',
    '```json',
    exampleResponse,
    '```',
    '',
  ].join('\n');
}

export async function generateAll(scrubbedPath: string, outDir: string): Promise<void> {
  const text = await Bun.file(scrubbedPath).text();
  const entries: RawEntry[] = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const groups = groupByOperation(entries);

  const queriesDir = path.join(outDir, 'operations', 'queries');
  const mutationsDir = path.join(outDir, 'operations', 'mutations');
  const schemaDir = path.join(outDir, 'schema');
  await mkdir(queriesDir, { recursive: true });
  await mkdir(mutationsDir, { recursive: true });
  await mkdir(schemaDir, { recursive: true });

  const indexLines = ['# Operations Index', ''];
  for (const [opName, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dir = group.kind === 'mutation' ? mutationsDir : queriesDir;
    const file = path.join(dir, `${opName}.md`);
    await Bun.write(file, renderOperationMarkdown(opName, group.kind, group.entries));
    const rel = path.relative(outDir, file);
    indexLines.push(`- [${opName}](${rel}) — ${group.kind}, ${group.entries.length} observation(s)`);
  }
  await Bun.write(path.join(schemaDir, 'operations.md'), indexLines.join('\n') + '\n');
}

if (import.meta.main) {
  const [, , scrubbedPath, outDir] = process.argv;
  if (!scrubbedPath || !outDir) {
    console.error('usage: bun scripts/graphql-capture/generate-docs.ts <scrubbed.jsonl> <outDir>');
    process.exit(1);
  }
  await generateAll(scrubbedPath, outDir);
  console.log(`generated docs → ${outDir}`);
}
