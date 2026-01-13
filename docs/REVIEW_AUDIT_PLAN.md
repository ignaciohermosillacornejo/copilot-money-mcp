# Review Audit Plan

**Audit Date:** 2026-01-13
**PRs Audited:** #1 - #48
**Auditor:** Claude Code

This document tracks all unaddressed suggestions from Claude's code reviews across all PRs.

---

## High Priority

### 1. Incomplete Math.round Refactor (PR #42)

**Status:** Unaddressed
**File:** `src/tools/tools.ts`
**Issue:** 21+ instances of `Math.round(x * 100) / 100` pattern not replaced with `roundAmount()` helper

**Affected Lines:**
- 827, 1405, 1558, 3798, 4273, 4284, 4675, 5173, 5177
- Additional instances throughout the file

**Action Required:**
```typescript
// Replace patterns like:
Math.round((data.total / totalSpending) * 10000) / 100
// With:
roundAmount((data.total / totalSpending) * 100)
```

**Complexity:** Medium - mechanical find/replace with testing

---

### 2. Tool Count Sync (PR #48)

**Status:** Unaddressed
**File:** `CLAUDE.md` line 50
**Issue:** States "All 28 MCP tools" but actual count may differ

**Action Required:**
- Verify actual tool count in manifest.json
- Update CLAUDE.md to match

**Complexity:** Low - simple documentation update

---

## Medium Priority

### 3. Large Dataset Handling (PR #19)

**Status:** Unaddressed
**File:** `src/tools/tools.ts` - Data quality report
**Issue:** Processes up to 50K transactions in memory

**Action Required:**
- Consider streaming or pagination for very large datasets
- Add configurable limit parameter

**Complexity:** Medium - requires architectural consideration

---

### 4. Configurable Thresholds (PR #19)

**Status:** Unaddressed
**File:** `src/tools/tools.ts`
**Issue:** Currency amount thresholds are hardcoded

**Action Required:**
- Extract thresholds to configuration
- Allow user override via parameters

**Complexity:** Low-Medium

---

### 5. Upper Bounds Validation (PR #19)

**Status:** Unaddressed
**File:** `src/tools/tools.ts`
**Issue:** No validation for extremely large transaction amounts

**Action Required:**
- Add sanity checks for unrealistic amounts
- Flag potential data quality issues

**Complexity:** Low

---

### 6. Path Resolution Robustness (PR #44)

**Status:** Unaddressed
**File:** `tests/unit/manifest-sync.test.ts` line 24
**Issue:** Uses `import.meta.dir` which may have compatibility issues

**Current Code:**
```typescript
const manifestPath = join(import.meta.dir, '../../manifest.json');
```

**Suggested Fix:**
```typescript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(__dirname, '../../manifest.json');
```

**Complexity:** Low

---

### 7. Description Truncation Edge Cases (PR #44)

**Status:** Unaddressed
**File:** `scripts/sync-manifest.ts`
**Issue:** Description truncation uses `split('. ')[0]` which fails for descriptions without periods

**Action Required:**
- Handle edge cases where description has no period
- Consider max length truncation as fallback

**Complexity:** Low

---

## Low Priority (Optional)

### 8. Branch Protection Check (PR #45)

**Status:** Unaddressed
**File:** `.github/workflows/delete-merged-branch.yml`
**Issue:** No validation to prevent deletion of main/master branches

**Note:** Currently relies on GitHub branch protection rules

**Complexity:** Low

---

### 9. Test Bail Flag (PR #21)

**Status:** Unaddressed
**File:** Pre-commit hook configuration
**Issue:** Tests don't use `--bail` flag for faster feedback

**Action Required:**
- Add `--bail` to test command in pre-commit hook

**Complexity:** Trivial

---

### 10. Path Validation in Cleanup (PR #10)

**Status:** Unaddressed
**File:** Test utilities
**Issue:** `cleanupFixtures()` lacks path validation

**Complexity:** Low

---

### 11. Test Data Dates (PR #10)

**Status:** Unaddressed
**File:** Test fixtures
**Issue:** Some tests use future dates instead of past dates

**Complexity:** Low

---

### 12. Decoder Hang Investigation (PR #10)

**Status:** Unaddressed
**File:** `src/core/decoder.ts`
**Issue:** Decoder tests can hang under certain conditions

**Note:** May have been resolved in subsequent changes

**Complexity:** Unknown - requires investigation

---

## Not Applicable (Code Removed)

The following suggestions from PRs #29, #30, #32 are no longer applicable because the code was removed during tool consolidation (PR #41):

- PR #29: Date validation, non-null assertions, test coverage for balance history
- PR #30: Field name inconsistency, floating-point division, magic numbers
- PR #32: Array copying efficiency, decoder window size, floating-point precision

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| High | 2 | To Do |
| Medium | 5 | To Do |
| Low | 5 | Optional |
| N/A | 9 | Closed |

---

## Next Steps

1. [ ] Address high priority items first
2. [ ] Create individual issues/PRs for medium priority items
3. [ ] Low priority items can be addressed opportunistically
4. [ ] Mark N/A items as closed (code no longer exists)

---

*This plan was generated from a comprehensive audit of all 48 PRs in the repository.*
