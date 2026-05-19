#!/usr/bin/env python3
"""Validate the SKILL.md files under skills/.

Checks:
1. Frontmatter — every skills/<name>/SKILL.md has YAML frontmatter with
   `name:` matching <name> and `description:` non-empty.
2. MCP tool references resolve against src/tools/tools.ts.
3. Profile path is canonical (~/.claude/copilot-money/user-profile.md),
   except for the literal template reference skills/user-profile.template.md.

Exit 1 on any failure with a clear per-check message.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = REPO_ROOT / "skills"
TOOLS_FILE = REPO_ROOT / "src" / "tools" / "tools.ts"
TOOLS_DIR = REPO_ROOT / "src" / "tools"

# Prefixes that look like MCP tool names in our skills (kept narrow to
# avoid matching English words that happen to share a prefix).
# Note: "tag_" is intentionally absent — no tools start with it and
# it would match parameter names like `tag_ids`.
TOOL_PREFIXES = (
    "get_",
    "set_",
    "categorize_",
    "split_",
    "create_",
    "review_",
    "refresh_",
    "update_",
    "delete_",
    "add_",
)

ALLOWED_PROFILE_PATHS = (
    "~/.claude/copilot-money/user-profile.md",
    "$HOME/.claude/copilot-money/user-profile.md",
    "skills/user-profile.template.md",
)


def parse_tool_names(tools_src: str) -> set[str]:
    """Extract tool names from a TypeScript tools source string.

    Tool names appear as `name: 'tool_name'` or `name: "tool_name"` in
    TypeScript object literals. We extract them by string match.
    """
    return set(re.findall(r"""name:\s*['"]([a-z_][a-z0-9_]*)['"]""", tools_src))


def collect_all_tool_names() -> set[str]:
    """Collect tool names from tools.ts and all src/tools/live/*.ts files."""
    if not TOOLS_FILE.exists():
        return set()
    names = parse_tool_names(TOOLS_FILE.read_text())
    live_dir = TOOLS_DIR / "live"
    if live_dir.is_dir():
        for ts_file in live_dir.glob("*.ts"):
            names |= parse_tool_names(ts_file.read_text())
    return names


def check_frontmatter(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        errors.append(f"{skill_dir.name}: missing SKILL.md")
        return errors
    content = skill_md.read_text()
    fm_match = re.match(r"^---\n(.*?)\n---\n", content, re.DOTALL)
    if not fm_match:
        errors.append(f"{skill_dir.name}: missing YAML frontmatter")
        return errors
    fm = fm_match.group(1)
    name_match = re.search(r"^name:\s*(.+)$", fm, re.MULTILINE)
    if not name_match:
        errors.append(f"{skill_dir.name}: frontmatter missing `name:`")
    else:
        actual = name_match.group(1).strip().strip("\"'")
        if actual != skill_dir.name:
            errors.append(
                f"{skill_dir.name}: frontmatter `name:` ({actual!r}) "
                f"does not match directory name ({skill_dir.name!r})"
            )
    desc_match = re.search(r"^description:\s*(.+)$", fm, re.MULTILINE)
    if not desc_match or not desc_match.group(1).strip().strip("\"'"):
        errors.append(
            f"{skill_dir.name}: frontmatter missing or empty `description:`"
        )
    return errors


def check_tool_refs(skill_dir: Path, known_tools: set[str]) -> list[str]:
    errors: list[str] = []
    content = (skill_dir / "SKILL.md").read_text()
    backtick_tokens = re.findall(r"`([a-z_][a-z0-9_]*)`", content)
    seen: set[str] = set()
    for tok in backtick_tokens:
        if tok in seen:
            continue
        seen.add(tok)
        if not any(tok.startswith(p) for p in TOOL_PREFIXES):
            continue
        if tok not in known_tools:
            errors.append(
                f"{skill_dir.name}: references unknown MCP tool `{tok}`"
            )
    return errors


def check_profile_path(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    content = (skill_dir / "SKILL.md").read_text()
    for line_no, line in enumerate(content.splitlines(), start=1):
        if "user-profile" not in line:
            continue
        # Extract every contiguous non-whitespace token that mentions user-profile
        for token in re.findall(r"\S*user-profile[^\s`]*", line):
            # Strip surrounding markdown punctuation (backticks, quotes, parens, commas)
            stripped = token.strip("`'\"(),.[]")
            if stripped in ALLOWED_PROFILE_PATHS:
                continue
            errors.append(
                f"{skill_dir.name}:SKILL.md:{line_no}: "
                f"non-canonical profile path: {stripped[:120]}"
            )
    return errors


def main() -> int:
    if not TOOLS_FILE.exists():
        print(
            f"ERROR: tools.ts not found at {TOOLS_FILE}", file=sys.stderr
        )
        return 1
    known_tools = collect_all_tool_names()
    if not known_tools:
        print(
            "ERROR: parsed 0 tool names from tools.ts — check the regex",
            file=sys.stderr,
        )
        return 1

    all_errors: list[str] = []
    skill_dirs = sorted(
        d
        for d in SKILLS_DIR.iterdir()
        if d.is_dir() and not d.name.startswith("_")
    )
    if not skill_dirs:
        print(f"ERROR: no skills under {SKILLS_DIR}", file=sys.stderr)
        return 1

    for skill_dir in skill_dirs:
        fm_errs = check_frontmatter(skill_dir)
        all_errors.extend(fm_errs)
        if (skill_dir / "SKILL.md").exists():
            all_errors.extend(check_tool_refs(skill_dir, known_tools))
            all_errors.extend(check_profile_path(skill_dir))

    if all_errors:
        for err in all_errors:
            print(f"FAIL: {err}", file=sys.stderr)
        print(f"\n{len(all_errors)} error(s)", file=sys.stderr)
        return 1
    print(f"OK: {len(skill_dirs)} skills validated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
