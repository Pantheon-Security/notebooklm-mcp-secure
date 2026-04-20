/**
 * Unit tests for SharedContextManager (src/session/shared-context-manager.ts).
 *
 * Scope: getOrCreateContext() re-use behaviour, closeContext(), and
 * getContextInfo() / needsHeadlessModeChange() / getCurrentHeadlessMode().
 *
 * chromium.launchPersistentContext is mocked so no real browser is started.
 *
 * See ISSUES.md I128.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BrowserContext } from "patchright";

// -------------------------------------------------------------------------
// Helpers lifted before vi.mock factories so they can be referenced inside.
// -------------------------------------------------------------------------
const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-sharedctx-test-"));
  return { TMP_ROOT: root };
});

// -------------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------------

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

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  const cfg = {
    ...actual.CONFIG,
    dataDir: TMP_ROOT,
    configDir: TMP_ROOT,
    chromeProfileDir: TMP_ROOT + "/chrome_profile",
    chromeInstancesDir: TMP_ROOT + "/chrome_instances",
    browserStateDir: TMP_ROOT + "/browser_state",
    headless: true,
    profileStrategy: "single" as const,
    cleanupInstancesOnStartup: false,
    cleanupInstancesOnShutdown: false,
    cloneProfileOnIsolated: false,
    instanceProfileTtlHours: 1,
    instanceProfileMaxCount: 3,
  };
  return {
    ...actual,
    CONFIG: cfg,
    getConfig: () => cfg,
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

vi.mock("../src/utils/file-permissions.js", () => ({
  mkdirSecure: vi.fn(),
  appendFileSecure: vi.fn(),
  PERMISSION_MODES: { OWNER_FULL: 0o700, OWNER_READ_WRITE: 0o600 },
}));

// ---------------------------------------------------------------------------
// The BrowserContext stub returned by launchPersistentContext.
// ---------------------------------------------------------------------------
function makeMockContext(cookiesResult: unknown = []): BrowserContext {
  const ctx = {
    cookies: vi.fn().mockResolvedValue(cookiesResult),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    _guid: "mock-guid-" + Math.random().toString(36).slice(2),
  } as unknown as BrowserContext;
  return ctx;
}

// Mock patchright — must come before the module import.
let mockContext: BrowserContext;

vi.mock("patchright", () => {
  return {
    chromium: {
      launchPersistentContext: vi.fn(async () => {
        mockContext = makeMockContext();
        return mockContext;
      }),
    },
  };
});

import { SharedContextManager } from "../src/session/shared-context-manager.js";
import { AuthManager } from "../src/auth/auth-manager.js";

// ---------------------------------------------------------------------------
// Stub AuthManager
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SharedContextManager", () => {
  let authMgr: AuthManager;
  let chromiumMock: { launchPersistentContext: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    authMgr = makeStubAuthManager();
    // Re-import patchright mock to get access to the spy
    const { chromium } = await import("patchright");
    chromiumMock = chromium as unknown as typeof chromiumMock;
    vi.clearAllMocks();
    // Reset mockContext for each test
    mockContext = makeMockContext();
    chromiumMock.launchPersistentContext.mockResolvedValue(mockContext);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // getOrCreateContext() — basic creation
  // =========================================================================

  describe("getOrCreateContext()", () => {
    it("launches a persistent context on first call", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      expect(chromiumMock.launchPersistentContext).toHaveBeenCalledTimes(1);
    });

    it("returns the same context object on a repeat call", async () => {
      const mgr = new SharedContextManager(authMgr);
      const ctx1 = await mgr.getOrCreateContext();
      const ctx2 = await mgr.getOrCreateContext();
      // Same reference — context was reused, not recreated
      expect(ctx1).toBe(ctx2);
      // launchPersistentContext should have been called only once
      expect(chromiumMock.launchPersistentContext).toHaveBeenCalledTimes(1);
    });

    it("recreates the context after close", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      await mgr.closeContext();

      // Create a fresh mock context for the second launch
      const ctx2 = makeMockContext();
      chromiumMock.launchPersistentContext.mockResolvedValueOnce(ctx2);

      const result = await mgr.getOrCreateContext();
      expect(result).toBe(ctx2);
      expect(chromiumMock.launchPersistentContext).toHaveBeenCalledTimes(2);
    });

    it("recreates the context when cookies() throws (context closed externally)", async () => {
      const mgr = new SharedContextManager(authMgr);
      const firstCtx = await mgr.getOrCreateContext();

      // Simulate external close — cookies() now throws
      (firstCtx.cookies as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Browser has been closed")
      );

      const freshCtx = makeMockContext();
      chromiumMock.launchPersistentContext.mockResolvedValueOnce(freshCtx);

      const result = await mgr.getOrCreateContext();
      expect(result).toBe(freshCtx);
      expect(chromiumMock.launchPersistentContext).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // closeContext()
  // =========================================================================

  describe("closeContext()", () => {
    it("calls context.close()", async () => {
      const mgr = new SharedContextManager(authMgr);
      const ctx = await mgr.getOrCreateContext();
      await mgr.closeContext();
      expect((ctx as any).close).toHaveBeenCalledTimes(1);
    });

    it("makes getContextInfo() report exists=false", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      await mgr.closeContext();
      expect(mgr.getContextInfo().exists).toBe(false);
    });

    it("is safe to call when no context exists", async () => {
      const mgr = new SharedContextManager(authMgr);
      await expect(mgr.closeContext()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // getContextInfo()
  // =========================================================================

  describe("getContextInfo()", () => {
    it("reports exists=false when no context has been created", () => {
      const mgr = new SharedContextManager(authMgr);
      const info = mgr.getContextInfo();
      expect(info.exists).toBe(false);
      expect(info.persistent).toBe(true);
    });

    it("reports exists=true after getOrCreateContext()", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      expect(mgr.getContextInfo().exists).toBe(true);
    });

    it("reports age_seconds >= 0 after context creation", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      const info = mgr.getContextInfo();
      expect(info.age_seconds).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // needsHeadlessModeChange() / getCurrentHeadlessMode()
  // =========================================================================

  describe("needsHeadlessModeChange()", () => {
    it("returns false when no context exists (no mode set yet)", () => {
      const mgr = new SharedContextManager(authMgr);
      expect(mgr.needsHeadlessModeChange(undefined)).toBe(false);
    });

    it("returns false when current mode matches the requested mode", async () => {
      const mgr = new SharedContextManager(authMgr);
      // headless=true in mocked CONFIG; overrideHeadless=false means SHOW browser = headless false
      // We don't pass an override, so it uses CONFIG.headless (true)
      await mgr.getOrCreateContext(); // headless=true
      expect(mgr.getCurrentHeadlessMode()).toBe(true);
      expect(mgr.needsHeadlessModeChange(undefined)).toBe(false);
    });

    it("returns true when override would change the headless mode", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext(); // headless=true from CONFIG
      // overrideHeadless=true means "show browser" = headless false → different from current true
      expect(mgr.needsHeadlessModeChange(true)).toBe(true);
    });
  });

  describe("getCurrentHeadlessMode()", () => {
    it("returns null before any context is created", () => {
      const mgr = new SharedContextManager(authMgr);
      expect(mgr.getCurrentHeadlessMode()).toBeNull();
    });

    it("returns a boolean after a context is created", async () => {
      const mgr = new SharedContextManager(authMgr);
      await mgr.getOrCreateContext();
      const mode = mgr.getCurrentHeadlessMode();
      expect(typeof mode).toBe("boolean");
    });
  });
});
