import type { RawEntry } from './scrub';

interface QueryManagerEntry {
  id: string;
  operationName: string;
  variables: Record<string, unknown>;
  query: string | null;
  lastResult: { data: unknown; loading: boolean; networkStatus: number };
}

interface LinkLevelEntry {
  timestamp: string;
  type: 'query' | 'mutation' | 'subscription';
  operationName: string;
  variables: Record<string, unknown>;
  query: string | null;
  data: unknown;
}

interface OperationEntry {
  id?: string;
  operationName: string;
  // Query captures use `operationType`, mutation captures use `type`.
  operationType?: 'query' | 'mutation' | 'subscription';
  type?: 'query' | 'mutation' | 'subscription';
  variables: Record<string, unknown>;
  query: string;
  // Query captures use `response.data`, mutation captures put `data` at top level.
  response?: { data: unknown; loading?: boolean; errors?: unknown };
  data?: unknown;
  errors?: unknown;
}

interface ApolloCapture {
  capturedAt: string;
  source?: string;
  url?: string;
  apolloVersion?: string;
  totalOperations?: number;
  uniqueOperations?: string[];
  operations?: OperationEntry[];
  linkLevelCaptures?: LinkLevelEntry[];
  queryManagerCaptures?: QueryManagerEntry[];
}

function jsTypeToGraphQL(v: unknown): string {
  if (v === null) return 'ID';
  if (Array.isArray(v)) {
    const first = v[0];
    return first !== undefined ? `[${jsTypeToGraphQL(first)}]` : '[String]';
  }
  switch (typeof v) {
    case 'string':
      return 'String';
    case 'number':
      return Number.isInteger(v) ? 'Int' : 'Float';
    case 'boolean':
      return 'Boolean';
    case 'object':
      return 'Object';
    default:
      return 'String';
  }
}

function inferSelectionSet(value: unknown, indent = 2): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const first = value.find((x) => x !== null && x !== undefined);
    return inferSelectionSet(first, indent);
  }
  if (typeof value !== 'object') return '';
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = inferSelectionSet(v, indent + 2);
      lines.push(`${pad}${k} {`, nested, `${pad}}`);
    } else if (Array.isArray(v)) {
      const first = v.find((x) => x !== null && x !== undefined);
      if (first !== undefined && typeof first === 'object') {
        const nested = inferSelectionSet(first, indent + 2);
        lines.push(`${pad}${k} {`, nested, `${pad}}`);
      } else {
        lines.push(`${pad}${k}`);
      }
    } else {
      lines.push(`${pad}${k}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

function inferQuery(
  kind: 'query' | 'mutation',
  opName: string,
  variables: Record<string, unknown>,
  data: unknown,
): string {
  const varDefs = Object.entries(variables)
    .map(([k, v]) => `$${k}: ${jsTypeToGraphQL(v)}`)
    .join(', ');
  const signature = varDefs ? `${kind} ${opName}(${varDefs})` : `${kind} ${opName}`;
  const selection = inferSelectionSet(data, 2);
  return [
    `${signature} {`,
    '  # NOTE: inferred from response shape — not captured verbatim from the wire.',
    '  # Actual field aliases, fragments, and arguments on nested selections may differ.',
    selection,
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

function toRawEntry(
  opName: string,
  kind: 'query' | 'mutation',
  variables: Record<string, unknown>,
  data: unknown,
  timestamp: string,
): RawEntry {
  const query = inferQuery(kind, opName, variables, data);
  return {
    ts: new Date(timestamp).getTime() || Date.now(),
    kind: 'fetch',
    url: 'https://app.copilot.money/api/graphql',
    method: 'POST',
    headers: {},
    requestBody: JSON.stringify({
      operationName: opName,
      query,
      variables,
    }),
    response: { data },
    status: 200,
  };
}

function toRawEntryVerbatim(
  opName: string,
  kind: 'query' | 'mutation',
  variables: Record<string, unknown>,
  query: string,
  data: unknown,
  timestamp: string,
): RawEntry {
  return {
    ts: new Date(timestamp).getTime() || Date.now(),
    kind: 'fetch',
    url: 'https://app.copilot.money/api/graphql',
    method: 'POST',
    headers: {},
    requestBody: JSON.stringify({ operationName: opName, query, variables }),
    response: { data },
    status: 200,
  };
}

export async function adaptApolloCapture(inputPath: string, outputPath: string): Promise<void> {
  const capture = (await Bun.file(inputPath).json()) as ApolloCapture;
  const entries: RawEntry[] = [];
  let verbatim = 0;
  let inferred = 0;

  if (capture.operations?.length) {
    for (const e of capture.operations) {
      const opType = e.operationType ?? e.type;
      const kind = opType === 'mutation' ? 'mutation' : 'query';
      const data = e.response?.data ?? e.data;
      if (e.query && e.query.length > 10) {
        entries.push(
          toRawEntryVerbatim(
            e.operationName,
            kind,
            e.variables,
            e.query,
            data,
            capture.capturedAt,
          ),
        );
        verbatim++;
      } else {
        entries.push(toRawEntry(e.operationName, kind, e.variables, data, capture.capturedAt));
        inferred++;
      }
    }
  }

  if (capture.linkLevelCaptures?.length) {
    for (const e of capture.linkLevelCaptures) {
      const kind = e.type === 'mutation' ? 'mutation' : 'query';
      if (e.query && e.query.length > 10) {
        entries.push(toRawEntryVerbatim(e.operationName, kind, e.variables, e.query, e.data, e.timestamp));
        verbatim++;
      } else {
        entries.push(toRawEntry(e.operationName, kind, e.variables, e.data, e.timestamp));
        inferred++;
      }
    }
  }

  if (capture.queryManagerCaptures?.length && !capture.operations?.length) {
    for (const e of capture.queryManagerCaptures) {
      entries.push(
        toRawEntry(e.operationName, 'query', e.variables, e.lastResult?.data, capture.capturedAt),
      );
      inferred++;
    }
  }

  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
  await Bun.write(outputPath, jsonl + '\n');
  console.log(
    `adapted ${entries.length} entries (${verbatim} verbatim query strings, ${inferred} inferred) → ${outputPath}`,
  );
}

if (import.meta.main) {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error(
      'usage: bun scripts/graphql-capture/adapt-apollo-log.ts <apollo-capture.json> <out.jsonl>',
    );
    process.exit(1);
  }
  await adaptApolloCapture(inPath, outPath);
}
