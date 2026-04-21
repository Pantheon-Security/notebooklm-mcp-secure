# NotebookLM-MCP-Secure — Master Issue List

> Consolidated from 4 parallel reviewers (MCP Developer, Architect, Skeptic, Sentinel)
> Generated 2026-04-17 against `main` @ 2973097 (v2026.2.11)
> Organized by area so you can work file-by-file. Severity inline.

## Status — 2026-04-21 (Day 3 complete)

**Closed this session (38 issues):**

Highs — security hardening + browser reliability:
- Auth type safety + token salt: I007, I110
- Test coverage (browser-session, shared-context-manager, prompt-injection): I128, I215
- Auth/webhook hardening: I123, I274, I276
- Notebook creator reliability + typed errors: I159, I161
- Session headless guard: I131
- Selector timeout budget: I145
- Advanced tools env flag + notebook-creator split: I069, I154

Mediums — MCP protocol + schema correctness:
- Response shape (structuredContent, isError, transport tags, shutdown flush): I010, I011, I012, I013, I014
- Annotation correctness (readOnlyHint, idempotentHint): I035, I036, I037, I038, I039
- Schema bounds (deep_research, list_documents, query history, chat history, browser timeout, batch): I050, I051, I052, I053, I054, I055, I056, I057
- Config + types cleanup (getConfig alias, followUpReminder, BrowserOptions, Tool re-export): I024, I025, I026, I029
- Source tool contracts + as-any reduction: I063, I064, I015

**Running totals after Day 3:**
- 565 tests passing (up from 259 after Day 2)
- tsc --noEmit clean

---

## Status — 2026-04-18 (Day 2 complete)

**Closed across two days of work (42 issues):**

Day 2 (2026-04-18) — 14 remaining crits closed:
- Webhook SSRF: I269
- Audit integrity cluster: I216, I217, I218
- Compliance wiring: I243, I244
- PQ claim honesty: I191
- Test coverage (6 new test files, +120 tests, 139 → 259): I121, I122, I251, I256, I268, I284
- Coverage aggregate + CI: I297

**Baseline test coverage after Day 2** (vitest --coverage, security-critical modules):
- mcp-auth.ts: 75.7% lines
- webhook-dispatcher.ts: 71.4% lines
- data-erasure.ts: 72.0% lines
- dsar-handler.ts: 59.0% lines
- quota-manager.ts: 31.9% lines (patchright-dependent scrapers pending integration tests)
- auth-manager.ts: 13.1% lines (browser paths pending integration tests)

4 of 6 security-critical modules exceed the 45% target. auth-manager and quota-manager have large patchright-dependent surfaces that require real browser contexts; those belong in an integration harness rather than unit coverage.

---

## Status — 2026-04-17 (evening session)

**Closed this session (35 issues):**

- Protocol & transport: I001, I002, I003, I004, I012, I135
- Annotations: I030, I031, I032, I033, I034, I035, I036, I037, I038
- Selectors: I138, I139, I140, I153, I162
- Query logger / secrets scanner: I181, I230, I231
- Tool handlers / file I/O: I315, I316, I317
- Hygiene / dead code: I068, I198, I199, I200, I201, I309, I310
- Cert pinning retraction: I174, I175, I176, I177, I178, I179, I180, I331 (via D2 delete)
- Claims alignment: I075 (privacy-notice cert claim), I248, I250 (policy-docs + privacy claims)
- Audit retention default: I220, I348 (default flipped to 2555 days)
- MEDUSA CI gate: I308, I333 (CI workflow added)
- Compliance scaffolding: I237, I238, I239, I240, I241, I242, I246, I247, I343 (tools now registered; deeper integration for I243/I244 pending)

**D1 follow-ups (deeper compliance integration — next session):**
- I243 — wire `ChangeLog.recordChange` into config mutation sites
- I244 — subscribe `BreachDetector.checkEvent` to the audit event bus
- I247 — pipe every `audit.*` call through `siem-exporter`
- I245 — surface `HealthMonitor` metrics in a periodic audit event

## Legend
- **SEV**: critical / high / medium / low / nit
- **Src**: which reviewer surfaced it — M=MCP, A=Architect, S=Skeptic, Sn=Sentinel
- **ID**: `I###` — stable for tracking

## Summary totals
- critical: 33
- high: 88
- medium: 119
- low: 76
- nit: 18
- **Total unique issues: 334**

---

# AREA 1 — Bootstrap, transport, errors (`src/index.ts`, `errors.ts`, `types.ts`, `config.ts`)

- **I001** [critical][M] `src/index.ts:204` — `progressToken` read from `args._meta.progressToken`; per SDK, `_meta` lives on `request.params._meta`. Progress notifications are silently dead. **Fix:** `request.params._meta?.progressToken`.
- **I002** [critical][M] `src/index.ts:205` — `authToken` pulled from the same wrong path. Only env-var fallback works. **Fix:** `request.params._meta?.authToken`.
- **I003** [critical][M] `src/index.ts:222-232, 255-262, 281-295` — every failure path returns `{ content: [...] }` without `isError: true`. Hosts cannot distinguish tool errors from successful output. **Fix:** add `isError: true` on every error branch.
- **I004** [critical][Sn] `src/index.ts:214` + `src/tools/handlers/auth.ts:131-234` — `re_auth` not in `TOOLS_REQUIRING_AUTH`. With `NLMCP_AUTH_DISABLED=true`, any client can trigger `clearAllAuthData()` → full credential wipe DoS. **Fix:** add `re_auth`, `setup_auth`, `configure_webhook`, `remove_webhook`, `delete_document` with `forceAuth=true`.
- **I005** [high][M] `src/index.ts:88` — `completions: {}` capability declared but declaration shape should be verified; comment says "Required for completion/complete handler" — misleading. **Fix:** align capability declaration with SDK spec.
- **I006** [high][M] `src/index.ts:88` — `logging: {}` capability declared but no `server.sendLoggingMessage` calls anywhere. Advertising unused capability misleads clients. **Fix:** remove or wire up log forwarding.
- **I007** [high][A] `src/index.ts:214` — `TOOLS_REQUIRING_AUTH` is inline string array; not type-checked against tool-name union. Silent drift as tools are added. **Fix:** `Set<ToolName>` typed against the tool-name type.
- **I008** [high][A] `src/index.ts:131-191` — `toolRegistry: Map<string, (a: any, p?: any) => Promise<any>>` — fully untyped dispatch table in hot path. **Fix:** type against `ToolHandlers` union.
- **I009** [high][A] `src/types.ts:103-107` — `ServerState` declares `playwright: any; sessionManager: any; authManager: any`. Three `any` in a shared type. **Fix:** use real types or delete if unused.
- **I010** [medium][M] `src/index.ts:268-275` — success path stringifies JSON into a single `text` block; doesn't use SDK v1.13+ `structuredContent`. **Fix:** return `{ content, structuredContent: result }`.
- **I011** [medium][M] `src/index.ts:194-199` — `list_tools` unpaginated; ~42 tools × ~2 KB = ~80 KB per listing. **Fix:** add optional cursor paging.
- **I012** [medium][M] `src/index.ts:220-233` — auth-failure response is a success-looking object without `isError: true`. **Fix:** set `isError: true`.
- **I013** [medium][M] `src/index.ts:276-296` — transport/protocol errors indistinguishable from domain errors in JSON body. **Fix:** tag transport errors separately.
- **I014** [medium][M] `src/index.ts:336-346` — `uncaughtException`/`unhandledRejection` call `requestShutdown` but don't flush in-flight MCP responses. Clients see hung stream. **Fix:** send final error frame before exit.
- **I015** [medium][A] `src/index.ts` — 301 `as any`/`@ts-expect-error` across 21 files (concentrated in notebook-creation/, session/). With `strict: true` these are real type gaps. **Fix:** audit each; annotate reason; replace with typed alternatives.
- **I016** [medium][M] `src/errors.ts` — only two error classes (`RateLimitError`, `AuthenticationError`). Handlers resort to stringly-typed `Error` + `.includes()`. **Fix:** add `ValidationError`, `QuotaError`, `NotFoundError`, `UpstreamError`, `BrowserError`, `SessionExpiredError`.
- **I017** [low][M] `src/errors.ts:33` — `AuthenticationError.suggestCleanup` flag unused. **Fix:** surface in payload or drop.
- **I018** [low][A] `src/index.ts:404-408` — startup logs truncate descriptions to 80 chars including emoji. Wastes budget on decoration. **Fix:** strip emoji from truncation.
- **I019** [low][M] `src/index.ts:411` — banner refers to `MCP_INFOS.md` which doesn't exist. **Fix:** remove or create.
- **I020** [low][M] `src/index.ts:131-191` — `this.toolRegistry!` non-null assertion awkward. **Fix:** initialize in field or use definite-assignment.
- **I021** [nit][A] `src/index.ts:116` — emoji-prefixed startup `🚀` on stderr. Noisy for clients. **Fix:** gate behind `--verbose`.
- **I022** [medium][M] `src/tools/definitions.ts:51-72` + `src/index.ts:108` — `buildToolDefinitions` built once at construction; `ask_question` description uses active notebook state but never updates after switching. **Fix:** rebuild on `list_tools` or send `notifications/tools/list_changed`.
- **I023** [high][A] `src/config.ts:418` — `ensureDirectories()` runs as import side effect. Tests importing config create filesystem state. **Fix:** explicit `initialize()` in server startup.
- **I024** [medium][A] `src/config.ts:323` — `getConfig()` is a pure alias for `CONFIG`; adds indirection with no encapsulation. **Fix:** delete.
- **I025** [medium][A] `src/config.ts:179` — 230-char ALLCAPS `followUpReminder` default embedded inline. **Fix:** extract as named constant.
- **I026** [medium][A] `src/config.ts` — `BrowserOptions`/`applyBrowserOptions` mixed with app config. **Fix:** move to `src/notebook-creation/browser-options.ts`.
- **I027** [medium][S] `src/config.ts` `parseInteger` — `parseInteger("1e9", 0) === 1` (parseInt stops at `e`). **Fix:** `Number.parseFloat` + `Math.trunc` with reject on non-integer.
- **I028** [low][S] `src/config.ts` `parseArray` — comma-only delimiter; `;`-separated input is a single element. **Fix:** document or support both.
- **I029** [medium][A] `src/types.ts:60-70` — `Tool` interface re-declares SDK types. Parallel divergence risk. **Fix:** re-export SDK types.

