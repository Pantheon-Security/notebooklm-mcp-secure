# Codex Batch — notebooklm-mcp-secure remaining issues

> Generated 2026-04-19. All tasks are independent unless noted.
> Repo: `/home/ross/Documents/projects/notebooklm-mcp-secure`
> Branch: `main` (currently 406 tests passing, clean `tsc --noEmit`)

---

## BATCH A — Test coverage (high value, mechanical)

### A1: `tests/notebook-library.test.ts`
Source: `src/library/notebook-library.ts`
Tests to write:
- `addNotebook` persists to disk and returns the notebook
- `getNotebook(id)` retrieves it; returns null for unknown ID
- `listNotebooks` returns all; filtered by folder
- `setActiveNotebook` / `getActiveNotebook`
- `removeNotebook` deletes entry; library file updated
- Disk round-trip: second `NotebookLibrary` instance loads from same file
- `getStats` returns correct counts

Pattern: mock `../src/config.js` to redirect `dataDir`/`configDir` to `fs.mkdtempSync` temp dir. Use `vi.hoisted`. See `tests/consent-manager.test.ts` for exact mock pattern.

---

### A2: `tests/settings-manager.test.ts`
Source: `src/utils/settings-manager.ts`
Tests:
- Default settings are returned when no file exists
- `set(key, value)` persists a setting
- `get(key)` reads it back
- `filterTools(allTools)` correctly hides/shows tools based on settings
- Disk round-trip: second instance loads saved settings

---

### A3: `tests/cleanup-manager.test.ts`
Source: `src/utils/cleanup-manager.ts`
Tests:
- `registerCleanupTarget` registers a path
- `cleanup()` deletes registered temp files/dirs
- Files outside allowed dirs are not deleted (safety check)
- Error during deletion is logged, not thrown

---

### A4: `tests/file-permissions.test.ts`
Source: `src/utils/file-permissions.ts`
Tests:
- `writeFileSecure(path, content, mode)` writes with correct permissions
- `appendFileSecure` appends without changing permissions
- `ensureDirectorySecure` creates dir with mode 0o700
- Rejects path traversal (`../../etc/passwd`)

---

## BATCH B — Code fixes (security/correctness)

### B1: `src/auth/mcp-auth.ts` — lockoutCount decay (I114)
**Location**: `validateToken` method, where lockout expiry is checked.
**Current code** (around line 236):
```typescript
if (this.isLockedOut(clientId)) {
  // ...locked path
}
// After lockout: reset count
if (tracker.lockedUntil && Date.now() > tracker.lockedUntil) {
  tracker.count = 0;
  tracker.lockoutCount = 0;  // <-- this is the fix that's already there
```
**Verify** that `lockoutCount` is actually reset to 0 when lockout expires (run `grep -n "lockoutCount" src/auth/mcp-auth.ts`). If the reset is already there (it appears to be at line 240), this issue is already resolved — mark as DONE.

---

### B2: `src/quota/quota-manager.ts` — `getDetailedStatus` rollover not persisted (I287)
**Location**: `getDetailedStatus` method (around line 710).
**Issue**: Calls `rolloverIfNeeded()` internally but doesn't persist the rollover.
**Fix**: After rolling over inside `getDetailedStatus`, call `this.saveSettings()`.

Read the current code first: `grep -n "getDetailedStatus\|rolloverIfNeeded\|saveSettings" src/quota/quota-manager.ts`

---

### B3: `src/compliance/dsar-handler.ts` — race on concurrent load (I253)
**Location**: `load()` method.
**Issue**: `if (this.loaded) return` guard is not async-safe; two concurrent callers both pass the guard.
**Fix**: Change to a loadPromise pattern:
```typescript
private loadPromise: Promise<void> | null = null;

private load(): Promise<void> {
  if (!this.loadPromise) {
    this.loadPromise = this._load();
  }
  return this.loadPromise;
}
```
Rename current `load()` body to `_load()`. Update all `await this.load()` callers.

---

### B4: `src/compliance/dsar-handler.ts` — no file lock on save (I254)
**Location**: `save()` method.
**Issue**: Concurrent `submitRequest` calls race on the save.
**Fix**: Wrap the file write in `withLock(this.requestsFile, ...)` from `../utils/file-lock.js`.

---

### B5: `src/utils/response-validator.ts` — stateful regex lastIndex skip (I214)
**Location**: Around line 327. Pattern rebuilt with `"gi"` flag but reuses `lastIndex`.
**Issue**: Stateful regex `lastIndex` causes some matches to be skipped on re-use.
**Fix**: Compile a fresh regex each time it's used in the loop, OR use `matchAll` with a non-stateful approach.

Read `src/utils/response-validator.ts` around line 310–340 first.

---

### B6: `src/utils/security.ts` — NLMCP_AUTH_DISABLED warning already present; verify (I209)
Run: `grep -n "AUTH_DISABLED\|AUTH_ENABLED\|checkSecurityContext" src/utils/security.ts`
If the check is already there (it appears to be at line 352), mark as DONE.

---

### B7: `src/compliance/data-erasure.ts` — passes:0 bypass (I263)
**Location**: `secureOverwrite` function or wherever `passes` is used as parameter.
**Fix**: Add `passes = Math.max(1, passes)` at the top of the overwrite loop.

Read `src/compliance/data-erasure.ts` around the `secureOverwrite` or `eraseData` function first.

---

## BATCH C — More test coverage

### C1: `tests/report-generator.test.ts`
Source: `src/compliance/report-generator.ts`
Tests:
- `generateReport("privacy_impact")` returns a report object with expected fields
- `saveReport(report, outputDir)` writes a file to disk
- `listReports(dir)` lists saved reports
- Report contains correct sections (data inventory, consent summary, etc.)

### C2: `tests/siem-exporter.test.ts`
Source: `src/compliance/siem-exporter.ts`
Tests:
- `queueEvent(event)` adds to the queue
- `processQueue()` attempts delivery (mock the HTTP/TCP transport)
- `saveFailedEvent(event)` writes to failed events file
- `retryFailed()` reads the failed events file and re-queues
- `isEnabled()` respects `NLMCP_SIEM_ENABLED` env var

### C3: `tests/evidence-collector.test.ts`
Source: `src/compliance/evidence-collector.ts`
Tests:
- `collectEvidence(type)` returns an evidence package with expected fields
- `savePackage(pkg, dir)` writes to disk
- `listPackages(dir)` lists saved packages
- Disk round-trip

### C4: `tests/policy-docs.test.ts`
Source: `src/compliance/policy-docs.ts`
Tests:
- `getPolicy(name)` returns a policy object
- `listPolicies()` returns all policies
- `getPolicyText(name)` returns human-readable text
- Custom policy override via `setPolicy`

---

## BATCH D — Schema and annotation fixes (already done — verify only)

These were confirmed resolved in previous sessions. Run `npx tsc --noEmit` and `npx vitest run` to confirm nothing regressed.

- I030-I038: Annotations (readOnlyHint, destructiveHint, idempotentHint)
- I042-I058: inputSchema `additionalProperties:false` + field bounds
- I059: Gemini model enum (no gemini-2.5-*)

---

## HOW TO RUN

```bash
cd /home/ross/Documents/projects/notebooklm-mcp-secure
npx tsc --noEmit          # must pass (0 errors)
npx vitest run            # must pass (all tests green)
```

After each batch, commit with message referencing the issue IDs fixed.
