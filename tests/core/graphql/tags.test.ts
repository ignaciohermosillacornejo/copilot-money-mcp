import { describe, test, expect, mock } from 'bun:test';
import { createTag, editTag, deleteTag } from '../../../src/core/graphql/tags.js';
import {
  CREATE_TAG,
  EDIT_TAG,
  DELETE_TAG,
} from '../../../src/core/graphql/operations.generated.js';
import type { GraphQLClient } from '../../../src/core/graphql/client.js';

function createMockClient(response: unknown): GraphQLClient {
  return {
    mutate: mock((_op: string, _q: string, _v: unknown) => Promise.resolve(response)),
  } as unknown as GraphQLClient;
}

describe('createTag', () => {
  test('sends CreateTag with input', async () => {
    const client = createMockClient({
      createTag: { id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' },
    });
    await createTag(client, { input: { name: 'urgent', colorName: 'PURPLE2' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('CreateTag');
    expect(call[1]).toBe(CREATE_TAG);
    expect(call[2]).toEqual({ input: { name: 'urgent', colorName: 'PURPLE2' } });
  });

  test('returns compact { id, name, colorName }', async () => {
    const client = createMockClient({
      createTag: { id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' },
    });
    const out = await createTag(client, { input: { name: 'urgent', colorName: 'PURPLE2' } });
    expect(out).toEqual({ id: 'tag-1', name: 'urgent', colorName: 'PURPLE2' });
  });
});

describe('editTag', () => {
  test('sends EditTag with id + input', async () => {
    const client = createMockClient({
      editTag: { id: 'tag-1', name: 'urgent-v2', colorName: 'PURPLE2' },
    });
    await editTag(client, { id: 'tag-1', input: { name: 'urgent-v2' } });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('EditTag');
    expect(call[1]).toBe(EDIT_TAG);
    expect(call[2]).toEqual({ id: 'tag-1', input: { name: 'urgent-v2' } });
  });
});

describe('deleteTag', () => {
  test('sends DeleteTag with id and returns { id, deleted: true }', async () => {
    const client = createMockClient({ deleteTag: true });
    const out = await deleteTag(client, { id: 'tag-1' });
    const call = (client.mutate as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe('DeleteTag');
    expect(call[1]).toBe(DELETE_TAG);
    expect(call[2]).toEqual({ id: 'tag-1' });
    expect(out).toEqual({ id: 'tag-1', deleted: true });
  });
});
