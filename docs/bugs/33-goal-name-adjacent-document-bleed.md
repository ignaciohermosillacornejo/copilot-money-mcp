---
id: 33
title: Goal name extracted from an adjacent LevelDB document
class: heuristic-decode-bleed
status: fixed
detected: dogfooding  # output disagreed with the Copilot app
fixed_in: https://github.com/ignaciohermosillacornejo/copilot-money-mcp/pull/33
issue: none — found and fixed directly
date: 2026-01-13
---

## Symptom
`get_goals` returned a savings goal whose `name` was the name of a *category* — a completely unrelated string — instead of the goal's actual name shown in the Copilot app. All other goal fields were correct, which made the wrong name look plausible.

## How it was detected
Dogfooding against the maintainer's real database: the returned goal name did not match the name visible in the Copilot Money UI. No test caught it — synthetic fixtures never place two documents adjacent in the byte stream.

## Root cause
The early decoder did not parse LevelDB/protobuf structurally. It located a path marker (`financial_goals`) in the raw `.ldb` bytes and then regex-searched a window of **500 bytes before + 3000 bytes after** the marker for field patterns like `name`. In a real database, the bytes before the marker belong to the *previous* document, so the first `name` match could come from whatever document happened to be stored next to the goal (in the observed case, a category document). Fields bled across document boundaries because the "document" was an arbitrary byte window, not a parsed record.

## The fix
`src/core/decoder.ts` was changed to extract all goal fields only from the bytes *after* the goal ID in the document path (`afterGoalId` buffer), so matches could no longer come from the preceding record. This was an instance patch; the class was retired one day later when PR #73 replaced window scanning entirely with structural LevelDB iteration (`classic-level`) + a real protobuf wire-format parser.

## Detector
The class-level fix was architectural: PR #73/#74 made byte-window scanning impossible by parsing documents at their true boundaries. The later real-database integration suite (`RUN_REAL_DB_TESTS=1`) is the ongoing gate that decoded output matches the live cache. No detector existed at the time of this bug.

## Lesson
Pattern-scanning a structured binary format is a bug generator, not a parser: every heuristic window is an implicit wrong assumption about record size and adjacency. When a shortcut parser produces one cross-record bleed, expect more (siblings: #26 "cross-record contamination", #72 records larger than the window) — replace the parser instead of widening the window.
