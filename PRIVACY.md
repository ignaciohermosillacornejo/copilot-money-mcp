# Privacy Policy for Copilot Money MCP Server

**Last Updated:** April 11, 2026

## Disclaimer

**This is an independent, community-driven project and is not affiliated with, endorsed by, or associated with Copilot Money or its parent company in any way.** This tool was created by an independent developer. "Copilot Money" is a trademark of its respective owner.

## Overview

The Copilot Money MCP Server is designed with privacy as a core principle. This document outlines our privacy practices and commitments.

The server operates in two modes:
- **Read-only mode (default):** Reads data exclusively from your local Copilot Money database cache. No network requests are made.
- **Write mode (opt-in, `--write` flag):** Adds the ability to modify your Copilot Money data. Because Copilot Money is backed by Google Firebase/Firestore, write operations require authenticated network requests to Firebase/Firestore on your behalf. See the [Write Mode and Network Access](#write-mode-and-network-access) section below.

## Data Collection

**We do not collect, store, or transmit any of your data to our servers or any third party.** The server has no backend, no analytics, and no telemetry.

The Copilot Money MCP Server:
- Operates on your local machine
- Reads data only from your local Copilot Money database cache
- Never sends your financial data to servers operated by this project (we don't have servers)
- Does not include any analytics or telemetry
- Makes zero network requests in the default read-only mode
- In opt-in write mode, makes network requests **only** to Google Firebase/Firestore (the same backend Copilot Money itself uses) to apply the changes you request

## Data Access

### What Data We Access

The server reads from your local Copilot Money database, which is stored at:
```
~/Library/Containers/com.copilot.production/Data/Library/Application Support/firestore/__FIRAPP_DEFAULT/copilot-production-22904/main
```

This database contains:
- Transaction records (amounts, dates, merchant names, categories)
- Account information (balances, account types, institution names)
- Budgets, goals, tags, categories, and recurring transactions
- Investment holdings, prices, and performance data

### How We Access Data

- **Local Reads:** All data reads happen against your local Copilot Money database cache
- **Local Processing:** All query processing, filtering, and aggregation happens on your machine
- **Read-Only by Default:** In the default mode, the server only reads data and makes zero network requests
- **No Third-Party Analytics:** No connections to analytics, tracking, or telemetry services
- **Opt-In Writes:** Write operations are disabled unless you explicitly start the server with `--write`. When enabled, writes are sent directly to Google Firebase/Firestore — the same backend Copilot Money itself uses — and not to any intermediary operated by this project

## Data Usage

Data read from your local database is used exclusively to:
1. Respond to queries from Claude Desktop via the Model Context Protocol (MCP)
2. Perform local calculations (e.g., spending aggregations, category summaries)
3. Filter and search transactions based on your requests

If you explicitly enable write mode with `--write`, data you ask the server to modify is additionally used to:
4. Construct authenticated Firestore REST API requests that apply your requested changes to your own Copilot Money account

All processing happens in memory on your local machine. No data is persisted outside of the existing Copilot Money database and its native Firebase/Firestore backend.

## Data Sharing

**We do not share your data with anyone.**

- No data is sent to our servers (we don't have servers)
- No data is sent to third parties for analytics, advertising, or tracking
- No data is sent to Anthropic (beyond what Claude Desktop processes locally)
- No analytics or crash reports are transmitted

In opt-in write mode, requested changes are sent directly from your machine to Google Firebase/Firestore using your own Copilot Money credentials. This is the same backend Copilot Money itself uses to persist your data — no intermediary server operated by this project is involved. This traffic is governed by Google's and Copilot Money's own privacy policies.

## Data Security

### Technical Safeguards

- **Local-First Architecture:** All queries, filtering, and aggregation happen locally
- **No Network Access in Default Mode:** With read-only mode (default), the server makes zero network requests
- **Opt-In Writes:** Write tools are disabled unless you explicitly start the server with `--write`
- **Authenticated Writes Only:** When write mode is enabled, network requests go only to Google Firebase/Firestore, authenticated with your own Copilot Money credentials over HTTPS
- **No Third-Party Network Destinations:** The server never contacts destinations other than Google's Firebase/Firestore endpoints (and only in write mode)
- **macOS Sandbox Compliance:** Respects macOS file system permissions

### Your Control

You maintain full control over your data:
- The server only runs when you explicitly start it via Claude Desktop
- You can stop the server at any time by closing Claude Desktop
- You can uninstall the server at any time
- Your Copilot Money data remains in its original location
- **Write mode is strictly opt-in:** Write tools are unavailable unless you explicitly start the server with `--write`. Without this flag, the server cannot modify your Copilot Money data even if instructed to do so

## Write Mode and Network Access

By default, the server starts in read-only mode and makes zero network requests. If you explicitly enable write mode by starting the server with the `--write` flag, the following additional behavior applies:

### What Happens in Write Mode

- The server can execute write tools that modify your Copilot Money data (categorizing transactions, creating budgets, editing goals, etc.)
- To apply those changes, the server authenticates to Google Firebase using a Firebase refresh token extracted from your local Copilot Money session, then sends Firestore REST API requests directly to `https://firestore.googleapis.com`
- These requests go to the **same Firebase/Firestore backend that Copilot Money itself uses** — your changes reach your own Copilot Money account, just as they would if you had made them in the Copilot Money app
- No write traffic passes through any server operated by this project

### What Does Not Happen

- No write traffic is ever sent to servers operated by this project (we don't have any)
- No write traffic is sent to Anthropic or any third party other than Google (Firebase/Firestore)
- The server never initiates writes on its own — every write is the direct result of a tool call you (or an AI assistant on your behalf) issued
- Your Firebase credentials are held only in memory and are never logged, persisted, or transmitted to anyone other than Google's token-exchange endpoint

### Governing Policies

Network traffic in write mode is subject to:
- [Google's Privacy Policy](https://policies.google.com/privacy) (as Firebase/Firestore is operated by Google)
- Copilot Money's own terms and privacy policy (as you are modifying data on their backend)

## Claude Desktop Integration

When integrated with Claude Desktop:
- Queries are processed by Claude via MCP protocol
- Claude may temporarily process your financial data to answer questions
- This processing happens according to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy)
- You control what queries are sent to Claude

## Third-Party Services

This server does not integrate with any third-party services beyond:
- **Claude Desktop** (optional, required for AI-powered queries)
- **Copilot Money** (reads the local database created by the app)
- **Google Firebase / Firestore** (only in opt-in write mode; this is Copilot Money's own backend, accessed directly with your own Copilot Money credentials)

## Children's Privacy

This server is not directed to children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in this document with an updated "Last Updated" date.

## Open Source

This server is open source. You can:
- Review the source code at https://github.com/ignaciohermosillacornejo/copilot-money-mcp
- Verify exactly which network destinations (if any) are contacted in each mode
- Audit the data access patterns
- Contribute improvements

## Contact

For privacy-related questions or concerns:
- Open an issue: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues
- Email: hello@ignaciohermosilla.com

## Summary

**In short:** This server is a local-first tool that reads your Copilot Money data to enable AI-powered queries via Claude Desktop. In its default read-only mode, your data never leaves your machine. If you explicitly opt in to write mode with the `--write` flag, the server can additionally apply your requested changes by talking directly to Copilot Money's own Firebase/Firestore backend using your own credentials. We never collect, store, or transmit your financial information to servers operated by this project — we don't have any.
