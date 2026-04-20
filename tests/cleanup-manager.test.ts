/**
 * Unit tests for CleanupManager (src/utils/cleanup-manager.ts).
 *
 * Strategy: mock `env-paths` and `os` so every path the CleanupManager
 * computes lands inside a mkdtempSync sandbox, preventing any real user
 * data from being touched.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Sandboxed directories (computed before any module is loaded)
// ---------------------------------------------------------------------------
const { TMP_ROOT, LEGACY_BASE, CURRENT_BASE, HOME_DIR, TEMP_DIR } = vi.hoisted(
  () => {
    const _fs = require("node:fs") as typeof import("node:fs");
    const _os = require("node:os") as typeof import("node:os");
    const _path = require("node:path") as typeof import("node:path");

    const root = _fs.mkdtempSync(
      _path.join(_os.tmpdir(), "nlmcp-cleanup-test-")
    );

    const legacy = _path.join(root, "legacy");
    const current = _path.join(root, "current");
    const home = _path.join(root, "home");
    const temp = _path.join(root, "tmpdir");

    for (const d of [legacy, current, home, temp]) {
      _fs.mkdirSync(d, { recursive: true });
    }

    return {
      TMP_ROOT: root,
      LEGACY_BASE: legacy,
      CURRENT_BASE: current,
      HOME_DIR: home,
      TEMP_DIR: temp,
    };
  }
);

// ---------------------------------------------------------------------------
// Mock env-paths to return our sandboxed paths
// ---------------------------------------------------------------------------
vi.mock("env-paths", () => {
  // env-paths is a default-export ESM package
  const mockEnvPaths = (name: string, opts?: { suffix?: string }) => {
    const suffix = opts?.suffix === "" ? "" : "-nodejs";
    const isLegacy = suffix === "-nodejs";
    const base = isLegacy ? LEGACY_BASE : CURRENT_BASE;
    return {
      data: path.join(base, "data"),
      config: path.join(base, "config"),
      cache: path.join(base, "cache"),
      log: path.join(base, "log"),
      temp: path.join(base, "temp"),
    };
  };
  return { default: mockEnvPaths };
});

// ---------------------------------------------------------------------------
// Mock os to redirect homedir and tmpdir into our sandbox
// ---------------------------------------------------------------------------
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => HOME_DIR,
      tmpdir: () => TEMP_DIR,
    },
    homedir: () => HOME_DIR,
    tmpdir: () => TEMP_DIR,
  };
});

// ---------------------------------------------------------------------------
// Silence logger output during tests
// ---------------------------------------------------------------------------
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/utils/logger.js", () => ({ log: mockLog }));

// ---------------------------------------------------------------------------
// Silence globby (we don't need it to find anything for most tests)
// ---------------------------------------------------------------------------
vi.mock("globby", () => ({ globby: vi.fn(async () => []) }));

// Import AFTER mocks are registered
import { CleanupManager } from "../src/utils/cleanup-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDir(dirPath: string, fileName = "data.txt"): void {
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, fileName), "test content");
}

function resetSandbox(): void {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  for (const d of [LEGACY_BASE, CURRENT_BASE, HOME_DIR, TEMP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CleanupManager", () => {
  let manager: CleanupManager;

  beforeEach(() => {
    resetSandbox();
    vi.clearAllMocks();
    manager = new CleanupManager();
  });

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. getCleanupPaths — path discovery per mode
  // -------------------------------------------------------------------------

  describe("getCleanupPaths", () => {
    it('returns legacy paths in "legacy" mode', async () => {
      const legacyData = path.join(LEGACY_BASE, "data");
      seedDir(legacyData);

      const { totalPaths, categories } = await manager.getCleanupPaths("legacy");

      expect(totalPaths).toContain(legacyData);
      expect(categories.some((c) => c.name.includes("Legacy"))).toBe(true);
    });

    it('does not include current-installation paths in "legacy" mode', async () => {
      const currentConfig = path.join(CURRENT_BASE, "config");
      seedDir(currentConfig);

      const { totalPaths } = await manager.getCleanupPaths("legacy");

      expect(totalPaths).not.toContain(currentConfig);
    });

    it('includes current paths in "all" mode', async () => {
      const legacyData = path.join(LEGACY_BASE, "data");
      const currentConfig = path.join(CURRENT_BASE, "config");
      seedDir(legacyData);
      seedDir(currentConfig);

      const { totalPaths } = await manager.getCleanupPaths("all");

      expect(totalPaths).toContain(legacyData);
      expect(totalPaths).toContain(currentConfig);
    });

    it("respects preserveLibrary by excluding data dir in all mode", async () => {
      const currentData = path.join(CURRENT_BASE, "data");
      const currentConfig = path.join(CURRENT_BASE, "config");
      seedDir(currentData);
      seedDir(currentConfig);

      const { totalPaths: withPreserve } = await manager.getCleanupPaths("all", true);
      const { totalPaths: withoutPreserve } = await manager.getCleanupPaths("all", false);

      // config should be in both
      expect(withPreserve).toContain(currentConfig);
      // data dir itself should only be omitted when preserveLibrary=true
      // (subdirs like sessions/audit are what gets listed, not data root)
      const sessionsDir = path.join(currentData, "sessions");
      seedDir(sessionsDir);

      const { totalPaths: fresh } = await manager.getCleanupPaths("all", true);
      expect(fresh).not.toContain(sessionsDir);

      const { totalPaths: freshAll } = await manager.getCleanupPaths("all", false);
      expect(freshAll).toContain(sessionsDir);
    });

    it("returns empty categories when no matching paths exist", async () => {
      const { categories, totalPaths } = await manager.getCleanupPaths("legacy");
      expect(categories).toHaveLength(0);
      expect(totalPaths).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. performCleanup — actually deletes the paths
  // -------------------------------------------------------------------------

  describe("performCleanup", () => {
    it("deletes existing legacy directories and reports them in deletedPaths", async () => {
      const legacyData = path.join(LEGACY_BASE, "data");
      const legacyConfig = path.join(LEGACY_BASE, "config");
      seedDir(legacyData);
      seedDir(legacyConfig);

      expect(fs.existsSync(legacyData)).toBe(true);

      const result = await manager.performCleanup("legacy");

      expect(result.success).toBe(true);
      expect(result.mode).toBe("legacy");
      expect(result.deletedPaths).toContain(legacyData);
      expect(result.deletedPaths).toContain(legacyConfig);
      expect(result.failedPaths).toHaveLength(0);

      expect(fs.existsSync(legacyData)).toBe(false);
      expect(fs.existsSync(legacyConfig)).toBe(false);
    });

    it("paths outside the registered candidate set are not touched", async () => {
      // A directory that CleanupManager has no reason to know about
      const unrelatedDir = path.join(TMP_ROOT, "unrelated-important-data");
      seedDir(unrelatedDir, "important.txt");

      await manager.performCleanup("all");

      expect(fs.existsSync(unrelatedDir)).toBe(true);
    });

    it("returns success:true with empty deletedPaths when nothing exists", async () => {
      const result = await manager.performCleanup("legacy");

      expect(result.success).toBe(true);
      expect(result.deletedPaths).toHaveLength(0);
      expect(result.failedPaths).toHaveLength(0);
    });

    it("is idempotent — second cleanup after first succeeds cleanly", async () => {
      const legacyData = path.join(LEGACY_BASE, "data");
      seedDir(legacyData);

      const first = await manager.performCleanup("legacy");
      expect(first.success).toBe(true);
      expect(first.deletedPaths).toContain(legacyData);

      // Re-seed and run again
      seedDir(legacyData);
      const second = await manager.performCleanup("legacy");
      expect(second.success).toBe(true);
      expect(second.deletedPaths).toContain(legacyData);
      expect(fs.existsSync(legacyData)).toBe(false);
    });

    it("catches fs.rm errors and records them in failedPaths without throwing", async () => {
      const legacyData = path.join(LEGACY_BASE, "data");
      seedDir(legacyData);

      // Make the directory non-writable so fs.rm fails with EACCES.
      // We restore permissions in a try/finally so the afterEach cleanup works.
      fs.chmodSync(legacyData, 0o555);
      // Also lock the parent so deletion of the dir itself fails.
      fs.chmodSync(LEGACY_BASE, 0o555);

      let result!: Awaited<ReturnType<typeof manager.performCleanup>>;
      try {
        await expect(
          manager.performCleanup("legacy").then((r) => {
            result = r;
          })
        ).resolves.toBeUndefined(); // must not throw

        expect(result.success).toBe(false);
        expect(result.failedPaths.length).toBeGreaterThan(0);
        expect(mockLog.error).toHaveBeenCalled();
      } finally {
        // Restore so resetSandbox() can clean up
        fs.chmodSync(LEGACY_BASE, 0o755);
        fs.chmodSync(legacyData, 0o755);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. formatBytes — utility
  // -------------------------------------------------------------------------

  describe("formatBytes", () => {
    it("returns '0 Bytes' for 0", () => {
      expect(manager.formatBytes(0)).toBe("0 Bytes");
    });

    it("formats kilobytes correctly", () => {
      expect(manager.formatBytes(1024)).toBe("1 KB");
    });

    it("formats megabytes correctly", () => {
      expect(manager.formatBytes(1024 * 1024)).toBe("1 MB");
    });

    it("handles sub-KB values as Bytes", () => {
      const result = manager.formatBytes(512);
      expect(result).toMatch(/Bytes/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. getPlatformInfo — shape check
  // -------------------------------------------------------------------------

  describe("getPlatformInfo", () => {
    it("returns an object with the expected keys", () => {
      const info = manager.getPlatformInfo();

      expect(info).toHaveProperty("platform");
      expect(info).toHaveProperty("legacyBasePath");
      expect(info).toHaveProperty("currentBasePath");
      expect(info).toHaveProperty("npmCachePath");
      expect(info).toHaveProperty("claudeCliCachePath");
      expect(info).toHaveProperty("claudeProjectsPath");
    });

    it("returns paths that sit inside the sandboxed home dir", () => {
      const info = manager.getPlatformInfo();

      // legacyBasePath and currentBasePath come from mocked env-paths
      expect(info.legacyBasePath).toContain(LEGACY_BASE);
      expect(info.currentBasePath).toContain(CURRENT_BASE);
      // npmCachePath is derived from os.homedir()
      expect(info.npmCachePath).toContain(HOME_DIR);
    });
  });
});
