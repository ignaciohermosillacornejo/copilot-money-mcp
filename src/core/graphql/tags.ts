import type { GraphQLClient } from './client.js';
import { CREATE_TAG, EDIT_TAG, DELETE_TAG } from './operations.generated.js';

export interface CreateTagInput {
  name: string;
  colorName: string;
}

interface CreateTagResponse {
  createTag: {
    id: string;
    name: string;
    colorName: string;
  };
}

export async function createTag(
  client: GraphQLClient,
  args: { input: CreateTagInput }
): Promise<{ id: string; name: string; colorName: string }> {
  const data = await client.mutate<{ input: CreateTagInput }, CreateTagResponse>(
    'CreateTag',
    CREATE_TAG,
    args
  );
  return {
    id: data.createTag.id,
    name: data.createTag.name,
    colorName: data.createTag.colorName,
  };
}

export interface EditTagInput {
  name?: string;
  colorName?: string;
}

export interface EditTagChanges {
  name?: string;
  colorName?: string;
}

interface EditTagResponse {
  editTag: {
    id: string;
    name: string;
    colorName: string;
  };
}

export async function editTag(
  client: GraphQLClient,
  args: { id: string; input: EditTagInput }
): Promise<{ id: string; changed: EditTagChanges }> {
  const data = await client.mutate<{ id: string; input: EditTagInput }, EditTagResponse>(
    'EditTag',
    EDIT_TAG,
    args
  );
  const tag = data.editTag;
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  const changed: EditTagChanges = {};
  if ('name' in args.input) changed.name = tag.name;
  if ('colorName' in args.input) changed.colorName = tag.colorName;
  return { id: tag.id, changed };
}

export async function deleteTag(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  await client.mutate<{ id: string }, { deleteTag: boolean }>('DeleteTag', DELETE_TAG, {
    id: args.id,
  });
  return { id: args.id, deleted: true };
}
