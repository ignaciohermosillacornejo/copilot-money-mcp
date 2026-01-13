#!/usr/bin/env bun
/**
 * PR Review Audit Agent
 *
 * This script audits Claude's review comments on PRs and creates GitHub issues
 * for any unaddressed suggestions. PRs are marked with 'audited' label after review.
 *
 * Usage:
 *   bun run scripts/audit-pr-reviews.ts [--dry-run] [--pr <number>]
 *
 * Options:
 *   --dry-run    Show what would be done without making changes
 *   --pr <n>     Audit a specific PR number only
 */

import { $ } from 'bun';

const AUDITED_LABEL = 'audited';
const CLAUDE_USERNAMES = ['claude', 'claude[bot]'];
const DRY_RUN = process.argv.includes('--dry-run');

// Validate and parse PR number to prevent command injection
function parseSpecificPR(): number | null {
  const prIndex = process.argv.indexOf('--pr');
  if (prIndex === -1) return null;

  const prArg = process.argv[prIndex + 1];
  if (!prArg) {
    console.error('Error: --pr requires a PR number');
    process.exit(1);
  }

  const prNumber = parseInt(prArg, 10);
  if (isNaN(prNumber) || prNumber <= 0 || prNumber > 1000000) {
    console.error('Error: Invalid PR number. Must be a positive integer.');
    process.exit(1);
  }

  return prNumber;
}

const SPECIFIC_PR = parseSpecificPR();

interface PRComment {
  body: string;
  user: { login: string };
  path?: string;
  line?: number;
  created_at: string;
}

interface PRReview {
  body: string;
  user: { login: string };
  state: string;
}

interface PR {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
}

