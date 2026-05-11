# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2026.3.3] - 2026-05-11

### Fixed

- **Entry-point detection broken for bin shim and npx invocations** — `isDirectRun` guard
  now passes `process.argv[1]` through `realpathSync` before comparing against
  `import.meta.url`, resolving symlinks created by `npm install -g` and `npx` before the
  equality check. Previously the server would boot, print the banner, and silently exit
  with no MCP transport registered when invoked via the bin shim or `npx`. Closes #11.
- **Opt-in startup diagnostic** — set `NLMCP_DEBUG=true` to log the exact `argv[1]` vs
  `import.meta.url` comparison when the entry-point guard gates off `main()`, making
  silent no-start failures diagnosable.

## [2026.3.1] - 2026-04-25

### Security Audit Complete — All 334 Issues Resolved

This release closes the full 334-item security audit end-to-end. v2026.3.0 closed every
critical, high, and medium issue. This release closes all remaining low-severity issues,
the three intentionally-deferred items (I171, I281, I305), and cleans internal process
documents out of the repository.

**By the numbers:**
- Tests: **609 → 643** across 52 test files
- `npx tsc --noEmit` — clean
- `npm audit` — 0 vulnerabilities

### Security & Validation

- **Notebook ID validation centralised** — inline regex in `resource-handlers.ts` replaced with `validateNotebookId()` from `security.ts`; path-segment guard added to URI template handler (I107, I108)
- **`delete_document` confirm guard** — destructive tool now requires `confirm: true` explicit param; request without it returns `{ success: false }` (I078, I331)
- **Auth startup transparency** — `getAuthConfig()` logs effective auth state for all three configuration cases at startup (I118, I314)
- **Token rotation** — optional periodic token rotation via `NLMCP_AUTH_ROTATION_INTERVAL_HOURS` env var; unref'd timer does not prevent clean shutdown (I119)
- **Login retry** — `page.goto` timeout now retries once before throwing instead of warning and proceeding (I126)
- **Startup tool coverage check** — startup asserts every registered tool appears in `TOOLS_REQUIRING_AUTH` or explicit opt-out; phantom entries removed (I313)
- **Secrets scanner** — Bearer token pattern broadened from JWT-only (`A.B.C`) to any opaque token ≥ 20 chars (I189)
- **Audit hash chain** — `previousHash` advanced only after write succeeds; silent kill on flush failure eliminated (I228)
- **File lock liveness** — `forceUnlock` treats `EPERM` as "process alive" rather than unlocking erroneously (I296)

### Protocol & API

- **Error body shape aligned** — all error paths include `data: null`; callers can safely check `payload.data` on both success and failure (I095, I330)
- **Annotation drift fixed** — duplicate `title` fields removed from all `annotations` blocks (I041)
- **Prompt definitions** — empty `arguments: []` removed from all 4 prompt definitions (I109)
- **`parseArray` delimiter** — now splits on both comma and semicolon (I028)
- **`AuthenticationError`** — unused `suggestCleanup` field removed (I017)
- **URL sanitization** — `"unexpected URL: ${url}"` throw replaced with sanitized message that never leaks raw notebook URLs to MCP client (I173, I332)
- **Webhook error classification** — catch block in `webhook-dispatcher.ts` now walks the Node `fetch` cause chain and classifies errors as `timeout`, `dns_or_connect`, or `network`; DNS/connect failures skip retries; `errorKind` included in all log messages and delivery records (I281)

### Code Quality

- **Non-null assertion eliminated** — `toolRegistry!` replaced with `= new Map()` field initialiser (I020)
- **Startup log emoji stripped** — `\p{Extended_Pictographic}` removed from tool descriptions before substring truncation (I018)
- **`close_session` / `reset_session` deduplicated** — `withSessionOp` helper extracted; both handlers delegate to it (I077)
- **Notebook URL resolution deduplicated** — 7× repeated resolution blocks in `audio-video.ts` and 3× in `notebook-creation.ts` replaced with `resolveNotebookUrl()` in `error-utils.ts` (I093, I094)
- **`findElement` / `waitForElement` relocated** — moved from `selectors.ts` to `src/utils/page-utils.ts` (I149)
- **Dialog submit merged** — `clickSubmitButton` and `clickInsertButton` unified as `clickDialogSubmit()`: JS-eval first, selector second, Enter fallback (I148)
- **`clickAddSource` extracted** — 145-line method split into `tryAddSourceByAria`, `tryAddSourceByClass`, `tryAddSourceByJs` helpers (I166)
- **`addFileSource` extracted** — 116-line method split into `tryFileUploadViaTrigger` helper; three strategies are 3 one-liners (I167)
- **`clampInteger` exported** — pure clamping function now testable without module reload (I304)
- **`skipLibCheck` comment** — tsconfig annotated explaining patchright broken `.d.ts` (I311)
- **Compliance language** — README distinguishes code-level controls from organisational process controls required for formal certification (I265)
- **Discovery scripts relocated** — `run-discovery.ts` and `selector-discovery.ts` moved from `src/notebook-creation/` to `scripts/`; `npm run discover-selectors` added to `package.json` (I171)

### Test Coverage

New and expanded assertions:
- `validateNotebookId` — 8 acceptance/rejection cases in `security.test.ts` (I329)
- `data: null` in error response body — integration test in `mcp-server.integration.test.ts` (I330)
- `delete_document` confirm guard — `gemini-handler.test.ts` covers `confirm: false` and `confirm: undefined` (I331)
- Sanitized throw — `notebook-creator.test.ts` asserts raw URL never surfaces in error message (I332)
- Log rotation/retention — `audit-logger.test.ts` verifies files older than `retentionDays` are deleted (I302)
- `RateLimiter` memory bound — `security.test.ts` asserts map size ≤ 10 000 under 10 001 distinct keys (I303)
- `clampInteger` boundaries — 4 direct unit tests in `config.test.ts` (I304)
- **Handler smoke tests** — `tests/session-management.test.ts` (6 tests), `tests/ask-question.test.ts` (3 tests), and `tests/notebook-creator.test.ts` extensions (+3 tests) covering all handler entry points via injected mocks; no browser required (I305)
- **Webhook error classification** — test verifies cause-chain DNS classification and single-attempt behaviour on `ENOTFOUND` (I281)

