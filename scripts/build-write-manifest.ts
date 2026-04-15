/**
 * Transform the read-only manifest into a writes-enabled variant.
 *
 * Used only by the local `pack:mcpb:write` build. The committed
 * `manifest.json` describes the read-only bundle published to Claude Desktop
 * and is intentionally left untouched. This transform layers in the write
 * tool schemas, adds `--write` to mcp_config.args, and renames the bundle so
 * a self-installed writes-enabled copy doesn't collide with the read-only
 * one a user may have installed from the Claude Desktop catalog.
 */

import { createWriteToolSchemas } from '../src/tools/tools.js';
import { truncateDescription, type Manifest } from './manifest-utils.js';

export type { Manifest } from './manifest-utils.js';

export function buildWriteManifest(readOnly: Manifest): Manifest {
  const clone: Manifest = JSON.parse(JSON.stringify(readOnly));

  const writeSchemas = createWriteToolSchemas();
  const existingNames = new Set(clone.tools.map((t) => t.name));
  for (const schema of writeSchemas) {
    if (existingNames.has(schema.name)) continue;
    clone.tools.push({
      name: schema.name,
      description: truncateDescription(schema.description),
    });
  }

  if (!clone.server.mcp_config.args.includes('--write')) {
    clone.server.mcp_config.args = [...clone.server.mcp_config.args, '--write'];
  }

  clone.name = `${readOnly.name}-write`;
  clone.display_name = `${readOnly.display_name} (Writes Enabled)`;
  const readCount = clone.tools.length - writeSchemas.length;
  clone.description =
    'Writes-enabled local build of Copilot Money MCP. ' +
    `${clone.tools.length} tools (${readCount} read + ${writeSchemas.length} write). ` +
    'For self-install only — not published to Claude Desktop.';

  return clone;
}
