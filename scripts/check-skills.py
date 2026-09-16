#!/usr/bin/env python3
"""Validate the SKILL.md files under skills/.

Checks:
1. Frontmatter — every skills/<name>/SKILL.md has YAML frontmatter with
   `name:` matching <name> and `description:` non-empty.
2. MCP tool references resolve against the server's own tool registry.
3. Profile path is canonical (~/.claude/copilot-money/user-profile.md),
   except for the literal template reference skills/user-profile.template.md.
4. Field references resolve against the referenced tool's DEFAULT field
   preset (#704) — see "Check 4" below.

Check 2 gets its tool list from `scripts/dump-tool-names.ts`, which imports
`ALL_TOOL_DEFS` — the same registry the server builds dispatch from. This
script used to scrape `name: '...'` literals out of TypeScript instead, which
failed open: when the schemas moved to `src/tools/registry/`, the parse
collapsed to one incidental literal and every skill reference was reported as
an unknown tool. That reads as dozens of skill bugs when it is really one
linter bug. Asking the registry directly removes the failure mode rather than
guarding it — a move that breaks the import fails typecheck loudly.

Check 4 (the #704 field detector) exists because the v3 context diet made
every skill a caller of a NARROWER response. A skill telling its agent to read
a field that the tool's `"default"` preset no longer returns is not an error
anywhere — the row simply arrives without the key — so it fails silently at
use time. PR #703 shipped three such instructions and hand-auditing missed all
three; this is the mechanical replacement for that audit.

The rule, deliberately narrow (see LIMITATIONS):
  - A tool is "terse by default" when it BOTH declares a `DEFAULT_*_FIELDS`
    preset and defaults to it via the `x.fields ?? ['default']` idiom. Both
    halves are discovered from the source, never listed here.
  - On a line that references such a tool in backticks and passes no
    `fields:` argument, every OTHER backticked identifier that is a known
    field name somewhere in this server's models — but is not in that tool's
    preset, and is not an argument name of a tool NAMED ON THAT LINE — is
    reported. Scoping the argument exemption to the line, rather than to a
    union over every tool in the repo, is what lets the check see a name with
    two jobs: `tag_ids` is an `update_transaction` parameter AND a transaction
    row field the v3 diet dropped.

LIMITATIONS (documented rather than silently tolerated):
  - Proximity is one LINE. A field named two lines below its tool reference is
    not seen. Widening to a 3-line window was measured against the checked-in
    skills and pulled in prose tokens (category names, unrelated payload keys)
    at a rate that would have trained readers to ignore the check.
  - A backticked token that is not in the model vocabulary (`jq`, a CLI name)
    is never reported, so a genuinely misspelled field slips through. That is
    the same trade: the vocabulary is what keeps English out of the check.
  - The argument exemption keys on BACKTICKED tool names, because `tokens` is
    what the backtick regex found. A line that names the second tool in plain
    prose ("...then call update_transaction with the new `category_id`") still
    reports. Every tool mention in the checked-in skills is backticked today,
    so this is latent; it is the same shape as the bug the line-scoping fixed,
    recorded rather than silently tolerated.
  - The price of scoping the argument exemption to the line is that PROSE
    naming a dropped row field next to a terse tool now reports, where the
    repo-wide union would have swallowed it if any tool happened to take that
    name as an argument. The remedy is the one already in the failure message
    — drop the backticks — and it is the intended trade, not a bug: a line
    that cannot be told from an instruction is worth one look.
  - Both remedies are in the failure message: add the `fields:` argument when
    the line really does instruct a read, or drop the backticks when it is
    prose ABOUT a field rather than an instruction to read one.

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
ARGS_SCRIPT = REPO_ROOT / "scripts" / "dump-tool-args.ts"

# Sources check 4 reads. Only field-selection.ts is mandatory: it is the one
# file that decides what a terse row contains, so its absence means the check
# cannot run at all, while a missing live/ or registry/ directory just yields
# fewer tools (and is caught by the attribution invariant below).
SRC_TOOLS = REPO_ROOT / "src" / "tools"
FIELD_SELECTION_TS = SRC_TOOLS / "field-selection.ts"
TOOLS_TS = SRC_TOOLS / "tools.ts"
REGISTRY_DIR = SRC_TOOLS / "registry"
LIVE_DIR = SRC_TOOLS / "live"
MODELS_DIR = REPO_ROOT / "src" / "models"

# Prefixes that look like MCP tool names in our skills (kept narrow to
# avoid matching English words that happen to share a prefix).
# Note: "tag_" is intentionally absent — no tools start with it and
# it would match parameter names like `tag_ids`.
TOOL_PREFIXES = (
    "get_",
    "set_",
    "split_",
    "bulk_",
    "create_",
    "review_",
    "refresh_",
    "update_",
    "delete_",
    "add_",
)

# Tool PARAMETER names that happen to start with a TOOL_PREFIXES entry.
# Without this, documenting a parameter in backticks reads as a reference to a
# nonexistent tool (e.g. `add_tag_ids` matches the "add_" prefix used by
# add_transaction_to_recurring). Keep this list to real parameter names.
KNOWN_TOOL_PARAMS = frozenset(
    {
        "add_tag_ids",
        "remove_tag_ids",
        "split_transactions",
        "update_existing",
    }
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


def _run_dump_script(script: Path) -> object:
    """Run one `scripts/dump-*.ts` under bun and parse its JSON stdout.

    Every failure mode is raised as ToolLookupError so the caller reports one
    linter fault instead of blaming every skill reference — the whole point of
    the bug this replaced. Shape validation is the caller's job (the two dump
    scripts print different shapes).
    """
    bun = shutil.which("bun")
    if bun is None:
        raise ToolLookupError(
            "bun is not on PATH, so the tool registry cannot be enumerated"
        )
    if not script.exists():
        raise ToolLookupError(f"{script} is missing")

    try:
        proc = subprocess.run(
            [bun, "run", str(script)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise ToolLookupError(f"{script.name} timed out after 120s") from None

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        tail = detail[-1] if detail else "no output"
        raise ToolLookupError(f"{script.name} exited {proc.returncode}: {tail}")

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ToolLookupError(
            f"{script.name} did not print valid JSON ({exc})"
        ) from None


def collect_all_tool_names() -> set[str]:
    """Ask the registry for every dispatchable tool name."""
    names = _run_dump_script(DUMP_SCRIPT)

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


def collect_tool_args() -> dict[str, set[str]]:
    """Ask the registry for every tool's INPUT ARGUMENT names.

    Check 4 needs these to tell a documented parameter (`exclude_transfers`,
    `period`, `limit`) apart from a documented row FIELD. Without the split,
    every skill that names a parameter in backticks next to its tool reads as
    a request for a field the terse row dropped.
    """
    args = _run_dump_script(ARGS_SCRIPT)

    if not isinstance(args, dict) or not all(
        isinstance(name, str)
        and isinstance(props, list)
        and all(isinstance(p, str) for p in props)
        for name, props in args.items()
    ):
        raise ToolLookupError(
            f"{ARGS_SCRIPT.name} printed {type(args).__name__}, expected a JSON "
            "object of tool name -> array of argument names"
        )
    if not args:
        raise ToolLookupError(f"{ARGS_SCRIPT.name} returned an empty tool list")
    # An empty MAP is not the shape a broken collector produces. Renaming the
    # schema field it reads yields {"get_transactions": [], "get_accounts": [],
    # ...} — a non-empty map of empty lists, which passes both checks above and
    # silently turns every argument name in the repo into a candidate row
    # field. Under-collection indistinguishable from a pass, in the map that
    # exists to prevent a false positive.
    if not any(args.values()):
        raise ToolLookupError(
            f"{ARGS_SCRIPT.name} returned {len(args)} tools and not one argument "
            "between them — the collector is reading the wrong schema field, not "
            "describing a registry where no tool takes arguments"
        )

    return {name: set(props) for name, props in args.items()}


# --- Check 4: terse-default field references (#704) -------------------------
#
# Discovery mirrors tests/tools/registry/diet-fields-disclosure.test.ts, which
# sweeps the same two tool shapes for the same idiom. Neither file hand-lists
# the tools: a tool that goes terse-by-default tomorrow is covered the day it
# lands, and a tool that drops out of the idiom is reported rather than
# silently skipped.

#: `export const DEFAULT_X_FIELDS = [ ... ] as const` in field-selection.ts.
PRESET_DECL_RE = re.compile(
    r"^export const (DEFAULT_[A-Z0-9_]+_FIELDS)\s*=\s*\[(.*?)\]\s*as const",
    re.MULTILINE | re.DOTALL,
)
STRING_LITERAL_RE = re.compile(r"['\"]([^'\"]+)['\"]")
#: `preset: DEFAULT_X_FIELDS` — how a handler hands its preset to projectRows.
PRESET_USE_RE = re.compile(r"preset:\s*(DEFAULT_[A-Z0-9_]+_FIELDS)")
#: `x.fields ?? ['default']` — the terse-by-default fallback, verbatim.
DEFAULT_IDIOM_RE = re.compile(r"\.fields\s*\?\?\s*\[['\"]default['\"]\]")
#: A function/method DECLARATION: line-anchored at 0 or 2 spaces of indent.
FN_HEADER_RE = re.compile(
    r"^(?: {2})?(?:export\s+)?(?:private\s+|public\s+|protected\s+|static\s+)*"
    r"(?:async\s+)?(?:function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<.*>)?\s*\(",
    re.MULTILINE,
)
#: Control-flow keywords FN_HEADER_RE can otherwise mistake for a declaration.
NOT_A_FUNCTION_NAME = frozenset(
    {"if", "for", "while", "switch", "catch", "return", "constructor", "new", "typeof"}
)
#: A zod object key (`transaction_id: z.string(),`) in src/models/*.ts.
ZOD_KEY_RE = re.compile(r"^\s+([A-Za-z_][A-Za-z0-9_]*):\s*z\.", re.MULTILINE)
#: A live row mapper key (`account_id: (n) => n.accountId,`) in src/tools/live.
MAPPER_KEY_RE = re.compile(r"^\s+([A-Za-z_][A-Za-z0-9_]*):\s*\(", re.MULTILINE)
#: A backticked bare identifier in a SKILL.md — snake_case or camelCase.
BACKTICK_IDENT_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")


def _read_source(path: Path, mandatory: bool = False) -> str:
    if not path.exists():
        if mandatory:
            raise ToolLookupError(
                f"{path} is missing, so no tool's default row can be resolved"
            )
        return ""
    return path.read_text()


def _ts_files(directory: Path, skip: frozenset[str] = frozenset()) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        f for f in directory.iterdir() if f.suffix == ".ts" and f.name not in skip
    )


def parse_field_presets() -> dict[str, list[str]]:
    """`DEFAULT_X_FIELDS` -> its field names, read from field-selection.ts."""
    presets = {
        m.group(1): STRING_LITERAL_RE.findall(m.group(2))
        for m in PRESET_DECL_RE.finditer(_read_source(FIELD_SELECTION_TS, mandatory=True))
    }
    if not presets:
        # The file exists but the declaration regex matched nothing: the
        # preset style changed. Every field reference would then validate
        # against an empty world, which is the vacuous pass this check exists
        # to prevent.
        raise ToolLookupError(
            f"{FIELD_SELECTION_TS.name} declares no DEFAULT_*_FIELDS presets that "
            "this linter can read — its parser needs updating"
        )
    return presets


def _enclosing_function(text: str, index: int) -> str | None:
    """Name of the function/method declaration nearest ABOVE `index`."""
    found = None
    for m in FN_HEADER_RE.finditer(text):
        if m.start() > index:
            break
        if m.group(1) in NOT_A_FUNCTION_NAME:
            continue
        found = m.group(1)
    return found


def _method_to_tool_name() -> dict[str, str]:
    """`CopilotMoneyTools` method name -> the tool name wired to it."""
    mapping: dict[str, str] = {}
    for path in _ts_files(REGISTRY_DIR, frozenset({"live.ts", "types.ts", "index.ts"})):
        text = path.read_text()
        for block in re.split(
            r"\n(?=export const [A-Za-z0-9_]+ = defineTool\()", text
        ):
            if "defineTool(" not in block:
                continue
            name = re.search(r"name:\s*'([^']+)'", block)
            method = re.search(r"ctx\.tools\.([A-Za-z0-9_]+)\(", block)
            if name and method:
                mapping[method.group(1)] = name.group(1)
    return mapping


def _cache_tools_owning(text: str, index: int, method_to_tool: dict[str, str]) -> list[str]:
    """Which cache tool(s) a src/tools/tools.ts match at `index` belongs to.

    Direct case: the match sits inside a method the registry wires to a tool.
    Helper case: it sits inside a module-level helper (projectTransactionFields)
    — then it belongs to every wired method that CALLS that helper.
    """
    fn = _enclosing_function(text, index)
    if fn is None:
        return []
    if fn in method_to_tool:
        return [method_to_tool[fn]]
    owners = []
    for call in re.finditer(r"\b" + re.escape(fn) + r"\(", text):
        caller = _enclosing_function(text, call.start())
        if caller is not None and caller != fn and caller in method_to_tool:
            owners.append(method_to_tool[caller])
    return owners


def _live_tool_name(path: Path, text: str) -> str:
    """The single tool name a src/tools/live/*.ts file defines."""
    names = re.findall(r"name:\s*'([^']+)'", text)
    if len(names) != 1:
        raise ToolLookupError(
            f"src/tools/live/{path.name} takes part in field selection but carries "
            f"{len(names)} schema name literals ({', '.join(names) or 'none'}) — "
            "per-file name resolution assumes one tool per live file"
        )
    return names[0]


def _scan(pattern: re.Pattern[str], method_to_tool: dict[str, str]) -> dict[str, set[str]]:
    """Tool name -> the `pattern` captures found in that tool's handler code."""
    found: dict[str, set[str]] = {}
    tools_ts = _read_source(TOOLS_TS)
    for m in pattern.finditer(tools_ts):
        owners = _cache_tools_owning(tools_ts, m.start(), method_to_tool)
        if not owners:
            raise ToolLookupError(
                f"src/tools/tools.ts uses {m.group(0)!r} in a function this linter "
                "cannot attribute to any registered tool — its resolver needs updating"
            )
        for owner in owners:
            found.setdefault(owner, set()).add(m.group(m.lastindex or 0))
    for path in _ts_files(LIVE_DIR):
        text = path.read_text()
        captures = {m.group(m.lastindex or 0) for m in pattern.finditer(text)}
        if captures:
            found.setdefault(_live_tool_name(path, text), set()).update(captures)
    return found


def collect_terse_default_tools() -> dict[str, set[str]]:
    """Tool name -> the exact field set its response carries by default.

    A tool qualifies only when it BOTH declares a preset and falls back to it
    (`x.fields ?? ['default']`). A tool that merely accepts `fields` still
    returns full rows when it is omitted, so nothing about it is excludable
    by default and there is nothing for a skill to opt back into.
    """
    presets = parse_field_presets()
    method_to_tool = _method_to_tool_name()
    preset_owners = _scan(PRESET_USE_RE, method_to_tool)
    idiom_owners = _scan(DEFAULT_IDIOM_RE, method_to_tool)

    terse: dict[str, set[str]] = {}
    for tool, preset_names in preset_owners.items():
        if tool not in idiom_owners:
            continue
        fields: set[str] = set()
        for preset_name in preset_names:
            if preset_name not in presets:
                raise ToolLookupError(
                    f"{tool} projects with {preset_name}, which "
                    f"{FIELD_SELECTION_TS.name} does not export"
                )
            fields.update(presets[preset_name])
        terse[tool] = fields

    if not terse:
        raise ToolLookupError(
            "no tool was found to be terse-by-default (a preset plus the "
            "`fields ?? ['default']` fallback) — the source scan is broken, and "
            "every skill field reference would validate against nothing"
        )
    return terse


def collect_field_vocabulary() -> set[str]:
    """Every name this server models as a ROW field, anywhere.

    Keeps English out of check 4: a backticked token that names no field in
    any model is prose (`jq`), not a request for data. Deliberately
    repo-wide rather than per-tool — the per-tool half of the check is the
    preset, and a cross-tool field name near the wrong tool is worth a look
    anyway.
    """
    vocabulary: set[str] = set()
    for path in _ts_files(MODELS_DIR):
        vocabulary.update(ZOD_KEY_RE.findall(path.read_text()))
    for names in parse_field_presets().values():
        vocabulary.update(names)
    for path in _ts_files(LIVE_DIR):
        vocabulary.update(MAPPER_KEY_RE.findall(path.read_text()))
    if not vocabulary:
        raise ToolLookupError(
            "no row-field names could be read from src/models or src/tools/live — "
            "check 4 would then report nothing at all"
        )
    return vocabulary


def check_field_refs(
    skill_dir: Path,
    terse_tools: dict[str, set[str]],
    tool_args: dict[str, set[str]],
    vocabulary: set[str],
) -> list[str]:
    """Report fields a skill reads that its tool no longer returns by default."""
    errors: list[str] = []
    for line_no, line in enumerate(
        (skill_dir / "SKILL.md").read_text().splitlines(), start=1
    ):
        tokens = BACKTICK_IDENT_RE.findall(line)
        referenced = [t for t in tokens if t in terse_tools]
        if not referenced:
            continue
        # An explicit `fields:` argument anywhere in the instruction is the
        # opt-in this check asks for; it covers every field named on the line.
        if "fields:" in line:
            continue
        default_fields = set().union(*(terse_tools[t] for t in referenced))
        # Arguments of EVERY tool named on this line — not of every tool in the
        # repo, and not only of the terse ones. The repo-wide union blinded the
        # check to any name that is a row field on one tool and a parameter on
        # another: `tag_ids` is a parameter of update_transaction, so a line
        # telling a skill to read `tag_ids` off `get_transactions` — where v3
        # dropped it from the default row — was skipped as "a documented
        # parameter". Narrowing to `referenced` (the TERSE tools on the line)
        # overshot the other way: an ordinary "pull with get_transactions, then
        # update_transaction with the new `category_id`" line names both tools
        # and instructs nothing wrong, but update_transaction is a write tool
        # and so is never in `referenced`.
        referenced_args = set().union(*(tool_args[t] for t in tokens if t in tool_args))
        for token in tokens:
            if token in tool_args or token in referenced_args:
                continue  # a tool name or a parameter of a tool on this line
            if token in default_fields or token not in vocabulary:
                continue
            errors.append(
                f"{skill_dir.name}:SKILL.md:{line_no}: `{token}` is a row field, but "
                f"{'/'.join(referenced)} does not return it by default (v3 terse rows) "
                f"and this line passes no `fields:` argument. Add "
                f'fields: ["default", "{token}"] to the call if the instruction needs '
                "the field, or drop the backticks if the line is prose about it."
            )
    return errors


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
        if tok in KNOWN_TOOL_PARAMS:
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
        tool_args = collect_tool_args()
        terse_tools = collect_terse_default_tools()
        vocabulary = collect_field_vocabulary()
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
            all_errors.extend(
                check_field_refs(skill_dir, terse_tools, tool_args, vocabulary)
            )

    if all_errors:
        for err in all_errors:
            print(f"FAIL: {err}", file=sys.stderr)
        print(f"\n{len(all_errors)} error(s)", file=sys.stderr)
        return 1
    print(
        f"OK: {len(skill_dirs)} skills validated "
        f"({len(terse_tools)} terse-by-default tools cross-checked)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
