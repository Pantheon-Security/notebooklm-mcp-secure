/**
 * Unit tests for ReportGenerator (src/compliance/report-generator.ts).
 *
 * Note: The task description referenced saveReport(report, dir) and
 * listReports(dir) — the actual API saves via generateReport options
 * (saveToDisk: true, outputDir) and listReports() takes no arguments,
 * reading from the internal reportsDir (config.dataDir/reports).
 *
 * We exercise compliance_summary to keep mock surface minimal.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-report-generator-test-")),
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

vi.mock("../src/utils/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

// Minimal dashboard stub — compliance_summary only needs generateDashboard + getComplianceScore
const dashboardStub = vi.hoisted(() => ({
  generateDashboard: vi.fn().mockResolvedValue({
    overall_status: "compliant",
    gdpr: {
      consent: { expired_consents: 0 },
      data_subjects: { pending_dsars: 0 },
    },
    soc2: {
      status: "compliant",
      security: {
        encryption_enabled: true,
        auth_enabled: true,
        cert_pinning_enabled: false,
      },
      availability: { uptime_percentage: 99.9 },
    },
    cssf: { policies: { due_for_review: 0 } },
    security: {
      status: "secure",
      breach_detection: { enabled: true, active_rules: 5 },
      incidents: { open_incidents: 0, by_status: { open: 0 } },
      alerts: { total_24h: 0, critical_24h: 0, unacknowledged: 0 },
    },
    health: { status: "healthy" },
  }),
  getComplianceScore: vi.fn().mockResolvedValue({ overall: 95, gdpr: 95, soc2: 95, cssf: 95 }),
}));

vi.mock("../src/compliance/dashboard.js", () => ({
  getComplianceDashboard: () => dashboardStub,
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => ({
    getStats: vi.fn().mockResolvedValue({ enabled: true, totalEvents: 10, eventsByCategory: {} }),
    verifyIntegrity: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  }),
}));

vi.mock("../src/compliance/data-inventory.js", () => ({
  getDataInventory: () => ({
    getAll: vi.fn().mockResolvedValue([]),
    getExportable: vi.fn().mockResolvedValue([]),
    getErasable: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../src/compliance/consent-manager.js", () => ({
  getConsentManager: () => ({
    getActiveConsents: vi.fn().mockResolvedValue([]),
    validateConsents: vi.fn().mockResolvedValue({ valid: true }),
  }),
}));

vi.mock("../src/compliance/dsar-handler.js", () => ({
  getDSARHandler: () => ({
    getStatistics: vi.fn().mockResolvedValue({
      total_requests: 0,
      pending_requests: 0,
      completed_requests: 0,
      by_type: {},
      average_processing_time_hours: 0,
    }),
    getAllRequests: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../src/compliance/incident-manager.js", () => ({
  getIncidentManager: () => ({
    getStatistics: vi.fn().mockResolvedValue({
      total_incidents: 0,
      by_severity: {},
      by_status: {},
      by_type: {},
    }),
    getAllIncidents: vi.fn().mockResolvedValue([]),
    getOpenIncidents: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../src/compliance/change-log.js", () => ({
  getChangeLog: () => ({
    getChangesInRange: vi.fn().mockResolvedValue([]),
    getStatistics: vi.fn().mockResolvedValue({
      total_changes: 0,
      by_component: {},
      by_impact: {},
      by_method: {},
      requiring_approval: 0,
      compliance_affecting: 0,
    }),
    getHighImpactChanges: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("../src/compliance/policy-docs.js", () => ({
  getPolicyDocManager: () => ({
    getAllPolicies: vi.fn().mockResolvedValue([]),
    getPolicySummary: vi.fn().mockResolvedValue({
      total_policies: 5,
      enforced_policies: 5,
      due_for_review: 0,
    }),
  }),
}));

vi.mock("../src/compliance/retention-engine.js", () => ({
  getRetentionEngine: () => ({
    getStatus: vi.fn().mockResolvedValue({
      active_policies: 3,
      next_due: [],
      last_runs: {},
    }),
    getPolicies: vi.fn().mockResolvedValue([]),
  }),
}));

import {
  ReportGenerator,
  getReportGenerator,
  generateReport,
  listReports,
} from "../src/compliance/report-generator.js";

function resetReportGenerator(): void {
  (ReportGenerator as unknown as { instance?: ReportGenerator }).instance = undefined;
}

describe("ReportGenerator", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetReportGenerator();
  });

  afterEach(() => {
    resetReportGenerator();
  });

  it("generateReport returns an object with expected top-level fields", async () => {
    const report = await generateReport("compliance_summary");

    expect(report).toHaveProperty("metadata");
    expect(report).toHaveProperty("content");

    const { metadata } = report;
    expect(metadata).toHaveProperty("report_id");
    expect(metadata).toHaveProperty("report_type", "compliance_summary");
    expect(metadata).toHaveProperty("format", "json");
    expect(metadata).toHaveProperty("generated_at");
    expect(metadata).toHaveProperty("checksum");
    expect(metadata).toHaveProperty("period");
    expect(metadata.period).toHaveProperty("from");
    expect(metadata.period).toHaveProperty("to");
  });

  it("generateReport returns non-empty content sections", async () => {
    const report = await generateReport("compliance_summary");

    expect(typeof report.content).toBe("string");
    expect(report.content.length).toBeGreaterThan(0);

    const parsed = JSON.parse(report.content) as Record<string, unknown>;
    expect(parsed).toHaveProperty("title");
    expect(parsed).toHaveProperty("executive_summary");
    expect(parsed).toHaveProperty("recommendations");
  });

  it("generateReport with saveToDisk writes the report file and meta.json sidecar", async () => {
    // Note: The task described saveReport(report, dir) but the real API uses
    // generateReport(type, { saveToDisk: true, outputDir }).
    const outputDir = path.join(TMP_ROOT, "reports");
    const report = await generateReport("compliance_summary", {
      saveToDisk: true,
      outputDir,
    });

    expect(report.file_path).toBeDefined();
    expect(fs.existsSync(report.file_path!)).toBe(true);

    const diskContent = fs.readFileSync(report.file_path!, "utf-8");
    expect(diskContent).toBe(report.content);

    // Meta sidecar must also be present for listGeneratedReports to work
    const metaPath = report.file_path! + ".meta.json";
    expect(fs.existsSync(metaPath)).toBe(true);
  });

  it("listReports returns the saved report entry after saving to the internal reports dir", async () => {
    // Note: The task described listReports(dir) but the real API takes no args
    // and reads from config.dataDir/reports. We save to that same directory.
    await generateReport("compliance_summary", { saveToDisk: true });

    const reports = listReports();

    expect(Array.isArray(reports)).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toHaveProperty("file");
    expect(reports[0]).toHaveProperty("type", "compliance_summary");
    expect(reports[0]).toHaveProperty("generated");
  });
});
