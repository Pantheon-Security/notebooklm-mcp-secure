/**
 * Unit tests for BrowserSession (src/session/browser-session.ts).
 *
 * Scope: the non-browser-automation surface — constructor properties,
 * isInitialized(), isExpired(), updateActivity(), getInfo(), close().
 * The browser-automation paths (init, ask, reset) require a real
 * patchright BrowserContext and belong in an integration harness.
 *
 * patchright is mocked so the module can be imported without a
 * live Chromium install.
 *
 * See ISSUES.md I128.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock patchright before importing session code that imports it transitively.
vi.mock("patchright", () => ({
  chromium: {
    launchPersistentContext: vi.fn(),
  },
}));

// Mock heavy collaborators so constructing BrowserSession doesn't require
// real filesystem or browser state.
vi.mock("../src/utils/audit-logger.js", () => ({
  audit: {
    session: vi.fn().mockResolvedValue(undefined),
    security: vi.fn().mockResolvedValue(undefined),
    system: vi.fn().mockResolvedValue(undefined),
    auth: vi.fn().mockResolvedValue(undefined),
    tool: vi.fn().mockResolvedValue(undefined),
    compliance: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/utils/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

vi.mock("../src/utils/stealth-utils.js", () => ({
  humanType: vi.fn().mockResolvedValue(undefined),
  randomDelay: vi.fn().mockResolvedValue(undefined),
  realisticClick: vi.fn().mockResolvedValue(undefined),
  randomMouseMovement: vi.fn().mockResolvedValue(undefined),
  randomInt: vi.fn().mockReturnValue(500),
  randomFloat: vi.fn().mockReturnValue(1.0),
}));

vi.mock("../src/utils/page-utils.js", () => ({
  waitForLatestAnswer: vi.fn().mockResolvedValue("mock answer"),
  snapshotAllResponses: vi.fn().mockResolvedValue([]),
  snapshotLatestResponse: vi.fn().mockResolvedValue(null),
  countResponseElements: vi.fn().mockResolvedValue(0),
}));

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-browsersession-test-"));
  return { TMP_ROOT: root };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  const cfg = {
    ...actual.CONFIG,
    dataDir: TMP_ROOT,
    configDir: TMP_ROOT,
    browserStateDir: TMP_ROOT + "/browser_state",
    chromeProfileDir: TMP_ROOT + "/chrome_profile",
    autoLoginEnabled: false,
    headless: true,
  };
  return {
    ...actual,
    CONFIG: cfg,
    getConfig: () => cfg,
    getSecureLoginPassword: vi.fn().mockReturnValue(null),
  };
});

vi.mock("../src/utils/crypto.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/crypto.js")>("../src/utils/crypto.js");
  return {
    ...actual,
    getSecureStorage: () => ({
      exists: vi.fn().mockReturnValue(false),
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ postQuantumEnabled: false }),
    }),
  };
});

vi.mock("../src/utils/file-lock.js", () => ({
  withLock: vi.fn(async (_path: string, fn: () => Promise<void>) => fn()),
  isLocked: vi.fn().mockReturnValue(false),
}));

import { BrowserSession } from "../src/session/browser-session.js";
import { SharedContextManager } from "../src/session/shared-context-manager.js";
import { AuthManager } from "../src/auth/auth-manager.js";

/**
 * Create a minimal stub SharedContextManager — we don't call getOrCreateContext
 * in these unit tests (no init()), so the stub never needs to return anything real.
 */
function makeStubContextManager(): SharedContextManager {
  return {
    getOrCreateContext: vi.fn().mockResolvedValue({}),
    closeContext: vi.fn().mockResolvedValue(undefined),
    getContextInfo: vi.fn().mockReturnValue({ exists: false, user_data_dir: "/tmp", persistent: true }),
    needsHeadlessModeChange: vi.fn().mockReturnValue(false),
    getCurrentHeadlessMode: vi.fn().mockReturnValue(null),
  } as unknown as SharedContextManager;
}

/**
 * Create a minimal stub AuthManager.
 */
