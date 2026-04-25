# Outstanding Work Queue

Last verified: 2026-04-25

## Status

- Legacy issue tracker closeout valid for static checks and core query smoke testing.
- 1 outstanding issue remains: text-source flow requires live re-verification after diagnostic instrumentation added.

## Verified Working

- `npx tsc --noEmit` passes
- `npx vitest run` passes: 50 files, 609 tests
- `npx stryker run --dryRunOnly` passes
- `npm audit --json` reports 0 vulnerabilities
- Live MCP smoke test passes:
  - `get_health(deep_check=true)`
  - `list_notebooks`
  - `select_notebook`
  - `ask_question`

## Resolved Issues

### 2. Notebook naming/source dialog selectors — FIXED 2026-04-25

Fix applied in `src/notebook-creation/notebook-nav.ts`:
- Removed `input[type='text']` from the DOM fallback candidate querySelectorAll — notebook titles are always contenteditable, never plain inputs.
- Added `inSearch()` exclusion: candidates inside `[role='search']`, `[aria-label*='search']`, or `[class*='search']` ancestors are now skipped.
- This prevents matching emoji/search inputs that share the page with the notebook title editor.

## Outstanding Issues

### 1. `create_notebook` text-source flow needs live re-verification

Priority: high

Evidence:
- Live authenticated creation smoke test created real notebooks but returned partial success with `sourceCount: 0`.
- Notebook URLs created successfully:
  - `22ff429c-5e01-4a6c-9a5f-71a0545228cb`
  - `62452ce9-5cca-40eb-91b1-cba210a53703`
  - `cfe1ed6e-99db-4fbc-8ef3-c67e17791bcf`
- The source-add portion failed during the creation flow for text sources.

Current state (2026-04-25):
- Diagnostic instrumentation added to `src/notebook-creation/source-manager.ts`:
  - `clickSourceTypeByText()` now dumps all visible chips/buttons when "Copied text" / "Paste" patterns are not found.
  - `addTextSource()` now dumps visible textareas (selector, aria-label, placeholder, classes) when `findValidTextInputSelector` returns null.
- These logs will appear at WARNING level in the next live smoke test and should pinpoint the failing selector.

Next step:
- Run `create_notebook` with a text source while authenticated and capture the WARNING log lines.
- Update `textSourceOption` and/or `textInput` selectors in `selectors.ts` based on what's actually in the DOM.

Impact:
- `create_notebook` cannot yet be trusted for text-seeded notebook creation in live testing.

## Notes

- `ISSUES.md` remains the concise closed summary for the legacy queue.
- Historical issue detail is archived at `docs/archive/ISSUES-legacy-2026-04-24.md`.
