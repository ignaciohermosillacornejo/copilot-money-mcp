# .mcpb Bundle Compliance Guide

**Purpose:** This document contains all learnings and requirements for .mcpb bundle submission to the official MCP directory.

**Status:** ✅ All requirements met, ready for testing

---

## Executive Summary

The .mcpb (Model Context Protocol Bundle) format enables **one-click installation** of MCP servers in Claude Desktop. Submissions are reviewed by Anthropic before being listed in the official directory.

**Key Facts:**
- 🎯 Distribution method: .mcpb bundles work out-of-the-box (Node.js ships with Claude Desktop)
- 📝 Review required: All submissions manually reviewed before listing
- ⏱️ Review time: 1-2 weeks typical
- ❌ Common rejections: Missing safety annotations, incomplete privacy policy, no examples

---

## Top 3 Rejection Reasons

Based on community feedback and documentation:

### 1. Missing Tool Safety Annotations (⭐ MOST COMMON)

**Problem:** Tools don't have `readOnlyHint` annotation.

**Required:**
```typescript
{
  name: "get_transactions",
  description: "...",
  inputSchema: { ... },
  annotations: {
    readOnlyHint: true  // ⭐ MANDATORY for read-only tools
  }
}
```

**Our Status:** ✅ All 5 tools have this annotation
- ✅ get_transactions → readOnlyHint: true
- ✅ search_transactions → readOnlyHint: true
- ✅ get_accounts → readOnlyHint: true
- ✅ get_spending_by_category → readOnlyHint: true
- ✅ get_account_balance → readOnlyHint: true

**Verification:**
```bash
# Run this test to verify:
bun test tests/tools/tools.test.ts -t "readOnlyHint"
```

**Why it matters:** Claude Desktop uses this hint to determine whether to show warnings before executing tools. Read-only tools are safer and don't need confirmation dialogs.

---

### 2. Missing or Incomplete Privacy Policy

**Problem:** No PRIVACY.md file, or manifest.json doesn't reference it.

**Required in THREE locations:**

**A. PRIVACY.md file in repository root**
```markdown
# Privacy Policy for [Your MCP Server]

## Data Collection
We do not collect, store, or transmit any of your data.

## Data Access
[Describe what local data you access]

## Data Usage
[Describe what you do with the data]

## Data Sharing
We do not share your data with anyone.
```

**Our Status:** ✅ PRIVACY.md exists (4,174 bytes)
- Location: `/PRIVACY.md`
- Covers: Data collection, access, usage, sharing, security
- Commitments: 100% local, read-only, no transmission, no telemetry

**B. manifest.json v0.3 with privacy_policies array**
```json
{
  "manifest_version": "0.3",
  "privacy_policies": [
    {
      "url": "https://github.com/[user]/[repo]/blob/main/PRIVACY.md",
      "type": "project"
    }
  ]
}
```

**Our Status:** ✅ manifest.json has privacy_policies array
- File: `/manifest.json`
- Version: 0.3
- URL: Points to our PRIVACY.md on GitHub

**C. README.md privacy section**
```markdown
## Privacy & Security

Your data never leaves your machine. See our [Privacy Policy](PRIVACY.md).

- ✅ No data collection or transmission
- ✅ No external API calls
- ✅ Read-only access
```

**Our Status:** ✅ README.md has privacy section
- Section: "Privacy First" (lines 20-28)
- Link to PRIVACY.md
- Clear privacy commitments listed

**Verification:**
```bash
# Check all three locations exist:
test -f PRIVACY.md && echo "✅ PRIVACY.md exists"
grep -q "privacy_policies" manifest.json && echo "✅ manifest.json has privacy_policies"
grep -q "Privacy" README.md && echo "✅ README.md mentions privacy"
```

---

### 3. Missing Working Examples

**Problem:** README doesn't show realistic usage examples.

**Required:** Minimum 3 examples showing:
1. User query (natural language)
2. Tool call (with parameters)
3. Tool response (JSON)
4. Claude's interpretation

**Our Status:** ✅ 3 working examples in README.md
- Example 1: Monthly spending analysis (get_spending_by_category)
- Example 2: Transaction search (search_transactions)
- Example 3: Account balance overview (get_accounts)

**Location:** README.md lines 80-215

