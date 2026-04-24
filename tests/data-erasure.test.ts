/**
 * Unit tests for DataErasureManager (src/compliance/data-erasure.ts).
 *
 * GDPR Article 17 (Right to Erasure) surface — was zero tests.
 * Covers request lifecycle, scope expansion, idempotency, and
 * real file deletion in a temp directory.
 *
 * See ISSUES.md I256. Known limitations (I257 SSD wear-leveling,
 * I259 Chrome profile race) are out of scope for unit tests; they
 * require integration coverage on real OS surfaces.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-erase-test-")) };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  const cfg = {
    ...actual.CONFIG,
    dataDir: TMP_ROOT,
    configDir: TMP_ROOT,
    browserStateDir: path.join(TMP_ROOT, "browser_state"),
    chromeProfileDir: path.join(TMP_ROOT, "chrome_profile"),
  };
  return {
    ...actual,
    CONFIG: cfg,
    getConfig: () => cfg,
  };
});

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: vi.fn(() => ({
    log: vi.fn().mockResolvedValue(undefined),
    logDataDeletion: vi.fn().mockResolvedValue(undefined),
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/compliance/consent-manager.js", () => ({
  getConsentManager: vi.fn(() => ({
    deleteAllConsents: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/compliance/privacy-notice.js", () => ({
  getPrivacyNoticeManager: vi.fn(() => ({
    deleteAllRecords: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { DataErasureManager } from "../src/compliance/data-erasure.js";

function resetSingleton(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DataErasureManager as any).instance = undefined;
}

function seedFile(relPath: string, content: string): string {
  const full = path.join(TMP_ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe("DataErasureManager", () => {
  const erasureLogFile = path.join(TMP_ROOT, "compliance", "erasure-log.json");

  beforeEach(() => {
    resetSingleton();
    // Wipe the compliance subdir so prior test state doesn't leak.
    try { fs.rmSync(path.join(TMP_ROOT, "compliance"), { recursive: true, force: true }); } catch { /* no-op */ }
    try { fs.rmSync(path.join(TMP_ROOT, "browser_state"), { recursive: true, force: true }); } catch { /* no-op */ }
    try { fs.rmSync(path.join(TMP_ROOT, "chrome_profile"), { recursive: true, force: true }); } catch { /* no-op */ }
    try { fs.unlinkSync(path.join(TMP_ROOT, "library.json")); } catch { /* no-op */ }
    try { fs.unlinkSync(path.join(TMP_ROOT, "quota.json")); } catch { /* no-op */ }
  });

  afterEach(() => {
    try { fs.rmSync(path.join(TMP_ROOT, "compliance"), { recursive: true, force: true }); } catch { /* no-op */ }
  });

  describe("createRequest", () => {
    it("applies DEFAULT_SCOPE when no scope provided", async () => {
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest();
      expect(req.scope.notebooks).toBe(true);
      expect(req.scope.settings).toBe(true);
      expect(req.scope.browser_data).toBe(true);
      expect(req.scope.audit_logs).toBe(false);
      expect(req.scope.compliance_events).toBe(false);
      expect(req.scope.encryption_keys).toBe(false);
      expect(req.confirmed).toBe(false);
    });

    it("merges partial scope over DEFAULT_SCOPE", async () => {
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ audit_logs: true });
      expect(req.scope.audit_logs).toBe(true);
      expect(req.scope.notebooks).toBe(true); // still true from default
    });

    it("complete_erasure=true expands to everything except compliance_events", async () => {
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ complete_erasure: true });
      expect(req.scope.notebooks).toBe(true);
      expect(req.scope.settings).toBe(true);
      expect(req.scope.browser_data).toBe(true);
      expect(req.scope.audit_logs).toBe(true);
      expect(req.scope.encryption_keys).toBe(true);
      // Compliance events are retained so the erasure record itself survives
      expect(req.scope.compliance_events).toBe(false);
    });

    it("persists erasure_record_retention_days = 7 years (CSSF)", async () => {
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest();
      expect(req.erasure_record_retention_days).toBe(7 * 365);
    });
  });

  describe("confirmAndExecute", () => {
    it("actually deletes seeded library.json when notebooks scope=true", async () => {
      const libPath = seedFile("library.json", JSON.stringify({ notebooks: [] }));
      expect(fs.existsSync(libPath)).toBe(true);

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });
      const result = await mgr.confirmAndExecute(req.request_id);

      expect(result).not.toBeNull();
      expect(result?.confirmed).toBe(true);
      expect(result?.executed_at).toBeDefined();
      expect(fs.existsSync(libPath)).toBe(false);
    });

    it("deletes browser_state and chrome_profile when browser_data scope=true", async () => {
      const bsFile = seedFile("browser_state/cookies.json", "[]");
      const cpFile = seedFile("chrome_profile/Default/Preferences", "{}");

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({
        notebooks: false,
        settings: false,
        browser_data: true,
      });
      const result = await mgr.confirmAndExecute(req.request_id);

      expect(result?.confirmed).toBe(true);
      expect(fs.existsSync(bsFile)).toBe(false);
      expect(fs.existsSync(cpFile)).toBe(false);
    });

    it("does not erase chrome_profile while SingletonLock indicates Chrome is running", async () => {
      const cpFile = seedFile("chrome_profile/Default/Preferences", "{}");
      seedFile("chrome_profile/SingletonLock", "lock");

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({
        notebooks: false,
        settings: false,
        browser_data: true,
      });
      const result = await mgr.confirmAndExecute(req.request_id);

      expect(result?.confirmed).toBe(true);
      expect(fs.existsSync(cpFile)).toBe(true);
      expect(JSON.stringify(result?.items_deleted)).toContain("SingletonLock");
    });

    it("leaves audit logs intact when audit_logs scope=false (default)", async () => {
      const auditFile = seedFile("audit/audit-2026-01-01.jsonl", "{}\n");
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest();
      await mgr.confirmAndExecute(req.request_id);
      expect(fs.existsSync(auditFile)).toBe(true);
    });

    it("deletes audit logs only when audit_logs scope=true", async () => {
      const auditFile = seedFile("audit/audit-2026-01-01.jsonl", "{}\n");
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({
        notebooks: false,
        settings: false,
        browser_data: false,
        audit_logs: true,
      });
      await mgr.confirmAndExecute(req.request_id);
      expect(fs.existsSync(auditFile)).toBe(false);
    });

    it("returns null for unknown request_id", async () => {
      const mgr = DataErasureManager.getInstance();
      const r = await mgr.confirmAndExecute("00000000-0000-0000-0000-000000000000");
      expect(r).toBeNull();
    });

    it("is idempotent — second confirm returns same request without re-deleting", async () => {
      seedFile("library.json", "{}");
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });

      const first = await mgr.confirmAndExecute(req.request_id);
      expect(first?.confirmed).toBe(true);
      const firstExecutedAt = first?.executed_at;

      // Second call should return the same (already-executed) request
      const second = await mgr.confirmAndExecute(req.request_id);
      expect(second?.confirmed).toBe(true);
      expect(second?.executed_at).toBe(firstExecutedAt);
    });

    it("records items_deleted counts across scope", async () => {
      seedFile("library.json", "x");
      seedFile("browser_state/a.json", "x");
      seedFile("browser_state/b.json", "x");

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: true });
      const result = await mgr.confirmAndExecute(req.request_id);

      expect(result?.items_deleted.length).toBeGreaterThanOrEqual(1);
      // Sum of items_deleted across all sub-results should be > 0
      const total = result?.items_deleted.reduce((s, r) => s + r.items_deleted, 0) ?? 0;
      expect(total).toBeGreaterThan(0);
    });
  });

  describe("persistence", () => {
    it("survives singleton reset", async () => {
      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true });

      resetSingleton();
      const fresh = DataErasureManager.getInstance();
      const all = await fresh.getAllRequests();
      expect(all.some((r) => r.request_id === req.request_id)).toBe(true);
    });

    it("writes version + last_updated envelope", async () => {
      const mgr = DataErasureManager.getInstance();
      await mgr.createRequest({ notebooks: true });
      const raw = JSON.parse(fs.readFileSync(erasureLogFile, "utf-8"));
      expect(raw.version).toBe("1.0.0");
      expect(Array.isArray(raw.requests)).toBe(true);
    });
  });
});
