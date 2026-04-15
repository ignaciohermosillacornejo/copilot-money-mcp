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

interface ManifestTool {
  name: string;
  description: string;
}

interface Manifest {
  name: string;
  display_name: string;
  description: string;
  tools: ManifestTool[];
  server: {
    mcp_config: {
      args: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function truncateDescription(description: string, maxLength = 150): string {
  if (!description || !description.trim()) return 'No description available.';
  const trimmed = description.trim();
  const sentenceEndMatch = trimmed.match(/^(.+?\.)\s|^(.+?\.)$/);
  const firstSentence = sentenceEndMatch ? sentenceEndMatch[1] || sentenceEndMatch[2] : null;
  if (firstSentence && firstSentence.length <= maxLength) return firstSentence;
  if (trimmed.length <= maxLength) return trimmed.endsWith('.') ? trimmed : trimmed + '.';
  return trimmed.slice(0, maxLength - 3).trimEnd() + '...';
}

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
  clone.description =
    'Writes-enabled local build of Copilot Money MCP. ' +
    `${clone.tools.length} tools (17 read + ${writeSchemas.length} write). ` +
    'For self-install only — not published to Claude Desktop.';

  return clone;
}
