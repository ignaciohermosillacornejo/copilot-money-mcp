# GitHub Security Configuration

This document describes the GitHub settings that must be configured **manually** via the GitHub UI to complete the repository security lockdown.

## Required: Branch Protection Rules

Go to **Settings > Branches > Add branch ruleset** (or classic branch protection for older GitHub plans)

### Main Branch Protection

**Branch name pattern:** `main`

Enable these settings:

- [x] **Require a pull request before merging**
  - [x] Require approvals: `1`
  - [x] Dismiss stale pull request approvals when new commits are pushed
  - [x] Require review from Code Owners (CRITICAL - makes CODEOWNERS file work)
  - [x] Require approval of the most recent reviewable push

- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - Required checks:
    - `test` (from test.yml workflow)
    - `check-author` (from claude-review.yml)
    - `review` (from claude-review.yml)

- [x] **Require conversation resolution before merging**

- [x] **Require signed commits** (Optional but recommended)

- [x] **Do not allow bypassing the above settings**
  - This applies to admins too - ensures even you can't bypass

- [x] **Restrict who can push to matching branches**
  - Only allow: `ignaciohermosillacornejo`

- [x] **Block force pushes**

- [x] **Block deletions**

## Required: Repository Settings

### Actions Permissions

Go to **Settings > Actions > General**

- [x] **Fork pull request workflows from outside collaborators**
  - Select: "Require approval for first-time contributors"
  - This prevents fork PRs from running workflows that could exfiltrate secrets

- [x] **Workflow permissions**
  - Select: "Read repository contents and packages permissions"
  - Uncheck: "Allow GitHub Actions to create and approve pull requests"
  - Individual workflows specify their own elevated permissions as needed

### Collaborators & Teams

Go to **Settings > Collaborators and teams**

- Review all collaborators
- Consider using a team for any future trusted contributors
- Remove any collaborators who shouldn't have write access

### Security & Analysis

Go to **Settings > Code security and analysis**

Enable:
- [x] **Dependency graph**
- [x] **Dependabot alerts**
- [x] **Dependabot security updates**
- [x] **Secret scanning**
- [x] **Push protection** (prevents committing secrets)

## Optional: Additional Hardening

### Private vulnerability reporting

Go to **Settings > Security > Advisories**

- [x] Enable private vulnerability reporting

### Tag protection (for releases)

Go to **Settings > Tags > Add rule**

- Pattern: `v*`
- This protects release tags from being moved or deleted

### Environment protection (for publishing)

If you want additional control over npm publishing:

1. Go to **Settings > Environments > New environment**
2. Create environment: `npm-publish`
3. Add protection rules:
   - Required reviewers: `ignaciohermosillacornejo`
   - Wait timer: 0 (or add delay for review)
4. Update npm-publish.yml to use `environment: npm-publish`

## Verification Checklist

After configuring, verify:

- [ ] Cannot push directly to main (should require PR)
- [ ] PRs require approval from owner
- [ ] CODEOWNERS paths require owner approval
- [ ] Workflows cannot be modified without owner review
- [ ] Dependabot alerts are visible in Security tab
- [ ] Secret scanning is active

## Emergency: If Compromised

If you suspect the repository has been compromised:

1. **Revoke all tokens immediately**
   - GitHub PATs
   - npm tokens (even though we use OIDC, check for any manual ones)
   - 1Password service account token (regenerate in 1Password)

2. **Review recent activity**
   - Check Actions history for unexpected runs
   - Review recent commits and force pushes
   - Check for new collaborators or changed permissions

3. **Unpublish compromised packages**
   - `npm unpublish @copilot-money/mcp@<version>` (within 72 hours)
   - Or deprecate: `npm deprecate @copilot-money/mcp@<version> "Security issue"`

4. **Rotate secrets**
   - Generate new 1Password service account token
   - Update GitHub secret `OP_SERVICE_ACCOUNT_TOKEN`

5. **Notify users**
   - Create GitHub security advisory
   - Post on relevant channels