function makeStubAuthManager(): AuthManager {
  return {
    validateWithRetry: vi.fn().mockResolvedValue(true),
    validateCookiesExpiry: vi.fn().mockResolvedValue(true),
    loadSessionStorage: vi.fn().mockResolvedValue(null),
    loadAuthState: vi.fn().mockResolvedValue(undefined),
    getValidStatePath: vi.fn().mockResolvedValue(null),
    loginWithCredentials: vi.fn().mockResolvedValue(false),
    clearAllAuthData: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthManager;
}

const NOTEBOOK_URL = "https://notebooklm.google.com/notebook/test-abc123";

describe("BrowserSession", () => {
  let ctxMgr: SharedContextManager;
  let authMgr: AuthManager;

  beforeEach(() => {
    ctxMgr = makeStubContextManager();
    authMgr = makeStubAuthManager();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Constructor / identity
  // =========================================================================

  describe("sessionId", () => {
    it("returns the id passed to the constructor", () => {
      const session = new BrowserSession("sess-001", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.sessionId).toBe("sess-001");
    });

    it("is a non-empty string", () => {
      const session = new BrowserSession("my-session-id", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);
    });
  });

  describe("notebookUrl", () => {
    it("returns the notebook URL passed to the constructor", () => {
      const session = new BrowserSession("s1", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.notebookUrl).toBe(NOTEBOOK_URL);
    });
  });

  // =========================================================================
  // isInitialized()
  // =========================================================================

  describe("isInitialized()", () => {
    it("returns false before init() is called", () => {
      const session = new BrowserSession("s2", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.isInitialized()).toBe(false);
    });
  });

  // =========================================================================
  // isExpired()
  // =========================================================================

  describe("isExpired()", () => {
    it("returns false for a freshly created session", () => {
      const session = new BrowserSession("s3", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.isExpired(3600)).toBe(false);
    });

    it("returns true when inactive longer than timeoutSeconds", () => {
      const session = new BrowserSession("s4", ctxMgr, authMgr, NOTEBOOK_URL);
      // Back-date lastActivity by more than the timeout
      session.lastActivity = Date.now() - 10_000;
      expect(session.isExpired(5)).toBe(true);
    });

    it("returns false when inactive less than timeoutSeconds", () => {
      const session = new BrowserSession("s5", ctxMgr, authMgr, NOTEBOOK_URL);
      session.lastActivity = Date.now() - 1_000;
      expect(session.isExpired(60)).toBe(false);
    });
  });

  // =========================================================================
  // updateActivity()
  // =========================================================================

  describe("updateActivity()", () => {
    it("updates lastActivity to approximately now", () => {
      const session = new BrowserSession("s6", ctxMgr, authMgr, NOTEBOOK_URL);
      session.lastActivity = Date.now() - 60_000; // 1 minute ago
      session.updateActivity();
      expect(Date.now() - session.lastActivity).toBeLessThan(500);
    });
  });

  // =========================================================================
  // getInfo()
  // =========================================================================

  describe("getInfo()", () => {
    it("returns the correct session id", () => {
      const session = new BrowserSession("info-test", ctxMgr, authMgr, NOTEBOOK_URL);
      const info = session.getInfo();
      expect(info.id).toBe("info-test");
    });

    it("returns the correct notebook_url", () => {
      const session = new BrowserSession("s7", ctxMgr, authMgr, NOTEBOOK_URL);
      const info = session.getInfo();
      expect(info.notebook_url).toBe(NOTEBOOK_URL);
    });

    it("reports message_count as 0 initially", () => {
      const session = new BrowserSession("s8", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.getInfo().message_count).toBe(0);
    });

    it("reports age_seconds >= 0", () => {
      const session = new BrowserSession("s9", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.getInfo().age_seconds).toBeGreaterThanOrEqual(0);
    });

    it("reports inactive_seconds >= 0", () => {
      const session = new BrowserSession("s10", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.getInfo().inactive_seconds).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // getPage()
  // =========================================================================

  describe("getPage()", () => {
    it("returns null before init() is called", () => {
      const session = new BrowserSession("s11", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.getPage()).toBeNull();
    });
  });

  // =========================================================================
  // close()
  // =========================================================================

  describe("close()", () => {
    it("sets isInitialized() to false", async () => {
      const session = new BrowserSession("s12", ctxMgr, authMgr, NOTEBOOK_URL);
      // Session starts uninitialized; close() should leave it uninitialized too
      await session.close();
      expect(session.isInitialized()).toBe(false);
    });

    it("sets getPage() to null", async () => {
      const session = new BrowserSession("s13", ctxMgr, authMgr, NOTEBOOK_URL);
      await session.close();
      expect(session.getPage()).toBeNull();
    });

    it("can be called multiple times without throwing", async () => {
      const session = new BrowserSession("s14", ctxMgr, authMgr, NOTEBOOK_URL);
      await expect(session.close()).resolves.toBeUndefined();
      await expect(session.close()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // createdAt / messageCount
  // =========================================================================

  describe("timing fields", () => {
    it("sets createdAt to approximately now", () => {
      const before = Date.now();
      const session = new BrowserSession("s15", ctxMgr, authMgr, NOTEBOOK_URL);
      const after = Date.now();
      expect(session.createdAt).toBeGreaterThanOrEqual(before);
      expect(session.createdAt).toBeLessThanOrEqual(after);
    });

    it("initialises messageCount to 0", () => {
      const session = new BrowserSession("s16", ctxMgr, authMgr, NOTEBOOK_URL);
      expect(session.messageCount).toBe(0);
    });
  });
});
