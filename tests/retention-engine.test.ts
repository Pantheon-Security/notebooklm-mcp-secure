import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-retention-engine-test-")),
  };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
    getConfig: () => ({ ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT }),
  };
});

const complianceLogger = vi.hoisted(() => ({
  logRetention: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

const auditLogger = vi.hoisted(() => ({
  logRetentionEvent: vi.fn(async () => undefined),
}));

vi.mock("../src/utils/audit-logger.js", () => ({
  getAuditLogger: () => auditLogger,
}));

import { RetentionEngine, getRetentionEngine } from "../src/compliance/retention-engine.js";

function resetRetentionEngine(): RetentionEngine {
  (RetentionEngine as unknown as { instance?: RetentionEngine }).instance = undefined;
  return getRetentionEngine();
}

/**
 * Back-date a file's modification time so the retention engine treats it as expired.
 */
function backdateFile(filePath: string, daysAgo: number): void {
  const pastDate = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, pastDate, pastDate);
}

describe("RetentionEngine", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetRetentionEngine();
  });

  afterEach(() => {
    resetRetentionEngine();
  });

  it("addPolicy stores a custom policy", async () => {
    const engine = getRetentionEngine();
    const added = await engine.addPolicy({
      name: "Custom Test Policy",
      data_types: ["session_state"],
      retention_days: 7,
      action: "delete",
      schedule: "daily",
    });

    expect(added.id).toMatch(/^policy_/);
    expect(added.name).toBe("Custom Test Policy");
    expect(added.retention_days).toBe(7);

    // Verify it was persisted to the policies file
    const policiesFile = path.join(TMP_ROOT, "retention-policies.json");
    expect(fs.existsSync(policiesFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(policiesFile, "utf-8")) as {
      policies: Array<{ id: string; name: string }>;
    };
    expect(data.policies.some(p => p.id === added.id)).toBe(true);
  });

  it("getPolicies returns custom policy alongside defaults", async () => {
    const engine = getRetentionEngine();
    const added = await engine.addPolicy({
      name: "Extra Policy",
      data_types: ["error_logs"],
      retention_days: 14,
      action: "delete",
      schedule: "weekly",
    });

    const policies = await engine.getPolicies();
    const ids = policies.map(p => p.id);

    // Custom policy is present
    expect(ids).toContain(added.id);
    // Default policies are also present
    expect(ids).toContain("policy_audit_logs");
    expect(ids).toContain("policy_session");
  });

  it("shouldRun returns true on first run (no last-run file)", async () => {
    const engine = getRetentionEngine();

    // No last-run file exists yet — all policies should run
    const lastRunFile = path.join(TMP_ROOT, "retention-last-run.json");
    expect(fs.existsSync(lastRunFile)).toBe(false);

    // Run due policies — they should all execute (shouldRun === true for all)
    const results = await engine.runDuePolicies();

    // The last-run file should now exist
    expect(fs.existsSync(lastRunFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(lastRunFile, "utf-8")) as {
      runs: Record<string, string>;
    };
    // At minimum the default policy IDs should be recorded
    expect(Object.keys(data.runs)).toContain("policy_audit_logs");
    expect(Object.keys(data.runs)).toContain("policy_session");
  });

  it("runDuePolicies calls recordRun and updates last-run timestamp", async () => {
    const engine = getRetentionEngine();
    const lastRunFile = path.join(TMP_ROOT, "retention-last-run.json");

    const before = Date.now();
    await engine.runDuePolicies();
    const after = Date.now();

    expect(fs.existsSync(lastRunFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(lastRunFile, "utf-8")) as {
      runs: Record<string, string>;
    };

    for (const ts of Object.values(data.runs)) {
      const runTime = new Date(ts).getTime();
      expect(runTime).toBeGreaterThanOrEqual(before);
      expect(runTime).toBeLessThanOrEqual(after);
    }
  });

  it("executes delete action: expired session files are removed", async () => {
    const engine = getRetentionEngine();

    // Create the sessions directory (data location for "session_state")
    const sessionsDir = path.join(TMP_ROOT, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create two old session files (beyond the 14-day policy threshold)
    const file1 = path.join(sessionsDir, "session-old-1.json");
    const file2 = path.join(sessionsDir, "session-old-2.json");
    fs.writeFileSync(file1, JSON.stringify({ id: "s1" }));
    fs.writeFileSync(file2, JSON.stringify({ id: "s2" }));
    backdateFile(file1, 20); // 20 days old — expired
    backdateFile(file2, 20);

    // Create a recent session file (should NOT be deleted)
    const file3 = path.join(sessionsDir, "session-recent.json");
    fs.writeFileSync(file3, JSON.stringify({ id: "s3" }));
    // file3 mtime is current — within retention window

    // Force run only the session policy (retention_days: 14)
    const results = await engine.forceRunPolicy("policy_session");
    expect(results.length).toBeGreaterThan(0);

    const sessionResult = results.find(r => r.data_type === "session_state");
    expect(sessionResult).toBeDefined();
    expect(sessionResult?.action).toBe("delete");
    expect(sessionResult?.items_processed).toBe(2);

    // Expired files deleted
    expect(fs.existsSync(file1)).toBe(false);
    expect(fs.existsSync(file2)).toBe(false);
    // Recent file preserved
    expect(fs.existsSync(file3)).toBe(true);
  });
});