### Repository Cleanup

- Removed internal process documents (`CODEX_BATCH*.md`, `ISSUES.md`, `OUTSTANDING.md`, `medusa-fp-analysis.md`) — never relevant to end users
- `.gitignore` extended to cover tooling artifacts (`graphify-out/`, `.stryker-tmp/`) and internal document patterns

---

## [2026.3.0] - 2026-04-25

### The Security Audit Release

We commissioned a parallel deep-audit of main @ `2973097` (v2026.2.11) using four specialised AI code reviewers, each independently focused on a different attack surface: security vulnerabilities, MCP protocol correctness, architecture quality, and testing gaps. Operating independently so findings wouldn't influence each other, they produced a 334-item master issue list across four severity tiers. This release closes the full high and medium tiers — every protocol correctness issue, every security gap identified, and every coverage hole — across three multi-day resolution sessions.

**By the numbers:**
- 334 issues audited across critical / high / medium / low / nit tiers
- ~115 issues closed (all highs and mediums resolved; lows/nits triaged)
- Tests: **139 → 609** across **50 test files** (4.4× increase)
- `npx tsc --noEmit` — clean
- `npm audit` — 0 vulnerabilities
- Live smoke test — `create_notebook` with text source: `sourceCount: 1, partial: false`

---

### Security — Critical & High Fixes

- **Auth token salt persisted** — `TOOLS_REQUIRING_AUTH` and `TOOLS_EXEMPT` converted to `Set<string>` for O(1) lookups; token hash salt now persisted across restarts so tokens survive server restart (I007, I110)
- **`forceAuth` bypass closed** — `validateToken()` accepts `forceValidation` flag; filesystem tools (`add_folder`, `cleanup_data`, `export_library`) now require auth even when auth is globally disabled (I069)
- **Webhook SSRF** — webhook dispatcher validates target URLs against SSRF blocklist before delivery; HMAC signing covers all delivery attempts (I269)
- **Webhook delivery persistence** — dispatcher retries failed deliveries with exponential backoff; results persisted across server restarts (I279)
- **Per-page mutex** — browser page operations now serialised per-page to prevent race conditions on concurrent tool calls (I163)
- **Login cancellation resilience** — auth flow handles user cancelling the Google login dialog without crashing or corrupting state (I123)
- **Headless session guard** — browser tools validate `headless` option before use; passing invalid values now returns a typed error instead of silently misbehaving (I131)
- **Selector timeout budget** — all `waitForSelector` calls use a deadline-based timeout budget shared across retries so no single selector can hang indefinitely (I145)

### Security — Audit Integrity

- **Hash chain verification on read** — audit log reader now recomputes the chain on every load and rejects tampered entries (I216)
- **Log rotation integrity** — chain anchor preserved across daily rotation boundaries; no gap in hash continuity (I217)
- **Concurrent write serialisation** — audit logger uses a write lock to prevent interleaved entries corrupting the JSONL file under concurrent tool calls (I218)

### MCP Protocol Compliance

- **Response shape** — all tool handlers now return `structuredContent` alongside `content`; error responses use `isError: true`; transport-layer tags stripped before delivery; server sends `notifications/cancelled` on shutdown (I010, I011, I012, I013, I014)
- **Annotation correctness** — `readOnlyHint`, `idempotentHint`, `destructiveHint` set correctly for all 48 tools — read-only tools no longer claim mutating side effects (I035, I036, I037, I038, I039)
- **Schema bounds** — all numeric and string tool parameters have explicit min/max constraints: `deep_research` depth (1-10), `list_documents` limit (1-100), query/chat history limits (1-500), browser timeout (5000-300000), batch size (1-10) (I050-I057)
- **Retired model names** — deprecated `gemini-2.5-*` model IDs replaced; deprecation messages corrected to past tense (I059)

### Architecture

- **Handler split** — 3,611-line `handlers.ts` decomposed into 9 domain modules: `ask-question`, `session-management`, `auth`, `notebook-management`, `notebook-creation`, `system`, `audio-video`, `webhooks`, `gemini`
- **HandlerContext DI** — all domain functions receive dependencies via `HandlerContext` instead of importing singletons directly; enables full unit testing without process-level mocks
- **Tool registry** — `Map<string, ToolHandler>` built once at startup replaces 500-line `switch/case` dispatch; O(1) lookup
- **Advanced tools env gate** — `generate_video_overview`, `generate_data_table`, and related Studio tools hidden behind `NLMCP_ADVANCED_TOOLS_ENABLED` flag (I069, I154)
- **Notebook creator split** — creation flow extracted from `handlers.ts` into dedicated `src/notebook-creation/` module with typed domain errors (I159, I161)

### Compliance Wiring

- **ChangeLog integration** — `ChangeLog.recordChange()` called at every config mutation site; audit trail covers all configuration state transitions (I243)
- **BreachDetector subscription** — `BreachDetector.checkEvent()` subscribes to the audit event bus; security events automatically trigger breach detection analysis (I244)

### Config & Types Cleanup

- **`getConfig()` alias** — `CONFIG` singleton now exported via `getConfig()` factory; consumers updated to use the factory (I024)
- **`followUpReminder` typing** — config field typed correctly; `parseBoolean`/`parseInteger` used consistently throughout config parsing (I025)
- **`BrowserOptions` extraction** — browser option type extracted to `src/types/browser-options.ts` and re-exported from `src/types/index.ts` (I026)
- **Tool re-export** — `Tool` type re-exported from `src/types/index.ts` so downstream consumers have a stable import path (I029)
- **`as any` reduction** — source tool contracts tightened; 30+ `as any` casts replaced with proper typed interfaces (I063, I064, I015)

### Test Coverage

Total: **139 → 609 tests across 50 files** — full breakdown of new test suites:

