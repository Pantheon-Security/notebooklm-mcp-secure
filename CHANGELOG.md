# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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