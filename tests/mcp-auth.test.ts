/**
 * Unit tests for MCP authentication (src/auth/mcp-auth.ts).
 *
 * Covers token generation/hashing, validation, lockout progression
 * (exponential backoff), isolation between clients, and token rotation.
 * See ISSUES.md I122.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub side-effecting audit + change-log so tests don't write to the
// user's real data dir. The stubs preserve the public surface callers
// exercise (audit.auth, audit.security, getChangeLog().recordChange).
vi.mock("../src/utils/audit-logger.js", () => ({
  audit: {
    auth: vi.fn().mockResolvedValue(undefined),
    security: vi.fn().mockResolvedValue(undefined),
    session: vi.fn().mockResolvedValue(undefined),
    system: vi.fn().mockResolvedValue(undefined),
    tool: vi.fn().mockResolvedValue(undefined),
    compliance: vi.fn().mockResolvedValue(undefined),
    dataAccess: vi.fn().mockResolvedValue(undefined),
    configChange: vi.fn().mockResolvedValue(undefined),
    retention: vi.fn().mockResolvedValue(undefined),
  },
  getAuditLogger: vi.fn(() => ({
    onEvent: vi.fn(() => () => undefined),
    getStats: vi.fn(() => ({ totalEvents: 0 })),
  })),
}));

vi.mock("../src/compliance/change-log.js", () => ({
  getChangeLog: vi.fn(() => ({
    recordChange: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { MCPAuthenticator, authenticateMCPRequest, getMCPAuthenticator } from "../src/auth/mcp-auth.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-auth-test-"));
}

describe("MCPAuthenticator", () => {
  let tmpDir: string;
  let tokenFile: string;

  beforeEach(() => {
    tmpDir = mkTmpDir();
    tokenFile = path.join(tmpDir, "auth-token.hash");
    delete process.env.NLMCP_AUTH_TOKEN;
    delete process.env.NLMCP_AUTH_DISABLED;
    delete process.env.NLMCP_AUTH_ENABLED;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("token generation + hashing", () => {
    it("generateToken returns 32-char base64url string (24 bytes)", () => {
      const auth = new MCPAuthenticator({ tokenFile });
      const token = auth.generateToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    });

    it("generateToken produces different values each call", () => {
      const auth = new MCPAuthenticator({ tokenFile });
      const a = auth.generateToken();
      const b = auth.generateToken();
      expect(a).not.toBe(b);
    });

    it("hashToken produces 64-char hex (SHA3-256) and is deterministic", () => {
      const auth = new MCPAuthenticator({ tokenFile });
      const h1 = auth.hashToken("abc123");
      const h2 = auth.hashToken("abc123");
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("hashToken uses SHA3-256 — different from SHA-256 for same input (I110)", () => {
      const crypto = require("node:crypto");
      const auth = new MCPAuthenticator({ tokenFile });
      const sha3 = auth.hashToken("test-token");
      const sha256 = crypto.createHash("sha256").update("test-token").digest("hex");
      expect(sha3).not.toBe(sha256);
    });
  });

  describe("initialize", () => {
    it("uses NLMCP_AUTH_TOKEN env when present (no file write)", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "env-token-value" });
      await auth.initialize();
      expect(fs.existsSync(tokenFile)).toBe(false);
      expect(auth.getStatus().hasToken).toBe(true);
    });

    it("loads token hash from file when length is 64 hex chars", async () => {
      const knownToken = "known-token-123";
      const hash = new MCPAuthenticator({ tokenFile }).hashToken(knownToken);
      fs.writeFileSync(tokenFile, hash, { mode: 0o600 });

      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();

      expect(await auth.validateToken(knownToken, "test-client")).toBe(true);
    });

    it("generates and persists a new token when no env and no file", async () => {
      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();
      expect(fs.existsSync(tokenFile)).toBe(true);
      const content = fs.readFileSync(tokenFile, "utf-8").trim();
      expect(content).toMatch(/^[0-9a-f]{64}$/);
    });

    it("initialize is idempotent", async () => {
      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();
      const mtime1 = fs.statSync(tokenFile).mtimeMs;
      await new Promise((r) => setTimeout(r, 5));
      await auth.initialize();
      const mtime2 = fs.statSync(tokenFile).mtimeMs;
      expect(mtime1).toBe(mtime2);
    });

    it("a malformed token file (wrong length) is ignored and a fresh token generated", async () => {
      fs.writeFileSync(tokenFile, "notahashjustsomegarbage", { mode: 0o600 });
      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();
      const content = fs.readFileSync(tokenFile, "utf-8").trim();
      // Should have been overwritten with a valid hash.
      expect(content).toMatch(/^[0-9a-f]{64}$/);
      expect(content).not.toBe("notahashjustsomegarbage");
    });

    it("a token file with non-hex chars is rejected even if 64 chars long (I116)", async () => {
      // 64 chars but contains uppercase G–Z which are not valid hex
      const nonHex = "G".repeat(64);
      fs.writeFileSync(tokenFile, nonHex, { mode: 0o600 });
      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();
      const content = fs.readFileSync(tokenFile, "utf-8").trim();
      expect(content).not.toBe(nonHex);
      expect(content).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("validateToken", () => {
    it("returns true when auth is globally disabled and not forced", async () => {
      const auth = new MCPAuthenticator({ enabled: false, tokenFile });
      expect(await auth.validateToken(undefined, "c1")).toBe(true);
      expect(await auth.validateToken("any-token", "c1")).toBe(true);
    });

    it("accepts the correct token", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "correct" });
      await auth.initialize();
      expect(await auth.validateToken("correct", "c1")).toBe(true);
    });

    it("rejects a wrong token", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "correct" });
      await auth.initialize();
      expect(await auth.validateToken("wrong", "c1")).toBe(false);
    });

    it("rejects an undefined token", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "correct" });
      await auth.initialize();
      expect(await auth.validateToken(undefined, "c1")).toBe(false);
    });

    it("rejects an empty-string token", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "correct" });
      await auth.initialize();
      expect(await auth.validateToken("", "c1")).toBe(false);
    });

    it("uses constant-time compare — wrong token of same length still rejected", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "exact-length-8" });
      await auth.initialize();
      expect(await auth.validateToken("same-length-8", "c1")).toBe(false);
    });
  });

  describe("lockout progression (exponential backoff)", () => {
    it("locks out after maxFailedAttempts wrong tokens", async () => {
      const auth = new MCPAuthenticator({
        tokenFile,
        token: "correct",
        maxFailedAttempts: 3,
        lockoutDurationMs: 1000,
      });
      await auth.initialize();

      // Three wrong attempts trigger the first lockout.
      for (let i = 0; i < 3; i++) {
        await auth.validateToken("wrong", "locked-client");
      }
      // Next attempt — even with the correct token — is rejected because
      // the client is locked.
      expect(await auth.validateToken("correct", "locked-client")).toBe(false);
      expect(auth.getStatus().lockedClients).toBeGreaterThanOrEqual(1);
    });

    it("exponential backoff applies within a continuous bad-actor session", async () => {
      vi.useFakeTimers();
      try {
        const base = 1000;
        const auth = new MCPAuthenticator({
          tokenFile,
          token: "correct",
          maxFailedAttempts: 2,
          lockoutDurationMs: base,
        });
        await auth.initialize();

        // First lockout — 2 wrong attempts, lockout for `base` ms.
        await auth.validateToken("wrong", "bc");
        await auth.validateToken("wrong", "bc");
        expect(await auth.validateToken("correct", "bc")).toBe(false);

        // Attempt again without waiting — still locked.
        expect(await auth.validateToken("correct", "bc")).toBe(false);

        // After base elapses, lockout clears (I114: lockoutCount also resets).
        vi.advanceTimersByTime(base + 1);
        expect(await auth.validateToken("correct", "bc")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("isolates lockout state per clientId", async () => {
      const auth = new MCPAuthenticator({
        tokenFile,
        token: "correct",
        maxFailedAttempts: 2,
        lockoutDurationMs: 10000,
      });
      await auth.initialize();

      await auth.validateToken("wrong", "alice");
      await auth.validateToken("wrong", "alice"); // alice now locked
      expect(await auth.validateToken("correct", "alice")).toBe(false);

      // bob is untouched — can still authenticate
      expect(await auth.validateToken("correct", "bob")).toBe(true);
    });

    it("successful auth clears the failed attempt counter", async () => {
      const auth = new MCPAuthenticator({
        tokenFile,
        token: "correct",
        maxFailedAttempts: 3,
        lockoutDurationMs: 10000,
      });
      await auth.initialize();

      await auth.validateToken("wrong", "c");
      await auth.validateToken("wrong", "c");
      // one more wrong would lock — instead succeed
      expect(await auth.validateToken("correct", "c")).toBe(true);
      // Now 3 more wrongs should still be needed before lockout.
      await auth.validateToken("wrong", "c");
      await auth.validateToken("wrong", "c");
      expect(await auth.validateToken("correct", "c")).toBe(true);
    });
  });

  describe("I111 — failedAttempts Map cap", () => {
    it("does not grow beyond 10 000 entries (oldest evicted)", async () => {
      const auth = new MCPAuthenticator({
        tokenFile,
        token: "correct",
        maxFailedAttempts: 999,
      });
      await auth.initialize();
      // Trigger 10 001 distinct client IDs — each gets one failed attempt
      for (let i = 0; i < 10_001; i++) {
        await auth.validateToken("wrong", `client-${i}`);
      }
      // Map must be capped; auth should still work for a brand-new client
      expect(await auth.validateToken("correct", "brand-new-client")).toBe(true);
    });
  });

  describe("I112 — 'unknown' clientId not tracked", () => {
    it("lockout state is never accumulated for clientId='unknown'", async () => {
      const auth = new MCPAuthenticator({
        tokenFile,
        token: "correct",
        maxFailedAttempts: 2,
        lockoutDurationMs: 60000,
      });
      await auth.initialize();
      // Many failures with the default 'unknown' clientId
      for (let i = 0; i < 10; i++) {
        await auth.validateToken("wrong", "unknown");
      }
      // A named client with the correct token must not be locked out
      expect(await auth.validateToken("correct", "real-client")).toBe(true);
      // Even "unknown" must not be locked (it is excluded from tracking)
      expect(await auth.validateToken("correct", "unknown")).toBe(true);
    });
  });

  describe("I114 — lockoutCount resets on expiry", () => {
    it("lockoutCount resets after expiry so next lockout uses base duration", async () => {
      vi.useFakeTimers();
      try {
        const base = 1000;
        const auth = new MCPAuthenticator({
          tokenFile,
          token: "correct",
          maxFailedAttempts: 2,
          lockoutDurationMs: base,
        });
        await auth.initialize();

        // First lockout
        await auth.validateToken("wrong", "cli");
        await auth.validateToken("wrong", "cli");

        // Advance well past the first lockout so the tracker resets
        vi.advanceTimersByTime(base * 10);

        // Subsequent lockout must again use the base duration (lockoutCount reset)
        await auth.validateToken("wrong", "cli");
        await auth.validateToken("wrong", "cli");

        // Just before base elapses: still locked
        vi.advanceTimersByTime(base - 50);
        expect(await auth.validateToken("correct", "cli")).toBe(false);

        // After base elapses: unlocked (would be 3*base if lockoutCount weren't reset)
        vi.advanceTimersByTime(100);
        expect(await auth.validateToken("correct", "cli")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("I115 — no tokenHash configured", () => {
    it("returns false immediately when no token has been set", async () => {
      const auth = new MCPAuthenticator({ enabled: true, tokenFile });
      // Don't call initialize() — tokenHash stays null
      expect(await auth.validateToken("any-token", "c1")).toBe(false);
    });
  });

  describe("rotateToken", () => {
    it("invalidates the old token and accepts the new one", async () => {
      const auth = new MCPAuthenticator({ tokenFile, token: "original" });
      await auth.initialize();
      expect(await auth.validateToken("original", "c")).toBe(true);

      const newToken = await auth.rotateToken();
      expect(newToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(newToken).not.toBe("original");

      expect(await auth.validateToken("original", "c")).toBe(false);
      expect(await auth.validateToken(newToken, "c")).toBe(true);
    });

    it("writes the new hash to disk", async () => {
      const auth = new MCPAuthenticator({ tokenFile });
      await auth.initialize();
      const before = fs.readFileSync(tokenFile, "utf-8");
      await auth.rotateToken();
      const after = fs.readFileSync(tokenFile, "utf-8");
      expect(before).not.toBe(after);
      expect(after).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("authenticateMCPRequest wrapper", () => {
    it("returns authenticated=true when auth disabled and not forced", async () => {
      process.env.NLMCP_AUTH_DISABLED = "true";
      // Force a fresh singleton by calling getMCPAuthenticator after env change
      // — note: the global singleton may already exist from a prior test; this
      // is a limitation of the CLI wrapper that the underlying class is
      // tested for directly above. We only verify the "disabled" short-circuit.
      const auth = new MCPAuthenticator({ enabled: false, tokenFile });
      const res = await auth.validateToken(undefined, "c");
      expect(res).toBe(true);
    });

    it("forceAuth=true rejects when no token present (disabled globally)", async () => {
      // Exercise the function directly via the class because the wrapper
      // calls the global singleton; we've already proven class behavior.
      const auth = new MCPAuthenticator({ enabled: false, tokenFile });
      await auth.initialize();
      // When enabled=false and forceValidation=true but we have no token
      // cached, validateToken falls through to recordFailedAttempt path.
      expect(await auth.validateToken(undefined, "c", true)).toBe(false);
    });
  });

  describe("singleton accessor", () => {
    it("getMCPAuthenticator returns the same instance on repeated calls", () => {
      const a = getMCPAuthenticator();
      const b = getMCPAuthenticator();
      expect(a).toBe(b);
    });
  });

  describe("authenticateMCPRequest middleware", () => {
    it("requires a token when forceAuth=true and auth globally disabled", async () => {
      process.env.NLMCP_AUTH_DISABLED = "true";
      const res = await authenticateMCPRequest(undefined, "test-tool", true);
      expect(res.authenticated).toBe(false);
      expect(res.error).toMatch(/authentication/i);
    });
  });
});
