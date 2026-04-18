/**
 * Unit tests for AuthManager (src/auth/auth-manager.ts).
 *
 * Scope: the filesystem-side surface of AuthManager — state expiry,
 * clearAllAuthData, hardResetState, clearState. The browser-automation
 * paths (performLogin, performSetup, validateCookiesExpiry,
 * validateWithRetry) require a patchright BrowserContext and belong in
 * an integration test harness (not written as part of this task).
 *
 * See ISSUES.md I121.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-authmgr-test-"));
  return { TMP_ROOT: root };
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

// Stub crypto storage — unit tests don't exercise real encryption.
vi.mock("../src/utils/crypto.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/crypto.js")>("../src/utils/crypto.js");
  return {
    ...actual,
    getSecureStorage: () => ({
      exists: (filePath: string) =>
        fs.existsSync(filePath) ||
        fs.existsSync(filePath + ".pqenc") ||
        fs.existsSync(filePath + ".enc"),
      save: async (filePath: string, data: unknown) => {
        fs.writeFileSync(filePath, JSON.stringify(data));
      },
      load: async (filePath: string) => {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      },
      delete: async (filePath: string) => {
        for (const ext of ["", ".pqenc", ".enc"]) {
          try { fs.unlinkSync(filePath + ext); } catch { /* no-op */ }
        }
      },
      getStatus: () => ({ postQuantumEnabled: false }),
    }),
  };
});

import { AuthManager } from "../src/auth/auth-manager.js";

const STATE_DIR = path.join(TMP_ROOT, "browser_state");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const CHROME_PROFILE = path.join(TMP_ROOT, "chrome_profile");

function wipe(): void {
  for (const dir of [STATE_DIR, CHROME_PROFILE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* no-op */ }
  }
}

function seedState(content = "{}", extensions: string[] = [""]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const ext of extensions) fs.writeFileSync(STATE_FILE + ext, content);
}

describe("AuthManager", () => {
  beforeEach(() => {
    wipe();
  });

  afterEach(() => {
    wipe();
  });

  describe("hasSavedState", () => {
    it("returns false when no state file exists", async () => {
      const am = new AuthManager();
      expect(await am.hasSavedState()).toBe(false);
    });

    it("returns true when plain state.json exists", async () => {
      seedState("{}");
      const am = new AuthManager();
      expect(await am.hasSavedState()).toBe(true);
    });

    it("returns true when encrypted .pqenc exists", async () => {
      seedState("encrypted-bytes", [".pqenc"]);
      const am = new AuthManager();
      expect(await am.hasSavedState()).toBe(true);
    });

    it("returns true when legacy .enc exists", async () => {
      seedState("legacy-bytes", [".enc"]);
      const am = new AuthManager();
      expect(await am.hasSavedState()).toBe(true);
    });
  });

  describe("isStateExpired", () => {
    it("treats missing file as expired", async () => {
      const am = new AuthManager();
      expect(await am.isStateExpired()).toBe(true);
    });

    it("returns false for a freshly-written state", async () => {
      seedState("{}");
      const am = new AuthManager();
      expect(await am.isStateExpired()).toBe(false);
    });

    it("returns true when mtime is older than 7 days", async () => {
      seedState("{}");
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.utimesSync(STATE_FILE, eightDaysAgo / 1000, eightDaysAgo / 1000);
      const am = new AuthManager();
      expect(await am.isStateExpired()).toBe(true);
    });

    it("returns false when mtime is 6 days old (within window)", async () => {
      seedState("{}");
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
      fs.utimesSync(STATE_FILE, sixDaysAgo / 1000, sixDaysAgo / 1000);
      const am = new AuthManager();
      expect(await am.isStateExpired()).toBe(false);
    });

    it("honors an encrypted .pqenc file's mtime", async () => {
      seedState("x", [".pqenc"]);
      const recent = Date.now() - 60 * 60 * 1000; // 1h old
      fs.utimesSync(STATE_FILE + ".pqenc", recent / 1000, recent / 1000);
      const am = new AuthManager();
      expect(await am.isStateExpired()).toBe(false);
    });
  });

  describe("clearState", () => {
    it("removes both state and session files (plain and encrypted variants)", async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, "{}");
      fs.writeFileSync(STATE_FILE + ".pqenc", "x");
      fs.writeFileSync(SESSION_FILE, "{}");
      fs.writeFileSync(SESSION_FILE + ".pqenc", "x");

      const am = new AuthManager();
      const result = await am.clearState();
      expect(result).toBe(true);

      expect(fs.existsSync(STATE_FILE)).toBe(false);
      expect(fs.existsSync(STATE_FILE + ".pqenc")).toBe(false);
      expect(fs.existsSync(SESSION_FILE)).toBe(false);
      expect(fs.existsSync(SESSION_FILE + ".pqenc")).toBe(false);
    });

    it("succeeds (returns true) when nothing to delete", async () => {
      const am = new AuthManager();
      expect(await am.clearState()).toBe(true);
    });
  });

  describe("clearAllAuthData (the nuclear option)", () => {
    it("wipes browser_state files and chrome_profile directory", async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, "state.json"), "{}");
      fs.writeFileSync(path.join(STATE_DIR, "session.json"), "{}");
      fs.writeFileSync(path.join(STATE_DIR, "state.json.pqenc"), "x");

      fs.mkdirSync(path.join(CHROME_PROFILE, "Default"), { recursive: true });
      fs.writeFileSync(path.join(CHROME_PROFILE, "Default", "Preferences"), "{}");

      const am = new AuthManager();
      await am.clearAllAuthData();

      // Files removed, chrome profile removed
      const stateFiles = fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR) : [];
      expect(stateFiles.length).toBe(0);
      expect(fs.existsSync(CHROME_PROFILE)).toBe(false);
    });

    it("is idempotent on an already-clean tree", async () => {
      const am = new AuthManager();
      await expect(am.clearAllAuthData()).resolves.not.toThrow();
    });

    it("leaves non-state files in browser_state_dir alone", async () => {
      // clearAllAuthData only deletes .json / .enc / .pqenc — NOT other
      // extensions. Verify a foreign file survives.
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, "state.json"), "{}");
      fs.writeFileSync(path.join(STATE_DIR, "README.txt"), "keep me");

      const am = new AuthManager();
      await am.clearAllAuthData();

      expect(fs.existsSync(path.join(STATE_DIR, "state.json"))).toBe(false);
      expect(fs.existsSync(path.join(STATE_DIR, "README.txt"))).toBe(true);
    });
  });

  describe("hardResetState", () => {
    it("removes state and session files and empties browser_state_dir", async () => {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, "{}");
      fs.writeFileSync(SESSION_FILE, "{}");
      fs.writeFileSync(path.join(STATE_DIR, "extra.json"), "{}");

      const am = new AuthManager();
      const ok = await am.hardResetState();
      expect(ok).toBe(true);

      const leftover = fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR) : [];
      expect(leftover.length).toBe(0);
    });

    it("returns true even when nothing exists", async () => {
      const am = new AuthManager();
      expect(await am.hardResetState()).toBe(true);
    });
  });
});