---

# AREA 2 — Tool definitions & annotations (`src/tools/definitions/*`, `annotations.ts`)

### Annotations wrong
- **I030** [high][M] `annotations.ts:124-133` — `export_library` has `readOnlyHint:true` but writes to disk. **Fix:** `readOnlyHint:false`.
- **I031** [high][M] `annotations.ts:222-231` — `download_audio` has `readOnlyHint:true` but writes file. **Fix:** `readOnlyHint:false`.
- **I032** [high][M] `annotations.ts:328-337` — `setup_auth` has `destructiveHint:false` but clears all saved credentials. **Fix:** `destructiveHint:true`.
- **I033** [high][M] `annotations.ts:358-366` — `get_quota` has `openWorldHint:false` but `sync=true` navigates to notebooklm.google.com. **Fix:** `openWorldHint:true` or split into two tools.
- **I034** [high][M] `annotations.ts:412-421` — `test_webhook` has `readOnlyHint:true` despite sending HTTP to third-party. **Fix:** `readOnlyHint:false`.
- **I035** [medium][M] `annotations.ts:30-39` — `ask_question` marked `readOnlyHint:true` but increments `use_count`, mutates quota, writes query log. **Fix:** `readOnlyHint:false`.
- **I036** [medium][M] `annotations.ts:44-53` — `add_notebook` claims `idempotentHint:true`; `NotebookLibrary.addNotebook` creates new entries per call. **Fix:** verify dedupe or `idempotentHint:false`.
- **I037** [medium][M] `annotations.ts:470-479` — `upload_document.idempotentHint:true` false; Files API creates new file per upload. **Fix:** `idempotentHint:false`.
- **I038** [medium][M] `annotations.ts:179-186` — `add_source.idempotentHint:true` false; adds duplicate entries. **Fix:** `idempotentHint:false`.
- **I039** [medium][M] `annotations.ts:155-162` — `batch_create_notebooks` annotations need review (destructiveHint judgement). **Fix:** clarify.
- **I040** [nit][M] `annotations.ts:260-269` — `generate_data_table` missing `execution.taskSupport`; takes 1–3 min. **Fix:** add on all long-running tools.
- **I041** [low][M] `annotations.ts` — every annotation has both top-level `title` and `annotations.title`; already drifted. **Fix:** single source of truth.

### Schema quality — universally missing constraints
- **I042** [high][M] All `inputSchema` in `src/tools/definitions/*.ts` lack `additionalProperties:false`. Clients can pass arbitrary extras. **Fix:** add universally.
- **I043** [high][M] `ask-question.ts:124-127` — `question` unbounded; handler validates. **Fix:** `minLength:1, maxLength:N`.
- **I044** [high][M] `gemini.ts:39-42` — `deep_research.query` unbounded; handler enforces 10000. **Fix:** `maxLength:10000`.
- **I045** [high][M] `gemini.ts:91-94` — `gemini_query.query` unbounded; handler enforces 30000. **Fix:** `maxLength:30000`.
- **I046** [high][M] `system.ts:274-276` — `configure_webhook.url` accepts any string. SSRF vector (see I168). **Fix:** `format:"uri"`, scheme+host allowlist.
- **I047** [high][M] `notebook-management.ts:46-49` — `add_notebook.url`/`update_notebook.url` unconstrained. **Fix:** `format:"uri"`, pattern anchored at notebooklm.google.com.
- **I048** [high][M] `notebook-management.ts:536-539` — `add_folder.folder_path` unconstrained; path traversal possible. **Fix:** constrain to allowlist; reject `..`/`~`.
- **I049** [medium][M] `gemini.ts:200-210` — `upload_document.file_path` unconstrained. **Fix:** allowlist upload dirs.
- **I050** [medium][M] `gemini.ts:48-51` — `deep_research.max_wait_seconds` no bounds; handler caps 600. **Fix:** `minimum:10, maximum:600`.
- **I051** [medium][M] `gemini.ts:288-296` — `list_documents.page_size` unconstrained. **Fix:** `minimum:1, maximum:1000`.
- **I052** [medium][M] `query-history.ts:40-43` — `limit` unconstrained. **Fix:** `minimum:1, maximum:500`.
- **I053** [medium][M] `chat-history.ts:58-65` — `limit`/`offset` unconstrained. **Fix:** add bounds.
- **I054** [medium][M] `ask-question.ts:163-167` — `browser_options.timeout_ms` unconstrained; MAX_SAFE_INTEGER accepted. **Fix:** `minimum:1000, maximum:300000`.
- **I055** [medium][M] `ask-question.ts:188-202` — typing/delay fields unconstrained, no cross-field min≤max. **Fix:** per-field bounds + handler cross-check.
- **I056** [medium][M] `notebook-management.ts:58-76` — topics/tags/content_types arrays unconstrained. **Fix:** `maxItems:50, items:{maxLength:100}`.
- **I057** [medium][M] `notebook-management.ts:688-731` — `batch_create_notebooks.notebooks` has `maxItems:10` but inner `sources` unbounded. **Fix:** add `maxItems` on nested arrays.
- **I058** [medium][M] `query-history.ts:31-34` — `date` string no pattern/format. **Fix:** `pattern:"^\\d{4}-\\d{2}-\\d{2}$"`.
- **I059** [low][M] `gemini.ts:97-100, 375-380` — `model` enum includes gemini-2.5-* retired March 2026; today is 2026-04-17. **Fix:** remove retired values; extract to shared constant.
- **I060** [low][M] `gemini.ts:122-127` — `response_schema` typed `object` with no sub-schema. **Fix:** document shape or mark `additionalProperties:true`.
- **I061** [low][M] `video.ts:58-62` — `style` enum doesn't match example at line 45 (`"documentary"` not in enum). **Fix:** align.

### Schema vs handler drift
- **I062** [high][M] `gemini.ts:52-58` — `deep_research.thinking_level` defined in schema but handler at `gemini.ts:36-41` doesn't accept or forward it. Silently dropped. **Fix:** thread through.
- **I063** [medium][M] `notebook-management.ts:509` — `add_source` requires `source` only; active-notebook fallback undocumented. **Fix:** `oneOf` for explicit contract.
- **I064** [medium][M] `notebook-management.ts:601` — `remove_source` same fallback ambiguity. **Fix:** as above.
- **I065** [medium][M] `notebook-management.ts:438-450` — `list_sources` no required fields; handler throws without active notebook. **Fix:** describe `anyOf`.
- **I066** [medium][M] `tools/handlers/auth.ts:49-54,157-164` — returns `authenticated:false` via `as any`; `ToolResult` has no such top-level field. **Fix:** place inside `data` or broaden type.
- **I067** [nit][M] `tools/handlers/notebook-management.ts:18,44,70,105,132,158,206,232` — handlers declared `Promise<ToolResult<{ notebook: any }>>`. **Fix:** use real `Notebook` type.

### Tool surface, descriptions, discoverability
- **I068** [critical][M,A] `/home/ross/Documents/projects/notebooklm-mcp-secure/tools.yaml` (repo root, untracked) — 935 lines of Portainer MCP tools, not this project. Looks authoritative. **Fix:** delete.
- **I069** [high][M] 42 total tools in `src/index.ts:132-191`; exceeds 30–40 sweet spot. **Fix:** merge generation-status checks, webhook CRUD, etc.
- **I070** [high][M] `ask-question.ts:15-99` — `buildAskQuestionDescription` produces ~80 lines per call with emojis and code fences, emitted every `list_tools`. **Fix:** trim to 10–15 lines; move examples to prompt template.
- **I071** [high][M] `ask-question.ts:11-13,97` — description interpolates `active.name/description/topics` verbatim. Confidential notebook names exposed to every `list_tools` call including proxies/log aggregators. **Fix:** use placeholder; expose details via resource.
- **I072** [medium][M] `system.ts:127-146` — `cleanup_data` description ~20 lines with 8 enumerated categories. **Fix:** trim.
- **I073** [medium][M] `notebook-management.ts:6-42` — `add_notebook` description ~35 lines including signup tutorial. **Fix:** trim; move to prompt.
- **I074** [medium][M] `system.ts:29-124` — `setup_auth` and `re_auth` are ~95% overlapping. **Fix:** merge into `authenticate(clear_existing?:boolean)`.
- **I075** [medium][M] `download_audio` exists but no `download_video` despite `generate_video_overview`. **Fix:** add or document gap.
- **I076** [medium][M] No tool to retrieve prior session answer without new query (costs quota). **Fix:** add or promote `get_notebook_chat_history`.
- **I077** [low][M] `session-management.ts:3-44` — `close_session`/`reset_session` near duplicates. **Fix:** optional merge.
- **I078** [low][M] `gemini.ts:298-328` — `delete_document` destructive but no `confirm` param. **Fix:** add optional `confirm:boolean`.
- **I079** [nit][M] Tool titles mix gerunds and imperatives. **Fix:** pick one.
- **I080** [nit][M] `gemini.ts:41` — `⚠️ REQUIRES GEMINI_API_KEY` prefix in several descriptions. **Fix:** use structured error code instead.
- **I081** [nit][M] `system.ts:131` — `⚠️ CRITICAL:` warning about Chrome is behaviour, not hint. **Fix:** detect Chrome + fail fast.
- **I082** [nit][M] `system.ts:135-146` — "ULTRATHINK Deep Cleanup" marketing copy in description. **Fix:** remove.

