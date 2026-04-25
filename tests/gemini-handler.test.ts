import { describe, expect, it, vi } from "vitest";
import { handleDeepResearch, handleDeleteDocument } from "../src/tools/handlers/gemini.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";

vi.mock("../src/utils/audit-logger.js", () => ({
  audit: {
    tool: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("Gemini handlers", () => {
  describe("handleDeleteDocument (I331)", () => {
    const ctx = {} as HandlerContext;

    it("rejects calls without confirm: true", async () => {
      const result = await handleDeleteDocument(ctx, { file_name: "test.pdf", confirm: false });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/confirm/i);
    });

    it("rejects calls with confirm omitted (undefined cast)", async () => {
      const result = await handleDeleteDocument(ctx, { file_name: "test.pdf", confirm: undefined as unknown as boolean });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/confirm/i);
    });
  });

  it("forwards deep_research thinking_level to GeminiClient", async () => {
    const deepResearch = vi.fn().mockResolvedValue({
      id: "research-1",
      status: "completed",
      outputs: [{ type: "text", text: "answer" }],
      usage: { totalTokens: 42 },
    });

    const ctx = {
      getGeminiClient: () => ({ deepResearch }),
    } as unknown as HandlerContext;

    const result = await handleDeepResearch(ctx, {
      query: "research topic",
      thinking_level: "high",
      wait_for_completion: false,
      max_wait_seconds: 30,
    });

    expect(result.success).toBe(true);
    expect(deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "research topic",
        thinkingLevel: "high",
        waitForCompletion: false,
        maxWaitMs: 30_000,
      }),
    );
  });
});
