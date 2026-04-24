# Outstanding Work Queue

Generated 2026-04-24 from current repo state after legacy `ISSUES.md` closeout.

This file is the current forward-looking queue. It replaces the stale historical issue body in `ISSUES.md` for day-to-day planning.

## Summary

- 5 active workstreams
- 3 code-quality/type-safety workstreams
- 1 dependency/security maintenance workstream
- 1 tracker hygiene workstream

## 1. Notebook-Creation DOM Typing Cleanup

Priority: medium

Evidence:
- `rg -n "as any|@ts-expect-error" src` finds 268 suppressions across 13 files.
- The largest concentration is in notebook-creation helpers:
  - `src/notebook-creation/source-manager.ts` — 71
  - `src/notebook-creation/video-manager.ts` — 31
  - `src/notebook-creation/notebook-sync.ts` — 30
  - `src/notebook-creation/discover-sources.ts` — 23
  - `src/notebook-creation/data-table-manager.ts` — 22
  - `src/notebook-creation/audio-manager.ts` — 20
  - `src/notebook-creation/discover-quota.ts` — 16
  - `src/notebook-creation/discover-creation-flow.ts` — 16
  - `src/notebook-creation/selector-discovery.ts` — 4
  - `src/notebook-creation/notebook-nav.ts` — 4

Goal:
- Replace broad DOM/browser `as any` and `@ts-expect-error` usage with explicit browser-context types.

## 2. Gemini SDK Typing Cleanup

Priority: medium

Evidence:
- `src/gemini/gemini-client.ts` still has 15 `as any` suppressions around SDK interactions.

Goal:
- Introduce explicit wrapper types for `interactions`, `files`, and `models` calls so the Gemini client no longer bypasses strict typing.

## 3. Quota + Stealth Browser-Context Typing Cleanup

Priority: low

Evidence:
- `src/quota/quota-manager.ts` — 11 DOM-type suppressions
- `src/utils/stealth-utils.ts` — 2 browser-context suppressions

Goal:
- Apply the same typed browser-context pattern already used in `auth-manager`, `browser-session`, and `page-utils`.

## 4. Dependency / Vulnerability Review

Priority: medium

Evidence:
- Recent `npm install` runs reported:
  - 7 vulnerabilities after Stryker install
  - earlier run reported 8 vulnerabilities before final dependency set settled
- `npm audit --json` could not be re-run in the default sandbox because registry DNS failed (`EAI_AGAIN`), so the exact current breakdown still needs a networked audit pass.

Goal:
- Run `npm audit` in a network-enabled context, identify the real remaining advisories, and either upgrade/fix or document accepted risk.

## 5. Tracker Hygiene / Archival

Priority: low

Evidence:
- `ISSUES.md` still contains the full historical issue body below the closeout staging section.
- The current active queue is no longer in that body; it is now only historical evidence.

Goal:
- Archive or rewrite the historical issue body so `ISSUES.md` becomes a concise status document, with resolved legacy findings moved to an archive file.

## Current Verification Baseline

- `npx vitest run` passes: 50 files, 606 tests
- `npx tsc --noEmit` passes
- `npx stryker run --dryRunOnly` passes

