# Codex Batch — High-Severity Issues (47 open)

> Generated 2026-04-20. Repo: `/home/ross/Documents/projects/notebooklm-mcp-secure`
> Branch: `main`. All tasks are independent unless noted.
> Run after each batch: `npx tsc --noEmit && npx vitest run`

---

## H1 — `src/index.ts` type safety (I007, I008, I009)

### I007 — `TOOLS_REQUIRING_AUTH` should be `Set<string>` not `string[]`
**File**: `src/index.ts`
**Fix**: Change declaration from `const TOOLS_REQUIRING_AUTH: string[] = [...]` to
`const TOOLS_REQUIRING_AUTH = new Set<string>([...])` and update `.includes(` calls to `.has(`.

### I008 — `toolRegistry` is untyped (`any`)
**File**: `src/index.ts`
**Fix**: Define an interface:
```typescript
interface ToolHandler {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  requiresAuth?: boolean;
}
const toolRegistry: Record<string, ToolHandler> = { ... };
```
Replace all `toolRegistry[name]` usages accordingly.

### I009 — `ServerState` has `any` fields
**File**: `src/index.ts`
**Fix**: Replace `any` type annotations in the `ServerState` type/interface with specific types.
Run `grep -n "any" src/index.ts` to locate them, then narrow each one.

---

## H2 — Auth hardening (I110, I111, I112)

### I110 — Token hash has no salt
**File**: `src/auth/mcp-auth.ts`
**Fix**: When hashing tokens for storage/comparison, prepend a per-instance salt:
```typescript
private readonly hashSalt = crypto.randomBytes(16).toString('hex');
private hashToken(token: string): string {
  return crypto.createHash('sha256').update(this.hashSalt + token).digest('hex');
}
```
Replace bare `crypto.createHash('sha256').update(token)` calls with `this.hashToken(token)`.

### I111 — `failedAttempts` Map grows without bound
**File**: `src/auth/mcp-auth.ts`
**Fix**: Add a cleanup sweep — when the Map exceeds 10 000 entries, delete entries whose
`lockedUntil` is in the past and `count` is 0. Call sweep inside `trackFailedAttempt`.

### I112 — `clientId="unknown"` shared lockout bucket
**File**: `src/auth/mcp-auth.ts`
**Fix**: When `clientId` is absent/empty, fall back to the request IP or generate a
random ephemeral key instead of using the literal string `"unknown"`. This prevents one
unauthenticated caller locking out all unknown clients.

---

## H3 — Auth-manager browser fixes (I123, I124)

### I123 — `performLogin` has no `AbortSignal` / timeout
**File**: `src/auth/auth-manager.ts` (locate `performLogin`)
**Fix**: Accept an `AbortSignal` parameter. At the top of the polling loop check
`signal?.throwIfAborted()`. Wire a `AbortController` with a 120 s timeout at the call
site in the public `login()` method.

### I124 — Login poll doesn't check `page.isClosed()`
**File**: `src/auth/auth-manager.ts` (login polling loop)
**Fix**: Before each `await page.$(selector)` call inside the poll loop, add:
```typescript
if (page.isClosed()) throw new Error('Browser page closed during login');
```

---

## H4 — Webhook security (I272, I273, I274, I275, I276)

### I272 — `webhooks.json` stores secrets in plaintext
**File**: `src/webhooks/webhook-dispatcher.ts` (or webhook storage layer)
**Fix**: Before persisting a webhook config, encrypt the `secret` field using AES-256-GCM
with a key derived from `CONFIG.encryptionKey`. Decrypt on load. Use the existing
`encrypt`/`decrypt` helpers if available (grep `src/utils/` for them).

### I273 — Outbound payload not secret-scanned before delivery
**File**: `src/webhooks/webhook-dispatcher.ts` `sendWithRetry` or `dispatch`
**Fix**: Before POSTing, run the serialised payload through the secrets scanner:
```typescript
import { scanForSecrets } from '../utils/secrets-scanner.js';
const hits = scanForSecrets(JSON.stringify(payload));
if (hits.length) throw new Error(`Payload contains secrets: ${hits.map(h=>h.type).join(', ')}`);
```

