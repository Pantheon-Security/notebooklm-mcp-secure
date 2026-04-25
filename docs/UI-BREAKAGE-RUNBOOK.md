# NotebookLM MCP — UI Breakage Runbook & Session Handoff

Last updated: **2026-04-25** (commit `01e3066` on main)
Fork: `https://github.com/takachaa/notebooklm-mcp-secure` (upstream: `Pantheon-Security/notebooklm-mcp-secure`)

This document serves two purposes:

1. **Runbook** — what to do when NotebookLM ships a UI change that breaks a selector.
2. **Handoff** — how a new Claude Code session in `~/Desktop/名称未設定フォルダ 7/notebooklm_cowork_fix/` can resume work.

---

## 1. Current State (what's done)

The fork is 9 PRs ahead of upstream. All PRs merged to `main`. Default pin: `github:takachaa/notebooklm-mcp-secure#01e3066` in both Claude Desktop and Claude Code user config.

| PR | Commit | Scope |
|---|---|---|
| #1 | `d94a9ed` | UI selectors for ja locale (create_notebook / add_source / list_sources / audio — see Section 4) |
| #2 | `223af4e` | `generate_slides` / `get_slides_status` / `generate_infographic` / `get_infographic_status` |
| #3 | `1823477` | Whitelist the new tools in `PROFILES.standard` |
| #4 | `2354f8a` | Pre-generation customize dialogs (slides format/length, infographic style/orientation) + `revise_slides` + `download_slides` + `download_infographic` |
| #5 | `c4d29ed` | `research_sources` (first, synchronous) |
| #6 | `3e1a4f8` | `research_sources` addedTitles set-diff bugfix |
| #7 | `9e8596f` | Split `research_sources` into async 3-step: `research_sources` + `get_source_discovery_status` + `import_research_results` |
| #8 | `b923ba7` | `get_source_content` + `download_source` (markdown/html/text via turndown) |
| #9 | `01e3066` | `source_titles` param on all 7 output-producing tools (ask + 6 generators) |

### Tool count: 31 (upstream) → 44 (this fork)

New tools added (13):
`generate_slides`, `get_slides_status`, `revise_slides`, `download_slides`,
`generate_infographic`, `get_infographic_status`, `download_infographic`,
`research_sources`, `get_source_discovery_status`, `import_research_results`,
`get_source_content`, `download_source`, (+ `source_titles` parameter on
existing tools — not a new tool but a new capability).

### Feature matrix (what each tool can do)

| NotebookLM UI feature | MCP tool(s) | Notes |
|---|---|---|
| Create notebook with sources | `create_notebook`, `batch_create_notebooks` | |
| Add 1 source | `add_source` | URL / text / file |
| List / inspect / delete sources | `list_sources`, `remove_source` | |
| **Read source content** | `get_source_content`, `download_source` | markdown / html / text, saves file |
| Ask chat question | `ask_question` | supports `source_titles` filter + session threading |
| Fast / Deep Research (discover new sources) | `research_sources` → `get_source_discovery_status` → `import_research_results` | async 3-step; Deep takes 2-10 min |
| Audio overview | `generate_audio_overview` / `get_audio_status` / `download_audio` | |
| Video overview | `generate_video_overview` / `get_video_status` | style + format params |
| Data table | `generate_data_table` / `get_data_table` | |
| **Slides (スライド資料)** | `generate_slides` / `get_slides_status` / `revise_slides` / `download_slides` | customize dialog params; PDF or PPTX download |
| **Infographic (インフォグラフィック)** | `generate_infographic` / `get_infographic_status` / `download_infographic` | 11 styles × 3 orientations |
| **Source filter on all output tools** | any of the 7 tools via `source_titles: string[]` | |

---

## 2. How to Resume in a New Claude Code Session

### 2.1 Working directory
```
/Users/takachaa/Desktop/名称未設定フォルダ 7/notebooklm_cowork_fix/
├── Direction.md                  — original task spec (may be outdated; most scope done)
├── DISCOVERY.md                  — UI DOM probe results (April 2026)
├── TEST-RESULTS.md               — running test matrix
├── HANDOFF.md                    — ptr to this runbook (created in this PR)
├── test-assets/                  — smoke test files + downloaded artifacts
└── notebooklm-mcp-secure/        — cloned fork, branch currently = main
    ├── docs/UI-BREAKAGE-RUNBOOK.md  ← this file
    ├── src/                       — TypeScript source
    └── dist/                      — compiled JS (npm run build)
```

