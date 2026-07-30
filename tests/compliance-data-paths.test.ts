/**
 * Regression gate: compliance data-path coverage (FX-001 / FX-002 / FX-003).
 *
 * The pre-existing suites (data-erasure.test.ts, data-inventory.test.ts) mock
 * `dataDir` and `configDir` to the SAME temp directory, which collapses the
 * exact distinction these bugs live in — an erasure that targets the wrong
 * directory still "passes" when both point at one place.
 *
 * This file deliberately mocks them to DIFFERENT directories, mirroring a real
 * install (env-paths returns different OS dirs for config vs data), and asserts:
 *   FX-001 the global library.json is erased/exported/inventoried from dataDir
 *   FX-002 per-project libraries (dataDir/projects/<id>/library.json) are covered
 *   FX-003 query_logs/ (plaintext Q&A) is covered by erasure, export and inventory
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { DATA_ROOT, CONFIG_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  const base = _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-datapaths-"));
  const data = _path.join(base, "data");
  const config = _path.join(base, "config");
  _fs.mkdirSync(data, { recursive: true });
  _fs.mkdirSync(config, { recursive: true });
  return { DATA_ROOT: data, CONFIG_ROOT: config };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  const cfg = {
    ...actual.CONFIG,
    dataDir: DATA_ROOT,
    configDir: CONFIG_ROOT,
    browserStateDir: path.join(DATA_ROOT, "browser_state"),
    chromeProfileDir: path.join(DATA_ROOT, "chrome_profile"),
  };
  return { ...actual, CONFIG: cfg, getConfig: () => cfg };
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
    getAllConsents: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../src/compliance/privacy-notice.js", () => ({
  getPrivacyNoticeManager: vi.fn(() => ({
    deleteAllRecords: vi.fn().mockResolvedValue(undefined),
    getAllAcknowledgments: vi.fn().mockResolvedValue([]),
  })),
}));

import { DataErasureManager } from "../src/compliance/data-erasure.js";

const SRC = path.join(__dirname, "..", "src", "compliance");

function readSrc(file: string): string {
  return fs.readFileSync(path.join(SRC, file), "utf8");
}

function resetSingletons(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (DataErasureManager as any).instance = undefined;
}

function seed(root: string, relPath: string, content: string): string {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe("compliance data-path coverage (dataDir !== configDir)", () => {
  beforeEach(() => {
    resetSingletons();
    for (const root of [DATA_ROOT, CONFIG_ROOT]) {
      for (const entry of fs.readdirSync(root)) {
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
    }
  });

  describe("FX-001 — global library.json lives in dataDir", () => {
    it("erases the real library.json written by NotebookLibrary", async () => {
      const real = seed(DATA_ROOT, "library.json", JSON.stringify({ notebooks: [{ id: "n1" }] }));
      expect(fs.existsSync(real)).toBe(true);

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });
      await mgr.confirmAndExecute(req.request_id);

      expect(fs.existsSync(real)).toBe(false);
    });

    it("does not report 'verified erased' for a library it never looked at", async () => {
      const real = seed(DATA_ROOT, "library.json", JSON.stringify({ notebooks: [{ id: "n1" }] }));

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });
      const result = await mgr.confirmAndExecute(req.request_id);

      const notebookResult = result?.items_deleted?.find(
        r => r.data_type === "notebook_library"
      );
      expect(notebookResult).toBeDefined();
      // A "verified" erasure must mean the real file is gone.
      expect(notebookResult?.verified && fs.existsSync(real)).toBe(false);
    });

    it("inventories and exports the library from dataDir, not configDir", () => {
      // Source-level assertions: the location maps are private/classifier-gated,
      // so assert the map itself rather than a mockable side effect.
      for (const file of ["data-inventory.ts", "data-export.ts", "data-erasure.ts"]) {
        const src = readSrc(file);
        expect(
          src,
          `${file} still resolves library.json from configDir`
        ).not.toMatch(/configDir\s*,\s*"library\.json"/);
        expect(src, `${file} does not resolve library.json from dataDir`).toMatch(
          /dataDir\s*,\s*"library\.json"/
        );
      }
    });
  });

  describe("FX-002 — per-project libraries", () => {
    it("erases dataDir/projects/<id>/library.json", async () => {
      const proj = seed(
        DATA_ROOT,
        path.join("projects", "proj-abc", "library.json"),
        JSON.stringify({ notebooks: [{ id: "p1" }] })
      );
      expect(fs.existsSync(proj)).toBe(true);

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });
      await mgr.confirmAndExecute(req.request_id);

      expect(fs.existsSync(proj)).toBe(false);
    });
  });

  describe("FX-003 — query_logs contain plaintext Q&A", () => {
    it("erases dataDir/query_logs when notebooks scope is set", async () => {
      const log = seed(
        DATA_ROOT,
        path.join("query_logs", "query-log-2026-07-29.jsonl"),
        JSON.stringify({ question: "secret question", answer: "secret answer" }) + "\n"
      );
      expect(fs.existsSync(log)).toBe(true);

      const mgr = DataErasureManager.getInstance();
      const req = await mgr.createRequest({ notebooks: true, settings: false, browser_data: false });
      await mgr.confirmAndExecute(req.request_id);

      expect(fs.existsSync(log)).toBe(false);
    });

    it("lists query_logs in the inventory and export maps", () => {
      for (const file of ["data-inventory.ts", "data-export.ts"]) {
        expect(readSrc(file), `${file} has no query_logs coverage`).toMatch(/query_logs/);
      }
    });
  });
});