### I274 — `sendWithRetry` records only the final attempt
**File**: `src/webhooks/webhook-dispatcher.ts` `sendWithRetry`
**Fix**: Move the `recordDelivery(...)` call inside the retry loop so each attempt is
logged with its own `attempt` index and status, not just the final outcome.

### I275 — Webhook delivery is serial; one slow endpoint blocks others
**File**: `src/webhooks/webhook-dispatcher.ts` `processQueue` or `dispatch`
**Fix**: Change sequential delivery to parallel:
```typescript
await Promise.allSettled(webhooks.map(wh => this.sendWithRetry(wh, event)));
```
Keep per-webhook error handling so one failure doesn't abort others.

### I276 — No circuit-breaker for repeatedly failing webhooks
**File**: `src/webhooks/webhook-dispatcher.ts`
**Fix**: Track consecutive failure count per webhook endpoint. After 5 consecutive
failures open the circuit (skip delivery, log WARN). After 60 s half-open: allow one
probe. Reset on success.

---

## H5 — Quick code fixes (I062, I088, I219, I223, I286, I321)

### I062 — `thinking_level` parameter silently dropped
**File**: locate with `grep -rn "thinking_level" src/`
**Fix**: Find where `thinking_level` is accepted but not forwarded to the Gemini API
call. Pass it through as `thinkingConfig.thinkingBudget` (or whatever the SDK field is).
Add a `// TODO` if the SDK doesn't yet support it, but do NOT silently discard it.

### I088 — Audit logger PII on error paths
**File**: `src/audit/audit-logger.ts` (error event paths)
**Fix**: Before writing an error event, run the message through `redactPII` (grep for it
in `src/utils/`). Apply same redaction used on normal audit events.

### I219 — `cleanOldLogs` silent failure
**File**: grep `cleanOldLogs` in `src/`
**Fix**: Wrap file deletion in try/catch and emit `logger.warn(...)` on failure instead
of swallowing the error silently.

### I223 — Audit hash truncated to 128 bits
**File**: `src/audit/audit-logger.ts`
**Fix**: Change `.digest('hex').slice(0, 32)` (or similar truncation) to use the full
256-bit hex digest (64 chars). Update any length assertions in tests accordingly.

### I286 — `incrementNotebookCount` has no file lock
**File**: `src/quota/quota-manager.ts` `incrementNotebookCount`
**Fix**: Wrap the read-modify-write inside `withLock(this.settingsFile, async () => { ... })`.
Import `withLock` from `'../utils/file-lock.js'` if not already imported.

### I321 — Not all credentials are wrapped in `SecureCredential`
**File**: grep `src/` for raw string credential storage (API keys, tokens assigned to
plain `string` fields).
**Fix**: Wrap each with `SecureCredential` from `src/utils/secure-credential.ts`.
Access via `.getValue()`, clear via `.clear()`.

---

## H6 — Session/browser test coverage (I128)

### I128 — ZERO session/browser tests
**Files to create**: `tests/browser-session.test.ts`, `tests/shared-context-manager.test.ts`

**`browser-session.test.ts`** — mock Playwright (`vi.mock('playwright', ...)`) and test:
- `getSessionId()` returns a non-empty string
- `isSessionActive()` returns false before launch, true after mock launch
- `close()` sets session inactive
- Error recovery path: if `findChatInput` throws, `recoverSession` is called

**`shared-context-manager.test.ts`** — mock browser context and test:
- `getOrCreateContext(profileId)` returns same object on second call
- `releaseContext(profileId)` decrements ref count; destroys at 0
- `cleanup()` closes all contexts

Pattern: use `vi.mock('../src/session/browser-session.js', ...)` with factory returning
jest-style mock objects. See `tests/auth-manager.test.ts` for existing browser mock pattern.

---

## H7 — Secrets scanner + response validator (I183, I184, I212, I215)

### I183 — AWS key lookahead direction is wrong
**File**: `src/utils/secrets-scanner.ts`
**Fix**: Find the AWS key regex. If it uses a negative lookbehind where a lookahead is
needed (or vice-versa), correct the direction. Confirm by running the regex against
`AKIAIOSFODNN7EXAMPLE` — it must match.