### Zod / schemas
- **I083** [medium][M] `package.json:66` declares `zod ^4.3.6` as runtime dep, but zero tool definitions use Zod. All inputSchemas are hand-written JSON. **Fix:** adopt Zod schemas OR remove dep if only SDK-transitive.
- **I084** [low][M] If Zod kept for SDK use, comment accordingly. **Fix:** add explanatory comment.

### Misc tool wiring
- **I085** [nit][M] `tools/handlers/system.ts:239,280`; `webhooks.ts:14,70,95,130`; `gemini.ts:530` — unused `_ctx: HandlerContext` parameters. **Fix:** drop or absorb.
- **I086** [nit][M] `tools/handlers/ask-question.ts:189-190` — `followUpReminder` appended to every answer invisibly. **Fix:** declare in description or expose as field.

---

# AREA 3 — Tool handlers (`src/tools/handlers/*`)

- **I087** [high][M] All handlers — raw `error.message` serialized back to client. fs errors leak absolute paths; Playwright errors leak CSS selectors; quota errors leak state. **Fix:** error mapper strips paths/selectors/stack fragments.
- **I088** [high][M] `ask-question.ts:84,96,109,271,285` — `audit.tool("ask_question", args, ...)` passes full args incl. raw question on failure; success path at 251-255 correctly redacts to `question_length`. PII leaks to audit on error paths. **Fix:** mirror redaction on all branches.
- **I089** [high][Sn] `tools/handlers/webhooks.ts:13-67` — `handleConfigureWebhook` passes url/secret/events/headers to dispatcher with no validation. **Fix:** validate URL (see I046, I168).
- **I090** [medium][M] `ask-question.ts:266` — heuristic `errorMessage.toLowerCase().includes("rate limit")` triggers for unrelated errors mentioning it. **Fix:** rely on `instanceof RateLimitError`.
- **I091** [medium][Sn] `tools/handlers/ask-question.ts:76-88` — only tool rate-limited; key falls back to literal `'global'` when no session_id. **Fix:** apply globally in dispatcher; key by auth-identity hash.
- **I092** [medium][A] `src/tools/handlers/notebook-management.ts` — every handler repeats identical try/catch boilerplate across 10+ handlers. **Fix:** `withErrorHandling(fn)` helper.
- **I093** [low][M] `audio-video.ts:30-58,91-119,147-175,209-239,276-304,332-360,393-421` — identical notebook-URL resolution duplicated 7×. **Fix:** extract `resolveNotebookUrl(ctx, args)`.
- **I094** [low][M] `notebook-creation.ts:344-365,414-431,572-589,724-740` — same resolution pattern duplicated in source-manager handlers. **Fix:** same helper.
- **I095** [low][M] `tools/handlers/auth.ts:49` — error path missing `data` field that success returns. **Fix:** consistent shape.
- **I096** [low][M] `tools/handlers/notebook-creation.ts:671-674` — loop catches + `log.warning` with raw message (path leakage). **Fix:** sanitise first.
- **I097** [medium][A] `src/tools/handlers/index.ts:99` — `GeminiClient` unconditionally instantiated at construction even without API key. **Fix:** lazy init behind config check.
- **I098** [medium][A] `src/tools/handlers/index.ts:99` — `new RateLimiter(100, 60000)` magic numbers. **Fix:** read from CONFIG.
- **I099** [low][A] `src/tools/handlers/index.ts:289` — `cleanup()` logs with emoji while others don't. **Fix:** consistent tone.
- **I100** [nit][A] `src/tools/handlers/index.ts:87,289` — facade class delegates except `cleanup()` which contains its own logic. **Fix:** extract `handleCleanup`.
- **I101** [medium][A] `src/tools/handlers/ask-question.ts:222-226` — progress block indented 6 spaces amid 4-space surroundings. **Fix:** fix indent.

---

# AREA 4 — Resources & prompts (`src/resources/*`)

- **I102** [high][M] `resources/resource-handlers.ts:182-251` — `throw new Error(...)` in `ReadResourceRequestSchema` interpolates user-provided URI into message. Log-injection vector. **Fix:** sanitise before interpolating.
- **I103** [medium][M] `resource-handlers.ts:47-111` — resource listing unpaginated. **Fix:** cursor pagination.
- **I104** [medium][M] `resource-handlers.ts:73-86` — per-notebook `mimeType:"application/json"` but `description` embeds pipe-delimited human text. Neither valid JSON nor structured. **Fix:** keep prose in description; move topics to content.
- **I105** [medium][M] `resource-handlers.ts:91-108` — `notebooklm://metadata` marked DEPRECATED but still listed. Non-deterministic resource listings. **Fix:** remove or set removal date.
- **I106** [low][M] `resource-handlers.ts:256-270` — `CompleteRequestSchema` casts `request.params as any` and returns `as any`. **Fix:** narrow with typed discriminant.
- **I107** [low][M] `resource-handlers.ts:195` — notebook-id regex `^[a-z0-9][a-z0-9-]{0,62}$` caps at 63; library may allow otherwise. **Fix:** centralise validator.
- **I108** [low][M] `resource-handlers.ts:179-215` — URI template doesn't enforce single path segment; fragile. **Fix:** explicit parse.
- **I109** [low][M] `resource-handlers.ts:283-308` — prompts declared `arguments:[]`; no parameterisation. **Fix:** add optional args or document static.

---

# AREA 5 — Auth & sessions (`src/auth/*`, `src/session/*`)

### Credential storage / token handling
- **I110** [high][Sn] `src/auth/mcp-auth.ts:189-207` — `hashToken = SHA256(token)` no salt, no PBKDF2/argon2. `auth-token.hash` allows offline brute of 24-byte token. **Fix:** scrypt/argon2id with per-token salt, or HMAC with server secret.
- **I111** [high][S] `src/auth/mcp-auth.ts:96` — `failedAttempts: Map` unbounded; memory DoS via per-IP/clientId spam. **Fix:** LRU-evict older than `lockoutDuration * 2`.
- **I112** [high][S] `src/auth/mcp-auth.ts:292` — default `clientId="unknown"`; all unauthenticated traffic shares one lockout tracker. One attacker locks everyone out. **Fix:** require clientId; fall back to client IP.
- **I113** [medium][Sn] `src/auth/mcp-auth.ts:243-275` — `clientId` defaults to tool name; not a network identity. Shared lockout bucket. **Fix:** derive from auth-token hash.
- **I114** [high][S] `src/auth/mcp-auth.ts:219-235` — after lockout expiry `tracker.count` reset but `lockoutCount` retained; legit user returning a week later gets escalated on first mistype. **Fix:** decay `lockoutCount` over time.
- **I115** [medium][S] `src/auth/mcp-auth.ts:324` — `secureCompare(providedHash, this.tokenHash ?? "")` compares hex with empty string (finding I215). **Fix:** initialise `tokenHash` to fixed-length random hex.
- **I116** [medium][S] `src/auth/mcp-auth.ts:126-137` — token-file validates only length 64; no hex regex. **Fix:** `/^[0-9a-f]{64}$/`.
- **I117** [medium][S] `src/auth/mcp-auth.ts:99-101` — multiple `MCPAuthenticator` instantiations create divergent tracker state. **Fix:** enforce singleton.
- **I118** [low][S] `src/auth/mcp-auth.ts:63-86` — dual env flags (`NLMCP_AUTH_DISABLED`/`_ENABLED`) with nuanced precedence; misconfig is silent. **Fix:** startup log with effective state + driving env var.
- **I119** [low][Sn] `src/auth/mcp-auth.ts:360-371` — `rotateToken()` only via CLI; no automatic rotation. **Fix:** optional periodic rotation.
- **I120** [medium][Sn] `src/index.ts:202-233` — single MCP token grants all tools incl. destructive. No RBAC. **Fix:** scoped tokens (read-only / admin).

### Auth Manager / login flow
- **I121** [critical][S] `src/auth/auth-manager.ts:1294 LoC` — ZERO unit tests on entire Google-login automation, cookie expiry, race-retry. **Fix:** unit-test `validateWithRetry`, `validateCookiesExpiry`, `isStateExpired`.
- **I122** [critical][S] `src/auth/mcp-auth.ts:493 LoC` — ZERO tests on token validation, lockout, exponential backoff. **Fix:** add tests.
- **I123** [high][S] `src/auth/auth-manager.ts:500-519` — `performLogin` has 10-min fixed upper bound; client disconnect leaves browser open. **Fix:** accept `AbortSignal`.
- **I124** [high][S] `src/auth/auth-manager.ts:466-506` — 600-iter poll with `waitForTimeout` but no page-closed detection. **Fix:** detect `page.isClosed()` and break.
- **I125** [medium][S] `src/auth/auth-manager.ts:632-641` — failure screenshot saved to `CONFIG.dataDir` with unrestricted mode; no retention. **Fix:** 0600 perms, crop fields, wire to retention.
- **I126** [low][S] `src/auth/auth-manager.ts:557-559` — `page.goto` timeout warning only; proceeds regardless. **Fix:** retry once then fail.
- **I127** [low][S] `src/auth/auth-manager.ts:165-178` `loadSessionStorage` — JSON.parse errors return null, indistinguishable from "no file". **Fix:** typed error.

