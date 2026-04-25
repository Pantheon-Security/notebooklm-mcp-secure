import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAudit, mockQuotaManager, mockValidateResponse, mockGetQueryLogger } = vi.hoisted(() => ({
  mockAudit: {
    security: vi.fn().mockResolvedValue(undefined),
    tool: vi.fn().mockResolvedValue(undefined),
  },
  mockQuotaManager: {
    canMakeQuery: vi.fn().mockReturnValue({ allowed: true }),
    getDetailedStatus: vi.fn().mockReturnValue({
      queries: { remaining: 99, used: 1, limit: 100, shouldStop: false },
      tier: "free",
      warnings: [],
    }),
    incrementQueryCountAtomic: vi.fn().mockResolvedValue(undefined),
  },
  mockValidateResponse: vi.fn().mockResolvedValue({
    safe: true,
    sanitized: "",
    blocked: [],
    warnings: [],
  }),
  mockGetQueryLogger: vi.fn().mockReturnValue({
    logQuery: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../src/utils/logger.js", () => ({
  log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/utils/audit-logger.js", () => ({ audit: mockAudit }));
vi.mock("../src/quota/index.js", () => ({ getQuotaManager: () => mockQuotaManager }));
vi.mock("../src/logging/index.js", () => ({ getQueryLogger: mockGetQueryLogger }));
vi.mock("../src/utils/response-validator.js", () => ({ validateResponse: mockValidateResponse }));

import { handleAskQuestion } from "../src/tools/handlers/ask-question.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockAudit.security.mockResolvedValue(undefined);
  mockAudit.tool.mockResolvedValue(undefined);
  mockQuotaManager.canMakeQuery.mockReturnValue({ allowed: true });
  mockQuotaManager.getDetailedStatus.mockReturnValue({
    queries: { remaining: 99, used: 1, limit: 100, shouldStop: false },
    tier: "free",
    warnings: [],
  });
  mockQuotaManager.incrementQueryCountAtomic.mockResolvedValue(undefined);
  mockGetQueryLogger.mockReturnValue({ logQuery: vi.fn().mockResolvedValue(undefined) });
  mockValidateResponse.mockResolvedValue({ safe: true, sanitized: "", blocked: [], warnings: [] });
});

describe("handleAskQuestion", () => {
  it("returns failure without calling sessionManager when rate limit is exceeded", async () => {
    const getOrCreateSession = vi.fn();
    const ctx = {
      rateLimiter: {
        isAllowed: vi.fn().mockReturnValue(false),
        getRemaining: vi.fn().mockReturnValue(0),
      },
      sessionManager: { getOrCreateSession },
      authManager: {},
      library: {},
      getGeminiClient: () => null,
    } as unknown as HandlerContext;

    const result = await handleAskQuestion(ctx, { question: "What is this?" });

    expect(result.success).toBe(false);
    expect(getOrCreateSession).not.toHaveBeenCalled();
  });

  it("returns failure with user-readable error when no active notebook and no URL provided", async () => {
    const ctx = {
      rateLimiter: {
        isAllowed: vi.fn().mockReturnValue(true),
        getRemaining: vi.fn().mockReturnValue(99),
      },
      sessionManager: {
        getOrCreateSession: vi.fn().mockRejectedValue(new Error("No notebook URL specified")),
      },
      authManager: {},
      library: {
        getActiveNotebook: vi.fn().mockReturnValue(null),
        getNotebook: vi.fn().mockReturnValue(null),
      },
      getGeminiClient: () => null,
    } as unknown as HandlerContext;

    const result = await handleAskQuestion(ctx, { question: "What is this?" });

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("calls session.ask and returns success when question is sent via notebook_url", async () => {
    const ask = vi.fn().mockResolvedValue("Test answer");
    const mockSession = {
      ask,
      getInfo: vi.fn().mockReturnValue({ age_seconds: 5, message_count: 1, last_activity: Date.now() }),
      sessionId: "sess-1",
      notebookUrl: "https://notebooklm.google.com/notebook/abc123",
    };
    const ctx = {
      rateLimiter: {
        isAllowed: vi.fn().mockReturnValue(true),
        getRemaining: vi.fn().mockReturnValue(99),
      },
      sessionManager: {
        getOrCreateSession: vi.fn().mockResolvedValue(mockSession),
      },
      authManager: {},
      library: {
        getNotebook: vi.fn().mockReturnValue(null),
      },
      getGeminiClient: () => null,
    } as unknown as HandlerContext;

    const result = await handleAskQuestion(ctx, {
      question: "What is this?",
      notebook_url: "https://notebooklm.google.com/notebook/abc123",
    });

    expect(result.success).toBe(true);
    expect(ask).toHaveBeenCalledWith("What is this?", undefined);
    expect(result.data?.answer).toMatch(/^Test answer/);
  });
});
