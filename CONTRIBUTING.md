# Contributing to Copilot Money MCP Server

Thank you for your interest in contributing to the Copilot Money MCP Server! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Style](#code-style)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- **Node.js**: Version 18 or higher
- **Bun**: Latest version (for development)
- **Copilot Money**: Installed on macOS for testing
- **Git**: For version control

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/copilot-money-mcp.git
   cd copilot-money-mcp
   ```
3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/ignaciohermosillacornejo/copilot-money-mcp.git
   ```

## Development Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Verify setup:**
   ```bash
   bun test
   npm run typecheck
   npm run lint
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

## Development Workflow

### Creating a Branch

Always create a new branch for your work:

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

Branch naming conventions:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test improvements

### Making Changes

1. **Make your changes** in the appropriate files
2. **Write tests** for new functionality
3. **Update documentation** if needed
4. **Run tests** to ensure nothing breaks:
   ```bash
   bun test
   ```
5. **Check types and linting:**
   ```bash
   npm run typecheck
   npm run lint
   ```

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:
```
feat(tools): add new transaction filtering options

Add support for filtering transactions by:
- Multiple merchants
- Date ranges with custom formats
- Transaction types (debit/credit)

Closes #123
```

```
fix(decoder): handle empty string values in binary data

The decoder was crashing when encountering empty strings
in the LevelDB binary format. Added defensive checks.

Fixes #456
```

## Testing

### Running Tests

```bash
# Run all tests
bun test

# Watch mode (re-run on changes)
bun test --watch

# Coverage report
bun test --coverage
```

### Writing Tests

- Place tests in the `tests/` directory
- Use descriptive test names
- Follow the existing test structure
- Aim for >80% code coverage

Example test structure:

```typescript
import { describe, test, expect } from "bun:test";

describe("MyNewFeature", () => {
  test("should handle basic case", () => {
    const result = myNewFeature({ input: "test" });
    expect(result).toBe("expected");
  });

  test("should handle edge case", () => {
    const result = myNewFeature({ input: "" });
    expect(result).toBe(null);
  });

  test("should throw on invalid input", () => {
    expect(() => myNewFeature({ input: null })).toThrow();
  });
});
```

### Test Requirements

All pull requests must:
- Include tests for new functionality
- Maintain or improve code coverage
- Pass all existing tests
- Not introduce TypeScript errors or ESLint warnings

## Code Style

### TypeScript Guidelines

- Use **strict mode** (already configured)
- Prefer **explicit types** over `any`
- Use **Zod schemas** for validation
- Follow **functional programming** patterns when appropriate
- Avoid mutations when possible

### Formatting

We use Prettier for code formatting:

```bash
# Format all files
npm run format

# Check formatting
npm run format:check
```

### Linting

We use ESLint with TypeScript support:

```bash
# Run linter
npm run lint

# Auto-fix issues
npm run lint:fix
```

### Code Organization

```
src/
├── models/          # Zod schemas and types
├── core/            # Core functionality (decoder, database)
├── utils/           # Utility functions
├── tools/           # MCP tool implementations
├── server.ts        # MCP server
└── cli.ts           # CLI entry point
```

## Pull Request Process

### Before Submitting

1. **Update from upstream:**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all checks:**
   ```bash
   npm run typecheck
   npm run lint
   bun test
   npm run build
   ```

3. **Update documentation:**
   - Update README.md if adding features
   - Add JSDoc comments for new functions
   - Update CHANGELOG.md (see below)

4. **Test the .mcpb bundle** (for significant changes):
   ```bash
   npm run pack:mcpb
   # Install and test in Claude Desktop
   ```

### Submitting a Pull Request

1. Push your branch to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. Open a pull request on GitHub

3. Fill out the PR template:
   - **Description**: What does this PR do?
   - **Motivation**: Why is this change needed?
   - **Testing**: How was this tested?
   - **Screenshots**: If applicable
   - **Breaking changes**: Any breaking changes?

4. Wait for review and address feedback

### PR Review Criteria

Your PR will be evaluated on:
- **Functionality**: Does it work as intended?
- **Tests**: Are there adequate tests?
- **Code quality**: Is the code clean and maintainable?
- **Documentation**: Is it well documented?
- **Privacy**: Does it maintain privacy commitments?
- **Performance**: Does it maintain or improve performance?

### After Approval

Once approved, a maintainer will merge your PR. The changes will be included in the next release.

## Reporting Issues

### Bug Reports

When reporting bugs, include:

1. **Description**: Clear description of the bug
2. **Steps to reproduce**: Minimal steps to reproduce the issue
3. **Expected behavior**: What should happen
4. **Actual behavior**: What actually happens
5. **Environment**:
   - OS version (macOS version)
   - Node.js version
   - Copilot Money version
   - MCP server version
6. **Logs**: Relevant error messages or logs

### Feature Requests

When requesting features, include:

1. **Description**: What feature do you want?
2. **Motivation**: Why is this feature needed?
3. **Use case**: How would you use this feature?
4. **Alternatives**: Have you considered alternatives?

## Project Structure

### Key Files

- `src/core/decoder.ts` - Binary LevelDB/Protobuf decoder (most complex)
- `src/core/database.ts` - Database abstraction layer
- `src/tools/tools.ts` - MCP tool implementations
- `src/server.ts` - MCP server implementation
- `PRIVACY.md` - Privacy policy (critical for .mcpb compliance)
- `manifest.json` - MCP bundle metadata

### Critical Components

1. **Binary Decoder** (`src/core/decoder.ts`)
   - Parses LevelDB binary format
   - Decodes Protocol Buffers data
   - Most complex component - be careful with changes

2. **MCP Tools** (`src/tools/tools.ts`)
   - All tools MUST have `readOnlyHint: true`
   - This is mandatory for .mcpb approval
   - Don't remove or modify these annotations

3. **Privacy Policy** (`PRIVACY.md`)
   - Must remain accurate
   - Changes require careful review
   - Referenced in manifest.json

## Development Tips

### Local Testing with Claude Desktop

1. Build the project:
   ```bash
   npm run build
   ```

2. Configure Claude Desktop to use local version:
   ```json
   {
     "mcpServers": {
       "copilot-money-dev": {
         "command": "/path/to/copilot-money-mcp/dist/cli.js"
       }
     }
   }
   ```

3. Restart Claude Desktop and test

### Debugging

Enable verbose logging:

```bash
node dist/cli.js --verbose
```

Logs go to stderr (stdout is reserved for MCP protocol).

### Performance Testing

For performance-critical changes:

```bash
# Time a query
time node dist/cli.js
```

Target performance:
- Transaction decoding: <2s
- Query performance: <5s
- Memory usage: <100MB

## Questions?

If you have questions:
- Open a [GitHub Discussion](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/discussions)
- Open an [Issue](https://github.com/ignaciohermosillacornejo/copilot-money-mcp/issues)
- Check existing issues and discussions first

## Thank You!

Your contributions make this project better for everyone. We appreciate your time and effort! 🙏