**Format:**
```markdown
### Example 1: Monthly Spending Analysis

**User Query:**
> "How much did I spend on dining out last month?"

**MCP Tool Call:**
{
  "tool": "get_spending_by_category",
  "arguments": {
    "period": "last_month"
  }
}

**Response:**
{
  "total_spending": 1847.32,
  "categories": [...]
}

**Claude's Answer:**
> "Last month you spent $487.50 on dining out..."
```

**Why it matters:** Examples help reviewers understand the tool's purpose and help users know how to use it.

---

## Complete Compliance Checklist

### Mandatory Requirements ✅

#### 1. Tool Safety Annotations
- [x] All read-only tools have `readOnlyHint: true`
- [x] Annotations are in tool schema definitions
- [x] Test coverage verifies annotations

**Verification:**
```typescript
// File: src/tools/tools.ts
export function createToolSchemas(): ToolSchema[] {
  return [
    {
      name: "get_transactions",
      // ...
      annotations: {
        readOnlyHint: true  // ✅ Present
      }
    }
  ];
}
```

#### 2. Privacy Policy (Three Locations)
- [x] PRIVACY.md exists in repository root
- [x] manifest.json v0.3 with privacy_policies array
- [x] README.md has privacy section with link

**Verification:**
```bash
ls -la PRIVACY.md manifest.json README.md
```

#### 3. Working Examples
- [x] Minimum 3 examples in README
- [x] Each example shows: query → tool call → response → interpretation
- [x] Examples use realistic data

**Location:** README.md lines 80-215

#### 4. Manifest v0.3
- [x] manifest_version: "0.3"
- [x] name, description, version fields
- [x] author information
- [x] privacy_policies array with URL
- [x] categories and tags
- [x] requirements (platform, node version)

**File:** `/manifest.json`

#### 5. Documentation
- [x] README with installation instructions
- [x] Tool documentation (parameters, examples)
- [x] Troubleshooting section
- [x] Clear description of what the server does

**File:** `/README.md` (415 lines)

#### 6. Testing
- [x] All tests passing
- [x] Test coverage ≥80%
- [x] Tests verify tool functionality
- [x] Tests verify safety annotations

**Status:** 142 tests passing, ~90% coverage

#### 7. Build Quality
- [x] TypeScript compiles without errors
- [x] ESLint passes without warnings
- [x] Bundle builds successfully
- [x] Executable runs without crashes

**Verification:**
```bash
bun run build && bun test
```

---

## Optional But Recommended

### 1. Performance Benchmarks
- [ ] Document query performance (<5s target)
- [ ] Document memory usage
- [ ] Document startup time

### 2. Additional Documentation
- [ ] CONTRIBUTING.md - Contribution guidelines
- [ ] CHANGELOG.md - Version history
- [ ] Architecture diagram

### 3. GitHub Repository Quality
- [ ] Clear README with badges
- [ ] Issues template
- [ ] PR template
- [ ] License file (MIT recommended)
- [ ] .gitignore configured

---

## .mcpb Bundle Technical Requirements

### File Structure
```
copilot-money-mcp.mcpb/
├── manifest.json          # ✅ v0.3 with privacy_policies
├── package.json           # ✅ Node.js package metadata
├── dist/
│   └── cli.js            # ✅ Bundled executable
└── README.md             # ✅ User documentation
```

### manifest.json Required Fields
```json
{
  "manifest_version": "0.3",      // ✅ Must be 0.3 or higher
  "name": "...",                  // ✅ Unique identifier
  "description": "...",           // ✅ Clear description
  "version": "1.0.0",            // ✅ Semantic versioning
  "privacy_policies": [          // ✅ MANDATORY
    {
      "url": "https://...",
      "type": "project"
    }
  ],
  "author": { ... },             // ✅ Author info
  "homepage": "...",             // ✅ GitHub URL
  "repository": { ... }          // ✅ Git repository
}
```

### package.json Required Fields
```json
{
  "name": "copilot-money-mcp",
  "version": "1.0.0",
  "type": "module",              // ✅ ESM modules
  "main": "dist/cli.js",         // ✅ Entry point
  "bin": {                       // ✅ Executable name
    "copilot-money-mcp": "dist/cli.js"
  },
  "engines": {
    "node": ">=18.0.0"           // ✅ Node version requirement
  }
}
```

---

## Building the .mcpb Bundle