| New Test File | Coverage Target |
|---|---|
| `browser-session.test.ts` | BrowserSession lifecycle, page navigation, auth state |
| `shared-context-manager.test.ts` | Profile strategy, cloning, concurrent session coordination |
| `prompt-injection.test.ts` | 40+ prompt injection and payload patterns |
| `notebook-library.test.ts` | CRUD, search, persistence, concurrent access |
| `settings-manager.test.ts` | Parse, validate, merge, env override |
| `cleanup-manager.test.ts` | Selective deletion, preserve_library, cross-platform |
| `file-permissions.test.ts` | Linux/macOS chmod, Windows ACL, failure logging |
| `audit-logger.test.ts` | Hash chain, concurrent writes, rotation, tamper detection |
| `change-log.test.ts` | Before/after tracking, impact levels |
| `retention-engine.test.ts` | 7-year retention, purge scheduling |
| `incident-manager.test.ts` | Severity classification, notification dispatch |
| `dsar-handler.test.ts` | Race condition fix, export, erasure |
| `compliance.test.ts` | Full compliance stack integration |
| `mcp-auth.test.ts` | Token validation, lockout escalation, salt persistence |
| `webhook-dispatcher.test.ts` | SSRF block, HMAC, retry, persistence |

Security-critical module coverage (vitest --coverage):
- `mcp-auth.ts`: 75.7% lines
- `webhook-dispatcher.ts`: 71.4% lines
- `data-erasure.ts`: 72.0% lines
- `dsar-handler.ts`: 59.0% lines

### Selector & Browser Reliability (post-audit)

- **Notebook name selector** — removed `input[type='text']` from DOM fallback candidates (titles are always `contenteditable`); added `inSearch()` exclusion to skip candidates inside `[role='search']` ancestors (I162)
- **Text source flow** — `clickSourceTypeByText()` now validates the target textarea is a real "Pasted text" input before typing; fallback click restricted to button/chip targets; `findValidTextInputSelector` skips any textarea whose `aria-label` or `placeholder` suggests a search context (post-audit smoke test fix)
- **Video tile detection** — mat-icon text scan added as fallback in `clickVideoTile`; detection no longer relies solely on `.green` CSS class
- **Studio panel** — `[class*='create-artifact']` added to `ensureStudioPanelOpen` selectors for resilience against class renames

### MEDUSA CI Gate

- GitHub Actions workflow updated to run `medusa scan . --fail-on high` on every push to `main` and every PR; high-severity findings now block merge (I308, I333)

### Accuracy / Claims Alignment

- **Certificate pinning retracted** — cert pinning implementation removed from all source paths; `NLMCP_CERT_PINNING` env var removed; documentation updated to remove pinning claims (I174-I180, I331)
- **PQ encryption scope** — SECURITY.md already honest ("local at-rest only, not Harvest-Now-Decrypt-Later"); README badge language and architecture diagram aligned with the documented scope
- **Compliance language** — all references updated to "compliance-ready architecture (controls implemented)" — does not imply formal SOC2 Type II report, GDPR registration, or CSSF submission

---

## [2026.2.11] - 2026-03-28

### Fixed — UI Selector Hardening

- **`video-manager.ts`**: Added mat-icon text scan as fallback in `clickVideoTile` (same locale-independent pattern used by data-table). Video tile is now found by icon exclusion (`!= "table_view"`) rather than relying solely on the `.green` CSS class
- **`video-manager.ts` + `data-table-manager.ts`**: Added `[class*='create-artifact']` to `ensureStudioPanelOpen` waitForSelector and querySelector — Studio panel detection no longer breaks if Google renames `.create-artifact-button-container`
- **`selectors.ts`** `chooseFileButton`: Added 3 new fallbacks (`[class*="file-dialog-button"]`, `button[class*="upload"][class*="trigger"]`, `span[class*="file-dialog"]`) for resilience against Dropzone class renames
- **`selectors.ts`** `closeDialogButton`: Added US spelling `button[aria-label="Close dialog"]` alongside British `"Close dialogue"` — survives if Google normalises to US English
- **`selectors.ts`** `chatInput`: Removed hardcoded German `aria-label="Feld für Anfragen"` fallback; replaced with locale-agnostic chain (`textarea[aria-label]`, `textarea[class*="query"]`, `.chat-input textarea`)

### Docs

- Compliance language updated throughout README and `package.json` to accurately reflect "compliance-ready architecture" (controls implemented) vs formal certification (requires third-party audit)

---

## [2026.2.10] - 2026-03-15

### Added — 3 New Security Layers (14 → 17)
- **Secure-by-Default Auth**: MCP authentication enabled by default — no configuration needed. Explicit opt-out via `NLMCP_AUTH_DISABLED=true`
- **Exponential Backoff Lockout**: Failed auth lockouts escalate 5min → 15min → 45min → 4hr (capped). `lockoutCount` persists across resets
- **Credential Isolation**: `LOGIN_PASSWORD` and `GEMINI_API_KEY` wrapped in `SecureCredential` with 30-min TTL. Original env vars scrubbed from `process.env`

### Added — Architecture Overhaul
- Split 3,611-line `handlers.ts` into 9 domain modules: ask-question, session-management, auth, notebook-management, notebook-creation, system, audio-video, webhooks, gemini
- `HandlerContext` dependency injection pattern for testable domain functions
- Tool registry `Map` replaces 500-line switch/case — built once at startup, O(1) dispatch
- Filesystem tools (`add_folder`, `cleanup_data`, `export_library`) gated behind auth even when globally disabled
- `forceValidation` parameter on `validateToken()` prevents auth bypass on sensitive tools

### Added — Token Management CLI
- `npx notebooklm-mcp token show` — check token status
- `npx notebooklm-mcp token rotate` — generate new token, invalidate old
- First-run token display shows copy-pasteable commands with actual token value

### Added — Reliability
- Gemini API retry with exponential backoff (429/500/502/503, 3 retries)
- Configurable response timeout: `NLMCP_RESPONSE_TIMEOUT_MS` (default: 120s)
- Configurable follow-up reminder: `NLMCP_FOLLOW_UP_ENABLED` / `NLMCP_FOLLOW_UP_REMINDER`
- Config value range clamping: `maxSessions` (1-50), `sessionTimeout` (60-86400), `browserTimeout` (5000-300000)
- File permission failures now logged and audited (no longer silently swallowed)

### Added — CI/CD & Docker
- `npm test` step added to CI pipeline
- Multi-stage Docker build (~40-60% smaller image)
- `.dockerignore` created

### Added — Testing
- 57 new tests: security utilities (`validateNotebookUrl`, `validateQuestion`, `RateLimiter`) and config parsing (`parseBoolean`, `parseInteger`, `parseArray`, `applyBrowserOptions`)
- 168 total tests passing across 6 test files

