/**
 * Unit tests for EvidenceCollector (src/compliance/evidence-collector.ts).
 *
 * Note: The task description referenced collectEvidence(type) but the
 * actual API is collectEvidence(options?: CollectionOptions). We pass
 * { types: ["configuration"] } to keep mock surface minimal — the
 * "configuration" collector only reads process.env and fs.existsSync,
 * requiring no compliance module mocks.
 *
 * EvidencePackage top-level fields: package_id, created_at, created_by,
 * purpose, period, regulations, items, manifest, chain_of_custody.
 *
 * savePackage(pkg, dir?) writes to dir or internal evidenceDir.
 * loadPackage(packageId) reads from internal evidenceDir only — so we
 * mock config to point both at TMP_ROOT.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-evidence-collector-test-")),
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

// Mock all compliance module dependencies (used by other evidence types)
vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => ({
    getStats: vi.fn().mockResolvedValue({ enabled: true, totalEvents: 0, eventsByCategory: {} }),
    getEvents: vi.fn().mockResolvedValue([]),
    verifyIntegrity: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  }),
}));

vi.mock("../src/compliance/consent-manager.js", () => ({
  getConsentManager: () => ({
    getActiveConsents: vi.fn().mockResolvedValue([]),
    validateConsents: vi.fn().mockResolvedValue({ valid: true }),
  }),
}));

vi.mock("../src/compliance/data-inventory.js", () => ({
  getDataInventory: () => ({
    getAll: vi.fn().mockResolvedValue([]),
    getExportable: vi.fn().mockResolvedValue([]),
    getErasable: vi.fn().mockResolvedValue([]),
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
  }),
}));

vi.mock("../src/compliance/change-log.js", () => ({
  getChangeLog: () => ({
    getStatistics: vi.fn().mockResolvedValue({
      total_changes: 0,
      by_component: {},
      by_impact: {},
      by_method: {},
      requiring_approval: 0,
      compliance_affecting: 0,
    }),
    getChangesInRange: vi.fn().mockResolvedValue([]),
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

vi.mock("../src/compliance/report-generator.js", () => ({
  getReportGenerator: () => ({
    listGeneratedReports: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock("../src/compliance/dashboard.js", () => ({
  getComplianceDashboard: () => ({
    generateDashboard: vi.fn().mockResolvedValue({
      overall_status: "compliant",
      gdpr: { consent: { expired_consents: 0 }, data_subjects: { pending_dsars: 0 } },
      soc2: {
        status: "compliant",
        security: { encryption_enabled: true, auth_enabled: true, cert_pinning_enabled: false },
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
  }),
}));

import {
  EvidenceCollector,
  getEvidenceCollector,
  collectEvidence,
  listEvidencePackages,
} from "../src/compliance/evidence-collector.js";
import type { EvidencePackage } from "../src/compliance/evidence-collector.js";

function resetEvidenceCollector(): void {
  (EvidenceCollector as unknown as { instance?: EvidenceCollector }).instance = undefined;
}

describe("EvidenceCollector", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetEvidenceCollector();
  });

  afterEach(() => {
    resetEvidenceCollector();
  });

  it("collectEvidence returns a package with expected top-level fields", async () => {
    // Use the "configuration" type only — no compliance module calls needed
    const pkg = await collectEvidence({ types: ["configuration"] });

    expect(pkg).toHaveProperty("package_id");
    expect(pkg).toHaveProperty("created_at");
    expect(pkg).toHaveProperty("created_by", "evidence-collector");
    expect(pkg).toHaveProperty("purpose");
    expect(pkg).toHaveProperty("period");
    expect(pkg.period).toHaveProperty("from");
    expect(pkg.period).toHaveProperty("to");
    expect(pkg).toHaveProperty("regulations");
    expect(Array.isArray(pkg.regulations)).toBe(true);
    expect(pkg).toHaveProperty("items");
    expect(Array.isArray(pkg.items)).toBe(true);
    expect(pkg).toHaveProperty("manifest");
    expect(pkg).toHaveProperty("chain_of_custody");
  });

  it("collectEvidence items have the expected evidence item fields", async () => {
    const pkg = await collectEvidence({ types: ["configuration"] });

    expect(pkg.items.length).toBeGreaterThan(0);
    const item = pkg.items[0]!;
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("type", "configuration");
    expect(item).toHaveProperty("title");
    expect(item).toHaveProperty("description");
    expect(item).toHaveProperty("collected_at");
    expect(item).toHaveProperty("source");
    expect(item).toHaveProperty("checksum");
    expect(item).toHaveProperty("size_bytes");
    expect(item).toHaveProperty("data");
  });

  it("savePackage writes the package to disk", async () => {
    const pkg = await collectEvidence({ types: ["configuration"] });
    const collector = getEvidenceCollector();

    const outputDir = path.join(TMP_ROOT, "evidence-out");
    const filePath = await collector.savePackage(pkg, outputDir);

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/evidence-.*\.json$/);
  });

  it("listPackages returns the saved package entry", async () => {
    // savePackage without outputDir writes to the internal evidenceDir
    // (config.dataDir/evidence) — same location listPackages reads from.
    const pkg = await collectEvidence({ types: ["configuration"] });
    const collector = getEvidenceCollector();
    await collector.savePackage(pkg);

    // Note: listEvidencePackages() / collector.listPackages() takes no args
    const list = listEvidencePackages();

    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    const entry = list[0]!;
    expect(entry).toHaveProperty("package_id", pkg.package_id);
    expect(entry).toHaveProperty("created_at");
    expect(entry).toHaveProperty("purpose");
    expect(entry).toHaveProperty("item_count");
  });

  it("disk round-trip: save then load returns consistent package data", async () => {
    const pkg = await collectEvidence({ types: ["configuration"] });
    const collector = getEvidenceCollector();

    // Save to internal dir so loadPackage can find it
    await collector.savePackage(pkg);

    const loaded = await collector.loadPackage(pkg.package_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.package_id).toBe(pkg.package_id);
    expect(loaded!.purpose).toBe(pkg.purpose);
    expect(loaded!.manifest.total_items).toBe(pkg.manifest.total_items);

    // Chain of custody should have grown (loaded_from_disk entry appended)
    expect(loaded!.chain_of_custody.length).toBeGreaterThan(pkg.chain_of_custody.length);
  });

  it("verifyPackageIntegrity returns valid=true for a freshly collected package", async () => {
    const pkg = await collectEvidence({ types: ["configuration"] });
    const collector = getEvidenceCollector();
    const result = collector.verifyPackageIntegrity(pkg);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
