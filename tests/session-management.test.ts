import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleListSessions,
  handleCloseSession,
  handleResetSession,
  handleGetHealth,
} from "../src/tools/handlers/session-management.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";

vi.mock("../src/utils/logger.js", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const baseStats = {
  active_sessions: 0,
  max_sessions: 5,
  session_timeout: 1800,
  oldest_session_seconds: 0,
  total_messages: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleListSessions", () => {
  it("returns success with zero sessions when pool is empty", async () => {
    const ctx = {
      sessionManager: {
        getStats: vi.fn().mockReturnValue(baseStats),
        getAllSessionsInfo: vi.fn().mockReturnValue([]),
      },
    } as unknown as HandlerContext;

    const result = await handleListSessions(ctx);

    expect(result.success).toBe(true);
    expect(result.data?.active_sessions).toBe(0);
    expect(result.data?.sessions).toHaveLength(0);
  });

  it("returns sessions array with correct shape when sessions exist", async () => {
    const sessionInfo = {
      id: "sess-1",
      created_at: Date.now() - 10_000,
      last_activity: Date.now(),
      age_seconds: 10,
      inactive_seconds: 0,
      message_count: 3,
      notebook_url: "https://notebooklm.google.com/notebook/abc",
    };
    const ctx = {
      sessionManager: {
        getStats: vi.fn().mockReturnValue({ ...baseStats, active_sessions: 1, total_messages: 3 }),
        getAllSessionsInfo: vi.fn().mockReturnValue([sessionInfo]),
      },
    } as unknown as HandlerContext;

    const result = await handleListSessions(ctx);

    expect(result.success).toBe(true);
    expect(result.data?.active_sessions).toBe(1);
    expect(result.data?.sessions).toHaveLength(1);
    const first = result.data?.sessions[0];
    expect(first?.id).toBe("sess-1");
    expect(first?.message_count).toBe(3);
    expect(first?.notebook_url).toBe("https://notebooklm.google.com/notebook/abc");
  });
});

describe("handleCloseSession", () => {
  it("returns success and delegates to sessionManager when session exists", async () => {
    const closeSession = vi.fn().mockResolvedValue(true);
    const ctx = {
      sessionManager: { closeSession },
    } as unknown as HandlerContext;

    const result = await handleCloseSession(ctx, { session_id: "sess-1" });

    expect(result.success).toBe(true);
    expect(closeSession).toHaveBeenCalledWith("sess-1");
  });

  it("returns failure when session is not found", async () => {
    const ctx = {
      sessionManager: {
        closeSession: vi.fn().mockResolvedValue(false),
      },
    } as unknown as HandlerContext;

    const result = await handleCloseSession(ctx, { session_id: "missing-sess" });

    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });
});

describe("handleResetSession", () => {
  it("delegates to session.reset and returns success when session exists", async () => {
    const reset = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      sessionManager: {
        getSession: vi.fn().mockReturnValue({ reset }),
      },
    } as unknown as HandlerContext;

    const result = await handleResetSession(ctx, { session_id: "sess-1" });

    expect(result.success).toBe(true);
    expect(reset).toHaveBeenCalledOnce();
  });
});

describe("handleGetHealth", () => {
  it("returns success with status present (shallow check, unauthenticated)", async () => {
    const ctx = {
      authManager: {
        getValidStatePath: vi.fn().mockResolvedValue(null),
      },
      sessionManager: {
        getStats: vi.fn().mockReturnValue(baseStats),
      },
    } as unknown as HandlerContext;

    const result = await handleGetHealth(ctx, {});

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("ok");
    expect(result.data?.authenticated).toBe(false);
  });
});