### Fixed
- Locale-agnostic browser selectors — removed hardcoded German `textarea[aria-label="Feld für Anfragen"]`
- `parseBoolean` used consistently for auth disable check (case-insensitive)
- `parseInteger` used consistently in mcp-auth (NaN-safe)
- Backoff comment corrected: "3rd: 1hr" → "3rd: 45min"

### Security Fixes (found during 4-agent review)
- **CRITICAL**: `forceAuth` bypass — `validateToken()` now accepts `forceValidation` to skip `!enabled` short-circuit
- **CRITICAL**: Plaintext credentials removed from `CONFIG` — consumers use `getSecureLoginPassword()` / `getSecureGeminiApiKey()`

## [2026.2.9] - 2026-03-01

### Fixed — performSetup No Longer Destroys Auth Before Chrome Opens
- **Root cause identified**: `performSetup()` was calling `clearAllAuthData()` unconditionally before launching Chrome
- If Chrome failed to open for any reason (display issue, profile lock, timeout), credentials were already gone
- **Fix**: Removed `clearAllAuthData()` from `performSetup()` — auth is only cleared if Chrome successfully opens and the user re-authenticates
- Added stack trace logging to `clearAllAuthData()` so any future caller can be traced in logs

## [2026.2.8] - 2026-03-01

### Fixed — cleanup_data No Longer Destroys Auth Credentials
- **Root cause identified**: `browser_state/` and `chrome_profile/` directories were included in all `cleanup_data` deletion paths
- Sessions following `get_health` troubleshooting tips ran `cleanup_data` and wiped Google auth cookies
- **Fix**: Both auth directories permanently excluded from ALL cleanup paths (both `preserve_library=true` and `preserve_library=false`)
- **Fix**: `get_health` troubleshooting tip updated — no longer suggests running `cleanup_data`
- Auth credentials now survive all cleanup operations

## [2026.2.7] - 2026-03-01

### Fixed — Headless setup_auth Blocked
- `setup_auth` without `show_browser: true` now returns an error immediately instead of attempting headless auth (which would fail silently)
- Consistent with existing `re_auth` headless guard added in v2026.2.4

### Added — Standalone auth-now.mjs Script
- New `auth-now.mjs` in project root bypasses MCP protocol entirely
- Handles Chrome profile lock (kills existing Chrome processes before launch)
- Saves `state.json.pqenc` via SecureStorage with plain JSON fallback
- Verifies file exists on disk after save with size check
- Stays open 60s after success so user can confirm

## [2026.2.6] - 2026-03-01

### Added — Bulk Folder Upload Tool
- **`add_folder`** — New tool to upload all PDFs/files from a local directory to a notebook
- Supports `dry_run` mode, `recursive` traversal, `file_types` filter, and progress callbacks
- Collects per-file errors and reports a summary instead of failing the whole batch
- Handles large folders (90+ files) with sequential upload and per-file error recovery

### Fixed — Tier Detection for NotebookLM Plus
- `detectTierFromPage()` now detects "NOTEBOOKLM PLUS", "ONE AI PREMIUM", and "GOOGLE ONE AI" branding
- Falls back to inferring tier from source limit shown in UI (50→free, 300→pro, 600→ultra)
- Resolves issue where tier was stuck on "unknown" defaulting to free tier limits

## [2026.2.5] - 2026-03-01

### Fixed — show_browser Silently Ignored in setup_auth
- `setup_auth` handler received `show_browser` parameter but never passed it to `performSetup()`
- Chrome stayed headless even when `show_browser: true` was explicitly set
- **Fix**: `performSetup()` now accepts and uses `show_browser` (overrideHeadless) parameter
- Browser now reliably opens for user authentication when requested

## [2026.2.4] - 2026-03-01

### Fixed — Auth State Expiry Extended to 7 Days
- State expiry extended from 24 hours to 7 days — matches real Google cookie lifetimes (2-4 weeks)
- `touchStateFile()` method added: resets the expiry clock on every successful auth validation so active sessions never expire
- Called in both `validateWithRetry()` fast path and retry success path

### Fixed — Headless re_auth Blocked
- `re_auth` without `show_browser: true` now returns a clear error instead of wiping auth state and failing silently
- Prevents the silent credential destruction loop caused by automated/headless `re_auth` calls

### Added — clearAllAuthData Caller Tracing
- `clearAllAuthData()` now logs a stack trace excerpt so any future unexpected caller can be identified in logs

## [2026.2.3] - 2026-02-20

### Fixed — Studio Panel Tools Fully Restored
- **`generate_data_table` and `generate_video_overview`** now work correctly end-to-end, confirmed on macOS M4 (French locale, headless mode)
- **Dead tile selector**: `clickDataTableTile` used `.mat-icon, [class*='icon']` which matched `SPAN.icon-container` before `<mat-icon>`, so `=== "table_view"` always failed silently. Fixed to `mat-icon` element tag (textContent is exactly `"table_view"`)
- **False failure on slow shimmer**: after clicking the tile, if `shimmer-blue` didn't appear within 15s the tools returned `success: false`. Generation was triggering server-side but headless DOM update lagged. Now returns `{ success: true, status: "generating" }` so callers can poll
- **`data-create-button-type` removed by Google** (Feb 2026): replaced with `mat-icon` text check and `jslog` numeric ID (`282298`) as locale-independent fallback
- **Studio panel timeout** increased from 10s to 30s for slower machines and larger notebooks
- **Full i18n pass**: all browser automation uses locale-independent signals first (CSS classes, Material icon names, element structure, `jslog` IDs) with English text as last-resort fallback only

### Added — CI / Branch Protection
- GitHub Actions CI (`.github/workflows/ci.yml`) runs TypeScript build on every PR and push to `main`
- `main` branch protection: force pushes blocked, branch deletion blocked, `Build` check required before merge

## [2026.2.2] - 2026-02-19

