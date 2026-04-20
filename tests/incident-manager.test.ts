import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-incident-manager-test-")),
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
  logSecurityIncident: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

const alertManager = vi.hoisted(() => ({
  sendAlert: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/alert-manager.js", () => ({
  getAlertManager: () => alertManager,
}));

import { IncidentManager, getIncidentManager } from "../src/compliance/incident-manager.js";

function resetIncidentManager(): IncidentManager {
  (IncidentManager as unknown as { instance?: IncidentManager }).instance = undefined;
  return getIncidentManager();
}

function incidentsFilePath(): string {
  return path.join(TMP_ROOT, "compliance", "incidents.json");
}

describe("IncidentManager", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetIncidentManager();
  });

  afterEach(() => {
    resetIncidentManager();
  });

  it("createIncident persists an incident and returns it with an ID", async () => {
    const manager = getIncidentManager();
    const incident = await manager.createIncident(
      "policy_violation",
      "low",
      "Test Policy Violation",
      "A test incident for unit testing"
    );

    expect(incident.id).toMatch(/^INC-/);
    expect(incident.type).toBe("policy_violation");
    expect(incident.severity).toBe("low");
    expect(incident.status).toBe("open");
    expect(incident.title).toBe("Test Policy Violation");
    expect(incident.description).toBe("A test incident for unit testing");
    expect(incident.detected_at).toEqual(expect.any(String));
    expect(incident.actions_taken).toHaveLength(1);
    expect(incident.actions_taken[0]?.action).toBe("Incident created");

    // Verify persistence to disk
    expect(fs.existsSync(incidentsFilePath())).toBe(true);
    const data = JSON.parse(fs.readFileSync(incidentsFilePath(), "utf-8")) as {
      incidents: Array<{ id: string }>;
    };
    expect(data.incidents).toHaveLength(1);
    expect(data.incidents[0]?.id).toBe(incident.id);
  });

  it("getAllIncidents lists all stored incidents", async () => {
    const manager = getIncidentManager();
    await manager.createIncident("policy_violation", "low", "Incident One", "First");
    await manager.createIncident("configuration_error", "medium", "Incident Two", "Second");

    const incidents = await manager.getAllIncidents();
    expect(incidents).toHaveLength(2);

    const titles = incidents.map(i => i.title);
    expect(titles).toContain("Incident One");
    expect(titles).toContain("Incident Two");
  });

  it("updateStatus changes incident status and adds an action record", async () => {
    const manager = getIncidentManager();
    const incident = await manager.createIncident(
      "configuration_error",
      "medium",
      "Config Error",
      "Bad config detected",
      { notification_required: false }
    );

    const updated = await manager.updateStatus(
      incident.id,
      "investigating",
      "Triaging the issue",
      "analyst"
    );

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("investigating");
    expect(updated?.reported_at).toEqual(expect.any(String));

    // An action record should be appended for the status change
    const statusAction = updated?.actions_taken.find(a =>
      a.action.includes("Status changed")
    );
    expect(statusAction).toBeDefined();
    expect(statusAction?.performed_by).toBe("analyst");
    expect(statusAction?.notes).toBe("Triaging the issue");

    // Verify the change persisted to disk
    const data = JSON.parse(fs.readFileSync(incidentsFilePath(), "utf-8")) as {
      incidents: Array<{ id: string; status: string }>;
    };
    const persisted = data.incidents.find(i => i.id === incident.id);
    expect(persisted?.status).toBe("investigating");
  });

  it("getIncident returns the specific incident by ID", async () => {
    const manager = getIncidentManager();
    await manager.createIncident("malware", "high", "Malware Found", "Virus detected");
    const target = await manager.createIncident(
      "dos_attack",
      "critical",
      "DoS Attack",
      "Traffic spike detected"
    );

    const found = await manager.getIncident(target.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(target.id);
    expect(found?.type).toBe("dos_attack");
    expect(found?.severity).toBe("critical");
  });

  it("getIncident returns null for an unknown ID", async () => {
    const manager = getIncidentManager();
    const result = await manager.getIncident("INC-NONEXISTENT-0000");
    expect(result).toBeNull();
  });

  it("disk round-trip: second instance sees incident created by first", async () => {
    // First instance creates an incident
    const manager1 = getIncidentManager();
    const incident = await manager1.createIncident(
      "unauthorized_access",
      "medium",
      "Round-Trip Test",
      "Testing disk persistence"
    );

    // Reset singleton to simulate a fresh process
    resetIncidentManager();

    // Second instance loads from disk
    const manager2 = getIncidentManager();
    const allIncidents = await manager2.getAllIncidents();
    expect(allIncidents).toHaveLength(1);

    const reloaded = await manager2.getIncident(incident.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.id).toBe(incident.id);
    expect(reloaded?.title).toBe("Round-Trip Test");
    expect(reloaded?.type).toBe("unauthorized_access");
  });

  it("high-severity incident triggers sendAlert", async () => {
    const manager = getIncidentManager();
    await manager.createIncident(
      "data_breach",
      "high",
      "Data Breach Detected",
      "Sensitive data may have been exposed"
    );

    expect(alertManager.sendAlert).toHaveBeenCalledOnce();
    expect(alertManager.sendAlert).toHaveBeenCalledWith(
      "error",
      "Security Incident: Data Breach Detected",
      "Sensitive data may have been exposed",
      "incident-manager",
      expect.objectContaining({ type: "data_breach", status: "open" })
    );
  });

  it("low-severity incident does not trigger sendAlert", async () => {
    const manager = getIncidentManager();
    await manager.createIncident(
      "policy_violation",
      "low",
      "Minor Policy Violation",
      "Small infraction",
      { notification_required: false }
    );

    expect(alertManager.sendAlert).not.toHaveBeenCalled();
  });
});