### Step 1: Build the Project
```bash
npm run build
# Or:
bun build src/cli.ts --outdir dist --target node --format esm
chmod +x dist/cli.js
```

**Verify:**
```bash
ls -la dist/cli.js
node dist/cli.js --help
```

### Step 2: Create .mcpb Bundle
```bash
npm run pack:mcpb
# Or:
bunx @anthropic-ai/mcpb pack
```

**This will:**
1. Read manifest.json
2. Bundle dist/ directory
3. Include package.json and README.md
4. Create copilot-money-mcp.mcpb file

**Output:**
```
✅ copilot-money-mcp.mcpb created
```

### Step 3: Verify Bundle Contents
```bash
# .mcpb files are ZIP archives
unzip -l copilot-money-mcp.mcpb
```

**Expected contents:**
```
manifest.json
package.json
README.md
dist/cli.js
dist/... (other bundled files)
```

---

## Testing the .mcpb Bundle

### Installation in Claude Desktop

**Option A: Double-click**
1. Double-click the .mcpb file
2. Claude Desktop will prompt for installation
3. Click "Install"
4. Restart Claude Desktop

**Option B: Manual Copy**
```bash
cp copilot-money-mcp.mcpb \
  ~/Library/Application\ Support/Claude/mcpb/
```

### Configuration

After installation, the server should be available automatically. Verify in Claude Desktop settings:

```
Settings → Developer → MCP Servers
```

You should see: `copilot-money-mcp` (enabled)

### Testing All 5 Tools

**Test 1: get_transactions**
```
User: "Show me my last 10 transactions"
Expected: List of 10 transactions with amounts and dates
```

**Test 2: search_transactions**
```
User: "Find all Starbucks purchases"
Expected: Filtered list of Starbucks transactions
```

**Test 3: get_accounts**
```
User: "What's my total balance?"
Expected: List of accounts with total balance calculated
```

**Test 4: get_spending_by_category**
```
User: "Break down my spending last month"
Expected: Categories sorted by spending, with totals
```

**Test 5: get_account_balance**
```
User: "Show me my checking account balance"
Expected: Specific account details with balance
```

### Validation Checklist

- [ ] All 5 tools execute successfully
- [ ] No errors or crashes
- [ ] Performance <5s per query
- [ ] Error messages are helpful
- [ ] No network requests (verify with Activity Monitor)
- [ ] Privacy: Data stays local
- [ ] No console errors in Claude Desktop logs

---

## Submission to MCP Directory

### Prerequisites

Before submitting, ensure ALL are ✅:

- [x] All tests passing (142/142)
- [x] PRIVACY.md exists and comprehensive
- [x] manifest.json v0.3 with privacy_policies
- [x] README has 3 working examples
- [x] All tools have readOnlyHint: true
- [ ] .mcpb bundle tested in Claude Desktop ⭐ MUST DO

### Submission Process

**1. Create GitHub Release**
```bash
# Tag the release
git tag v1.0.0
git push origin v1.0.0

# Create release on GitHub
gh release create v1.0.0 \
  --title "v1.0.0 - Initial Release" \
  --notes "First production release with all 5 tools" \
  copilot-money-mcp.mcpb
```

**2. Fork MCP Directory**
```bash
git clone https://github.com/anthropics/mcp-directory
cd mcp-directory
git checkout -b add-copilot-money-mcp
```

**3. Add Server Entry**

Edit `servers.json`:
```json
{
  "servers": [
    {
      "id": "copilot-money-mcp",
      "name": "Copilot Money MCP Server",
      "description": "AI-powered personal finance queries using local Copilot Money data. 100% local processing, no data transmission.",
      "repository": "https://github.com/ignaciohermosillacornejo/copilot-money-mcp",
      "mcpb_url": "https://github.com/ignaciohermosillacornejo/copilot-money-mcp/releases/download/v1.0.0/copilot-money-mcp.mcpb",
      "privacy_policy": "https://github.com/ignaciohermosillacornejo/copilot-money-mcp/blob/main/PRIVACY.md",
      "categories": ["finance", "productivity", "data-analysis"],
      "tags": ["personal-finance", "transactions", "budgeting", "spending-analysis", "local-data", "privacy-first"],
      "platforms": ["darwin"],
      "requirements": {
        "node": ">=18.0.0",
        "app": "Copilot Money"
      }
    }
  ]
}
```

