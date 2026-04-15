import type { RawEntry } from './scrub';

interface DocumentDump {
  documents: Record<string, string>;
}

export async function mergeDocuments(jsonlPath: string, documentsPath: string): Promise<void> {
  const dump = (await Bun.file(documentsPath).json()) as DocumentDump;
  const text = await Bun.file(jsonlPath).text();
  const lines = text.split('\n').filter((l) => l.trim());
  let merged = 0;
  let unchanged = 0;

  const out = lines.map((l) => {
    const entry = JSON.parse(l) as RawEntry;
    if (!entry.requestBody) return l;
    let body: { operationName?: string; query?: string; variables?: unknown };
    try {
      body = JSON.parse(entry.requestBody);
    } catch {
      return l;
    }
    const verbatim = body.operationName ? dump.documents[body.operationName] : undefined;
    const isInferred = typeof body.query === 'string' && body.query.includes('inferred from response');
    if (verbatim && isInferred) {
      body.query = verbatim;
      entry.requestBody = JSON.stringify(body);
      merged++;
      return JSON.stringify(entry);
    }
    unchanged++;
    return l;
  });

  await Bun.write(jsonlPath, out.join('\n') + '\n');
  console.log(`merged ${merged} entries with verbatim query strings, ${unchanged} unchanged`);
}

if (import.meta.main) {
  const [, , jsonlPath, documentsPath] = process.argv;
  if (!jsonlPath || !documentsPath) {
    console.error('usage: bun scripts/graphql-capture/merge-documents.ts <captured-log.jsonl> <documents.json>');
    process.exit(1);
  }
  await mergeDocuments(jsonlPath, documentsPath);
}
