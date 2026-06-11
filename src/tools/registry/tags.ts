/**
 * Tag tool definitions (writes only — tags have no cache-mode read).
 */

import { defineTool, type ToolMethodArgs } from './types.js';
import { COLOR_NAMES } from '../../core/graphql/colors.js';

export const createTagTool = defineTool({
  schema: {
    name: 'create_tag',
    description:
      'Create a new user-defined tag for categorizing transactions. Tags appear in the ' +
      'Copilot Money app and are stored in the tag_ids field on transactions. ' +
      'Optionally set a color. Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tag name (e.g. "vacation", "business expense")',
        },
        color_name: {
          type: 'string',
          enum: [...COLOR_NAMES],
          description:
            'Optional palette token from Copilot (e.g. "PURPLE2", "OLIVE1", "RED1"). ' +
            'Defaults to "PURPLE2" when omitted.',
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.createTag(args as ToolMethodArgs<'createTag'>),
});

export const deleteTagTool = defineTool({
  schema: {
    name: 'delete_tag',
    description:
      'Delete a user-defined tag. The tag_id can be obtained from the tag definitions ' +
      'in the local cache. Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        tag_id: {
          type: 'string',
          description: 'Tag ID to delete',
        },
      },
      required: ['tag_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.deleteTag(args as ToolMethodArgs<'deleteTag'>),
});

export const updateTagTool = defineTool({
  schema: {
    name: 'update_tag',
    description:
      'Update an existing tag. Provide tag_id (required) and at least one of name or ' +
      'color_name. Only the specified fields are updated. ' +
      'Writes directly to Copilot Money via GraphQL.',
    inputSchema: {
      type: 'object',
      properties: {
        tag_id: {
          type: 'string',
          description: 'Tag ID to update',
        },
        name: {
          type: 'string',
          description: 'New display name for the tag',
        },
        color_name: {
          type: 'string',
          enum: [...COLOR_NAMES],
          description: 'New palette token from Copilot (e.g. "PURPLE2", "OLIVE1", "RED1").',
        },
      },
      required: ['tag_id'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  readOnly: false,
  handler: (ctx, args) => ctx.tools.updateTag(args as ToolMethodArgs<'updateTag'>),
});