### Session management
- **I128** [high][S] `src/session/session-manager.ts` + `shared-context-manager.ts` + `session-timeout.ts` — ZERO tests on session lifecycle, timeouts, context sharing. **Fix:** add tests.
- **I129** [high][A] `src/session/browser-session.ts:191-204` — `isPageClosedSafe()` uses `void this.page.url()` as side-effectful liveness check; nav error could be misread as "page closed". **Fix:** `page.isClosed()` direct.
- **I130** [high][S] `src/session/shared-context-manager.ts:258-263` — `close` handler unconditionally nulls `this.globalContext`; if `recreateContext` replaced it first, handler nulls the new live context (use-after-replace). **Fix:** capture ref in closure, compare before null.
- **I131** [high][S] `src/session/shared-context-manager.ts:76-101` — no lock around headless-change check; two concurrent `getOrCreateContext` can both close & recreate under the file lock. **Fix:** move inside `withLock`.
- **I132** [medium][Sn] `src/session/shared-context-manager.ts:203-208` — browser launched with `--disable-blink-features=AutomationControlled`, no `--disable-extensions`, no `--site-per-process`. **Fix:** add isolation flags.
- **I133** [medium][Sn] `src/session/shared-context-manager.ts:192` — `channel:"chrome"` uses system Chrome; if run as root the sandbox self-disables. **Fix:** prefer bundled chromium; detect root.
- **I134** [medium][S] `src/auth/auth-manager.ts` — `validateWithRetry` called only at start of `initialize`; long source upload may span cookie refresh by parallel process. **Fix:** periodic cookie-validity check in multi-step flows.
- **I135** [medium][M] `src/index.ts:214-233` — `upload_document` not in force-auth list; unauthenticated clients could upload arbitrary local files if auth disabled. **Fix:** add `upload_document`, `download_audio` to force-auth.
- **I136** [low][A] `src/session/browser-session.ts` — `SharedContextManager` co-located with browser-session; meaningful seam. **Fix:** give own file.

### Session timeout / lifecycle
- **I137** [high][Sn] `src/session/session-timeout.ts:262-265` — check runs every 30s with `unref()`; session can run up to 30s past expiry. Controlled by env flag (easy to disable). **Fix:** check on each tool invocation; tighten interval.

---

# AREA 6 — Browser automation (`src/notebook-creation/*`)

### Selector fragility
- **I138** [critical][A] `src/notebook-creation/selectors.ts:148` — `insertButton.primary:'button'` matches every button on the page. **Fix:** text-content or aria-label scoped.
- **I139** [critical][A] `src/notebook-creation/selectors.ts:29` — `notebookNameInput.primary:'input[type="text"]'` matches first text input anywhere. **Fix:** scope with container/aria-label.
- **I140** [critical][A] `src/notebook-creation/selectors.ts:137` — `submitButton.primary:'button:has-text("Insert")'` may not work in patchright; falls through to `button[type="submit"]` also non-specific. **Fix:** remove broken primary, promote reliable fallback.
- **I141** [medium][S] `src/notebook-creation/selectors.ts:122-132` — `chooseFileButton` includes `'a:text("choose file")'` — Playwright-extension syntax that may not exist in patchright. **Fix:** verify and drop.
- **I142** [medium][S] `src/notebook-creation/selectors.ts:205` — `chatInput.fallbacks:'textarea[aria-label]'` matches any textarea with aria-label. **Fix:** combine with role or container class.
- **I143** [high][S] `src/notebook-creation/selectors.ts:22-208` — 14 entries dated "confirmed: true, December 2025"; today 2026-04-17 (~4 months stale); no auto-freshness check. **Fix:** scheduled CI job using `run-discovery` + telemetry when fallback succeeds.
- **I144** [high][S] `src/notebook-creation/selectors.ts:224-242` `findElement` — `catch{}` swallows every error, indistinguishable from "not present". **Fix:** propagate error class, log counts per site.
- **I145** [high][S] `src/notebook-creation/selectors.ts:247-276` `waitForElement` — divides total timeout by selector count; on slow networks all get too little. **Fix:** full timeout on primary, short on fallbacks, or `Promise.any`.
- **I146** [low][S] `src/notebook-creation/selectors.ts` — `confirmed:false` selectors used in production with no runtime warning when used. **Fix:** debug log.
- **I147** [high][A] `src/utils/page-utils.ts` — 13 `RESPONSE_SELECTORS` defined outside `selectors.ts`. Selector knowledge split. **Fix:** move into `selectors.ts` as `responseContent`.
- **I148** [low][A] `src/notebook-creation/selectors.ts:137,151` — `submitButton` and `insertButton` overlap; comment says "use insertButton for text". **Fix:** merge with usage comment.
- **I149** [low][A] `src/notebook-creation/selectors.ts:216-276` — `findElement`/`waitForElement` belong in `src/utils/page-utils.ts`. **Fix:** move; keep selectors file data-only.
- **I150** [nit][A] `src/notebook-creation/selectors.ts:47` — locale note only on some selectors that mix locale-dependent/-independent. **Fix:** add to all.
- **I151** [nit][A] `src/notebook-creation/selectors.ts:156` — `closeDialogButton` uses British "dialogue"; primary should be class-based. **Fix:** audit.
- **I152** [low][S] `src/notebook-creation/selectors.ts:209` — `fallbacks: 'as const'` readonly tuple; fragile. **Fix:** ensure non-empty for unconfirmed selectors.

### Notebook creator (god file)
- **I153** [critical][A] `src/notebook-creation/notebook-creator.ts:365-383` — `clickAddSource()` iterates all buttons on page and logs each on every call. Debug DOM enumeration in production hot path. **Fix:** gate behind `DEBUG`.
- **I154** [high][A] `src/notebook-creation/notebook-creator.ts` — 1029-line god file with 8 responsibilities. **Fix:** extract `SourceAdder`, `ProcessingWatcher`, `NotebookNavigator`.
- **I155** [medium][A] `src/notebook-creation/notebook-creator.ts:24` + 4 peers — `NOTEBOOKLM_URL` duplicated in 5 files. **Fix:** import from `src/config.ts`.
- **I156** [medium][A] `src/notebook-creation/notebook-creator.ts:536-636` — `addTextSource()` inline `page.evaluate()` string doing DOM traversal; no types, no tests. **Fix:** extract to typed `dom-scripts.ts`.
- **I157** [medium][A] `src/notebook-creation/notebook-creator.ts` — two parallel `waitForSourceProcessing` methods, called inconsistently. **Fix:** document or merge with `lenient:boolean`.
- **I158** [medium][A] `src/notebook-creation/notebook-creator.ts:876` — magic `60000` timeout. **Fix:** name it.
- **I159** [high][S] `src/notebook-creation/notebook-creator.ts:151` — `waitForLoadState("networkidle").catch(()=>{})` swallows. **Fix:** log + bounded polling fallback.
- **I160** [high][S] `src/notebook-creation/notebook-creator.ts:40-116` — partial source failure leaves notebook half-populated; no rollback. **Fix:** atomic delete on failure OR `partial:true` flag + surface.
- **I161** [high][S] `src/notebook-creation/notebook-creator.ts:159-210` — `clickNewNotebook` throws generic error; doesn't capture tier, URL, screenshot. **Fix:** rich error context on throw.
- **I162** [high][S] `src/notebook-creation/notebook-creator.ts:365-383` — debug log serializes button text/aria-label; leaks notebook/source titles. **Fix:** gate + sanitize.
- **I163** [medium][S] `src/notebook-creation/notebook-creator.ts:252-297` — concurrent tool calls on same session interleave operations on shared page. **Fix:** per-page mutex; reject concurrent with BUSY or queue.
- **I164** [medium][S] Patchright hang — no per-method timeout on `page.evaluate` (`quota-manager.ts:139-182`, `notebook-creator.ts:306-343`). **Fix:** `Promise.race` with 30s timeout.
- **I165** [medium][S] Network-drop during source add — `waitForSourceProcessing` has no bounded upper-limit; can hang indefinitely. **Fix:** bound max duration.
- **I166** [low][A] `src/notebook-creation/notebook-creator.ts:352-496` — `clickAddSource()` 145 lines, 3 retry strategies inline. **Fix:** extract named methods.
- **I167** [low][A] `src/notebook-creation/notebook-creator.ts:644-759` — `addFileSource()` 116 lines, 3 upload strategies. **Fix:** extract.
- **I168** [medium][S] Default `waitUntil:"domcontentloaded"` returns before Angular hydrates; selectors race. **Fix:** wait on anchor element after DCL.
- **I169** [medium][S] `src/utils/stealth-utils.ts` — `humanType`/`realisticClick` on every auth path; no tests. Regression breaks 2FA. **Fix:** tests with fake timers.
- **I170** [nit][S] Timing bias in `humanType` could fingerprint individual user to NotebookLM's anti-abuse. **Fix:** document.
- **I171** [low][A] `src/notebook-creation/selector-discovery.ts:1` — 548 lines of dev tooling in `src/`, inflating production bundle. **Fix:** move to `scripts/` or `tools/`.
- **I172** [medium][A] `src/notebook-creation/selector-discovery.ts:535-539` — inline `CSS.escape` polyfill reimplements browser API available in chromium. **Fix:** remove polyfill.
- **I173** [low][Sn] `src/notebook-creation/notebook-creator.ts:66` — throws `Failed to create notebook - unexpected URL: ${url}` back to MCP client; URL may contain IDs. **Fix:** sanitise.

---

# AREA 7 — Crypto, secrets, secure memory

