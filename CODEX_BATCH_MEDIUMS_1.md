# Codex Batch — Medium Issues #1 (25 issues)

> Repo: `/home/ross/Documents/projects/notebooklm-mcp-secure`
> Branch: `main` — 565 tests passing, tsc clean.
> After each group: `npx tsc --noEmit && npx vitest run` must stay green. Commit per group.

---

## Group M1 — src/index.ts response shape fixes (I010, I011, I012, I013, I014)

### I010 — Use structuredContent on success path
`src/index.ts:268-275` — success path returns single `text` block. Return `structuredContent` too:
```typescript
return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
```

### I011 — Paginate list_tools
`src/index.ts:194-199` — `list_tools` returns all ~42 tools unpaginated (~80KB). Add optional cursor paging: accept `cursor` param, slice tools array, return `nextCursor` if more remain.

### I012 — Auth failure must set isError:true
`src/index.ts:220-233` — auth failure response missing `isError: true`. Add it.

### I013 — Tag transport/protocol errors separately
`src/index.ts:276-296` — transport errors indistinguishable from domain errors. Add a `_errorType: "transport" | "domain"` field or use a separate error code.

### I014 — Flush in-flight responses before exit on uncaughtException
`src/index.ts:336-346` — `uncaughtException`/`unhandledRejection` call `requestShutdown` without flushing. Send a final error frame to the MCP transport before calling `process.exit`.

**Commit**: `fix: MCP response shape — structuredContent, isError, error tags, shutdown flush (I010, I011, I012, I013, I014)`

---

## Group M2 — Annotation correctness (I035, I036, I037, I038, I039)

**File**: `src/tools/annotations.ts`

### I035 — ask_question readOnlyHint:false
Line 30-39: `ask_question` is marked `readOnlyHint:true` but mutates quota and writes query log. Change to `readOnlyHint: false`.

### I036 — add_notebook idempotentHint:false
Line 44-53: `add_notebook` claims `idempotentHint:true` but creates new entries per call. Change to `idempotentHint: false`.

### I037 — upload_document idempotentHint:false
Line 470-479: `upload_document` creates a new file per upload. Change to `idempotentHint: false`.

### I038 — add_source idempotentHint:false
Line 179-186: `add_source` adds duplicate entries. Change to `idempotentHint: false`.

### I039 — batch_create_notebooks destructiveHint review
Line 155-162: Review `batch_create_notebooks` annotations — set `destructiveHint: false` (creation only, no deletion).

**Commit**: `fix: annotation correctness — readOnlyHint/idempotentHint fixes (I035, I036, I037, I038, I039)`

---

## Group M3 — Schema bounds (I050, I051, I052, I053, I054, I055, I056, I057)

### I050 — deep_research.max_wait_seconds bounds
`src/tools/definitions/gemini.ts:48-51`: add `minimum: 10, maximum: 600`.

### I051 — list_documents.page_size bounds
`src/tools/definitions/gemini.ts:288-296`: add `minimum: 1, maximum: 1000`.

### I052 — query history limit bounds
`src/tools/definitions/query-history.ts:40-43`: add `minimum: 1, maximum: 500`.

### I053 — chat history limit/offset bounds
`src/tools/definitions/chat-history.ts:58-65`: add `minimum: 1, maximum: 500` on limit; `minimum: 0` on offset.

### I054 — browser_options.timeout_ms bounds
`src/tools/definitions/ask-question.ts:163-167`: add `minimum: 1000, maximum: 300000`.

### I055 — typing/delay fields bounds
`src/tools/definitions/ask-question.ts:188-202`: add per-field bounds on typing speed, delay fields. In handler add cross-check that min ≤ max where applicable.

### I056 — topics/tags/content_types array bounds
`src/tools/definitions/notebook-management.ts:58-76`: add `maxItems: 50` on arrays, `maxLength: 100` on string items.

### I057 — batch_create_notebooks nested sources bounds
`src/tools/definitions/notebook-management.ts:688-731`: inner `sources` array has no `maxItems`. Add `maxItems: 20`.

**Commit**: `fix: schema bounds on query/chat/research/batch tools (I050-I057)`

---

## Group M4 — Config + types cleanup (I024, I025, I026, I029)

### I024 — Delete getConfig() alias
`src/config.ts:323`: `getConfig()` is a pure alias for `CONFIG`. Delete it and update any callers to use `CONFIG` directly.

### I025 — Extract followUpReminder constant
`src/config.ts:179`: 230-char inline string. Extract as `const DEFAULT_FOLLOW_UP_REMINDER = "..."` above the config object.

### I026 — Move BrowserOptions to browser-options.ts
`src/config.ts`: `BrowserOptions` interface and `applyBrowserOptions` function are mixed with app config. Move to `src/notebook-creation/browser-options.ts`, re-export from config.ts for backwards compatibility.

### I029 — Re-export SDK Tool type instead of redeclaring
`src/types.ts:60-70`: `Tool` interface re-declares SDK types. Replace with re-export from `@modelcontextprotocol/sdk/types.js`.

**Commit**: `refactor: config + types cleanup — getConfig alias, BrowserOptions extraction (I024, I025, I026, I029)`

---

## Group M5 — Source tool contract clarity (I063, I064, I015-partial)

### I063 — add_source document active-notebook fallback
`src/tools/definitions/notebook-management.ts:509`: `add_source` accepts `source` only but silently uses active notebook. Make this explicit in the schema description. Add `oneOf` or document the fallback clearly.

### I064 — remove_source same fallback
`src/tools/definitions/notebook-management.ts:601`: same pattern as I063. Document or make explicit.

### I015 — Audit `as any` / @ts-expect-error (partial)
`src/index.ts` and `src/tools/` — replace obvious `as any` casts with typed alternatives. Focus on the tool registry and handler dispatch. Leave `session/` and `notebook-creation/` for a later pass. Aim to reduce `as any` count by at least 20.

**Commit**: `fix: source tool contracts, reduce as-any casts (I063, I064, I015-partial)`

---

## HOW TO RUN

```bash
cd /home/ross/Documents/projects/notebooklm-mcp-secure
npx tsc --noEmit          # must pass (0 errors)
npx vitest run            # must pass (565+ tests green)
```
