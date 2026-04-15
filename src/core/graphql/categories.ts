import type { GraphQLClient } from './client.js';
import { CREATE_CATEGORY, EDIT_CATEGORY, DELETE_CATEGORY } from './operations.generated.js';

export interface CreateCategoryInput {
  name: string;
  colorName: string;
  emoji: string;
  isExcluded: boolean;
  parentId?: string;
}

interface CreateCategoryResponse {
  createCategory: {
    id: string;
    name: string;
    colorName: string;
  };
}

export async function createCategory(
  client: GraphQLClient,
  args: { input: CreateCategoryInput }
): Promise<{ id: string; name: string; colorName: string }> {
  const data = await client.mutate<
    { input: CreateCategoryInput; spend: boolean; budget: boolean },
    CreateCategoryResponse
  >('CreateCategory', CREATE_CATEGORY, { spend: false, budget: false, input: args.input });
  return {
    id: data.createCategory.id,
    name: data.createCategory.name,
    colorName: data.createCategory.colorName,
  };
}

export interface EditCategoryInput {
  name?: string;
  colorName?: string;
  emoji?: string;
  isExcluded?: boolean;
  parentId?: string | null;
}

interface EditCategoryResponse {
  editCategory: {
    category: {
      id: string;
      name: string;
      colorName: string;
    };
  };
}

export interface EditCategoryChanges {
  name?: string;
  colorName?: string;
  emoji?: string;
  isExcluded?: boolean;
  parentId?: string | null;
}

export async function editCategory(
  client: GraphQLClient,
  args: { id: string; input: EditCategoryInput }
): Promise<{ id: string; changed: EditCategoryChanges }> {
  const data = await client.mutate<
    { id: string; input: EditCategoryInput; spend: boolean; budget: boolean },
    EditCategoryResponse
  >('EditCategory', EDIT_CATEGORY, {
    id: args.id,
    spend: false,
    budget: false,
    input: args.input,
  });
  const cat = data.editCategory.category;
  // Report back fields the caller named in args.input — keyed by presence,
  // not by value. Lets callers explicitly "change to undefined" if ever needed;
  // tools.ts builds args.input via conditional spread so explicit-undefined
  // shouldn't normally reach us.
  const changed: EditCategoryChanges = {};
  if ('name' in args.input) changed.name = cat.name;
  if ('colorName' in args.input) changed.colorName = cat.colorName;
  if ('emoji' in args.input) changed.emoji = args.input.emoji;
  if ('isExcluded' in args.input) changed.isExcluded = args.input.isExcluded;
  if ('parentId' in args.input) changed.parentId = args.input.parentId;
  return { id: cat.id, changed };
}

export async function deleteCategory(
  client: GraphQLClient,
  args: { id: string }
): Promise<{ id: string; deleted: true }> {
  await client.mutate<{ id: string }, { deleteCategory: boolean }>(
    'DeleteCategory',
    DELETE_CATEGORY,
    { id: args.id }
  );
  return { id: args.id, deleted: true };
}
