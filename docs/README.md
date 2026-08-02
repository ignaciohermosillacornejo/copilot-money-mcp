# Documentation

This directory contains additional documentation for the Copilot Money MCP Server.

## Contents

- **[TESTING_GUIDE.md](TESTING_GUIDE.md)** - Comprehensive testing instructions for Claude Desktop
  - Installation methods
  - Test cases for all 5 tools
  - Performance testing
  - Error handling tests
  - Privacy & security verification

- **[MCPB_COMPLIANCE.md](MCPB_COMPLIANCE.md)** - Complete .mcpb submission guide
  - Top 3 rejection reasons and how we addressed them
  - Compliance checklist
  - Building and testing .mcpb bundles
  - Submission process to MCP directory

- **[DESIGN_NOTES.md](DESIGN_NOTES.md)** - Technical design decisions
  - Architecture choices
  - Implementation patterns
  - Trade-offs and rationale

- **[bulk-edit-transactions.md](bulk-edit-transactions.md)** - How bulk transaction edits work
  - `bulkEditTransactions`: one edit applied to many rows
  - What can and cannot be bulk-edited, and which tool to reach for
  - Why the `filter` argument is dangerous, and the verified/inferred boundary
  - Silent skips: why `failed: []` does not mean success

- **[REVERSE_ENGINEERING_FINDING.md](REVERSE_ENGINEERING_FINDING.md)** - Research notes
  - LevelDB binary format analysis
  - Protocol Buffers decoding
  - Firestore local cache structure

## Quick Links

- [Main README](../README.md) - Project overview and quick start
- [CONTRIBUTING](../CONTRIBUTING.md) - How to contribute
- [CHANGELOG](../CHANGELOG.md) - Version history
- [PRIVACY](../PRIVACY.md) - Privacy policy