### Cert pinning (CRITICAL — theater + vulnerable)
- **I174** [critical][Sn] `src/utils/cert-pinning.ts` entire file — `CertificatePinningManager`/`createPinnedAgent`/`validateConnection` never imported from any production code outside tests. Browser launched via patchright `launchPersistentContext` bypasses pin check. **Fix:** wire into every `fetch` (Gemini, webhooks) or delete the claim.
- **I175** [critical][Sn] `src/utils/cert-pinning.ts:33-67` — pinned SPKI hashes are stale vs real Google cert; `reportOnly:true` means even if wired, everything passes. **Fix:** refresh pins; set `reportOnly:false` by default.
- **I176** [medium][S] `src/utils/cert-pinning.ts:33-67` — no pin expiry, no kill-switch. **Fix:** annotate pins with `notAfter`, warn 30 days before.
- **I177** [medium][S] `src/utils/cert-pinning.ts:148-178` — `validateCertificatePin` silently passes when no pins found for host. **Fix:** log debug line.
- **I178** [medium][Sn] `src/utils/cert-pinning.ts:113-143` — `getCertificateChainHashes` loops break on seen-fingerprint; truncated chains never reach the real root. **Fix:** use `tls.rootCertificates` + pin leaf/intermediate/root.
- **I179** [low][S] `tests/cert-pinning.test.ts:158-164` — no direct assertion on internal pin array length. **Fix:** expose `getPins(host)`.
- **I180** [medium][S] `tests/cert-pinning.test.ts:204-249` — tests pass a mocked `getPeerCertificate`; tests validate the mock, not real socket behaviour. **Fix:** integration test against local TLS server.

### Secrets scanner (CRITICAL — unused)
- **I181** [critical][Sn] `src/utils/secrets-scanner.ts` entire file — `SecretsScanner` defined but never imported by any caller. No output, log, or export goes through it. **Fix:** invoke in ask-question before query-log write and before returning to client.
- **I182** [high][S] `src/utils/secrets-scanner.ts:443-447` — `clean.replace(match, redacted)` replaces first occurrence only; second copy survives. **Fix:** global replace.
- **I183** [high][S] `src/utils/secrets-scanner.ts:61-66` — AWS Secret Access Key lookahead `(?=.*aws|.*secret|.*key)` only matches hint AFTER key; misses `AWS_SECRET = "..."`. **Fix:** either-side alternation or entropy scoring.
- **I184** [high][S] `src/utils/secrets-scanner.ts:245-251` — "High Entropy String" pattern triggers on JWT payloads, PNG data-URIs, GCS object names. At default `minSeverity=low` every response with an image data-URI gets flagged. **Fix:** Shannon entropy >4.5 + context heuristics.
- **I185** [medium][Sn] `src/utils/secrets-scanner.ts:246-251` — same pattern would flag legitimate ML-KEM `encapsulatedKey`, JWT payloads, CSRF tokens. **Fix:** tighten threshold; exempt known-safe contexts.
- **I186** [medium][S] `src/utils/secrets-scanner.ts:335-384` — no bound on input length; 100MB regex with catastrophic-backtracking risk. **Fix:** `text.length > maxInputBytes` short-circuit, pattern timeouts.
- **I187** [medium][S] `src/utils/secrets-scanner.ts:437-441` — `indexOf` on mutated `clean` recomputes offsets against shrunk string; positions wrong. **Fix:** use match `.index` captured at scan time.
- **I188** [medium][S] `src/utils/secrets-scanner.ts:299` — `NLMCP_SECRETS_IGNORE` split on comma no trim; `"foo, bar"` → `["foo"," bar"]`. **Fix:** trim.
- **I189** [low][S] `src/utils/secrets-scanner.ts:233-241` — Bearer token requires `A.B.C` JWT shape; opaque tokens missed. **Fix:** second pattern for opaque ≥20 chars.
- **I190** [low][S] `tests/secrets-scanner.test.ts:295-301` — only asserts critical absence; medium/low matches unchecked. **Fix:** assert exact match set.

### Crypto / key derivation
- **I191** [critical][Sn] `src/utils/crypto.ts:454-524` — PQ keypair generated locally; PQ secret key saved to disk encrypted with classical key (PBKDF2 from machine-derived). Attacker with local read wraps classical key first and unwraps PQ. No remote PQ recipient. **Fix:** document honestly as "local at-rest hybrid" or integrate remote KMS.
- **I192** [medium][Sn] `src/utils/crypto.ts:183-186,232-235` — KDF is `SHA256(sharedSecret ‖ salt)` — not HKDF. Weak domain separation. **Fix:** HKDF-SHA256 per RFC 5869.
- **I193** [medium][Sn] `src/utils/crypto.ts:135-149` — machine-derived key from hostname/platform/arch/CPU/homedir is <30-bit entropy. PBKDF2 doesn't rescue. **Fix:** persist random 32-byte key on first run with 0600.
- **I194** [medium][S] `src/utils/crypto.ts:125-127` — default PBKDF2 100 000 iters; OWASP 2023 ≥600 000. **Fix:** raise default.
- **I195** [medium][S] `tests/crypto.test.ts` — no negative test for v1/v2/v3 version mismatch; legacy migration path has no fixture. **Fix:** add frozen v1/v2 fixture + migration assertion.
- **I196** [medium][S] `tests/crypto.test.ts` — never writes a `.pqenc` file and decrypts on a second module instance. In-memory only. **Fix:** add disk round-trip test.

### Secure memory (theater)
- **I197** [high][S] `src/utils/secure-memory.ts:47-98` — `new SecureString(value:string)` copies into Buffer but caller's immutable JS string stays in V8 heap (internalised). Wipe zeroes Buffer copy only; real credential persists. **Fix:** document; accept `Buffer` in hot paths.
- **I198** [high][S] `src/utils/secure-memory.ts:260-287` — `FinalizationRegistry` callback cannot zero Buffer because memory already GC'd. Theater. **Fix:** remove or wire to explicit wipe via ref-counted wrapper.
- **I199** [medium][A] `src/utils/secure-memory.ts:264` — registry inline comment acknowledges "no-op". **Fix:** remove.
- **I200** [medium][A] `src/utils/secure-memory.ts:169-229` — `SecureObject<T>` never instantiated. Dead code. **Fix:** remove.
- **I201** [medium][A] `src/utils/secure-memory.ts:249-287` — `withSecureBuffer`/`createSecureBuffer` never called. Dead code. **Fix:** remove.
- **I202** [high][S] `src/utils/secure-memory.ts:292-303` — `secureCompare` when lengths differ calls `timingSafeEqual(bufA, Buffer.alloc(bufA.length))`; leaks length via branch and allocation timing. **Fix:** constant-time length pad.
- **I203** [medium][S] `tests/secure-memory.test.ts:276-293` — test acknowledges "can't easily test GC" and skips asserting FinalizationRegistry. Feature unvalidated. **Fix:** remove theater OR `--expose-gc` test.
- **I204** [high][Sn] `package.json:89` — `memoryScubbing` typo + only wraps `loginPassword`/`geminiApiKey`. Cookies, session responses, query log entries never scrubbed. **Fix:** rename flag; extend scrubbing.

### General security.ts / RateLimiter
- **I205** [medium][S] `src/utils/security.ts:234-292` `RateLimiter` — `isAllowed` only deletes keys when zero requests survive; dormant keys leak forever. **Fix:** periodic sweep + max key count.
- **I206** [low][S] `src/utils/security.ts:89` — path-traversal check `.includes("..")` case-sensitive; `%2E%2E` bypasses. **Fix:** `.toLowerCase()` and rely on `pathname` normalisation.
- **I207** [low][S] `src/utils/security.ts:203-210` `maskEmail` — 1-char local part reveals full domain. **Fix:** always mask portion of TLD-minus-one.
- **I208** [low][Sn] `src/utils/security.ts:12-18` — sanitizer has no pattern for `smb://user:pass@host`, `ftp://...`, UNC Windows paths. **Fix:** protocol-agnostic credential-in-URL regex.
- **I209** [low][Sn] `src/utils/security.ts:316-338` `checkSecurityContext` — warns about visible browser + dev mode but NOT `NLMCP_AUTH_DISABLED=true`. **Fix:** add to warnings.

### Response validator
- **I210** [medium][Sn] `src/utils/response-validator.ts:65-143` — prompt-injection regex has unbounded `[^\n]{20,}` groups (ReDoS) and catches only English. Non-English/homoglyph/line-broken bypass. **Fix:** size cap; ML/Semgrep-style detectors.
- **I211** [medium][Sn] `src/utils/response-validator.ts:172` — base64 entropy detection strips legitimate images/JSON base64. High FP rate. **Fix:** entropy-gated, not length-only.
- **I212** [high][Sn] `src/utils/response-validator.ts:172` — minimum length 100; real secrets <100 slip through. **Fix:** entropy + shorter min + known prefix.
- **I213** [low][Sn] `src/utils/response-validator.ts:223-225` — sanitization uses `.replace(match,...)`; first match only. **Fix:** `replaceAll`.
- **I214** [medium][Sn] `src/utils/response-validator.ts:327-336` — pattern rebuilt with `"gi"` but reuses original pattern elsewhere; stateful `lastIndex` skips. **Fix:** fresh-compile or `matchAll`.
- **I215** [high][S] `src/utils/response-validator.ts` — ZERO tests on prompt-injection patterns. **Fix:** corpus of real injections + benign prompts; measure FP/FN.

---

# AREA 8 — Audit, logging, observability

