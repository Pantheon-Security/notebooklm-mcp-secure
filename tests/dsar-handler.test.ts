/**
 * Unit tests for DSARHandler (src/compliance/dsar-handler.ts).
 *
 * Covers GDPR Article 15-21 request submission, processing, and
 * persistence round-trips. See ISSUES.md I251.
 *
 * Note: I252 (generateResponse hardcodes subject_verified:true) and
 * I253 (concurrent submit file-lock race) are tracked open issues;
 * the corresponding tests below assert current behavior with a
 * pointer to the issue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-dsar-test-")) };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
    getConfig: () => ({ ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT }),
  };
});

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: vi.fn(() => ({
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/compliance/data-inventory.js", () => ({
  getDataInventory: vi.fn(() => ({
    getPersonalData: vi.fn().mockResolvedValue([
      {
        id: "inv-1",
        data_type: "notebook_library",
        data_categories: ["user_content"],
        classification: "internal",
        retention_days: 365,
        processing_purposes: ["app_functionality"],
        legal_basis: "contract",
        exportable: true,
      },
      {
        id: "inv-2",
        data_type: "auth_cookies",
        data_categories: ["credentials"],
        classification: "confidential",
        retention_days: 30,
        processing_purposes: ["authentication"],
        legal_basis: "contract",
        exportable: false,
      },
    ]),
    getAll: vi.fn().mockResolvedValue([
      {
        id: "inv-1",
        data_type: "notebook_library",
        data_categories: ["user_content"],
        classification: "internal",
        retention_days: 365,
        processing_purposes: ["app_functionality"],
        legal_basis: "contract",
        exportable: true,
      },
    ]),
  })),
}));

import { DSARHandler } from "../src/compliance/dsar-handler.js";

const REQUEST_TYPES = [
  "access",
  "portability",
  "erasure",
  "rectification",
  "restriction",
  "objection",
] as const;

function resetSingleton(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DSARHandler as any).instance = undefined;
}

describe("DSARHandler", () => {
  let requestsFile: string;

  beforeEach(() => {
    resetSingleton();
    requestsFile = path.join(TMP_ROOT, "compliance", "dsar-requests.json");
    try { fs.unlinkSync(requestsFile); } catch { /* no-op */ }
  });

  afterEach(() => {
    try { fs.unlinkSync(requestsFile); } catch { /* no-op */ }
  });

  describe("submitRequest", () => {
    for (const type of REQUEST_TYPES) {
      it(`accepts type='${type}' and persists to disk`, async () => {
        const handler = DSARHandler.getInstance();
        const req = await handler.submitRequest(type);
        expect(req.request_id).toMatch(/^[0-9a-f-]{36}$/);
        expect(req.type).toBe(type);
        expect(req.status).toBe("pending");
        expect(req.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Round-trip: new handler reads persisted data
        resetSingleton();
        const fresh = DSARHandler.getInstance();
        const all = await fresh.getAllRequests();
        expect(all.some((r) => r.request_id === req.request_id)).toBe(true);
      });
    }

    it("defaults to type='access' when not specified", async () => {
      const handler = DSARHandler.getInstance();
      const req = await handler.submitRequest();
      expect(req.type).toBe("access");
    });
  });

  describe("processRequest", () => {
    it("generates a DSAR response with GDPR rights and processing purposes", async () => {
      const handler = DSARHandler.getInstance();
      const req = await handler.submitRequest("access");

      const response = await handler.processRequest(req.request_id);
      expect(response).not.toBeNull();
      expect(response?.request_id).toBe(req.request_id);
      expect(response?.available_rights).toContain(
        "Right of access (GDPR Article 15)",
      );
      expect(response?.available_rights).toContain(
        "Right to erasure (GDPR Article 17)",
      );
      expect(response?.data_recipients).toContain("None - all data is processed locally");
    });

    it("redacts sensitive data categories from the sample", async () => {
      const handler = DSARHandler.getInstance();
      const req = await handler.submitRequest("access");
      const response = await handler.processRequest(req.request_id);
      const authEntry = response?.personal_data.find((p) => p.category === "auth_cookies");
      // data-inventory mock marks auth_cookies as credentials + not exportable,
      // so the handler should substitute metadata with a "not included" note.
      expect(authEntry).toBeDefined();
      const payload = authEntry?.data as { note?: string };
      expect(payload.note).toMatch(/not included/i);
    });

    it("marks request completed after processing", async () => {
      const handler = DSARHandler.getInstance();
      const req = await handler.submitRequest("access");
      await handler.processRequest(req.request_id);

      resetSingleton();
      const fresh = DSARHandler.getInstance();
      const reloaded = await fresh.getRequest(req.request_id);
      expect(reloaded?.status).toBe("completed");
      expect(reloaded?.completed_at).toBeDefined();
      expect(reloaded?.response).toBeDefined();
    });

    it("returns null for unknown request_id", async () => {
      const handler = DSARHandler.getInstance();
      const r = await handler.processRequest("00000000-0000-0000-0000-000000000000");
      expect(r).toBeNull();
    });

    it("I252 fixed: subject_verified is false (identity verification not implemented)", async () => {
      const handler = DSARHandler.getInstance();
      const req = await handler.submitRequest("access");
      const response = await handler.processRequest(req.request_id);
      // I252: subject_verified must be false — the system does not verify identity.
      expect(response?.subject_verified).toBe(false);
    });
  });

  describe("getAllRequests", () => {
    it("returns requests in submission order", async () => {
      const handler = DSARHandler.getInstance();
      const r1 = await handler.submitRequest("access");
      const r2 = await handler.submitRequest("erasure");
      const r3 = await handler.submitRequest("portability");

      const all = await handler.getAllRequests();
      const ids = all.map((r) => r.request_id);
      expect(ids).toEqual([r1.request_id, r2.request_id, r3.request_id]);
    });

    it("empty array when no requests submitted", async () => {
      const handler = DSARHandler.getInstance();
      const all = await handler.getAllRequests();
      expect(all).toEqual([]);
    });
  });

  describe("persistence format", () => {
    it("stores requests with version + last_updated envelope", async () => {
      const handler = DSARHandler.getInstance();
      await handler.submitRequest("access");
      const raw = JSON.parse(fs.readFileSync(requestsFile, "utf-8"));
      expect(raw.version).toBe("1.0.0");
      expect(raw.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Array.isArray(raw.requests)).toBe(true);
      expect(raw.requests.length).toBe(1);
    });

    it("corrupt file is treated as empty (graceful recovery)", async () => {
      fs.mkdirSync(path.dirname(requestsFile), { recursive: true });
      fs.writeFileSync(requestsFile, "{not-json");
      const handler = DSARHandler.getInstance();
      const all = await handler.getAllRequests();
      expect(all).toEqual([]);
    });
  });
});
