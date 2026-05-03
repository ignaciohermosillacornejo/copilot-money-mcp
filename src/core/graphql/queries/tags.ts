/**
 * GraphQL query wrapper for Tags.
 *
 * Returns a flat list — Copilot's Tags query takes no variables and the
 * response shape is a simple array (no nesting, no childTags). One round-trip
 * per call; the SnapshotCache caches the full set with a 24h TTL.
 *
 * The captured query at docs/graphql-capture/operations/queries/Tags.md
 * exposes only `id`, `name`, `colorName` on each Tag.
 */

import type { GraphQLClient } from '../client.js';
import { TAGS } from '../operations.generated.js';

export interface TagNode {
  id: string;
  name: string;
  colorName: string | null;
}

interface TagsResponse {
  tags: TagNode[];
}

export async function fetchTags(client: GraphQLClient): Promise<TagNode[]> {
  const data = await client.query<Record<string, never>, TagsResponse>('Tags', TAGS, {});
  return data.tags;
}
