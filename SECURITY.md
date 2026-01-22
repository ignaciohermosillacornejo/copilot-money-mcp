# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability, please report it responsibly.

### How to Report

**DO NOT** create a public GitHub issue for security vulnerabilities.

Instead, please report security issues via one of these methods:

1. **GitHub Security Advisories** (Preferred)
   - Go to the [Security tab](../../security/advisories) of this repository
   - Click "Report a vulnerability"
   - Provide details about the vulnerability

2. **Email**
   - Send details to the repository owner via GitHub profile contact

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Resolution Timeline**: Depends on severity, typically within 30 days

### Security Measures

This project implements several security measures:

1. **Local Processing Only**: All data processing happens locally. No network requests are made.
2. **Read-Only Access**: The MCP server cannot modify the Copilot Money database.
3. **No Data Exfiltration**: No telemetry, analytics, or data transmission.
4. **OIDC Publishing**: npm packages are published using OIDC trusted publishing with provenance.
5. **Code Review**: All PRs require owner approval for security-critical paths.
6. **Dependency Auditing**: Regular security audits of dependencies.

### Scope

Security reports should relate to:

- Vulnerabilities in the MCP server code
- Data privacy issues
- Supply chain security concerns
- Authentication/authorization bypasses

Out of scope:

- Vulnerabilities in Copilot Money itself (report to Copilot)
- Vulnerabilities in Claude Desktop (report to Anthropic)
- Issues with third-party dependencies (report upstream, but let us know)

## Security Hardening

For contributors and security researchers, here are the key security controls:

| Control | Implementation |
|---------|---------------|
| Package Publishing | OIDC trusted publishing, owner-only releases |
| PR Approval | Owner and Claude-bot only, CODEOWNERS enforcement |
| Security Paths | .github/, package.json, scripts/ require owner review |
| Dependency Management | Regular audits, lockfile verification |
| Code Review | Automated AI review + manual owner review for sensitive changes |
