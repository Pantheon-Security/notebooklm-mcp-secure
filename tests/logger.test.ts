import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, log } from "../src/utils/logger.js";

describe("logger", () => {
  afterEach(() => {
    delete process.env.NLMCP_LOG_FORMAT;
    vi.restoreAllMocks();
  });

  it("emits structured JSON logs with active correlation context", () => {
    process.env.NLMCP_LOG_FORMAT = "json";
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    log.withContext({ correlation_id: "req-123", tool: "ask_question" }, () => {
      log.info("hello");
    });

    expect(stderr).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(stderr.mock.calls[0][0])) as {
      level: string;
      message: string;
      correlation_id: string;
      tool: string;
      ts: string;
    };
    expect(entry).toMatchObject({
      level: "info",
      message: "hello",
      correlation_id: "req-123",
      tool: "ask_question",
    });
    expect(entry.ts).toEqual(expect.any(String));
  });

  it("keeps human-readable logging as the default", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.info("plain");

    expect(String(stderr.mock.calls[0][0])).toContain("plain");
    expect(() => JSON.parse(String(stderr.mock.calls[0][0]))).toThrow();
  });
});
