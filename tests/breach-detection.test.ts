import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-breach-detection-test-")) };
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
  logBreach: vi.fn(async () => undefined),
  logSecurityIncident: vi.fn(async () => undefined),
}));

const alertManager = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => ({ id: "alert-1" })),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

vi.mock("../src/compliance/alert-manager.js", () => ({
  getAlertManager: () => alertManager,
}));

import {
  BreachDetector,
  checkForBreach,
  getBreachDetector,
} from "../src/compliance/breach-detection.js";

function resetBreachDetector(): BreachDetector {
  (BreachDetector as unknown as { instance?: BreachDetector }).instance = undefined;
  return getBreachDetector();
}

describe("BreachDetector", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetBreachDetector();
  });

  afterEach(() => {
    resetBreachDetector();
  });

  it("creates an incident for a matching rule and increments detection stats", async () => {
    const detection = await checkForBreach("secrets_detected", { source: "stdout" });
    const stats = getBreachDetector().getStats();

    expect(detection).not.toBeNull();
    expect(detection).toMatchObject({
      event_count: 1,
      incident_id: expect.stringMatching(/^incident_/),
      actions_taken: expect.arrayContaining(["log", "alert", "create_incident"]),
    });
    expect(stats.detections_count).toBe(1);
    expect(stats.by_severity.critical).toBe(1);
    expect(complianceLogger.logBreach).toHaveBeenCalledTimes(1);
    expect(complianceLogger.logSecurityIncident).toHaveBeenCalledTimes(1);
  });

  it("does nothing harmful for a non-matching event", async () => {
    const detection = await checkForBreach("unrelated_event", { foo: "bar" });
    const stats = getBreachDetector().getStats();

    expect(detection).toBeNull();
    expect(stats.detections_count).toBe(0);
    expect(getBreachDetector().getRecentDetections()).toEqual([]);
    expect(complianceLogger.logBreach).not.toHaveBeenCalled();
    expect(alertManager.sendAlert).not.toHaveBeenCalled();
  });

  it("getStats returns the current detector state", async () => {
    await checkForBreach("secrets_detected", { sample: true });

    const stats = getBreachDetector().getStats();

    expect(stats.enabled).toBe(true);
    expect(stats.rules_count).toBeGreaterThan(0);
    expect(stats.detections_count).toBe(1);
    expect(stats.by_rule.rule_secrets_leaked).toBe(1);
    expect(stats.blocked_patterns).toBe(0);
  });

  it("a high-severity event triggers blocking and an error alert", async () => {
    let detection = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      detection = await checkForBreach("auth_failed", { attempt });
    }

    const stats = getBreachDetector().getStats();

    expect(detection).not.toBeNull();
    expect(detection).toMatchObject({
      blocked: true,
      event_count: 10,
      actions_taken: expect.arrayContaining(["block", "alert", "create_incident"]),
    });
    expect(getBreachDetector().isBlocked("auth_failed")).toBe(true);
    expect(stats.by_severity.high).toBe(1);
    expect(alertManager.sendAlert).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Brute Force Attack"),
      expect.any(String),
      "breach-detector",
      expect.objectContaining({ attempt: 9 })
    );
  });
});
