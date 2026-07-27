#!/usr/bin/env python3
"""Validate the SKILL.md files under skills/.

Checks:
1. Frontmatter — every skills/<name>/SKILL.md has YAML frontmatter with
   `name:` matching <name> and `description:` non-empty.
2. MCP tool references resolve against the server's own tool registry.
3. Profile path is canonical (~/.claude/copilot-money/user-profile.md),
   except for the literal template reference skills/user-profile.template.md.

Check 2 gets its tool list from `scripts/dump-tool-names.ts`, which imports
`ALL_TOOL_DEFS` — the same registry the server builds dispatch from. This
script used to scrape `name: '...'` literals out of TypeScript instead, which
failed open: when the schemas moved to `src/tools/registry/`, the parse
collapsed to one incidental literal and every skill reference was reported as
an unknown tool. That reads as dozens of skill bugs when it is really one
linter bug. Asking the registry directly removes the failure mode rather than
guarding it — a move that breaks the import fails typecheck loudly.

Exit 1 on any failure with a clear per-check message.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Overridable so tests can point the linter at a synthetic repo tree.
REPO_ROOT = Path(
    os.environ.get("CHECK_SKILLS_REPO_ROOT")
    or Path(__file__).resolve().parent.parent
).resolve()
SKILLS_DIR = REPO_ROOT / "skills"
DUMP_SCRIPT = REPO_ROOT / "scripts" / "dump-tool-names.ts"

# Prefixes that look like MCP tool names in our skills (kept narrow to
# avoid matching English words that happen to share a prefix).
# Note: "tag_" is intentionally absent — no tools start with it and
# it would match parameter names like `tag_ids`.
TOOL_PREFIXES = (
    "get_",
    "set_",
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


class ToolLookupError(Exception):
    """The tool registry could not be enumerated.

    Always a fault in this linter or its environment, never in the skills —
    callers must report it as such and validate nothing.
    """


def collect_all_tool_names() -> set[str]:
    """Ask the registry for every dispatchable tool name.

    Runs `scripts/dump-tool-names.ts` under bun and reads back a JSON array.
    Every failure mode is raised as ToolLookupError so the caller reports one
    linter fault instead of blaming every skill reference — the whole point of
    the bug this replaced.
    """
    bun = shutil.which("bun")
    if bun is None:
        raise ToolLookupError(
            "bun is not on PATH, so the tool registry cannot be enumerated"
        )
    if not DUMP_SCRIPT.exists():
        raise ToolLookupError(f"{DUMP_SCRIPT} is missing")

    try:
        proc = subprocess.run(
            [bun, "run", str(DUMP_SCRIPT)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise ToolLookupError(f"{DUMP_SCRIPT.name} timed out after 120s") from None

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        tail = detail[-1] if detail else "no output"
        raise ToolLookupError(
            f"{DUMP_SCRIPT.name} exited {proc.returncode}: {tail}"
        )

    try:
        names = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ToolLookupError(
            f"{DUMP_SCRIPT.name} did not print valid JSON ({exc})"
        ) from None

    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ToolLookupError(
            f"{DUMP_SCRIPT.name} printed {type(names).__name__}, expected a JSON "
            "array of strings"
        )
    if not names:
        # A registry that enumerates nothing is the degenerate answer that let
        # the original bug through. Refuse it rather than validating against it.
        raise ToolLookupError(f"{DUMP_SCRIPT.name} returned an empty tool list")

    return set(names)


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
    # Gate the whole run: without a trustworthy tool list every downstream
    # tool-ref error is a false positive, so report the linter and stop.
    try:
        known_tools = collect_all_tool_names()
    except ToolLookupError as exc:
        print(
            f"FAIL: linter self-check: {exc}. Skill references were NOT validated.",
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
