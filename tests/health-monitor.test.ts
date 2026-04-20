import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-health-monitor-test-")),
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

// Mock compliance-logger to avoid real I/O and isolation concerns
const complianceLogger = vi.hoisted(() => ({
  log: vi.fn(async () => ({
    id: "mock-id",
    timestamp: new Date().toISOString(),
    category: "data_processing" as const,
    event_type: "health_check_completed",
    actor: { type: "system" as const },
    outcome: "success" as const,
    hash: "0".repeat(64),
    previous_hash: "0".repeat(64),
    retention_days: 2555,
  })),
  getStats: vi.fn(async () => ({ enabled: true, totalEvents: 0, eventsByCategory: {} })),
  verifyIntegrity: vi.fn(async () => ({ valid: true, totalEvents: 0, validEvents: 0 })),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

// Mock alert-manager so health checks don't fire real alerts
const alertManager = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => null),
}));

vi.mock("../src/compliance/alert-manager.js", () => ({
  getAlertManager: () => alertManager,
}));

// Mock incident-manager
const incidentManager = vi.hoisted(() => ({
  getOpenIncidents: vi.fn(async () => []),
}));

vi.mock("../src/compliance/incident-manager.js", () => ({
  getIncidentManager: () => incidentManager,
}));

// Mock consent-manager
const consentManager = vi.hoisted(() => ({
  validateConsents: vi.fn(async () => ({ valid: true })),
}));

vi.mock("../src/compliance/consent-manager.js", () => ({
  getConsentManager: () => consentManager,
}));

// Mock retention-engine
const retentionEngine = vi.hoisted(() => ({
  getPolicies: vi.fn(async () => []),
}));

vi.mock("../src/compliance/retention-engine.js", () => ({
  getRetentionEngine: () => retentionEngine,
}));

import {
  HealthMonitor,
  getHealthMonitor,
  runHealthCheck,
  getHealthStatus,
} from "../src/compliance/health-monitor.js";

function resetHealthMonitor(): HealthMonitor {
  const instance = (HealthMonitor as unknown as { instance?: HealthMonitor }).instance;
  instance?.stop();
  (HealthMonitor as unknown as { instance?: HealthMonitor }).instance = undefined;
  return getHealthMonitor();
}

