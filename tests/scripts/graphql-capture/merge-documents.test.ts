import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeDocuments } from '../../../scripts/graphql-capture/merge-documents';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'merge-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const jsonlLine = (operationName: string, query: string) =>
  JSON.stringify({
    ts: 1,
    kind: 'fetch',
    url: 'https://app.copilot.money/api/graphql',
    method: 'POST',
    headers: {},
    requestBody: JSON.stringify({ operationName, query, variables: {} }),
    response: { data: null },
  });

describe('mergeDocuments', () => {
  it('replaces inferred queries with verbatim ones from the document dump', async () => {
    const inferred =
      'mutation EditTag($id: ID!) {\n  # NOTE: inferred from response shape — not captured verbatim from the wire.\n  editTag\n}';
    const verbatim =
      'mutation EditTag($id: ID!, $input: EditTagInput!) { editTag(id: $id, input: $input) { id name } }';

    const jsonlPath = path.join(dir, 'in.jsonl');
    const docsPath = path.join(dir, 'docs.json');
    await Bun.write(jsonlPath, jsonlLine('EditTag', inferred) + '\n');
    await Bun.write(docsPath, JSON.stringify({ documents: { EditTag: verbatim } }));

    await mergeDocuments(jsonlPath, docsPath);

    const out = (await Bun.file(jsonlPath).text()).trim();
    const body = JSON.parse(JSON.parse(out).requestBody);
    expect(body.query).toBe(verbatim);
  });

  it('leaves verbatim queries untouched', async () => {
    const alreadyVerbatim = 'query Foo { foo }';
    const jsonlPath = path.join(dir, 'in.jsonl');
    const docsPath = path.join(dir, 'docs.json');
    await Bun.write(jsonlPath, jsonlLine('Foo', alreadyVerbatim) + '\n');
    await Bun.write(
      docsPath,
      JSON.stringify({ documents: { Foo: 'query Foo { someDifferentShape }' } })
    );

    await mergeDocuments(jsonlPath, docsPath);

    const out = (await Bun.file(jsonlPath).text()).trim();
    const body = JSON.parse(JSON.parse(out).requestBody);
    expect(body.query).toBe(alreadyVerbatim);
  });

  it('skips entries whose operationName has no matching document', async () => {
    const inferred = 'query Foo { # NOTE: inferred from response shape — unchanged\n}';
    const jsonlPath = path.join(dir, 'in.jsonl');
    const docsPath = path.join(dir, 'docs.json');
    await Bun.write(jsonlPath, jsonlLine('Foo', inferred) + '\n');
    await Bun.write(docsPath, JSON.stringify({ documents: { OtherOp: 'query OtherOp { x }' } }));

    await mergeDocuments(jsonlPath, docsPath);

    const out = (await Bun.file(jsonlPath).text()).trim();
    const body = JSON.parse(JSON.parse(out).requestBody);
    expect(body.query).toBe(inferred);
  });
});
