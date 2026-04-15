#!/bin/sh
# Launcher for copilot-money-mcp inside a Claude Desktop .mcpb bundle.
#
# Claude Desktop routes extensions with mcp_config.command === "node" into an
# Electron UtilityProcess that enforces macOS hardened-runtime library
# validation. npm prebuilds (classic-level, etc.) are signed ad-hoc, lack
# Anthropic's Team ID, and dlopen rejects them before our JS runs. Pointing
# mcp_config.command at this script (an absolute path, not the literal string
# "node") makes Claude Desktop fall through to plain child_process spawn mode,
# where native .node binaries load normally.
#
# See https://github.com/modelcontextprotocol/mcpb/issues/229

set -e

# PATH on macOS GUI-launched processes does not inherit the shell's PATH, so
# Homebrew-ARM (/opt/homebrew/bin) and nvm installs are usually invisible.
# Fall back through common install locations before giving up.
for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        exec "$candidate" "$@"
    fi
done

echo "copilot-money-mcp: could not find a Node.js binary on PATH or in" >&2
echo "  /opt/homebrew/bin, /usr/local/bin, /usr/bin." >&2
echo "Install Node.js 18+ from https://nodejs.org/ and restart Claude Desktop." >&2
exit 127