describe("HealthMonitor", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    // Disable automatic periodic monitoring so tests don't leak timers
    process.env.NLMCP_HEALTH_MONITORING = "false";
    process.env.NLMCP_AUDIT_ENABLED = "false";
    resetHealthMonitor();
  });

  afterEach(() => {
    // Stop any running timers and reset the singleton
    const instance = (HealthMonitor as unknown as { instance?: HealthMonitor }).instance;
    instance?.stop();
    (HealthMonitor as unknown as { instance?: HealthMonitor }).instance = undefined;
    delete process.env.NLMCP_HEALTH_MONITORING;
    delete process.env.NLMCP_AUDIT_ENABLED;
    delete process.env.NLMCP_ENCRYPTION_ENABLED;
  });

  it("getStatus returns an object with status and uptime_seconds before any health check", () => {
    const status = getHealthStatus();
    // No check has run yet; status should be "unknown"
    expect(status.status).toBe("unknown");
    expect(status.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(status.last_check).toBeUndefined();
  });

  it("runHealthCheck returns a HealthMetrics object with expected shape", async () => {
    const metrics = await runHealthCheck();

    expect(metrics.timestamp).toEqual(expect.any(String));
    expect(["healthy", "degraded", "unhealthy"]).toContain(metrics.status);
    expect(metrics.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(metrics.components)).toBe(true);
    expect(metrics.resources).toBeDefined();
    expect(metrics.resources.memory_used_mb).toBeGreaterThanOrEqual(0);
    expect(metrics.security).toBeDefined();
    expect(metrics.compliance).toBeDefined();
  });

  it("runHealthCheck does not throw", async () => {
    await expect(runHealthCheck()).resolves.toBeDefined();
  });

  it("getStatus returns populated status after runHealthCheck", async () => {
    await runHealthCheck();
    const status = getHealthStatus();
    expect(["healthy", "degraded", "unhealthy"]).toContain(status.status);
    expect(status.last_check).toEqual(expect.any(String));
    expect(status.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("security info is included in runHealthCheck metrics", async () => {
    incidentManager.getOpenIncidents.mockResolvedValueOnce([]);
    const metrics = await runHealthCheck();

    expect(metrics.security).toBeDefined();
    expect(typeof metrics.security.open_incidents).toBe("number");
    expect(typeof metrics.security.encryption_enabled).toBe("boolean");
    expect(typeof metrics.security.auth_enabled).toBe("boolean");
  });

  it("compliance info is included in runHealthCheck metrics", async () => {
    consentManager.validateConsents.mockResolvedValueOnce({ valid: true });
    retentionEngine.getPolicies.mockResolvedValueOnce([]);

    const metrics = await runHealthCheck();

    expect(metrics.compliance).toBeDefined();
    expect(typeof metrics.compliance.consent_valid).toBe("boolean");
    expect(typeof metrics.compliance.retention_policies_active).toBe("number");
    expect(metrics.compliance.last_compliance_check).toEqual(expect.any(String));
  });

  it("data_directory component reports up when dataDir exists", async () => {
    const metrics = await runHealthCheck();
    const dataDirComponent = metrics.components.find(c => c.name === "data_directory");

    expect(dataDirComponent).toBeDefined();
    // dataDir (TMP_ROOT) exists and is writable, so it should be up
    expect(dataDirComponent?.status).toBe("up");
  });

  it("compliance_logging component reflects verifyIntegrity result", async () => {
    // Integrity mock is already set to return valid=true
    complianceLogger.verifyIntegrity.mockResolvedValueOnce({
      valid: true,
      totalEvents: 2,
      validEvents: 2,
    });

    const metrics = await runHealthCheck();
    const complianceComponent = metrics.components.find(c => c.name === "compliance_logging");

    expect(complianceComponent).toBeDefined();
    // stats.enabled is true and integrity is valid → should be "up"
    expect(complianceComponent?.status).toBe("up");
  });

  it("getLastMetrics returns null before first health check", () => {
    const monitor = getHealthMonitor();
    expect(monitor.getLastMetrics()).toBeNull();
  });

  it("getLastMetrics returns the metrics from the most recent check", async () => {
    const monitor = getHealthMonitor();
    await monitor.runHealthCheck();
    const last = monitor.getLastMetrics();
    expect(last).not.toBeNull();
    expect(last?.status).toBeDefined();
  });

  it("registerCheck adds a custom health component that appears in metrics", async () => {
    const monitor = getHealthMonitor();
    monitor.registerCheck("custom_check", async () => ({
      name: "custom_check",
      status: "up",
      last_check: new Date().toISOString(),
    }));

    const metrics = await monitor.runHealthCheck();
    const customComponent = metrics.components.find(c => c.name === "custom_check");
    expect(customComponent).toBeDefined();
    expect(customComponent?.status).toBe("up");
  });

  it("unhealthy component triggers alert via alert-manager", async () => {
    const monitor = getHealthMonitor();
    monitor.registerCheck("failing_check", async () => ({
      name: "failing_check",
      status: "down",
      last_check: new Date().toISOString(),
      error: "Service unavailable",
    }));

    const metrics = await monitor.runHealthCheck();
    expect(metrics.status).toBe("unhealthy");
    expect(alertManager.sendAlert).toHaveBeenCalledWith(
      "error",
      "System Health Degraded",
      expect.stringContaining("failing_check"),
      "health-monitor",
      expect.objectContaining({ components: expect.arrayContaining(["failing_check"]) })
    );
  });

  it("getUptimeFormatted returns a non-empty string", () => {
    const monitor = getHealthMonitor();
    const uptime = monitor.getUptimeFormatted();
    expect(typeof uptime).toBe("string");
    expect(uptime.length).toBeGreaterThan(0);
  });
});