### Audit logger
- **I216** [critical][S] `src/utils/audit-logger.ts:219-243` — `writeEvent` when `isWriting=true` enqueues and returns immediately; caller sees resolution before durability. Crash loses audit records. **Fix:** per-event promise resolved in flush loop.
- **I217** [critical][S,Sn] `src/utils/audit-logger.ts:127-145` — on corrupted line `try/catch` silently resets `previousHash="GENESIS"`. Attacker tampers any byte → subsequent events validate fresh chain. **Fix:** refuse start or persist `chain_reset` sentinel event.
- **I218** [critical][Sn] `src/utils/audit-logger.ts` — `verifyIntegrity()` never invoked at runtime. Chain written but never verified. **Fix:** call at startup + schedule; refuse on mismatch.
- **I219** [high][S] `src/utils/audit-logger.ts:150-170` `cleanOldLogs` — bare `catch{}`; silent failure on retention cleanup, disk fills. **Fix:** log warning + metric.
- **I220** [high][Sn] `src/utils/audit-logger.ts:48` — default retention 30 days; contradicts CSSF `sevenYearRetention` claim; hard-deletes before retention engine could archive. **Fix:** default 2555d; honor RetentionPolicy action="archive" first.
- **I221** [high][S] `src/utils/audit-logger.ts:128` + `quota-manager.ts:105,468,575,655` — day-boundary `new Date().toISOString().split("T")[0]` (UTC). Operators see rotation at non-local hours. **Fix:** document UTC or `NLMCP_TIMEZONE` env.
- **I222** [high][S] `src/utils/audit-logger.ts:218-243` — only in-process `isWriting` flag; two Node procs interleave bytes; hash-chain divergent across writers. **Fix:** `withLock(currentLogFile)` or per-PID files.
- **I223** [high][Sn] `src/utils/audit-logger.ts:186` — hash truncated to `slice(0,32)` = 128 bits; halves SHA-256 collision resistance. **Fix:** keep full 64 hex.
- **I224** [medium][S] `src/utils/audit-logger.ts:509-515` `flush` — busy-waits `setTimeout(...,10)`; non-deterministic shutdown latency. **Fix:** promise chained from flush loop.
- **I225** [medium][S,Sn] `src/utils/audit-logger.ts:190-214` `sanitizeDetails` — regex over-matches (`public_key_hash`, `authorization_level`) and under-matches (`bearer`); doesn't sanitize values when key is `user_input`/`query`/`url`. **Fix:** allowlist + secrets-scanner on values.
- **I226** [medium][Sn] `src/utils/audit-logger.ts:150-170` — parses filename with `slice(6,16)`; symlink/arbitrary-date file in dir gets deleted. **Fix:** strict regex `^audit-(\d{4}-\d{2}-\d{2})\.jsonl$`.
- **I227** [medium][Sn] `src/utils/audit-logger.ts:219-243` + `src/logging/query-logger.ts:162-186` — async write queue in-memory; SIGKILL loses pending events. **Fix:** fsync critical events or WAL journal.
- **I228** [low][S] `src/utils/audit-logger.ts:137` — `lastEvent.hash` — if schema drifts and event missing hash, `previousHash=undefined`, chain silently disabled. **Fix:** type guard validation.
- **I229** [medium][A] `src/utils/audit-logger.ts` — audit event types include `"compliance"` but compliance module orphaned. **Fix:** remove until wired.

### Query logger (PII leak)
- **I230** [critical][Sn] `src/logging/query-logger.ts:191-208` — persists full question AND answer plaintext to daily JSONL. No sanitization, no secret-scanning pass. Contradicts `logSanitization`/`credentialMasking` claims. **Fix:** route through `sanitizeForLogging` + `scanAndRedactSecrets`; or hash/truncate + store length.
- **I231** [high][Sn] `src/logging/query-logger.ts:206` — debug log leaks first 50 chars of question to stderr unsanitized. **Fix:** pipe through sanitizer or drop preview.
- **I232** [medium][Sn] `src/logging/query-logger.ts:162-186` — no per-file/per-day size cap; adversarial huge questions fill disk. **Fix:** enforce caps; truncate/reject oversize.
- **I233** [medium][Sn] `src/logging/query-logger.ts:325-346` `getAllQueries` — loads every JSONL to memory per call; multi-GB DoS on `search_queries`. **Fix:** stream + incremental filter.

### Observability / metrics
- **I234** [medium][S] No structured log format — `log.info(...)` string interpolation; no correlation IDs across multi-step flows. **Fix:** JSON logs with `{ts, level, correlation_id, event, ...}`.
- **I235** [medium][S] No metrics emission (no Prometheus/OTel) — rate-limit counters, quota %, webhook-delivery success opaque. **Fix:** OTel counters on dispatch/lockout/session/chaff.

### Audit/config leaks in logs
- **I236** [medium][Sn] `src/utils/security.ts` + `src/config.ts` — `checkSecurityContext` warns about `LOGIN_PASSWORD` in env but logs the var name; applyEnvOverrides leaves env vars in `process.env` (except password/gemini). **Fix:** blank all sensitive env after read; redact env dumps.

---

# AREA 9 — Compliance module (`src/compliance/*`)

### Entire module orphaned
- **I237** [critical][A,Sn] `src/compliance/index.ts` — `getComplianceTools`/`handleComplianceToolCall` never imported outside `compliance/`. Entire module (18 files, ~11k LoC) produces zero runtime effect. **Fix:** wire into `src/tools/definitions.ts` + `src/index.ts`, OR delete the module entirely.
- **I238** [critical][Sn] `src/compliance/consent-manager.ts` — `grant_consent`/`revoke_consent` tools unreachable. Users cannot record consent via MCP. **Fix:** register.
- **I239** [critical][Sn] `src/compliance/dsar-handler.ts` — `submit_dsar_request` unreachable. **Fix:** register.
- **I240** [critical][Sn] `src/compliance/data-export.ts` — `DataExporter.exportAll` unreachable. **Fix:** register.
- **I241** [critical][Sn] `src/compliance/data-erasure.ts` — scoped erasure unreachable. **Fix:** register.
- **I242** [critical][Sn] `src/compliance/privacy-notice.ts` — `needsDisplay()`/`acknowledge()` never invoked at server start. **Fix:** call at startup before data processing.
- **I243** [critical][Sn] `src/compliance/change-log.ts` — `ChangeLog.recordChange` never invoked from any mutation site. No change audit. **Fix:** invoke from config/settings/token-rotation/quota-tier/webhook-CRUD sites.
- **I244** [critical][Sn] `src/compliance/incident-manager.ts` + `breach-detection.ts` — `BreachDetector.checkEvent` never fed events; `report_incident` unreachable. No automatic detection. **Fix:** subscribe detector to audit/event bus; auto-escalate high-severity.
- **I245** [high][Sn] `src/compliance/health-monitor.ts` — runs in constructor but results not exported anywhere. **Fix:** wire to audit events or SIEM.
- **I246** [high][Sn] `src/compliance/retention-engine.ts:602` — `runRetentionPolicies()` never invoked. No scheduler. **Fix:** `setInterval` on startup.
- **I247** [high][Sn] `src/compliance/siem-exporter.ts:23,158` — opt-in + `exportToSIEM`/`queueEvent` never called from production audit/tool paths. Even enabled, no events flow. **Fix:** pipe every `audit.*` through.
- **I248** [medium][Sn] `src/compliance/policy-docs.ts` — default policies claim cert pinning + PQ encryption (false per I174, I191). **Fix:** align text with reality.
- **I249** [medium][Sn] `src/compliance/compliance-logger.ts:41-63` — `maskIP` defined but no caller passes IP (stdio transport has none). Theater. **Fix:** remove.
- **I250** [medium][Sn] `src/compliance/privacy-notice-text.ts:82,110,194` — notice text claims PQ + cert pinning protect user; false. **Fix:** align.

### DSAR safety
- **I251** [critical][S] `src/compliance/dsar-handler.ts` — ZERO tests on GDPR Article 15 handler. **Fix:** add tests.
- **I252** [high][Sn] `src/compliance/dsar-handler.ts:175-229` — `generateResponse` hardcodes `subject_verified:true`. Any MCP caller (if wired) exfils full data inventory. **Fix:** require signed verification claim from authenticated identity; cooldown.
- **I253** [high][S] `src/compliance/dsar-handler.ts:66-80` `load` — guard `if (this.loaded) return` not async-safe; two concurrent `submitRequest` both load + save, losing entries. **Fix:** `this.loadPromise = this.loadPromise ?? this._load()`.
- **I254** [high][S] `src/compliance/dsar-handler.ts:85-96` `save` — no file lock; concurrent DSAR submissions race. **Fix:** `withLock(this.requestsFile, ...)`.
- **I255** [medium][S] `src/compliance/dsar-handler.ts:251-290` `getDataSample` — reads raw file <10KB into response; may include PII. **Fix:** pipe through `secretsScanner.scanAndRedact`.