### Fixed — Studio Panel Reliability on Slower Machines
- **`generate_data_table` and `generate_video_overview`** no longer fail with "Could not find Studio panel toggle button" when the Studio panel loads collapsed or the DOM hasn't fully rendered
- Added `waitForSelector` before Studio panel checks — blocks until either the panel tiles or toggle button appear (up to 10s), preventing race conditions on slower machines
- Added `waitForSelector` for the generating artifact shimmer state after tile click — replaces fixed 3-4s delay, so generation is confirmed reliably regardless of machine speed
- Multi-selector fallback chain retained for future-proofing against NotebookLM DOM changes

## [2026.2.1] - 2026-02-18

### Fixed — Standard Profile Missing Key Tools
- **Standard profile expanded** from 14 to 33 tools — all browser-based features now visible by default
- Previously hidden tools now in standard: `create_notebook`, `batch_create_notebooks`, `add_source`, `remove_source`, `list_sources`, `generate_audio_overview`, `get_audio_status`, `download_audio`, `sync_library`, `remove_notebook`, `get_notebook_chat_history`, `get_query_history`, `re_auth`, `close_session`, `reset_session`, `get_quota`, `cleanup_data`
- **Root cause**: The `standard` profile was never updated as new features were added, so key advertised features (notebook creation, source management, audio) were only available with `NOTEBOOKLM_PROFILE=full`
- Gemini API tools remain in `full` profile only — keeps standard aligned with the "no API key required" promise
- Full profile (`NOTEBOOKLM_PROFILE=full`) still includes all 47 tools (adds Gemini API, webhooks, compliance, export)

## [2026.2.0] - 2026-02-17

### Added — Gemini 3 Model Support
- **Gemini 3 models** — `gemini-3-flash-preview` and `gemini-3-pro-preview` now available as default models
- **Deprecation warnings** — Using `gemini-2.5-flash` or `gemini-2.5-pro` now returns a warning that these models retire March 31, 2026
- **Incomplete status handling** — Deep Research now handles `"incomplete"` status from the API as a terminal state with partial results

### Added — Thinking Level Control
- **`thinking_level` parameter** — New optional parameter for `gemini_query` and `deep_research` tools
- Supports `minimal`, `low`, `medium`, and `high` levels for controlling response thoroughness vs speed

### Added — Structured JSON Output
- **`response_schema` parameter** — New optional parameter for `gemini_query` tool
- Pass a JSON schema to get structured, validated JSON responses from Gemini 3
- Automatically sets `responseMimeType: "application/json"` when schema is provided

### Added — Video Overview Generation
- **`generate_video_overview`** — Generate AI-powered Video Overviews through NotebookLM's Studio panel
- **`get_video_status`** — Check Video Overview generation progress
- 10 visual styles: auto-select, custom, classic, whiteboard, kawaii, anime, watercolour, retro-print, heritage, paper-craft
- 2 formats: explainer (full, 5-15 min) and brief (summary, 1-3 min)

### Added — Data Table Extraction
- **`generate_data_table`** — Generate structured Data Tables from notebook sources via Studio panel
- **`get_data_table`** — Extract generated table data as structured JSON (headers + rows)

### Changed
- **Default model** changed from `gemini-2.5-flash` to `gemini-3-flash-preview`
- **@google/genai SDK** upgraded from 1.38.0 to 1.41.0
- **Server banner** updated to reflect Gemini 3

## [2026.1.12] - 2026-02-15

### Security — Code Review & Medusa Scan Remediation
- **Constant-time auth token comparison** using `secureCompare` (prevents timing attacks)
- **Command injection fix** in `file-permissions.ts` — replaced `execSync()` with `execFileSync()` (array args)
- **MCP SDK updated** to 1.26.0 — patches HIGH severity cross-client data leak (GHSA-345p-7cg4-v4c7)
- **Audit hash chain** increased from 64-bit to 128-bit truncation for stronger collision resistance
- **Settings JSON validation** — parsed settings now validated before merge (prevents property injection)
- **Error message sanitization** — internal identifiers removed from error responses
- **Dockerfile hardened** with `--no-install-recommends`
- **Config env var validation** — `NOTEBOOK_PROFILE_STRATEGY` validated against allowed values

### Fixed — Memory Leaks & Concurrency
- **CONFIG mutation race condition eliminated** — removed all 6 `Object.assign(CONFIG, ...)` call sites that could corrupt global state during concurrent requests
- **RateLimiter memory leak** — empty keys now evicted from Map to prevent unbounded growth
- **FinalizationRegistry self-reference** — fixed held value that prevented GC of secure buffers
- **Event listener leak** — `framenavigated` listener now cleaned up after 30s timeout
- **SecureCredential timer** — `.unref()` added so auto-wipe timer doesn't prevent process exit

### Performance
- **Regex precompilation** in `sanitizeForLogging` — 5 patterns + email regex moved to module scope
- **Response validator** — eliminated regex recompilation in `detectSuspiciousUrls` loop
- **Rate limit detection** — consolidated 8+ IPC round-trips into single `page.evaluate()` call
- **ESM import fix** — removed inline `require('path')` in favor of module-level import
- **O(n) dedup** — notebook extraction uses Set-based deduplication instead of O(n^2)

### Code Quality
- **Version strings unified** — MCP server and audit log now use `package.json` version
- **Debounced library save** — `incrementUseCount` no longer writes to disk on every query
- **Data URI pattern** — tightened false-positive-prone `data:` regex in response validator
- **Quota storage** — moved from `configDir` to `dataDir` for consistency with directory lifecycle

## [2026.1.11] - 2026-02-02

### Fixed - Notebook Sync Extraction for New Angular UI
- **sync_library** now correctly extracts notebook UUIDs from NotebookLM's Angular Material UI
  - Automatically switches to grid view where notebook UUIDs are available in DOM element IDs
  - Primary strategy: extract from `project-button` card elements in grid view
  - Fallback: click-navigation through table rows to capture URLs
  - Last resort: basic table row extraction with placeholder URLs
- **quota_manager** updated to detect notebooks via `project-button` (grid) and `project-action-button` (table)
- Resolves issue reported in PR #3 — thanks @robert-merrill for identifying the UI change

### Added - Disable Gemini Tools Environment Variable
- **NOTEBOOKLM_NO_GEMINI** - New environment variable to disable all Gemini API tools
  - Set `NOTEBOOKLM_NO_GEMINI=true` to hide 8 Gemini tools from tool list
  - Useful for clients with context window limitations (e.g., OpenCode)
  - Reduces tool count for clients that don't need Gemini features
  - Disabled tools: `deep_research`, `gemini_query`, `get_research_status`, `upload_document`, `query_document`, `list_documents`, `delete_document`, `query_chunked_document`

