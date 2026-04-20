import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-compliance-logger-test-")),
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

import {
  ComplianceLogger,
  getComplianceLogger,
} from "../src/compliance/compliance-logger.js";

function resetComplianceLogger(): ComplianceLogger {
  (ComplianceLogger as unknown as { instance?: ComplianceLogger }).instance = undefined;
  return getComplianceLogger();
}

function complianceDir(): string {
  return path.join(TMP_ROOT, "compliance");
}

function currentLogFile(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return path.join(complianceDir(), `events-${year}-${month}.jsonl`);
}

describe("ComplianceLogger", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    // Ensure compliance logging is enabled and not redirected by env
    delete process.env.NLMCP_COMPLIANCE_ENABLED;
    delete process.env.NLMCP_COMPLIANCE_DIR;
    vi.clearAllMocks();
    resetComplianceLogger();
  });

  afterEach(() => {
    resetComplianceLogger();
  });

  it("logConsent writes a consent event to disk", async () => {
    const logger = getComplianceLogger();
    const event = await logger.logConsent(
      "granted",
      { type: "user" },
      ["usage_analytics"],
      true,
      { consent_id: "c123" }
    );

    expect(event.id).toEqual(expect.any(String));
    expect(event.category).toBe("consent");
    expect(event.event_type).toBe("consent_granted");
    expect(event.outcome).toBe("success");
    expect(event.hash).toEqual(expect.any(String));
    expect(event.hash.length).toBe(64);

    // Verify on disk
    const logFile = currentLogFile();
    expect(fs.existsSync(logFile)).toBe(true);
    const line = fs.readFileSync(logFile, "utf-8").trim();
    const parsed = JSON.parse(line) as typeof event;
    expect(parsed.id).toBe(event.id);
    expect(parsed.category).toBe("consent");
  });

  it("logDataDeletion writes a data deletion event to disk", async () => {
    const logger = getComplianceLogger();
    const event = await logger.logDataDeletion(
      { type: "user" },
      "notebook_metadata",
      5,
      true,
      { request_id: "req-42" }
    );

    expect(event.category).toBe("data_deletion");
    expect(event.event_type).toBe("erasure_completed");
    expect(event.outcome).toBe("success");
    expect(event.details?.items_deleted).toBe(5);

    const logFile = currentLogFile();
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as typeof event;
    expect(parsed.event_type).toBe("erasure_completed");
  });

  it("getEvents reads back all written events from disk", async () => {
    const logger = getComplianceLogger();

    await logger.logConsent("granted", { type: "user" }, ["analytics"], true);
    await logger.logDataDeletion({ type: "system" }, "audit_logs", 10, true);
    await logger.logSecurityIncident("unauthorized_access", "medium", { ip: "10.0.0.1" });

    const all = await logger.getEvents();
    expect(all.length).toBeGreaterThanOrEqual(3);

    const consentEvents = await logger.getEvents("consent");
    expect(consentEvents).toHaveLength(1);
    expect(consentEvents[0]?.category).toBe("consent");

    const deletionEvents = await logger.getEvents("data_deletion");
    expect(deletionEvents).toHaveLength(1);
    expect(deletionEvents[0]?.event_type).toBe("erasure_completed");
  });

  it("verifyIntegrity returns valid=true for an unmodified log", async () => {
    const logger = getComplianceLogger();
    await logger.logConsent("granted", { type: "user" }, ["analytics"], true);
    await logger.logDataDeletion({ type: "system" }, "audit_logs", 3, true);

    const result = await logger.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.totalEvents).toBe(2);
    expect(result.validEvents).toBe(2);
    expect(result.firstInvalidEvent).toBeUndefined();
  });

  it("verifyIntegrity returns valid=false for a tampered log", async () => {
    const logger = getComplianceLogger();
    await logger.logConsent("granted", { type: "user" }, ["analytics"], true);
    await logger.logConsent("revoked", { type: "user" }, ["analytics"], true);

    const logFile = currentLogFile();
    const original = fs.readFileSync(logFile, "utf-8");

    // Tamper with the first line by modifying the event_type field
    const lines = original.trim().split("\n");
    const firstLine = lines[0]!;
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    parsed["event_type"] = "TAMPERED";
    lines[0] = JSON.stringify(parsed);
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    // Reset singleton so it reloads from tampered file
    resetComplianceLogger();
    const freshLogger = getComplianceLogger();
    const result = await freshLogger.verifyIntegrity();

    expect(result.valid).toBe(false);
    expect(result.totalEvents).toBe(2);
    expect(result.validEvents).toBeLessThan(result.totalEvents);
  });

  it("getEvents respects date range filters", async () => {
    const logger = getComplianceLogger();
    await logger.logPolicyChange("setting", "old", "new", "user");

    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);

    const past = new Date();
    past.setFullYear(past.getFullYear() - 1);

    // From future: should return nothing
    const noResults = await logger.getEvents(undefined, future);
    expect(noResults).toHaveLength(0);

    // Up to past: should return nothing
    const alsoNone = await logger.getEvents(undefined, undefined, past);
    expect(alsoNone).toHaveLength(0);

    // Full range: should return the event
    const results = await logger.getEvents(undefined, past, future);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("getStats returns accurate counts per category", async () => {
    const logger = getComplianceLogger();
    await logger.logConsent("granted", { type: "user" }, ["analytics"], true);
    await logger.logConsent("revoked", { type: "user" }, ["analytics"], true);
    await logger.logDataDeletion({ type: "system" }, "session_data", 2, true);

    const stats = await logger.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.totalEvents).toBe(3);
    expect(stats.eventsByCategory.consent).toBe(2);
    expect(stats.eventsByCategory.data_deletion).toBe(1);
    expect(stats.logFileCount).toBeGreaterThanOrEqual(1);
  });

  it("hash-chain: each event links to the previous event's hash", async () => {
    const logger = getComplianceLogger();
    const e1 = await logger.logConsent("granted", { type: "user" }, ["analytics"], true);
    const e2 = await logger.logConsent("revoked", { type: "user" }, ["analytics"], true);

    // Genesis event has previous_hash of all zeros
    expect(e1.previous_hash).toBe("0".repeat(64));
    // Second event's previous_hash must equal first event's hash
    expect(e2.previous_hash).toBe(e1.hash);
  });
});
