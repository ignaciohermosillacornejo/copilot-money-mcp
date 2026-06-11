#!/bin/bash
# Install the weekly scheduled drift check (#440) as a launchd user agent.
# Re-running updates the plist in place (paths are resolved at install time).
set -euo pipefail

LABEL="com.copilot-money-mcp.scheduled-smoke"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.claude/copilot-money/logs"

[ -x "$BUN" ] || { echo "error: bun not found — install bun first" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# Weekly: Monday 10:00 local. launchd coalesces missed runs on wake, so a
# laptop asleep on Monday morning still runs the check when it wakes.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>run</string>
    <string>$REPO_DIR/scripts/scheduled-smoke.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/scheduled-smoke.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/scheduled-smoke.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" > /dev/null || {
  echo "error: generated plist is malformed — check for XML special chars in $REPO_DIR / $BUN" >&2
  exit 1
}

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $LABEL (weekly, Monday 10:00 local)"
echo "manual run: launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "status file: ~/.claude/copilot-money/scheduled-smoke.json"