### I184 — Entropy scorer produces false positives on base64 URLs
**File**: `src/utils/secrets-scanner.ts` entropy detection section
**Fix**: Before flagging a high-entropy string, check if it's a valid URL or a
well-known safe pattern (UUIDs, hex colour codes). Skip those from entropy alerts.

### I212 — Response validator minimum length hard-coded to 100
**File**: `src/utils/response-validator.ts`
**Fix**: Make the minimum length configurable, defaulting to a lower value (e.g. 10) or
0, so short legitimate responses are not rejected.

### I215 — ZERO prompt-injection tests
**File to create**: `tests/prompt-injection.test.ts`
**Tests**:
- Known injection payloads (`"Ignore previous instructions"`, `"[[SYSTEM]]"`) are
  detected and rejected by the response validator / input sanitiser.
- Benign text containing similar keywords is NOT flagged.
- Nested injection in JSON field values is caught.
- Unicode homoglyph variants of trigger phrases are caught (if the scanner handles them).

---

## H8 — Notebook-creator reliability (I159, I160, I161)

### I159 — `waitForLoadState` errors swallowed
**File**: `src/notebook-creation/notebook-creator.ts`
**Fix**: In the `waitForLoadState` call (or its wrapper), catch the error, log it at
WARN level with context, then rethrow so the caller knows the page didn't fully load.

### I160 — Partial source failure has no rollback
**File**: `src/notebook-creation/notebook-creator.ts` source-addition loop
**Fix**: Track which sources were successfully added. On failure mid-loop, attempt to
remove the successfully-added sources before rethrowing. Wrap in try/finally.

### I161 — `clickNewNotebook` throws a generic Error
**File**: `src/notebook-creation/notebook-creator.ts` `clickNewNotebook`
**Fix**: Replace `throw new Error("Failed to click new notebook")` with a typed error
that includes the selector tried, the page URL, and the underlying cause:
```typescript
throw new NotebookCreationError('clickNewNotebook failed', { selector, url: page.url(), cause: err });
```
Define `NotebookCreationError extends Error` in the same file or `src/errors.ts`.

---

## H9 — Misc high-severity (I005, I023, I069, I070, I089, I102, I130, I131, I137, I143, I144, I145, I147, I154, I197, I204, I245, I259, I264)

### I005 — `completions` capability shape incorrect
**File**: `src/index.ts`
**Fix**: Run `grep -n "completions" src/index.ts`. Ensure the capability object matches
the MCP spec shape: `{ completions: {} }` not `{ completions: true }` or similar.

### I023 — `ensureDirectories` called as import side-effect
**File**: grep `ensureDirectories` in `src/`
**Fix**: Remove top-level call from module scope. Call it explicitly from the server
startup function so it doesn't execute on import.

### I069 — 42 tools exceeds recommended sweet spot (aim ≤20)
**File**: `src/index.ts` tool registration
**Fix**: Audit the tool list. Move low-usage administrative tools behind a
`NLMCP_ADVANCED_TOOLS=1` env flag so they're not registered by default. Document in README.

### I070 — Single tool description >80 lines
**File**: `src/index.ts`
**Fix**: `grep -n "description:" src/index.ts | awk` to find oversized descriptions.
Trim each to ≤5 lines; move detailed parameter docs to `inputSchema.properties[field].description`.

### I089 — Webhook URL not validated in handler
**File**: `src/webhooks/webhook-dispatcher.ts` (or wherever `configure_webhook` is handled)
**Fix**: Validate the URL with `new URL(rawUrl)` and confirm protocol is `https:` before
storing. Throw a user-visible error if invalid.

### I102 — URI log injection
**File**: grep `logger` calls that include user-supplied URIs in `src/`
**Fix**: Before logging a URI, sanitise newlines and control characters:
```typescript
const safeUri = uri.replace(/[\r\n\x00-\x1f]/g, '_');
```

### I130 — Close handler holds stale page reference
**File**: `src/session/browser-session.ts` close/cleanup handler
**Fix**: After `page.close()`, null out the stored `this.page` reference so subsequent
calls don't operate on a closed page object.

