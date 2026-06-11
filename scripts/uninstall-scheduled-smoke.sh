#!/bin/bash
# Remove the weekly scheduled drift check (#440).
set -euo pipefail

LABEL="com.copilot-money-mcp.scheduled-smoke"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "uninstalled: $LABEL (status/report files under ~/.claude/copilot-money/ left in place)"