## [2026.1.10] - 2026-01-28

### Fixed - Tool Description Clarity for Multi-LLM Compatibility
- **ask_question** - Removed "Gemini" references that confused LLMs into thinking API key was needed
  - Now clearly states "Browser-Based • NO API KEY REQUIRED"
  - Added "PREFER THIS TOOL" guidance for notebook queries
- **deep_research** - Added prominent warning "⚠️ REQUIRES GEMINI_API_KEY"
  - Added "When NOT to Use" section directing to ask_question
- **gemini_query** - Added prominent warning "⚠️ REQUIRES GEMINI_API_KEY"
  - Added "When NOT to Use" section directing to ask_question
- **upload_document** - Added note about alternatives that don't need API key

This fix addresses feedback from OpenCode users where the LLM was incorrectly choosing Gemini API tools over browser-based tools.

## [2026.1.9] - 2026-01-28

### Changed - Documentation & UX Improvements
- **TL;DR Feature Summary** - Quick bullet list at top of README for instant understanding
- **Updated "What's New in 2026"** - Shows all recent releases at a glance
- **Full Feature List** - Collapsible section listing all 43 tools by category
- **Gemini API Optional Callout** - Prominent messaging that core features need no API key
- **Architecture Diagram** - Updated to show "NO API KEY NEEDED" vs "OPTIONAL"

### Security
- Fixed 1 moderate vulnerability in hono dependency via `npm audit fix`

## [2026.1.8] - 2026-01-27

### Changed - Major Dependency Updates
- **@noble/post-quantum** 0.2.1 → 0.5.4 (FIPS 203/204/205 post-quantum cryptography updates)
- **dotenv** 16.6.1 → 17.2.3
- **env-paths** 3.0.0 → 4.0.0
- **globby** 14.1.0 → 16.1.0
- **zod** 3.25.76 → 4.3.6
- **@types/node** 20.19.21 → 20.19.30

### Fixed
- **@noble/post-quantum import path** - Updated import from `@noble/post-quantum/ml-kem` to `@noble/post-quantum/ml-kem.js` (API change in v0.5.4)

## [2026.1.7] - 2026-01-27

### Added - MCP Protocol UX Enhancements
- **Tool Icons** - All 43 tools now have SVG icons for visual identification in compatible MCP clients
- **Human-Friendly Titles** - Tools have proper display titles (e.g., "Ask NotebookLM" instead of "ask_question")
- **Tool Behavior Annotations** - Tools include hints for client decision-making:
  - `readOnlyHint` - Indicates if tool only reads data
  - `destructiveHint` - Warns about data deletion operations
  - `idempotentHint` - Indicates if repeated calls are safe
  - `openWorldHint` - Shows if tool interacts with external services
- **Task Support for Deep Research** - `deep_research` tool now declares `execution.taskSupport: "optional"` for proper long-running operation handling
- **Resource Icons & Annotations** - Resources now include:
  - SVG icons for visual identification
  - `title` field for human-friendly display
  - `annotations` with `audience`, `priority`, and `lastModified` hints
- **Predefined Prompts** - New prompts available via `prompts/list`:
  - `notebooklm.auth-setup` - Initial authentication guide
  - `notebooklm.auth-repair` - Authentication troubleshooting
  - `notebooklm.quick-start` - Getting started guide
  - `notebooklm.security-overview` - Security features documentation

### Changed
- Updated `@modelcontextprotocol/sdk` from 1.25.2 to 1.25.3
- Updated `@google/genai` from 1.36.0 to 1.38.0
- Updated `patchright` from 1.55.0 to 1.57.0
- Updated `tsx` from 4.19.0 to 4.21.0

### Security
- Fixed 3 npm audit vulnerabilities (body-parser, hono, qs)

## [2026.1.4] - 2026-01-23

