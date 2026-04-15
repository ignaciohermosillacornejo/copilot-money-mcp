/**
 * Shared helpers for manifest generation scripts (sync-manifest, build-write-manifest).
 */

export interface ManifestTool {
  name: string;
  description: string;
}

export interface Manifest {
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

export function truncateDescription(description: string, maxLength = 150): string {
  // Handle empty or whitespace-only descriptions
  if (!description || !description.trim()) {
    return 'No description available.';
  }

  const trimmed = description.trim();

  // Find the first sentence-ending period (followed by space, end of string, or newline)
  // This avoids splitting on periods in abbreviations like "e.g." or "etc."
  const sentenceEndMatch = trimmed.match(/^(.+?\.)\s|^(.+?\.)$/);
  const firstSentence = sentenceEndMatch ? sentenceEndMatch[1] || sentenceEndMatch[2] : null;

  // If we found a sentence and it fits within maxLength, use it
  if (firstSentence && firstSentence.length <= maxLength) {
    return firstSentence;
  }

  // Otherwise, truncate at maxLength
  if (trimmed.length <= maxLength) {
    // Short description without period - add one
    return trimmed.endsWith('.') ? trimmed : trimmed + '.';
  }

  // Truncate long descriptions with ellipsis
  return trimmed.slice(0, maxLength - 3).trimEnd() + '...';
}