interface UnaddressedSuggestion {
  prNumber: number;
  prTitle: string;
  suggestion: string;
  file?: string;
  line?: number;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Check if a comment is from Claude
 */
function isClaudeComment(user: string): boolean {
  return CLAUDE_USERNAMES.some(
    (name) => user.toLowerCase() === name.toLowerCase()
  );
}

// Maximum text size to process to prevent ReDoS attacks
const MAX_TEXT_SIZE = 50000;

// Delay between API calls to avoid rate limiting (ms)
const API_DELAY_MS = 500;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract actionable suggestions from review text
 */
function extractSuggestions(text: string): string[] {
  const suggestions: string[] = [];

  // Limit input size to prevent ReDoS
  const safeText = text.slice(0, MAX_TEXT_SIZE);

  // Patterns that indicate suggestions (simplified to reduce backtracking)
  const suggestionPatterns = [
    /(?:suggest|consider|should|could|recommend|would be better|improvement)[:\s]+([^.]{10,200}\.)/gi,
    /(?:TODO|FIXME|NOTE)[:\s]+([^.]{10,200}\.)/gi,
    /\*\*(?:suggestion|issue|problem|concern)[:\s]*\*\*[:\s]*([^.]{10,200}\.)/gi,
    /(?:^|\n)-\s*\[?\s*\]?\s*([^\n]{10,200}(?:should|could|consider|add|fix|update|replace)[^\n]{0,100})/gi,
  ];

  for (const pattern of suggestionPatterns) {
    let match;
    while ((match = pattern.exec(safeText)) !== null) {
      const suggestion = match[1]?.trim();
      if (suggestion && suggestion.length > 20 && suggestion.length < 500) {
        suggestions.push(suggestion);
      }
    }
  }

  // Also look for code blocks with suggestions
  const codeBlockPattern = /```(?:suggestion|diff)?\n([\s\S]*?)```/g;
  let codeMatch;
  while ((codeMatch = codeBlockPattern.exec(safeText)) !== null) {
    if (codeMatch[1]?.includes('+') || codeMatch[1]?.includes('-')) {
      suggestions.push(`Code change suggested: ${codeMatch[1].slice(0, 200)}...`);
    }
  }

  return [...new Set(suggestions)]; // Dedupe
}

/**
 * Determine priority based on keywords
 */
function determinePriority(text: string): 'high' | 'medium' | 'low' {
  const lowerText = text.toLowerCase();

  if (
    lowerText.includes('critical') ||
    lowerText.includes('security') ||
    lowerText.includes('breaking') ||
    lowerText.includes('bug') ||
    lowerText.includes('error')
  ) {
    return 'high';
  }

  if (
    lowerText.includes('performance') ||
    lowerText.includes('should') ||
    lowerText.includes('recommend')
  ) {
    return 'medium';
  }

  return 'low';
}

/**
 * Check if suggestion appears to be addressed (very basic heuristic)
 */
function isLikelyAddressed(suggestion: string, prState: string): boolean {
  // If PR is merged/closed, we assume blocking issues were addressed
  // Non-blocking suggestions may still be unaddressed
  const nonBlockingKeywords = [
    'optional',
    'consider',
    'could',
    'might',
    'nice to have',
    'non-blocking',
    'minor',
  ];

  const isNonBlocking = nonBlockingKeywords.some((kw) =>
    suggestion.toLowerCase().includes(kw)
  );

  // For merged PRs, only flag non-blocking items as potentially unaddressed
  if (prState === 'MERGED') {
    return !isNonBlocking;
  }

  return false;
}

/**
 * Get all PRs from the repository
 */
async function getPRs(): Promise<PR[]> {
  const result =
    await $`gh pr list --state all --limit 200 --json number,title,state,labels`.text();
  return JSON.parse(result);
}

/**
 * Get review comments for a PR
 */
async function getPRComments(prNumber: number): Promise<PRComment[]> {
  try {
    const result =
      await $`gh api repos/{owner}/{repo}/pulls/${prNumber}/comments`.text();
    return JSON.parse(result);
  } catch {
    return [];
  }
}

/**
 * Get reviews for a PR
 */
async function getPRReviews(prNumber: number): Promise<PRReview[]> {
  try {
    const result =
      await $`gh api repos/{owner}/{repo}/pulls/${prNumber}/reviews`.text();
    return JSON.parse(result);
  } catch {
    return [];
  }
}

/**
 * Check if an issue already exists for a suggestion
 */
async function issueExists(prNumber: number, suggestion: string): Promise<boolean> {
  try {
    const searchQuery = `repo:{owner}/{repo} is:issue "PR #${prNumber}" in:body`;
    const result = await $`gh issue list --search ${searchQuery} --json number,body`.text();
    const issues = JSON.parse(result);

    // Check if any issue contains this suggestion (fuzzy match)
    const suggestionWords = suggestion.toLowerCase().split(/\s+/).slice(0, 5);
    return issues.some((issue: { body: string }) =>
      suggestionWords.every((word) => issue.body?.toLowerCase().includes(word))
    );
  } catch {
    return false;
  }
}

/**
 * Create a GitHub issue for unaddressed suggestions
 */
async function createIssue(suggestions: UnaddressedSuggestion[]): Promise<void> {
  if (suggestions.length === 0) return;

  const prNumber = suggestions[0].prNumber;
  const prTitle = suggestions[0].prTitle;

  const body = `## Unaddressed Review Suggestions from PR #${prNumber}

**PR Title:** ${prTitle}

The following suggestions from Claude's code review were identified as potentially unaddressed:

${suggestions
  .map(
    (s, i) => `### ${i + 1}. ${s.priority.toUpperCase()} Priority
${s.file ? `**File:** \`${s.file}\`${s.line ? `:${s.line}` : ''}` : ''}

${s.suggestion}
`
  )
  .join('\n')}

---
*This issue was automatically created by the PR Review Audit Agent.*
`;

  const title = `[Audit] Unaddressed suggestions from PR #${prNumber}`;
  const labels = 'audit,review-followup';

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create issue: "${title}"`);
    console.log(`Body preview:\n${body.slice(0, 500)}...`);
    return;
  }

  await $`gh issue create --title ${title} --body ${body} --label ${labels}`;
  console.log(`Created issue for PR #${prNumber}`);
}

/**
 * Add audited label to a PR
 */
async function markAsAudited(prNumber: number): Promise<void> {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would mark PR #${prNumber} as audited`);
    return;
  }