### Data erasure
- **I256** [critical][S] `src/compliance/data-erasure.ts` — ZERO tests on GDPR Article 17. **Fix:** assert files deleted, secureOverwrite passes, verification flag truthful.
- **I257** [high][S,Sn] `src/compliance/data-erasure.ts:43-60` — multi-pass overwrite ineffective on SSDs (wear leveling), COW (btrfs/ZFS/APFS), journaled FS. GDPR Article 17 claim not honourable. **Fix:** document caveats; prefer crypto-shredding.
- **I258** [high][S] `src/compliance/data-erasure.ts:49-56` — `fs.writeFileSync` no `fsync`; buffers may never reach disk before unlink. **Fix:** openSync + write + fsyncSync + close + unlink.
- **I259** [high][S] `src/compliance/data-erasure.ts:365-405` `eraseBrowserData` — deletes running Chrome profile without stopping Chrome; on Linux Chrome writes back on close. **Fix:** `SharedContextManager.closeContext()` first; verify no `SingletonLock`.
- **I260** [high][S] `src/compliance/data-erasure.ts:57-60,94-97,102-104,145-148,355-356,462-464` — every `catch` swallows; `verified=false` with no `error` field. **Fix:** capture `err.message` in `result.error`.
- **I261** [medium][S] TOCTOU — `fs.existsSync` check + later read/delete races. **Fix:** open with exclusive flags.
- **I262** [medium][S] `src/compliance/data-erasure.ts:30-38` — `DEFAULT_SCOPE.audit_logs:false`; user may forget to tick, tool invocations remain. **Fix:** print explicit note.
- **I263** [low][S] `src/compliance/data-erasure.ts:42` — `passes:number=3` allows 0; zero-pass "success". **Fix:** `Math.max(1, passes)`.
- **I264** [high][S] `src/compliance/consent-manager.ts`, `privacy-notice.ts`, `breach-detection.ts`, `retention-engine.ts`, `compliance-logger.ts`, `incident-manager.ts` — ZERO tests. **Fix:** per-module persistence round-trip + state transitions.
- **I265** [low][A] `src/compliance/` — marketed as SOC2/CSSF compliance for an MCP wrapping a web app. Genuine SOC2 needs org controls. **Fix:** README should distinguish code-enforced vs process-required.
- **I266** [medium][A] `src/compliance/siem-exporter.ts` — reads 12 env vars with inline `parseInt`/casts; duplicates config.ts pattern. **Fix:** consolidate into `applyEnvOverrides`.
- **I267** [low][Sn] `src/compliance/retention-engine.ts:29-73,125-127` — mutable singleton; custom policy with same id silently overrides CSSF default. **Fix:** freeze defaults, forbid id collisions.

---

# AREA 10 — Webhooks (`src/webhooks/*`)

- **I268** [critical][S] `src/webhooks/webhook-dispatcher.ts` — ZERO tests on outbound HTTP + HMAC. **Fix:** retry/sig/format tests.
- **I269** [critical][Sn] `src/webhooks/webhook-dispatcher.ts:82-121` — env-initialised webhooks (`NLMCP_WEBHOOK_URL`, `NLMCP_SLACK_WEBHOOK_URL`, etc.) passed to `addWebhook` with zero validation. Attacker with env-write → `http://169.254.169.254/latest/meta-data/` SSRF. **Fix:** HTTPS-only allowlist, block RFC1918/link-local/metadata.
- **I270** [critical][Sn] `src/webhooks/webhook-dispatcher.ts` + `tools/handlers/webhooks.ts` — `configure_webhook` accepts arbitrary URL, not in TOOLS_REQUIRING_AUTH. Unauthenticated SSRF if auth disabled. **Fix:** require auth; validate host.
- **I271** [high][S,Sn] `src/webhooks/webhook-dispatcher.ts:430-437,433-437` — HMAC signs payload only; no timestamp/nonce. Replay indefinite. **Fix:** `X-Webhook-Timestamp` + reject >5 min old; include timestamp in signed payload.
- **I272** [high][Sn] `src/webhooks/webhook-dispatcher.ts:69-76` — `webhooks.json` written plain JSON; `secret` field plaintext, bypasses PQ/ChaCha20. **Fix:** route through `getSecureStorage().save()`.
- **I273** [high][Sn] `src/webhooks/webhook-dispatcher.ts:169-205` — payload JSON.stringified without secret-scanning; `security_incident` event dumps payload unfiltered. **Fix:** run `scanAndRedactSecrets` on outbound.
- **I274** [high][S] `src/webhooks/webhook-dispatcher.ts:156-244` `sendWithRetry` — records only final attempt; attempts 1..N-1 have no delivery record. **Fix:** record on every attempt with `attempt` field.
- **I275** [high][S] `src/webhooks/webhook-dispatcher.ts:122-130,137-143` — subscribes to `*`; serial `await` in `for` loop. One slow webhook blocks all deliveries. **Fix:** `Promise.allSettled`.
- **I276** [high][S] Retry bomb — 10 webhooks × one flaky endpoint × 100 events → 7000 retry-seconds per webhook. **Fix:** circuit-breaker disabling after N failures.
- **I277** [medium][S] `src/webhooks/webhook-dispatcher.ts:69-76` `saveStore` — no file lock; concurrent `addWebhook` loses updates. **Fix:** `withLock`.
- **I278** [medium][S] `src/webhooks/webhook-dispatcher.ts:137-143` — no cross-process ordering guarantee. **Fix:** document; include `sequence` field.
- **I279** [medium][S] `src/webhooks/webhook-dispatcher.ts:442-447` — `deliveryHistory` in-memory capped 100; no disk persistence. Can't audit yesterday. **Fix:** rotating log file.
- **I280** [medium][S] `src/webhooks/webhook-dispatcher.ts:181` — UA `"notebooklm-mcp/1.7.0"` hardcoded; ships as v2026.2.11. **Fix:** import from generated `version.ts`.
- **I281** [low][S] `src/webhooks/webhook-dispatcher.ts:175-189` — `AbortController` timeout doesn't distinguish "slow server" from "DNS failure". **Fix:** catch `AbortError` specifically.
- **I282** [medium][Sn] `src/webhooks/webhook-dispatcher.ts:183` — `webhook.headers` spread to outbound fetch; no filter. Attacker sets `Host`, `X-Forwarded-For`, `Authorization`. **Fix:** deny CRLF; strip disallowed header names.
- **I283** [low][Sn] `src/webhooks/webhook-dispatcher.ts:177` — default follow-redirects; pre-allowlisted host redirects to IMDS. **Fix:** `redirect:"error"` or manual re-validation.

---

# AREA 11 — Quota & rate limiting (`src/quota/*`)

- **I284** [critical][S] `src/quota/quota-manager.ts:724 LoC` — ZERO tests. **Fix:** day-rollover, concurrent atomic increment, tier detection tests.
- **I285** [high][S] `src/quota/quota-manager.ts:574-599` `canMakeQuery` — mutates settings (reset-on-new-day) during read-only check; two concurrent callers race. **Fix:** move reset to atomic increment only; make canMakeQuery pure.
- **I286** [high][S] `src/quota/quota-manager.ts:457-461` `incrementNotebookCount` — sync no lock; two procs lose increment. **Fix:** mirror `incrementNotebookCountAtomic`.
- **I287** [high][S] `src/quota/quota-manager.ts:654-713` `getDetailedStatus` — mutates settings on rollover but doesn't persist. **Fix:** persist reset.
- **I288** [medium][S] `src/quota/quota-manager.ts:138-182` — tier detection uses `document.body.innerText.toUpperCase()`; notebook source containing "ULTRA" mis-detects tier. **Fix:** scope query to account chrome.
- **I289** [medium][S] `src/quota/quota-manager.ts:486-519` `incrementQueryCountAtomic` — inside lock, `fs.writeFileSync` errors caught + logged only; caller thinks atomic succeeded. **Fix:** rethrow.
- **I290** [medium][S] `src/quota/quota-manager.ts` — no upper clamp on `queriesUsedToday` from UI scrape; huge UI integer permanently locks user. **Fix:** clamp to limits.

---

# AREA 12 — File I/O, locks, permissions

- **I291** [high][S] `src/utils/file-lock.ts` — ZERO tests. Cross-process advisory lock w/ stale detection unverified. **Fix:** spawned child procs hold/release tests.
- **I292** [high][S] `src/utils/file-lock.ts:38-42` — default stale-threshold 30s; `performSetup` holds auth lock up to 10 min and other callers lack overrides. Stale-reaper steals lock mid-write. **Fix:** 60s minimum; callers must override up-front.
- **I293** [medium][S] `src/utils/file-lock.ts:127-130` `wx` — advisory on NFS, unreliable on network shares. **Fix:** document local-FS-only; detect NFS + refuse.
- **I294** [medium][S] `src/utils/file-lock.ts:155-178` `release` — verifies lockId then unlinks; narrow race. **Fix:** atomic rename-to-unique + unlink.
- **I295** [medium][S] `src/utils/file-lock.ts:225-243` `isLocked` — returns false on JSON parse error; corrupted lock → "unlocked". **Fix:** treat corrupted as locked.
- **I296** [low][S] `src/utils/file-lock.ts:250-263` `forceUnlock` — exported; no liveness check on other owners. **Fix:** CLI-only with `--force` + warning.

---

# AREA 13 — Tests & coverage

- **I297** [critical][S] Aggregate coverage — 6 test files cover ~2000/22900 LoC = **<10%**. Zero-test modules (critical): auth/, compliance/, events/, gemini/, library/, logging/, notebook-creation/, quota/, resources/, session/, tools/, webhooks/, audit-logger, cleanup-manager, cli-handler, file-lock, file-permissions, logger, page-utils, response-validator, settings-manager, stealth-utils, tool-validation, errors, index. **Fix:** tests for every security-critical module (individual findings above reference specific files).
- **I298** [medium][S] No `--random-order`; `secrets-scanner.test.ts` shares scanner state via module-level `beforeEach`. **Fix:** `vitest --sequence.shuffle` in CI.
- **I299** [medium][S] No mutation testing (Stryker), no property-based (fast-check). **Fix:** add Stryker for tested modules; fast-check for `secrets-scanner`, `security`, `crypto` round-trips.
- **I300** [medium][S] `tests/` has no `.integration.test.ts` layer; no smoke test booting the MCP server. **Fix:** integration test spawning server + `list_notebooks`.
- **I301** [medium][S] Property-test candidates — `validateNotebookUrl`, `sanitizeForLogging` (idempotence), `encryptPQ/decryptPQ` round-trip, `deriveKey` determinism. **Fix:** fast-check generators.
- **I302** [low][S] No test for log rotation/retention — `audit-logger.cleanOldLogs`, `logging/query-logger`. **Fix:** mock fs + advance "now" 31 days, assert unlink.
- **I303** [low][S] No test for `RateLimiter` memory boundedness under distinct keys. **Fix:** 100k distinct keys, assert bounded Map size (requires sweeper I205).
- **I304** [low][S] `tests/config.test.ts:113` — range-clamping tests observe post-hoc state; don't reload with env. **Fix:** set env, reload module, assert clamped.
- **I305** [low][A] Test strategy — no tests for handlers/session/notebook-creation even with mocked patchright. **Fix:** at minimum smoke tests with fixtures.

