# Outstanding Work Queue

Last verified: 2026-04-24

## Status

- Legacy issue tracker closeout remains valid for static checks and core query smoke testing.
- 2 currently reproducible notebook-creation issues remain open from live authenticated testing.

## Verified Working

- `npx tsc --noEmit` passes
- `npx vitest run` passes: 50 files, 607 tests
- `npx stryker run --dryRunOnly` passes
- `npm audit --json` reports 0 vulnerabilities
- Live MCP smoke test passes:
  - `get_health(deep_check=true)`
  - `list_notebooks`
  - `select_notebook`
  - `ask_question`

## Outstanding Issues

### 1. `create_notebook` text-source flow is not reliable

Priority: high

Evidence:
- Live authenticated creation smoke test created real notebooks but returned partial success with `sourceCount: 0`.
- Notebook URLs created successfully:
  - `22ff429c-5e01-4a6c-9a5f-71a0545228cb`
  - `62452ce9-5cca-40eb-91b1-cba210a53703`
  - `cfe1ed6e-99db-4fbc-8ef3-c67e17791bcf`
- The source-add portion failed during the creation flow for text sources.

Current understanding:
- One browser-evaluate helper regression was fixed locally, but the end-to-end creation flow is still not verified clean.
- A remaining selector/UI-flow issue is still present in the creation path.

Impact:
- `create_notebook` cannot yet be trusted for disposable text-seeded notebook creation in live NotebookLM testing.

### 2. Notebook naming/source dialog selectors need UI refresh

Priority: medium

Evidence:
- `setNotebookName()` repeatedly matched an unrelated emoji search input in the live create flow and fell back to:
  - `Name input not found - notebook may have been created with default name`
- Standalone `add_source` smoke behavior also showed dialog-state fragility when a source overlay/backdrop was already present.

Current understanding:
- The new NotebookLM UI appears to expose overlays/dialogs that do not match the current name-input and source-dialog assumptions reliably.
- Additional selector discovery or a more state-aware flow is needed before creation/source-management can be considered stable.

Impact:
- New notebooks may keep default names.
- Source-add operations can become brittle when NotebookLM opens or preserves modal state automatically.

## Notes

- `ISSUES.md` remains the concise closed summary for the legacy queue.
- Historical issue detail is archived at `docs/archive/ISSUES-legacy-2026-04-24.md`.
- This file should now be treated as the live forward tracker again until the creation-flow issues are resolved and re-verified.