### 2.2 Check what's currently pinned
```bash
grep -A3 '"notebooklm"' "/Users/takachaa/Library/Application Support/Claude/claude_desktop_config.json"
grep notebooklm-mcp-secure ~/.claude.json | head -3
```
Both should point at the same commit sha. If they diverge, match them to the latest main.

### 2.3 Starting a new fix / feature

1. `cd notebooklm-mcp-secure`
2. `git checkout main && git pull`
3. `git checkout -b <type>/<slug>` (types: `fix/`, `feat/`, `docs/`, `chore/`)
4. Edit, test with `npm run build`
5. Commit, push, `gh pr create`, merge
6. **Critical**: update both configs to the new merge commit:
   ```bash
   # Claude Desktop
   # edit ~/Library/Application\ Support/Claude/claude_desktop_config.json
   #   replace the sha after "#" in args

   # Claude Code
   claude mcp remove notebooklm -s user
   claude mcp add notebooklm -s user \
     -e NLMCP_AUTH_ENABLED=true \
     -e NLMCP_AUTH_TOKEN=<token-from-old-config> \
     -- npx -y github:takachaa/notebooklm-mcp-secure#<new-sha>
   ```
7. **Pre-warm the npx cache** to avoid a race condition with the Claude Desktop startup — run `npx -y github:takachaa/notebooklm-mcp-secure#<new-sha>` once in a throwaway terminal and let it initialize before restarting Claude:
   ```bash
   (npx -y github:takachaa/notebooklm-mcp-secure#<new-sha> 2>&1 </dev/null) &
   PID=$!; sleep 60; kill -9 $PID 2>/dev/null
   ```
8. Fully quit Claude Desktop (⌘Q, not just close window) and restart. Then exit/restart Claude Code to pick up the new tool catalog.

### 2.4 Testing etiquette
- Use `fix-verify-*` notebooks the previous session created for destructive tests — avoid polluting user's real notebooks.
- `ask_question` costs 1/50 daily quota. Prefer tests that use the Studio path (slides/infographic/video/audio/data table) when possible.
- For Deep Research, pre-wait ~5-8 min; never block inside an MCP call for >60s.

---

## 3. Architecture cheatsheet

### 3.1 Layers
```
┌─────────────────────────────────────────────┐
│ Claude Desktop / Claude Code (MCP clients) │
└───────────────┬─────────────────────────────┘
                │ stdio JSON-RPC
┌───────────────▼──────────────────────────────┐
│ dist/index.js  (MCP server + dispatch)       │
│  ├── tools/definitions.ts   (aggregator)     │
│  │    ├── ask-question.ts                    │
│  │    ├── notebook-management.ts (audio)     │
│  │    ├── video.ts                           │
│  │    ├── data-tables.ts                     │
│  │    ├── slides.ts                          │
│  │    ├── infographic.ts                     │
│  │    ├── research.ts                        │
│  │    └── source-content.ts                  │
│  ├── tools/handlers/        (thin wrappers)  │
│  │    └── audio-video.ts / research.ts / … │
│  └── notebook-creation/     (browser automn) │
│       ├── notebook-creator.ts                │
│       ├── source-manager.ts                  │
│       ├── source-selection.ts (PR #9)        │
│       ├── audio-manager.ts                   │
│       ├── video-manager.ts                   │
│       ├── data-table-manager.ts              │
│       ├── slides-manager.ts                  │
│       ├── infographic-manager.ts             │
│       ├── research-manager.ts                │
│       └── selectors.ts (shared)              │
└─────────────────────┬────────────────────────┘
                      │ patchright (Playwright fork)
┌─────────────────────▼────────────────────────┐
│ Chromium headless (persistent profile at     │
│ ~/Library/Application Support/notebooklm-mcp/│
│ chrome_profile/)                             │
└──────────────────────────────────────────────┘
```

### 3.2 Where to add a new output-producing tool