### Security
- **Defense-in-Depth Path Validation** - Added input validation for Windows `icacls` command
  - `isPathSafeForShell()` - Blocks shell metacharacters (`;&|`$` etc.) and path traversal (`..`)
  - `isUsernameSafe()` - Validates username format before shell use
  - Path normalization before execution
  - Addresses Medusa security scan finding (false positive but hardened anyway)

### Notes
- Medusa scan showed 11 findings, 10 were false positives
- This release hardens the one legitimate concern even though it wasn't exploitable

## [2026.1.3] - 2026-01-15

### Changed
- Updated `@modelcontextprotocol/sdk` from 1.0.0 to 1.25.2

## [2026.1.2] - 2026-01-15

### Added - Multi-Session Authentication Coordination
- **Auth Lock System** - Global `.auth-in-progress` lock prevents race conditions when multiple Claude Code sessions authenticate simultaneously
- **Wait for Auth** - Isolated profiles now wait for any in-progress authentication before cloning base profile
- **Automatic State Reuse** - If another session completes auth while waiting, shared state is automatically reused

### Configuration
New environment variables for multi-session support:
```bash
export NOTEBOOK_PROFILE_STRATEGY=isolated  # isolated|single|auto
export NOTEBOOK_CLONE_PROFILE=true         # Clone auth from base profile
```

### How It Works
1. Session A starts auth → acquires lock → clears old auth → opens browser
2. Session B starts → needs isolated profile → detects lock → waits
3. Session A completes login → saves state → releases lock
4. Session B continues → clones now-authenticated profile → works immediately

## [2026.1.1] - 2026-01-14

### Added
- **Deep Health Check** - `get_health` tool now supports `deep_check: true` parameter to verify NotebookLM chat UI actually loads
- Catches stale sessions where cookies exist but UI won't load

## [2026.1.0] - 2026-01-13

### Added
- **Chat History Context Management** - New `get_notebook_chat_history` tool for extracting conversation history from NotebookLM notebooks
- **CalVer Versioning** - Switched to Calendar Versioning (2026.MINOR.PATCH)
- Preview mode, pagination, and file export options for chat history

## [1.6.0] - 2025-12-18

### Added - Enterprise Compliance Module

Major release adding comprehensive enterprise compliance support for GDPR, SOC2 Type II, and CSSF (Luxembourg) regulations.

#### Core Compliance Infrastructure (Phase 1)
- **Compliance Logger** - Hash-chained audit logs with SHA-256 integrity verification
  - Tamper-evident logging with cryptographic chain
  - 7-year retention support (CSSF requirement)
  - Structured compliance events with actor tracking
- **Data Classifier** - Automatic data sensitivity classification
  - 5 classification levels: PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED, REGULATED
  - Pattern-based detection for PII, credentials, financial data
- **Data Inventory** - GDPR Article 30 Records of Processing Activities
  - Automatic discovery and cataloging of all data stores
  - Processing purpose and legal basis tracking
- **Consent Manager** - User consent tracking and management
  - GDPR Article 6 legal basis support
  - Consent versioning and expiration handling

#### Data Subject Rights - GDPR (Phase 2)
- **DSAR Handler** - Data Subject Access Request processing (Article 15)
  - Automated data collection and response generation
  - 30-day deadline tracking
- **Data Erasure Manager** - Right to be forgotten (Article 17)
  - Verified secure deletion with audit trail
  - Scope-based erasure (categories, date ranges)
- **Data Exporter** - Data portability (Article 20)
  - Machine-readable JSON export format
  - Checksum verification for integrity
- **Retention Engine** - Automatic data retention enforcement
  - Configurable policies per data type
  - CSSF 7-year retention for audit logs

#### Security Monitoring & Incident Response (Phase 3)
- **Incident Manager** - Security incident lifecycle management
  - Severity-based workflow (low/medium/high/critical)
  - 72-hour notification deadline tracking (GDPR breach notification)
  - Root cause analysis and remediation tracking
- **Alert Manager** - Multi-channel security alerting
  - Console, file, webhook, and email channels
  - Severity-based routing and rate limiting
- **Breach Detector** - Pattern-based breach detection
  - Configurable detection rules
  - Automatic incident creation and alerting
- **Health Monitor** - System availability monitoring (SOC2)
  - Component health checks
  - Uptime tracking and SLA reporting
- **SIEM Exporter** - Enterprise SIEM integration
  - CEF (ArcSight), LEEF (QRadar), Syslog, Splunk HEC formats
  - Real-time event streaming

#### Compliance Reporting & Documentation (Phase 4)
- **Report Generator** - Compliance report generation
  - 10 report types: compliance_summary, gdpr_audit, soc2_audit, cssf_audit, security_audit, incident_report, dsar_report, retention_report, change_management, full_audit
  - JSON, CSV, HTML output formats
- **Evidence Collector** - Audit evidence packages
  - Verifiable evidence with SHA-256 checksums
  - Regulation-specific collection (GDPR, SOC2, CSSF)
- **Compliance Dashboard** - Real-time compliance status
  - Per-regulation status (compliant/at_risk/non_compliant)
  - Compliance score calculation (0-100)
  - CLI-formatted dashboard output
- **Change Log** - Configuration change tracking (SOC2)
  - Before/after value tracking
  - Impact assessment (low/medium/high/critical)
  - Approval workflow support
- **Policy Doc Manager** - Policy documentation management
  - 6 policy types: privacy, retention, access control, encryption, incident response, acceptable use
  - Version control and review scheduling
- **16 MCP Compliance Tools** - Claude integration
  - Full compliance functionality exposed via MCP tools
  - Real-time compliance status queries

### Technical Details
- **23 new TypeScript modules** in `src/compliance/`
- **13,147 lines of code** for compliance functionality
- **All modules use singleton pattern** for consistent state management
- **Full type safety** with comprehensive TypeScript interfaces
- **Zero external dependencies** for compliance code

### Documentation
- Added `docs/COMPLIANCE-SPEC.md` - Full 4-phase implementation specification
- Added MEDUSA scan response documenting false positive analysis

## [1.2.0] - 2025-11-21

### Added
- **Tool Profiles System** - Reduce token usage by loading only the tools you need
  - Three profiles: `minimal` (5 tools), `standard` (10 tools), `full` (16 tools)
  - Persistent configuration via `~/.config/notebooklm-mcp/settings.json`
  - Environment variable overrides: `NOTEBOOKLM_PROFILE`, `NOTEBOOKLM_DISABLED_TOOLS`

- **CLI Configuration Commands** - Easy profile management without editing files
  - `npx notebooklm-mcp config get` - Show current configuration
  - `npx notebooklm-mcp config set profile <name>` - Set profile (minimal/standard/full)
  - `npx notebooklm-mcp config set disabled-tools <list>` - Disable specific tools
  - `npx notebooklm-mcp config reset` - Reset to defaults

### Changed
- **Modularized Codebase** - Improved maintainability and code organization
  - Split monolithic `src/tools/index.ts` into `definitions.ts` and `handlers.ts`
  - Extracted resource handling into dedicated `ResourceHandlers` class
  - Cleaner separation of concerns throughout the codebase

### Fixed
- **LibreChat Compatibility** - Fixed "Server does not support completions" error
  - Added `prompts: {}` and `logging: {}` to server capabilities
  - Resolves GitHub Issue #3 for LibreChat integration

- **Thinking Message Detection** - Fixed incomplete answers showing placeholder text
  - Now waits for `div.thinking-message` element to disappear before reading answer
  - Removed unreliable text-based placeholder detection (`PLACEHOLDER_SNIPPETS`)
  - Answers like "Reviewing the content..." or "Looking for answers..." no longer returned prematurely
  - Works reliably across all languages and NotebookLM UI changes

## [1.1.2] - 2025-10-19

### Changed
- **README Documentation** - Added Claude Code Skill reference
  - New badge linking to [notebooklm-skill](https://github.com/PleasePrompto/notebooklm-skill) repository
  - Added prominent callout section explaining Claude Code Skill availability
  - Clarified differences between MCP server and Skill implementations
  - Added navigation link to Skill repository in top menu
  - Both implementations use the same browser automation technology

## [1.1.1] - 2025-10-18

### Fixed
- **Binary executable permissions** - Fixed "Permission denied" error when running via npx
  - Added `postbuild` script that automatically runs `chmod +x dist/index.js`
  - Ensures binary has executable permissions after compilation
  - Fixes installation issue where users couldn't run the MCP server

### Repository
- **Added package-lock.json** - Committed lockfile to repository for reproducible builds
  - Ensures consistent dependency versions across all environments
  - Improves contributor experience with identical development setup
  - Enables `npm ci` for faster, reliable installations in CI/CD
  - Follows npm best practices for library development (2025)

## [1.1.0] - 2025-10-18

### Added
- **Deep Cleanup Tool** - Comprehensive system cleanup for fresh NotebookLM MCP installations
  - Scans entire system for ALL NotebookLM files (installation data, caches, logs, temp files)
  - Finds hidden files in NPM cache, Claude CLI logs, editor logs, system trash, temp backups
  - Shows categorized preview before deletion with exact file list and sizes
  - Safe by design: Always requires explicit confirmation after preview
  - Cross-platform support: Linux, Windows, macOS
  - Enhanced legacy path detection for old config.json files
  - New dependency: globby@^14.0.0 for advanced file pattern matching
- CHANGELOG.md for version tracking
- Changelog badge and link in README.md

### Changed
- **Configuration System Simplified** - No config files needed anymore!
  - `config.json` completely removed - works out of the box with sensible defaults
  - Settings passed as tool parameters (`browser_options`) or environment variables
  - Claude can now control ALL browser settings via tool parameters
  - `saveUserConfig()` and `loadUserConfig()` functions removed
- **Unified Data Paths** - Consolidated from `notebooklm-mcp-nodejs` to `notebooklm-mcp`
  - Linux: `~/.local/share/notebooklm-mcp/` (was: `notebooklm-mcp-nodejs`)
  - macOS: `~/Library/Application Support/notebooklm-mcp/`
  - Windows: `%LOCALAPPDATA%\notebooklm-mcp\`
  - Old paths automatically detected by cleanup tool
- **Advanced Browser Options** - New `browser_options` parameter for browser-based tools
  - Control visibility, typing speed, stealth mode, timeouts, viewport size
  - Stealth settings: Random delays, human typing, mouse movements
  - Typing speed: Configurable WPM range (default: 160-240 WPM)
  - Delays: Configurable min/max delays (default: 100-400ms)
  - Viewport: Configurable size (default: 1024x768, changed from 1920x1080)
  - All settings optional with sensible defaults
- **Default Viewport Size** - Changed from 1920x1080 to 1024x768
  - More reasonable default for most use cases
  - Can be overridden via `browser_options.viewport` parameter
- Config directory (`~/.config/notebooklm-mcp/`) no longer created (not needed)
- Improved logging for sessionStorage (NotebookLM does not use sessionStorage)
- README.md updated to reflect config-less architecture

### Fixed
- **Critical: envPaths() default suffix bug** - `env-paths` library appends `-nodejs` suffix by default
  - All paths were incorrectly created with `-nodejs` suffix
  - Fix: Explicitly pass `{suffix: ""}` to disable default behavior
  - Affects: `config.ts` and `cleanup-manager.ts`
  - Result: Correct paths now used (`notebooklm-mcp` instead of `notebooklm-mcp-nodejs`)
- Enhanced cleanup tool to detect all legacy paths including manual installations
  - Added `getManualLegacyPaths()` method for comprehensive legacy file detection
  - Finds old config.json files across all platforms
  - Cross-platform legacy path detection (Linux XDG dirs, macOS Library, Windows AppData)
- **Library Preservation Option** - cleanup_data can now preserve library.json
  - New parameter: `preserve_library` (default: false)
  - When true: Deletes everything (browser data, caches, logs) EXCEPT library.json
  - Perfect for clean reinstalls without losing notebook configurations
- **Improved Auth Troubleshooting** - Better guidance for authentication issues
  - New `AuthenticationError` class with cleanup suggestions
  - Tool descriptions updated with troubleshooting workflows
  - `get_health` now returns `troubleshooting_tip` when not authenticated
  - Clear workflow: Close Chrome → cleanup_data(preserve_library=true) → setup_auth/re_auth
  - Critical warnings about closing Chrome instances before cleanup
- **Critical: Browser visibility (show_browser) not working** - Fixed headless mode switching
  - **Root cause**: `overrideHeadless` parameter was not passed from `handleAskQuestion` to `SessionManager`
  - **Impact**: `show_browser=true` and `browser_options.show=true` were ignored, browser stayed headless
  - **Solution**:
    - `handleAskQuestion` now calculates and passes `overrideHeadless` parameter correctly
    - `SharedContextManager.getOrCreateContext()` checks for headless mode changes before reusing context
    - `needsHeadlessModeChange()` now checks CONFIG.headless when no override parameter provided
  - **Session behavior**: When browser mode changes (headless ↔ visible):
    - Existing session is automatically closed and recreated with same session ID
    - Browser context is recreated with new visibility mode
    - Chat history is reset (message_count returns to 0)
    - This is necessary because NotebookLM chat state is not persistent across browser restarts
  - **Files changed**: `src/tools/index.ts`, `src/session/shared-context-manager.ts`

### Removed
- Empty postinstall scripts (cleaner codebase)
  - Deleted: `src/postinstall.ts`, `dist/postinstall.js`, type definitions
  - Removed: `postinstall` npm script from package.json
  - Follows DRY & KISS principles

## [1.0.5] - 2025-10-17

### Changed
- Documentation improvements
- Updated README installation instructions

## [1.0.4] - 2025-10-17

### Changed
- Enhanced usage examples in documentation
- Fixed formatting in usage guide

## [1.0.3] - 2025-10-16

### Changed
- Improved troubleshooting guide
- Added common issues and solutions

## [1.0.2] - 2025-10-16

### Fixed
- Fixed typos in documentation
- Clarified authentication flow

## [1.0.1] - 2025-10-16

### Changed
- Enhanced README with better examples
- Added more detailed setup instructions

## [1.0.0] - 2025-10-16

### Added
- Initial release
- NotebookLM integration via Model Context Protocol (MCP)
- Session-based conversations with Gemini 2.5
- Source-grounded answers from notebook documents
- Notebook library management system
- Google authentication with persistent browser sessions
- 16 MCP tools for comprehensive NotebookLM interaction
- Support for Claude Code, Codex, Cursor, and other MCP clients
- TypeScript implementation with full type safety
- Playwright browser automation with stealth mode