### I131 — No lock around headless-toggle check
**File**: `src/session/browser-session.ts`
**Fix**: Wrap the headless-mode check-and-set in a simple boolean guard or mutex to
prevent two callers from simultaneously toggling headless mode.

### I137 — 30 s timeout on interval is too long (blocks event loop perception)
**File**: grep `30000\|30 \* 1000` in `src/session/`
**Fix**: Replace with a shorter poll or use `page.waitForSelector` with `timeout: 5000`
and retry externally.

### I143 — Stale selectors cached without freshness check
**File**: `src/session/selectors.ts` or wherever selector cache lives
**Fix**: Add a cache-bust key (page URL + timestamp bucket). On cache hit, verify the
element is still attached (`elementHandle.isVisible()`) before returning.

### I144 — `findElement` error swallowed
**File**: grep `findElement` in `src/session/`
**Fix**: Replace bare `catch {}` or `catch (e) { return null }` with a logged warn and
`return null` so failures are visible in debug output.

### I145 — `waitForElement` timeout divided incorrectly
**File**: grep `waitForElement` in `src/session/`
**Fix**: Audit the timeout arithmetic. A common bug is `timeout / retries` shrinking
the per-attempt window too aggressively. Use `timeout` as total budget and track elapsed time.

### I147 — `RESPONSE_SELECTORS` defined outside `selectors.ts`
**File**: grep `RESPONSE_SELECTORS` in `src/`
**Fix**: Move the constant into `src/session/selectors.ts` and re-export. Remove the
duplicate definition from the original location.

### I154 — `notebook-creator.ts` is a god file (>600 lines)
**File**: `src/notebook-creation/notebook-creator.ts`
**Fix**: Extract responsibilities into sibling files:
- `src/notebook-creation/source-manager.ts` — source-add/remove logic
- `src/notebook-creation/notebook-nav.ts` — click/navigation helpers
Keep `NotebookCreator` as a thin orchestrator. No behaviour changes.

### I197 — `SecureString` V8 heap caveat not documented
**File**: `src/utils/secure-credential.ts` or `src/utils/secure-string.ts`
**Fix**: Add a single-line comment above the class:
```typescript
// Note: string contents remain in V8 heap until GC; .clear() zeroes the stored buffer only.
```

### I204 — `memoryScubbing` typo in function/variable name
**File**: grep `memoryScubbing\|memoryScrubbing` in `src/`
**Fix**: Rename `memoryScubbing` → `memoryScrubbing` everywhere (use
`sed -i 's/memoryScubbing/memoryScrubbing/g'` or IDE rename). Update any tests.

### I245 — `health-monitor` check results not exported / accessible
**File**: `src/compliance/health-monitor.ts`
**Fix**: Ensure `getLastResults()` or equivalent is exported from the module and
registered as an MCP tool or accessible via the stats endpoint.

### I259 — `eraseBrowserData` deletes live browser profile
**File**: `src/compliance/data-erasure.ts` `eraseBrowserData`
**Fix**: Before deleting, assert the path is inside `CONFIG.dataDir` (not the system
Chrome/Firefox profile). Add a guard:
```typescript
if (!targetPath.startsWith(CONFIG.dataDir)) throw new Error('Refusing to erase outside dataDir');
```

### I264 — Remaining compliance test gaps
**Files**: `tests/report-generator.test.ts`, `tests/siem-exporter.test.ts`,
`tests/evidence-collector.test.ts`, `tests/policy-docs.test.ts`
(These may already exist from CODEX_BATCH Batch C — run `ls tests/` to check.)
If they exist but have low coverage, add missing cases per `CODEX_BATCH.md` C1–C4.

---

## HOW TO RUN

```bash
cd /home/ross/Documents/projects/notebooklm-mcp-secure
npx tsc --noEmit          # must pass (0 errors)
npx vitest run            # must pass (all tests green)
```

Commit after each H-batch with message referencing issue IDs, e.g.:
`fix: webhook security hardening (I272, I273, I274, I275, I276)`