  try {
    await $`gh pr edit ${prNumber} --add-label ${AUDITED_LABEL}`.quiet();
    console.log(`Marked PR #${prNumber} as audited`);
  } catch (error) {
    console.error(`Failed to mark PR #${prNumber} as audited:`, error);
  }
}

/**
 * Audit a single PR
 */
async function auditPR(pr: PR): Promise<UnaddressedSuggestion[]> {
  console.log(`Auditing PR #${pr.number}: ${pr.title}`);

  const suggestions: UnaddressedSuggestion[] = [];

  // Get comments and reviews
  const [comments, reviews] = await Promise.all([
    getPRComments(pr.number),
    getPRReviews(pr.number),
  ]);

  // Process inline comments
  for (const comment of comments) {
    if (!isClaudeComment(comment.user.login)) continue;

    const extracted = extractSuggestions(comment.body);
    for (const suggestion of extracted) {
      if (!isLikelyAddressed(suggestion, pr.state)) {
        suggestions.push({
          prNumber: pr.number,
          prTitle: pr.title,
          suggestion,
          file: comment.path,
          line: comment.line,
          priority: determinePriority(suggestion),
        });
      }
    }
  }

  // Process review bodies
  for (const review of reviews) {
    if (!isClaudeComment(review.user.login)) continue;
    if (!review.body) continue;

    const extracted = extractSuggestions(review.body);
    for (const suggestion of extracted) {
      if (!isLikelyAddressed(suggestion, pr.state)) {
        suggestions.push({
          prNumber: pr.number,
          prTitle: pr.title,
          suggestion,
          priority: determinePriority(suggestion),
        });
      }
    }
  }

  return suggestions;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('PR Review Audit Agent');
  console.log('=====================');
  if (DRY_RUN) console.log('[DRY RUN MODE - No changes will be made]\n');

  // Ensure audited label exists
  if (!DRY_RUN) {
    try {
      await $`gh label create ${AUDITED_LABEL} --description "PR has been reviewed in audit" --color "0E8A16"`.quiet();
    } catch {
      // Label already exists
    }
  }

  // Get PRs to audit
  let prs = await getPRs();

  // Filter to specific PR if requested
  if (SPECIFIC_PR) {
    prs = prs.filter((pr) => pr.number === SPECIFIC_PR);
    if (prs.length === 0) {
      console.error(`PR #${SPECIFIC_PR} not found`);
      process.exit(1);
    }
  } else {
    // Filter out already audited PRs
    prs = prs.filter((pr) => !pr.labels.some((l) => l.name === AUDITED_LABEL));
  }

  console.log(`Found ${prs.length} PRs to audit\n`);

  if (prs.length === 0) {
    console.log('No PRs to audit. All PRs have been previously audited.');
    return;
  }

  // Audit each PR
  const allSuggestions: Map<number, UnaddressedSuggestion[]> = new Map();

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i];
    const suggestions = await auditPR(pr);

    if (suggestions.length > 0) {
      // Check if issue already exists
      const exists = await issueExists(pr.number, suggestions[0].suggestion);
      if (!exists) {
        allSuggestions.set(pr.number, suggestions);
      } else {
        console.log(`  Issue already exists for PR #${pr.number}, skipping`);
      }
    }

    // Mark as audited
    await markAsAudited(pr.number);

    // Rate limiting: add delay between PRs (except for last one)
    if (i < prs.length - 1) {
      await sleep(API_DELAY_MS);
    }
  }

  // Create issues for unaddressed suggestions
  console.log('\n--- Creating Issues ---\n');

  for (const [prNumber, suggestions] of allSuggestions) {
    if (suggestions.length > 0) {
      console.log(
        `PR #${prNumber}: ${suggestions.length} unaddressed suggestion(s)`
      );
      await createIssue(suggestions);
    }
  }

  // Summary
  console.log('\n--- Summary ---');
  console.log(`PRs audited: ${prs.length}`);
  console.log(`PRs with unaddressed suggestions: ${allSuggestions.size}`);
  console.log(
    `Total suggestions found: ${[...allSuggestions.values()].flat().length}`
  );
}

main().catch(console.error);