1. **Manager** — add class in `src/notebook-creation/<foo>-manager.ts`. Copy `data-table-manager.ts` as a template (simplest: direct tile click, no customize dialog).
2. **Tool definition** — add schema in `src/tools/definitions/<foo>.ts` and aggregate in `definitions.ts`.
3. **Handler** — add function in `src/tools/handlers/audio-video.ts` (or a new file) with `resolveNotebookUrl` pattern.
4. **Facade** — add method in `src/tools/handlers/index.ts` (`ToolHandlers` class).
5. **Dispatch** — add entry in `src/index.ts`'s dispatch table.
6. **Whitelist** — add tool name to `PROFILES.standard` in `src/utils/settings-manager.ts` (PR #3 lesson: easy to forget, but server silently hides the tool if missing).
7. **`source_titles` support** — if the new tool produces output grounded in sources, import `applySourceFilter` from `source-selection.ts` and call it after `navigateToNotebook`.

---

## 4. Selectors Reference (April 2026, ja locale)

Canonical values extracted via live DOM probe. Keep this table in sync when you fix a selector — the commit message should ideally mention the jslog or class used.

### 4.1 Home page — New notebook button
| Signal | Value | Notes |
|---|---|---|
| class | `button.create-new-button` | **Primary — locale-independent** |
| jslog | `236819` | Google click-tracking, stable |
| aria (ja) | `ノートブックを新規作成` | |
| aria (en) | `Create new notebook` | |

### 4.2 Add-source dialog — source type tiles
All `button.drop-zone-icon-button` with `mdc-button--outlined`.
| Type | jslog | ja text |
|---|---|---|
| File upload | `279304` | `uploadファイルをアップロード` |
| Website / YouTube | `279308` | `linkvideo_youtubeウェブサイト` |
| Google Drive | `279299` | `driveドライブ` |
| Copied text (paste) | `279295` | `content_pasteコピーしたテキスト` |

### 4.3 URL sub-dialog (after clicking ウェブサイト)
| Field | Selector / jslog |
|---|---|
| Input | `textarea[jslog^="279306"]`, aria `URL を入力`, placeholder `リンクを貼り付ける` |
| Submit (挿入) | `button[jslog^="279307"]` |
| Back | `button[jslog^="279305"]` |
| Close | `button[jslog^="279294"]` |

### 4.4 Text-paste sub-dialog (コピーしたテキスト)
| Field | Selector / jslog |
|---|---|
| Input | `textarea[jslog^="279298"]` / `textarea.copied-text-input-textarea`, aria `貼り付けたテキスト` |
| Submit (挿入) | `button[jslog^="279297"]` |

### 4.5 Source list (left panel)
```
section.source-panel
  └─ div.single-source-container        ← one row
     ├─ button.source-stretched-button  (aria = full source title)
     ├─ div.icon-and-menu-container
     │   ├─ mat-icon.source-item-more-menu-icon   (text "more_vert")
     │   └─ button.source-item-more-button        (jslog 202051 — ⋮ menu)
     ├─ div.source-title-column
     │   └─ div.source-title     (textContent = title)
     └─ div.select-checkbox-container
         └─ mat-checkbox.select-checkbox
            └─ input.mdc-checkbox__native-control   (click target)
```
Global select-all: `mat-checkbox.select-checkbox-all-sources`.

### 4.6 Source-view opened (click a row)
| Element | Selector |
|---|---|
| Panel mode | `section.source-panel.source-panel-view` |
| Main content | `labs-tailwind-doc-viewer` (innerHTML = full rendered source) |
| Back to list | `button[jslog^="243453"]` (aria `collapse_content`) |
| Guide summary | `.source-guide-container` (may be collapsed; AI summary + topic chips) |

### 4.7 Studio panel tiles
Container: `section.source-panel` toggle `.toggle-source-panel-button`. Each tile: `div.create-artifact-button-container[role="button"]`.

| Tile | jslog | Material icon | Color class | Shimmer (generating) |
|---|---|---|---|---|
| 音声解説 (Audio) | `261212` | `audio_magic_eraser` | `.blue` | `.shimmer-blue` |
| スライド資料 (Slides) | `279187` | `tablet` | `.yellow` | `.shimmer-yellow` |
| 動画解説 (Video) | `261214` | subscriptions (ready) / sync (gen) | `.green` | `.shimmer-green` |
| マインドマップ | `261216` | `flowchart` | `.pink` | `.shimmer-pink` |
| レポート | `270542` | `auto_tab_group` | `.yellow` | n/a |
| フラッシュカード | `270538` | `cards_star` | `.orange` | n/a |
| クイズ | `270539` | `quiz` | `.cyan` | n/a |
| インフォグラフィック | `279184` | `stacked_bar_chart` | `.pink` | `.shimmer-pink` |
| Data Table | `282298` | `table_view` | n/a | `.shimmer-blue` |

### 4.8 Customize dialog — chevron button
Inside each tile: `.option-icon > button.edit-button` (jslog `270546`). Opens a `mat-dialog-container` with per-artifact fields.

### 4.9 Customize dialog — common submit
`button.mdc-button--unelevated` inside `mat-dialog-actions`; text `生成` (generate) / `挿入` (insert).

### 4.10 Slides-specific customize fields
| Field | Values |
|---|---|
| format radio | `value="1"` 詳細 / `value="2"` プレゼンター |
| length mat-button-toggle | text `短め` / `デフォルト` |
| description | `textarea[aria-label*="スライド"]` |

### 4.11 Infographic-specific customize fields
| Field | Values |
|---|---|
| style radio (11) | `auto=1, sketch=2, professional=3, bento=4, editorial=5, explanatory=6, block=7, clay=8, anime=9, kawaii=10, science=11` |
| orientation toggle | `横向き` / `縦向き` / `正方形` |
| description | `textarea[aria-label*="インフォグラフィック"]` |

### 4.12 Artifact ⋮ menu (slides)
| Action | jslog |
|---|---|
| Rename | (no jslog) icon `edit` |
| PDF download | `302103` |
| PPTX download | `302084` |
| Share | `296546` |
| Start slideshow | `296107` |
| **Revise (変更)** | `304805` (opens inline `textarea.revision-input-textarea`) |
| Delete | `261221` |

### 4.13 Artifact ⋮ menu (infographic)
| Action | jslog |
|---|---|
| Rename | (no jslog) |
| Download | `296552` |
| Share | `296548` |
| Delete | `261221` |

### 4.14 Revision mode (slides only)
| Field | Selector / jslog |
|---|---|
| Input | `textarea.revision-input-textarea`, aria `リビジョンの手順` |
| Submit | `button[jslog^="305586"]` (text `改訂版のスライドを生成`) |
| Cancel | `button[jslog^="305585"]` |

### 4.15 Source-discovery / Research UI
Located at the top of `section.source-panel`.
| Element | Selector / jslog |
|---|---|
| Query input | `textarea.query-box-textarea`, jslog `274655`, placeholder `ウェブで新しいソースを検索` |
| Research mode trigger | `button.researcher-menu-trigger`, jslog `282720` |
| Fast Research option | jslog `282722` |
| Deep Research option | jslog `282721` |
| Corpus trigger | `button.corpus-menu-trigger`, jslog `282717` |
| Web corpus option | jslog `282718` |
| Drive corpus option | jslog `282719` |
| Submit arrow | `button.actions-enter-button`, jslog `282723`, aria `送信` |
| Completion container | `.source-discovery-container` |
| Import button | jslog `282708` (text `インポート`) |
| Dismiss button | jslog `282707` (text `削除`) |
| Preview/show | jslog `282706` |

### 4.16 Selectors file (src/notebook-creation/selectors.ts)
Central registry for the most DOM-sensitive selectors. When fixing a selector, prefer updating this file's `primary` + `fallbacks` over hardcoding inside a manager. Current entries:
- `newNotebookButton` / `urlInput` / `textInput`
- `urlSourceTypeButton` / `textSourceTypeButton` / `fileSourceTypeButton` / `driveSourceTypeButton`
- `urlInsertButton` / `textInsertButton`
- `addSourceButton` / `chatInput` / etc.

---

## 5. How to Diagnose a New Breakage

1. Reproduce the failing MCP call and note the exact error message.
2. Check recent UI changes by going to the notebook in a regular Chrome and clicking through the same path.
3. Identify the selector that missed. Usually one of:
   - A jslog ID changed (rare — these are very stable)
   - A class name changed (common)
   - An English fallback aria was used when ja is needed (or vice versa)
4. Probe the live DOM with `mcp__claude-in-chrome__javascript_tool`:
   ```js
   document.querySelectorAll('button, [role="button"]').forEach(b => {
     const j = b.getAttribute('jslog') || '';
     if (j.startsWith('<target-prefix>')) console.log(b.outerHTML.slice(0,300));
   });
   ```
5. Update the relevant manager (or `selectors.ts`). Keep old selectors as fallbacks so the fix is incremental.
6. Follow Section 2.3 to ship the fix.

### Rule of thumb for resilient selectors

Prefer in this order:
1. **`jslog^="<numeric-id>"`** — Google's internal click-tracking; stable across locales, rarely changes.
2. **CSS class that encodes function** — e.g. `.add-source-button`, `.source-guide-container`.
3. **Material icon text inside `<mat-icon>`** — `"tablet"`, `"stacked_bar_chart"`, `"audio_magic_eraser"` — never translated.
4. **aria-label substring** (with ja + en + fr variants) — fallback only; locale-dependent.

---

## 6. Pending / Known Issues

### 6.1 UX polish (non-blocking)
- `sourceTitle` in `get_source_content` / `download_source` responses sometimes has trailing `open_in_new` (external-link icon text) for URL sources. Cosmetic.
- `sourceGuide.summary` returns `button_magic ソースガイドarrow_drop_up` when the guide panel is collapsed. The real summary only appears if the guide is expanded first.
- `list_sources` normally reports proper titles, but **right after import via research_sources**, NotebookLM briefly shows raw URLs before extracting titles; subsequent list_sources calls return the clean names.
- `candidatePreview` in `get_source_discovery_status` tends to match the "+N more sources" collapse link rather than individual card titles. Low-priority cosmetic fix.

### 6.2 Functional gap
- `import_research_results { action: "dismiss" }` clicks the 削除 button, MCP returns success, but the `.source-discovery-container` occasionally remains visible in the UI. The logical semantic (no sources added) is correct. Likely the UI has a confirmation dialog or transition we don't wait for.

### 6.3 MCP-protocol quirks
- Claude Desktop's **request/response timeout is ~60s**. Any tool that needs to wait longer must return early with a "polling" pattern (see Section 4 of PR #7). Never block a `generate_*` tool until completion.
- **npx race condition**: after changing the pinned commit, Claude Desktop may try to connect while npm is still running the `prepare` script. Symptom: `Cannot find module '../package.json'`. Fix: pre-warm the cache (see Section 2.3 step 7) before restarting Claude Desktop.

### 6.4 User-visible test artifacts left behind
On the test Google account there are several `fix-verify-*` / `Untitled notebook` notebooks with smoke test sources. Safe to delete in the NotebookLM UI; they do not affect MCP operation.

---

## 7. Testing Checklist Before a Release

Run these after any non-trivial change. Each item = ~30s of MCP call unless noted.

### 7.1 Smoke (always run)
- [ ] `get_health` → `authenticated: true`
- [ ] `list_notebooks` → returns library
- [ ] `list_sources { notebook_id }` → proper titles (not `more_vert`)

### 7.2 Core CRUD
- [ ] `create_notebook` with text source → URL returned, appears in library
- [ ] `add_source` with URL source → success, list_sources reflects it
- [ ] `remove_source` → count decreases
- [ ] `remove_notebook` → library updates

### 7.3 Generation
- [ ] `generate_audio_overview` → returns `generating` quickly
- [ ] `generate_video_overview` → same, optionally with style/format
- [ ] `generate_data_table` → same
- [ ] `generate_slides` with + without customize dialog params
- [ ] `generate_infographic` with + without customize dialog params
- [ ] `revise_slides` with instructions → `generating` returned
- [ ] `download_slides` (PDF) → file saved with non-zero size
- [ ] `download_slides` (PPTX) → file saved
- [ ] `download_infographic` → PNG file saved

### 7.4 Research (allow 2-10 min wait)
- [ ] `research_sources { mode: "fast" }` → `triggered: true` fast
- [ ] `get_source_discovery_status` polls to `completed`
- [ ] `import_research_results { action: "import" }` → sources added
- [ ] `research_sources { mode: "deep" }` + poll + import (longer wait)

### 7.5 Filter
- [ ] `ask_question { source_titles: [<valid unique substring>] }` → scoped answer
- [ ] `ask_question { source_titles: [<non-existent>] }` → error with available titles
- [ ] `ask_question { source_titles: [<ambiguous>] }` → ambiguity error
- [ ] regression: without `source_titles` → works like before

### 7.6 Source content
- [ ] `get_source_content { source_id, format: "markdown" }` → well-formed MD
- [ ] `get_source_content format: "html"` → raw HTML
- [ ] `download_source` with + without output_path

---

## 8. Contact / Upstream

Upstream: https://github.com/Pantheon-Security/notebooklm-mcp-secure

If an upstream release supersedes the behavior we fixed, consider opening a PR upstream rather than keeping the fork permanently diverged. The most shippable upstream candidates are:

- PR #1 (ja locale selector resilience)
- PR #5-#7 (research_sources — the async split is broadly useful)
- PR #8 (source download — no such feature upstream)
- PR #9 (source_titles filter — matches how the UI actually works)

PR #2/#3/#4 are fork-specific beta tile coverage; upstream may add these when the features exit beta.