---

# AREA 14 — Build, deps, repo hygiene

- **I306** [medium][Sn] `package.json:57-67` — all deps caret-ranged (`^`); no `npm ci --ignore-scripts`, no `overrides`, no integrity enforcement. **Fix:** exact pins; `npm ci --ignore-scripts` in CI.
- **I307** [medium][Sn] `package.json:64` — `patchright` is a single-maintainer stealth fork of playwright; postinstall scripts download system chrome drivers; CVE response lags upstream. **Fix:** document; isolate via container.
- **I308** [high][Sn] `package.json:19` — `security-scan` script `medusa scan` exists but CI workflow only runs `npm ci/build/test`. Never gated. **Fix:** add CI step `medusa scan . --fail-on high` or drop claim.
- **I309** [low][Sn] `medusa-env/` committed — entire Python virtualenv (binaries, site-packages) in repo; CVE surface. **Fix:** gitignore; remove from publish (package.json `files` allowlist should prevent leakage — verify).
- **I310** [low][Sn] `mcp-publisher.tar.gz` at repo root. **Fix:** gitignore.
- **I311** [low][A] `tsconfig.json` — `skipLibCheck:true` suppresses patchright type regressions. **Fix:** set false + fix remaining, or scope to `skipDefaultLibCheck`.
- **I312** [medium][M] `src/tools/definitions.ts:51-72` — definitions built once but `ask_question` description uses active notebook state. **Fix:** rebuild per `list_tools` or `tools/list_changed`.
- **I313** [low][A] `src/index.ts:214` — no build-time assertion that every tool is in TOOLS_REQUIRING_AUTH or explicit opt-out list. New tool silently unauthenticated. **Fix:** startup check.
- **I314** [low][Sn] MCP token file — no log when present vs absent. Startup logs not verbose enough re: auth state. **Fix:** consolidated startup summary.

---

# AREA 15 — Additional security

- **I315** [critical][Sn] `src/tools/handlers/system.ts:37-72` `export_library` — `fs.writeFileSync(outputPath, content, {mode:0o600})`; `outputPath` user-supplied zero validation. Arbitrary write to `/etc/cron.d/*`, `~/.ssh/authorized_keys`, shell rc files if perms allow. **Fix:** resolve under base dir; reject escape.
- **I316** [critical][Sn] `src/tools/handlers/notebook-creation.ts:490-534` `add_folder` — arbitrary `folder_path` recursively scanned + uploaded to Google NotebookLM. Exfiltrates `~/.ssh`, `~/.aws/credentials`, secrets via legit-looking user action. **Fix:** allowlist base dir; user confirmation with file list.
- **I317** [low][Sn] `src/tools/handlers/system.ts:41-52` — CSV export doesn't escape leading formulas. Notebook name `=cmd|...` → DDE RCE when opened in Excel (CWE-1236). **Fix:** prefix with `'`.
- **I318** [low][Sn] `src/config.ts:287` — `NLMCP_FOLLOW_UP_REMINDER` env appended to every response; prompt-injection vector if env attacker-controllable. **Fix:** validate/escape.
- **I319** [medium][Sn] `src/auth/mcp-auth.ts:243-275` `recordFailedAttempt` — `lockoutCount` unbounded in Map; memory DoS. **Fix:** cap Map size; evict after `lockedUntil + grace`.
- **I320** [low][Sn] `src/auth/mcp-auth.ts:182-184` `generateToken` — 24 bytes (192 bits) OK. **Fix:** noted for completeness.
- **I321** [high][Sn] `src/config.ts:216-228,295-304` — only `LOGIN_PASSWORD`/`GEMINI_API_KEY` wrapped in `SecureCredential`; MCP auth token, webhook secrets, SIEM API key plaintext in env for lifetime. **Fix:** wrap all consistently.

---

# AREA 16 — Error handling (cross-cutting)

- **I322** [high][S] 145 bare `catch{}` across codebase. Notable: `notebook-creation/selectors.ts:236,270`, `notebook-sync.ts:133,256`, `video-manager.ts:103,233,468`, `compliance/data-erasure.ts:*`, `utils/file-permissions.ts:222`. Swallow root causes. **Fix:** minimum `catch(e){ log.debug(\`${ctx}: ${e}\`); }`; ESLint rule.
- **I323** [medium][S] `src/notebook-creation/notebook-creator.ts:108-115` — catch logs + rethrows; caller logs too. Duplicate traces. **Fix:** wrap in custom error or drop log.
- **I324** [medium][S] `src/utils/secrets-scanner.ts:400-421` — `await audit.security(...)` inside `scanAndRedact`; audit failure breaks main flow. **Fix:** wrap audit call.
- **I325** [medium][S] `src/session/shared-context-manager.ts:57`, `src/index.ts:330` — unawaited `void` promises; errors never surface. **Fix:** `.catch(err => log.warning(...))`.
- **I326** [medium][S] `src/notebook-creation/notebook-creator.ts:85-89` — `error.message` stripped from `failedSources`; debugging needs stack. **Fix:** persist stack behind debug flag.
- **I327** [low][S] Info disclosure in throws — URLs with identifiers interpolated into error messages. **Fix:** sanitise before throwing to MCP.
- **I328** [low][Sn] `src/index.ts:276-296` — errors propagated to client with full stack/path/URL. **Fix:** log server-side; return generic + correlation ID.

---

# AREA 17 — Claims verification summary

Cross-reference all findings above against `package.json` claims. Each claim is overclaimed unless code proof exists.

- **I329** [claim] `securityHardening.logSanitization` — overclaimed (see I230, I231, I225)
- **I330** [claim] `securityHardening.credentialMasking` — partial (see I225)
- **I331** [claim] `securityHardening.certificatePinning` — theater (see I174–I180)
- **I332** [claim] `securityHardening.secretsScanning` — theater (see I181)
- **I333** [claim] `securityHardening.medusaIntegration` — theater (see I308)
- **I334** [claim] `securityHardening.postQuantumEncryption` — overclaimed (see I191–I194)
- **I335** [claim] `securityHardening.memoryScubbing` — typo + partial (see I204)
- **I336** [claim] `securityHardening.auditLogging` — partial (see I217, I218, I220, I222, I223)
- **I337** [claim] `securityHardening.rateLimiting` — partial (see I091)
- **I338** [claim] `securityHardening.sessionTimeout` — partial (see I137)
- **I339** [claim] `securityHardening.inputValidation` / `urlWhitelisting` — partial (see I089, I046, I270)
- **I340** [claim] `securityHardening.exponentialBackoffLockout` — partial (see I113, I319)
- **I341** [claim] `securityHardening.credentialIsolation` — partial (see I321)
- **I342** [claim] `securityHardening.responseValidation` — partial (see I210–I215)
- **I343** [claim] `gdpr.consentManagement`/`dataSubjectRights`/`dataPortability`/`rightToErasure`/`privacyNotice` — ALL theater (see I237–I242)
- **I344** [claim] `soc2.hashChainedAuditLogs` — partial (I217, I218, I223)
- **I345** [claim] `soc2.changeManagement` — theater (I243)
- **I346** [claim] `soc2.incidentResponse` — theater (I244)
- **I347** [claim] `soc2.availabilityMonitoring` — theater (I245)
- **I348** [claim] `cssf.sevenYearRetention` — overclaimed (I220) + scheduler never runs (I246)
- **I349** [claim] `cssf.siemIntegration` — overclaimed (I247)
- **I350** [claim] `cssf.policyDocumentation` — partial (I248, I250)

---

# Suggested work ordering

1. **Delete the wrong `tools.yaml` from repo root** (I068) — 1 min, removes confusion
2. **Critical protocol/wiring bugs** (I001, I002, I003) — silently broken since shipping
3. **Auth-bypass DoS** (I004) — unauth clients can wipe all credentials if auth disabled
4. **Claims vs code gap** — either wire up or retract:
   - Compliance module (I237 — decide: wire or delete?)
   - Secrets scanner (I181)
   - Cert pinning (I174)
   - `medusaIntegration` CI gate (I308)
   - `sevenYearRetention` default (I220)
5. **Selector fragility** (I138, I139, I140, I153) — one DOM change breaks everything
6. **SSRF + arbitrary file I/O via tools** (I269, I270, I315, I316)
7. **Query logger PII leak** (I230)
8. **Audit log tamper/durability** (I216, I217, I218, I222, I223)
9. **Annotation correctness** (I030–I041) — one pass through annotations.ts
10. **Schema constraints** (I042 + I043–I058) — one pass adding `additionalProperties:false`, bounds, patterns
11. **Tool surface trimming** (I069, I070, I071)
12. **Test coverage** — start with I121, I122, I128, I251, I256, I268, I284 (security-critical modules with ZERO tests)
13. Everything else, ordered by file

## Per-area triage priority

- **Highest-impact files:** `src/index.ts`, `src/utils/audit-logger.ts`, `src/logging/query-logger.ts`, `src/utils/cert-pinning.ts`, `src/utils/secrets-scanner.ts`, `src/compliance/index.ts`, `src/webhooks/webhook-dispatcher.ts`, `src/notebook-creation/selectors.ts`, `src/tools/annotations.ts`, `src/tools/handlers/webhooks.ts`, `package.json`.
- **Most-likely silent wins:** delete `tools.yaml`, delete `mcp-publisher.tar.gz`, gitignore `medusa-env/`, delete `src/utils/secure-memory.ts:169-287` dead code.
