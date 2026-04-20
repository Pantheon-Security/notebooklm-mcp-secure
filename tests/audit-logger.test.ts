import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/utils/audit-logger.js";

// Spy on logger.warning to verify corruption/chain warnings are emitted.
const loggerWarning = vi.fn();
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    warning: (...args: unknown[]) => loggerWarning(...args),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    log: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  logDir: string,
  overrides: Partial<{
    retentionDays: number;
    hashChainEnabled: boolean;
    includeDetails: boolean;
  }> = {}
) {
  return {
    enabled: true,
    logDir,
    retentionDays: overrides.retentionDays ?? 90,
    includeDetails: overrides.includeDetails ?? true,
    hashChainEnabled: overrides.hashChainEnabled ?? true,
  };
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-audit-test-"));
    loggerWarning.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Basic event write
  // -------------------------------------------------------------------------
  it("writes a JSONL line to the log file after logToolCall", async () => {
    const audit = new AuditLogger(makeConfig(tempDir));

    await audit.logToolCall("test_tool", {}, true, 100);
    await audit.flush();

    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const lines = readLines(path.join(tempDir, files[0]!));
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: "tool",
      eventName: "test_tool",
      success: true,
      duration_ms: 100,
    });
  });

  // -------------------------------------------------------------------------
  // 2. Hash chain — second event's previousHash equals first event's hash
  // -------------------------------------------------------------------------
  it("chains hashes: second event.previousHash === first event.hash", async () => {
    const audit = new AuditLogger(makeConfig(tempDir));

    await audit.logToolCall("tool_one", {}, true, 10);
    await audit.logToolCall("tool_two", {}, true, 20);
    await audit.flush();

    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const lines = readLines(path.join(tempDir, files[0]!));
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as { hash: string; previousHash: string };
    const second = JSON.parse(lines[1]!) as { hash: string; previousHash: string };

    expect(first.previousHash).toBe("GENESIS");
    expect(second.previousHash).toBe(first.hash);
  });

  // -------------------------------------------------------------------------
  // 3. Log rotation / retention — old files deleted, today's file survives
  // -------------------------------------------------------------------------
  it("deletes log files older than retentionDays and keeps current day's file (I302)", () => {
    // Write two old audit files — safely in the past
    const oldFile1 = path.join(tempDir, "audit-2020-01-01.jsonl");
    const oldFile2 = path.join(tempDir, "audit-2020-01-02.jsonl");
    fs.writeFileSync(oldFile1, '{"stub":1}\n');
    fs.writeFileSync(oldFile2, '{"stub":2}\n');

    // Advance time so "today" is well ahead of the 2-day retention window
    const futureDate = new Date("2025-06-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(futureDate);

    // Write a "current day" file that the constructor will recognize as today's
    const todayStr = futureDate.toISOString().split("T")[0]; // "2025-06-15"
    const currentFile = path.join(tempDir, `audit-${todayStr}.jsonl`);
    fs.writeFileSync(currentFile, '{"stub":"today"}\n');

    // Constructing with retentionDays:2 triggers cleanOldLogs in constructor
    const audit = new AuditLogger(makeConfig(tempDir, { retentionDays: 2 }));
    void audit; // suppress unused-variable lint

    const remaining = fs.readdirSync(tempDir).filter((f) => f.endsWith(".jsonl"));
    expect(remaining).not.toContain("audit-2020-01-01.jsonl");
    expect(remaining).not.toContain("audit-2020-01-02.jsonl");
    expect(remaining).toContain(`audit-${todayStr}.jsonl`);
  });

  // -------------------------------------------------------------------------
  // 4. Chain corruption warning — invalid JSON in existing file
  // -------------------------------------------------------------------------
  it("logs a warning when the existing log file contains invalid JSON (corruption)", () => {
    // Create today's log file with invalid JSON as the last line
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(tempDir, `audit-${today}.jsonl`);
    fs.writeFileSync(logFile, "NOT_VALID_JSON\n");

    // Constructing AuditLogger reads the file and detects the parse error
    new AuditLogger(makeConfig(tempDir));

    expect(loggerWarning).toHaveBeenCalledWith(
      expect.stringMatching(/audit log chain corruption detected/)
    );
  });

  // -------------------------------------------------------------------------
  // 5. Hash not truncated — hash field is 64 hex chars (full SHA-256, I223)
  // -------------------------------------------------------------------------
  it("records a full 64-character hex SHA-256 hash on every event (I223)", async () => {
    const audit = new AuditLogger(makeConfig(tempDir));

    await audit.logToolCall("hash_length_check", {}, true, 50);
    await audit.flush();

    const files = fs.readdirSync(tempDir).filter((f) => f.endsWith(".jsonl"));
    const lines = readLines(path.join(tempDir, files[0]!));
    const event = JSON.parse(lines[0]!) as { hash: string };

    expect(event.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