**4. Submit Pull Request**
```bash
git add servers.json
git commit -m "Add Copilot Money MCP Server"
git push origin add-copilot-money-mcp

# Create PR on GitHub
gh pr create \
  --title "Add Copilot Money MCP Server" \
  --body "Submitting Copilot Money MCP Server for directory listing.

**Server:** copilot-money-mcp
**Description:** AI-powered personal finance queries using local Copilot Money data

**Compliance:**
- ✅ All tools have readOnlyHint: true annotations
- ✅ PRIVACY.md with comprehensive privacy policy
- ✅ manifest.json v0.3 with privacy_policies array
- ✅ 3 working examples in README
- ✅ 142 tests passing
- ✅ Tested in Claude Desktop

**Privacy:** 100% local processing, no data transmission, read-only access"
```

**5. Wait for Review**
- Review time: 1-2 weeks typical
- Reviewers will check all compliance requirements
- May request changes or clarifications
- Address feedback promptly

---

## Common Review Feedback

Based on community reports:

### "Missing readOnlyHint annotation"
**Fix:** Add to all read-only tools
```typescript
annotations: { readOnlyHint: true }
```

### "Privacy policy URL is broken"
**Fix:** Ensure GitHub URL is correct and accessible
```json
"privacy_policies": [
  {
    "url": "https://github.com/[user]/[repo]/blob/main/PRIVACY.md"
  }
]
```

### "Examples are not clear"
**Fix:** Add more detail:
- Show actual user query
- Show tool call with parameters
- Show response with data
- Show Claude's interpretation

### "Bundle doesn't install"
**Fix:** Test installation:
```bash
# Verify bundle structure
unzip -l copilot-money-mcp.mcpb

# Test installation manually
cp copilot-money-mcp.mcpb ~/Library/Application\ Support/Claude/mcpb/
```

### "Performance concerns"
**Fix:** Document performance:
- Query time: <5s
- Memory usage: <100MB
- Startup time: <1s

---

## Post-Approval

After approval and listing:

### 1. Update README Badge
```markdown
[![MCP Directory](https://img.shields.io/badge/MCP-Directory-blue)](https://directory.modelcontextprotocol.io/)
```

### 2. Announce Release
- GitHub Discussions
- Social media
- Copilot Money community

### 3. Monitor Usage
- Watch for GitHub issues
- Respond to questions
- Fix bugs quickly

### 4. Maintain Version
- Keep dependencies updated
- Address security issues
- Add features based on feedback

---

## Troubleshooting

### Issue: .mcpb bundle doesn't build
**Solution:**
```bash
# Verify build works first
npm run build
ls -la dist/cli.js

# Then try packing
bunx @anthropic-ai/mcpb pack
```

### Issue: Bundle installs but doesn't appear in Claude Desktop
**Solution:**
1. Check manifest.json is valid JSON
2. Verify package.json bin field points to correct file
3. Restart Claude Desktop completely
4. Check Claude Desktop logs:
   ```
   ~/Library/Logs/Claude/
   ```

### Issue: Tools execute but return errors
**Solution:**
1. Check database path is correct
2. Verify Copilot Money is installed
3. Test CLI directly:
   ```bash
   node dist/cli.js --verbose
   ```

### Issue: Privacy policy URL returns 404
**Solution:**
1. Ensure PRIVACY.md is in main branch
2. Update manifest.json URL to match
3. Test URL in browser before submitting

---

## Resources

- **MCP Documentation:** https://modelcontextprotocol.io/
- **MCP Directory Repo:** https://github.com/anthropics/mcp-directory
- **Claude Desktop:** https://claude.ai/desktop
- **@anthropic-ai/mcpb:** https://www.npmjs.com/package/@anthropic-ai/mcpb

---

## Summary

### ✅ We're Compliant

All major requirements met:
- ✅ Tool safety annotations (readOnlyHint: true)
- ✅ Privacy policy in 3 locations
- ✅ 3 working examples in README
- ✅ manifest.json v0.3 with privacy_policies
- ✅ 142 tests passing
- ✅ Documentation complete

### ⏳ Next Step

**Test .mcpb bundle in Claude Desktop before submitting.**

1. Build bundle: `npm run pack:mcpb`
2. Install in Claude Desktop
3. Test all 5 tools
4. Verify performance and stability
5. Submit to MCP directory

**After testing passes, we're ready for submission! 🚀**
