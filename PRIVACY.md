# Privacy Policy for Copilot Money MCP Server

**Last Updated:** January 11, 2026

## Overview

The Copilot Money MCP Server is designed with privacy as a core principle. This document outlines our privacy practices and commitments.

## Data Collection

**We do not collect, store, or transmit any of your data.**

The Copilot Money MCP Server:
- Operates entirely on your local machine
- Reads data only from your local Copilot Money database cache
- Never sends your financial data to external servers
- Never transmits data over the internet
- Does not include any analytics or telemetry

## Data Access

### What Data We Access

The server reads from your local Copilot Money database, which is stored at:
```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main
```

This database contains:
- Transaction records (amounts, dates, merchant names, categories)
- Account information (balances, account types, institution names)
- Category data

### How We Access Data

- **Read-Only:** The server only reads data; it never modifies your Copilot Money database
- **Local Processing:** All data processing happens on your machine
- **No Network Requests:** The server makes zero network requests
- **No External APIs:** No connections to third-party services

## Data Usage

Data read from your local database is used exclusively to:
1. Respond to queries from Claude Desktop via the Model Context Protocol (MCP)
2. Perform local calculations (e.g., spending aggregations, category summaries)
3. Filter and search transactions based on your requests

All processing happens in memory on your local machine and is never persisted outside of the existing Copilot Money database.

## Data Sharing

**We do not share your data with anyone.**

- No data is sent to our servers (we don't have servers)
- No data is sent to third parties
- No data is sent to Anthropic (beyond what Claude Desktop processes locally)
- No analytics or crash reports are transmitted

## Data Security

### Technical Safeguards

- **Local-Only Architecture:** All operations are performed locally
- **No Network Access:** The server does not make network requests
- **Read-Only Access:** Cannot modify or delete your financial data
- **macOS Sandbox Compliance:** Respects macOS file system permissions

### Your Control

You maintain full control over your data:
- The server only runs when you explicitly start it via Claude Desktop
- You can stop the server at any time by closing Claude Desktop
- You can uninstall the server at any time
- Your Copilot Money data remains in its original location

## Claude Desktop Integration

When integrated with Claude Desktop:
- Queries are processed by Claude via MCP protocol
- Claude may temporarily process your financial data to answer questions
- This processing happens according to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy)
- You control what queries are sent to Claude

## Third-Party Services

This server does not integrate with any third-party services beyond:
- **Claude Desktop** (optional, required for AI-powered queries)
- **Copilot Money** (reads local database created by the app)

## Children's Privacy

This server is not directed to children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in this document with an updated "Last Updated" date.

## Open Source

This server is open source. You can:
- Review the source code at https://github.com/ignaciohermosillacornejo/copilot-money-mcp
- Verify that no data is transmitted externally
- Audit the data access patterns
- Contribute improvements

## Contact

For privacy-related questions or concerns:
- Open an issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues
- Email: ignacio@example.com

## Summary

**In short:** This server is a local-only tool that reads your Copilot Money data to enable AI-powered queries via Claude Desktop. Your data never leaves your machine, and we never collect, store, or transmit your financial information.
