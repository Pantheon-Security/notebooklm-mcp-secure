/**
 * Evidence Collector
 *
 * Collects and packages evidence for compliance audits.
 * Creates audit-ready evidence packages with integrity verification.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getConsentManager } from "./consent-manager.js";
import { getDataInventory } from "./data-inventory.js";
import { getDSARHandler } from "./dsar-handler.js";
import { getIncidentManager } from "./incident-manager.js";
import { getChangeLog } from "./change-log.js";
import { getPolicyDocManager } from "./policy-docs.js";
import { getReportGenerator } from "./report-generator.js";
import { getComplianceDashboard } from "./dashboard.js";
import type { SecurityIncident } from "./types.js";

/**
 * Evidence types
 */
export type EvidenceType =
  | "audit_logs"
  | "consent_records"
  | "data_inventory"
  | "dsar_records"
  | "incident_records"
  | "change_records"
  | "policy_documents"
  | "compliance_reports"
  | "configuration"
  | "integrity_proofs";

/**
 * Evidence item
 */
export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  title: string;
  description: string;
  collected_at: string;
  source: string;
  checksum: string;
  size_bytes: number;
  data: unknown;
}

/**
 * Evidence package
 */
export interface EvidencePackage {
  package_id: string;
  created_at: string;
  created_by: string;
  purpose: string;
  period: {
    from: string;
    to: string;
  };
  regulations: string[];
  items: EvidenceItem[];
  manifest: {
    total_items: number;
    total_size_bytes: number;
    types_included: EvidenceType[];
    package_checksum: string;
  };
  chain_of_custody: Array<{
    timestamp: string;
    action: string;
    actor: string;
    details?: string;
  }>;
}

/**
 * Collection options
 */
export interface CollectionOptions {
  from?: Date;
  to?: Date;
  types?: EvidenceType[];
  regulations?: string[];
  purpose?: string;
  includeRawData?: boolean;
}

/**
 * Evidence Collector class
 */
export class EvidenceCollector {
  private static instance: EvidenceCollector;
  private evidenceDir: string;

  private constructor() {
    const config = getConfig();
    this.evidenceDir = path.join(config.dataDir, "evidence");
    mkdirSecure(this.evidenceDir);
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): EvidenceCollector {
    if (!EvidenceCollector.instance) {
      EvidenceCollector.instance = new EvidenceCollector();
    }
    return EvidenceCollector.instance;
  }

  /**
   * Collect evidence package
   */
  public async collectEvidence(
    options: CollectionOptions = {}
  ): Promise<EvidencePackage> {
    const packageId = crypto.randomUUID();
    const from = options.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = options.to || new Date();
    const types = options.types || this.getDefaultTypes();
    const regulations = options.regulations || ["GDPR", "SOC2", "CSSF"];
    const purpose = options.purpose || "Compliance Audit";

    const items: EvidenceItem[] = [];

    // Collect each type of evidence
    for (const type of types) {
      try {
        const evidence = await this.collectEvidenceType(type, from, to, options.includeRawData);
        if (evidence) {
          items.push(evidence);
        }
      } catch (error) {
        // Log but continue collecting other evidence
        console.error(`Failed to collect ${type} evidence:`, error);
      }
    }

    // Calculate package checksum
    const packageData = JSON.stringify(items);
    const packageChecksum = crypto.createHash("sha256").update(packageData).digest("hex");

    // Calculate total size
    const totalSize = items.reduce((sum, item) => sum + item.size_bytes, 0);

    const evidencePackage: EvidencePackage = {
      package_id: packageId,
      created_at: new Date().toISOString(),
      created_by: "evidence-collector",
      purpose,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      regulations,
      items,
      manifest: {
        total_items: items.length,
        total_size_bytes: totalSize,
        types_included: items.map(i => i.type),
        package_checksum: packageChecksum,
      },
      chain_of_custody: [
        {
          timestamp: new Date().toISOString(),
          action: "created",
          actor: "evidence-collector",
          details: `Evidence package created for ${purpose}`,
        },
      ],
    };

    return evidencePackage;
  }

  /**
   * Get default evidence types
   */
  private getDefaultTypes(): EvidenceType[] {
    return [
      "audit_logs",
      "consent_records",
      "data_inventory",
      "dsar_records",
      "incident_records",
      "change_records",
      "policy_documents",
      "compliance_reports",
      "configuration",
      "integrity_proofs",
    ];
  }

  /**
   * Collect specific evidence type
   */
  private async collectEvidenceType(
    type: EvidenceType,
    from: Date,
    to: Date,
    includeRawData?: boolean
  ): Promise<EvidenceItem | null> {
    const id = crypto.randomUUID();
    const collectedAt = new Date().toISOString();

    switch (type) {
      case "audit_logs":
        return this.collectAuditLogs(id, collectedAt, from, to, includeRawData);
      case "consent_records":
        return this.collectConsentRecords(id, collectedAt);
      case "data_inventory":
        return this.collectDataInventory(id, collectedAt);
      case "dsar_records":
        return this.collectDSARRecords(id, collectedAt, from, to);
      case "incident_records":
        return this.collectIncidentRecords(id, collectedAt, from, to);
      case "change_records":
        return this.collectChangeRecords(id, collectedAt, from, to);
      case "policy_documents":
        return this.collectPolicyDocuments(id, collectedAt);
      case "compliance_reports":
        return this.collectComplianceReports(id, collectedAt, from, to);
      case "configuration":
        return this.collectConfiguration(id, collectedAt);
      case "integrity_proofs":
        return this.collectIntegrityProofs(id, collectedAt);
      default:
        return null;
    }
  }

  /**
   * Collect audit logs
   */
  private async collectAuditLogs(
    id: string,
    collectedAt: string,
    from: Date,
    to: Date,
    includeRawData?: boolean
  ): Promise<EvidenceItem> {
    const logger = getComplianceLogger();
    const stats = await logger.getStats();
    const events = await logger.getEvents(undefined, from, to, 10000);
    const integrity = await logger.verifyIntegrity();

    const data = {
      statistics: stats,
      integrity_verification: integrity,
      events_count: events.length,
      events: includeRawData ? events : events.slice(0, 100), // Sample if not including all
      sample_note: includeRawData ? undefined : "Limited to first 100 events. Set includeRawData=true for full data.",
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "audit_logs",
      title: "Compliance Audit Logs",
      description: "Hash-chained audit log entries with integrity verification",
      collected_at: collectedAt,
      source: "compliance-logger",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect consent records
   */
  private async collectConsentRecords(
    id: string,
    collectedAt: string
  ): Promise<EvidenceItem> {
    const consentManager = getConsentManager();
    const consents = await consentManager.getActiveConsents();
    const validation = await consentManager.validateConsents();

    const data = {
      total_consents: consents.length,
      validation_result: validation,
      consents: consents.map((c: { purposes: string[]; legal_basis: string; granted_at: string; expires_at?: string; is_valid?: boolean; revoked?: boolean }) => ({
        purpose: c.purposes.join(", "),
        legal_basis: c.legal_basis,
        granted_at: c.granted_at,
        expires_at: c.expires_at,
        is_valid: c.is_valid,
        revoked: c.revoked,
      })),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "consent_records",
      title: "GDPR Consent Records",
      description: "Records of data processing consent with legal basis",
      collected_at: collectedAt,
      source: "consent-manager",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect data inventory
   */
  private async collectDataInventory(
    id: string,
    collectedAt: string
  ): Promise<EvidenceItem> {
    const inventory = getDataInventory();
    const items = await inventory.getAll();
    const exportable = await inventory.getExportable();
    const erasable = await inventory.getErasable();

    const data = {
      total_categories: items.length,
      exportable_categories: exportable.length,
      erasable_categories: erasable.length,
      inventory: items,
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "data_inventory",
      title: "GDPR Article 30 Data Inventory",
      description: "Records of processing activities",
      collected_at: collectedAt,
      source: "data-inventory",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect DSAR records
   */
  private async collectDSARRecords(
    id: string,
    collectedAt: string,
    from: Date,
    to: Date
  ): Promise<EvidenceItem> {
    const dsarHandler = getDSARHandler();
    const summary = await dsarHandler.getStatistics();
    const requests = await dsarHandler.getAllRequests();

    // Filter requests by date range
    const filteredRequests = requests.filter((r: { submitted_at: string }) => {
      const date = new Date(r.submitted_at);
      return date >= from && date <= to;
    });

    const data = {
      summary,
      requests: filteredRequests.map((r: { request_id: string; type: string; status: string; submitted_at: string; completed_at?: string }) => ({
        id: r.request_id,
        type: r.type,
        status: r.status,
        submitted_at: r.submitted_at,
        completed_at: r.completed_at,
      })),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "dsar_records",
      title: "Data Subject Access Requests",
      description: "DSAR processing records and response times",
      collected_at: collectedAt,
      source: "dsar-handler",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect incident records
   */
  private async collectIncidentRecords(
    id: string,
    collectedAt: string,
    from: Date,
    to: Date
  ): Promise<EvidenceItem> {
    const incidentManager = getIncidentManager();
    const statistics = await incidentManager.getStatistics();
    const allIncidents = await incidentManager.getAllIncidents();

    // Filter incidents by date range
    const incidents = allIncidents.filter((i: SecurityIncident) => {
      const date = new Date(i.detected_at);
      return date >= from && date <= to;
    });

    const data = {
      statistics,
      incidents: incidents.map((i: SecurityIncident) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        title: i.title,
        status: i.status,
        detected_at: i.detected_at,
        resolved_at: i.resolved_at,
        actions_taken: i.actions_taken.length,
      })),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "incident_records",
      title: "Security Incident Records",
      description: "Security incident tracking and response records",
      collected_at: collectedAt,
      source: "incident-manager",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect change records
   */
  private async collectChangeRecords(
    id: string,
    collectedAt: string,
    from: Date,
    to: Date
  ): Promise<EvidenceItem> {
    const changeLog = getChangeLog();
    const statistics = await changeLog.getStatistics(from, to);
    const changes = await changeLog.getChangesInRange(from, to, 1000);

    const data = {
      statistics,
      changes: changes.map(c => ({
        id: c.id,
        timestamp: c.timestamp,
        component: c.component,
        setting: c.setting,
        changed_by: c.changed_by,
        method: c.method,
        impact: c.impact,
        requires_approval: c.requires_approval,
        approved_by: c.approved_by,
      })),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "change_records",
      title: "Configuration Change Records",
      description: "SOC2 change management audit trail",
      collected_at: collectedAt,
      source: "change-log",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect policy documents
   */
  private async collectPolicyDocuments(
    id: string,
    collectedAt: string
  ): Promise<EvidenceItem> {
    const policyManager = getPolicyDocManager();
    const policies = await policyManager.getAllPolicies();
    const summary = await policyManager.getPolicySummary();

    const data = {
      summary,
      policies: policies.map(p => ({
        id: p.id,
        type: p.type,
        title: p.title,
        version: p.version,
        effective_date: p.effective_date,
        regulations: p.regulations,
        enforced: p.enforced,
        last_reviewed: p.last_reviewed,
        next_review: p.next_review,
        approved_by: p.approved_by,
      })),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "policy_documents",
      title: "Compliance Policy Documents",
      description: "Documented security and privacy policies",
      collected_at: collectedAt,
      source: "policy-docs",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect compliance reports
   */
  private async collectComplianceReports(
    id: string,
    collectedAt: string,
    from: Date,
    to: Date
  ): Promise<EvidenceItem> {
    const reportGenerator = getReportGenerator();
    const dashboard = getComplianceDashboard();

    const dashboardData = await dashboard.generateDashboard();
    const score = await dashboard.getComplianceScore();
    const existingReports = reportGenerator.listGeneratedReports();

    const data = {
      current_dashboard: dashboardData,
      compliance_score: score,
      generated_reports: existingReports.filter(r => {
        const reportDate = new Date(r.generated);
        return reportDate >= from && reportDate <= to;
      }),
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "compliance_reports",
      title: "Compliance Reports and Dashboards",
      description: "Generated compliance reports and current status",
      collected_at: collectedAt,
      source: "report-generator",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect configuration evidence
   */
  private async collectConfiguration(
    id: string,
    collectedAt: string
  ): Promise<EvidenceItem> {
    const config = getConfig();

    // Collect non-sensitive configuration
    const data = {
      environment: {
        node_version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      security_settings: {
        encryption_enabled: process.env.NLMCP_ENCRYPTION_ENABLED !== "false",
        auth_enabled: process.env.NLMCP_AUTH_ENABLED === "true",
        // Certificate pinning was removed; flag is always false.
        cert_pinning_enabled: false,
        audit_enabled: process.env.NLMCP_AUDIT_ENABLED !== "false",
        compliance_logging_enabled: process.env.NLMCP_COMPLIANCE_LOGGING !== "false",
      },
      data_directories: {
        config_dir_exists: fs.existsSync(config.configDir),
        data_dir_exists: fs.existsSync(config.dataDir),
      },
      compliance_features: {
        gdpr_enabled: true,
        soc2_enabled: true,
        cssf_enabled: true,
        siem_enabled: process.env.NLMCP_SIEM_ENABLED === "true",
        health_monitoring_enabled: process.env.NLMCP_HEALTH_MONITORING !== "false",
      },
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "configuration",
      title: "System Configuration",
      description: "Security and compliance configuration settings",
      collected_at: collectedAt,
      source: "system-config",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Collect integrity proofs
   */
  private async collectIntegrityProofs(
    id: string,
    collectedAt: string
  ): Promise<EvidenceItem> {
    const logger = getComplianceLogger();
    const integrity = await logger.verifyIntegrity();

    const data = {
      audit_log_integrity: integrity,
      verification_timestamp: collectedAt,
      verification_method: "SHA-256 hash chain verification",
      tamper_evident: true,
    };

    const dataStr = JSON.stringify(data);

    return {
      id,
      type: "integrity_proofs",
      title: "Integrity Verification Proofs",
      description: "Cryptographic proofs of audit log integrity",
      collected_at: collectedAt,
      source: "integrity-verifier",
      checksum: crypto.createHash("sha256").update(dataStr).digest("hex"),
      size_bytes: Buffer.byteLength(dataStr),
      data,
    };
  }

  /**
   * Save evidence package to disk
   */
  public async savePackage(
    evidencePackage: EvidencePackage,
    outputDir?: string
  ): Promise<string> {
    const dir = outputDir || this.evidenceDir;
    mkdirSecure(dir);

    const fileName = `evidence-${evidencePackage.package_id}.json`;
    const filePath = path.join(dir, fileName);

    // Add chain of custody entry
    evidencePackage.chain_of_custody.push({
      timestamp: new Date().toISOString(),
      action: "saved_to_disk",
      actor: "evidence-collector",
      details: `Saved to ${filePath}`,
    });

    writeFileSecure(filePath, JSON.stringify(evidencePackage, null, 2));

    return filePath;
  }

  /**
   * Load evidence package from disk
   */
  public async loadPackage(packageId: string): Promise<EvidencePackage | null> {
    const fileName = `evidence-${packageId}.json`;
    const filePath = path.join(this.evidenceDir, fileName);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const evidencePackage = JSON.parse(content) as EvidencePackage;

    // Add chain of custody entry
    evidencePackage.chain_of_custody.push({
      timestamp: new Date().toISOString(),
      action: "loaded_from_disk",
      actor: "evidence-collector",
    });

    return evidencePackage;
  }

  /**
   * Verify evidence package integrity
   */
  public verifyPackageIntegrity(
    evidencePackage: EvidencePackage
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Verify each item checksum
    for (const item of evidencePackage.items) {
      const dataStr = JSON.stringify(item.data);
      const calculatedChecksum = crypto.createHash("sha256").update(dataStr).digest("hex");

      if (calculatedChecksum !== item.checksum) {
        errors.push(`Item ${item.id} (${item.type}): checksum mismatch`);
      }
    }

    // Verify package checksum
    const packageData = JSON.stringify(evidencePackage.items);
    const calculatedPackageChecksum = crypto.createHash("sha256").update(packageData).digest("hex");

    if (calculatedPackageChecksum !== evidencePackage.manifest.package_checksum) {
      errors.push("Package manifest: checksum mismatch");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * List saved evidence packages
   */
  public listPackages(): Array<{
    package_id: string;
    created_at: string;
    purpose: string;
    item_count: number;
  }> {
    const packages: Array<{
      package_id: string;
      created_at: string;
      purpose: string;
      item_count: number;
    }> = [];

    try {
      const files = fs.readdirSync(this.evidenceDir).filter(f => f.startsWith("evidence-") && f.endsWith(".json"));

      for (const file of files) {
        try {
          const filePath = path.join(this.evidenceDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const pkg = JSON.parse(content) as EvidencePackage;

          packages.push({
            package_id: pkg.package_id,
            created_at: pkg.created_at,
            purpose: pkg.purpose,
            item_count: pkg.manifest.total_items,
          });
        } catch {
          // Skip malformed packages
        }
      }
    } catch {
      // Ignore errors
    }

    return packages.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Create evidence package for specific regulation
   */
  public async collectRegulationEvidence(
    regulation: "GDPR" | "SOC2" | "CSSF",
    options: Omit<CollectionOptions, "regulations" | "types"> = {}
  ): Promise<EvidencePackage> {
    let types: EvidenceType[];

    switch (regulation) {
      case "GDPR":
        types = [
          "consent_records",
          "data_inventory",
          "dsar_records",
          "policy_documents",
          "audit_logs",
          "integrity_proofs",
        ];
        break;
      case "SOC2":
        types = [
          "audit_logs",
          "change_records",
          "incident_records",
          "policy_documents",
          "configuration",
          "integrity_proofs",
        ];
        break;
      case "CSSF":
        types = [
          "audit_logs",
          "incident_records",
          "policy_documents",
          "change_records",
          "compliance_reports",
          "integrity_proofs",
        ];
        break;
    }

    return this.collectEvidence({
      ...options,
      types,
      regulations: [regulation],
      purpose: `${regulation} Compliance Audit`,
    });
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the evidence collector instance
 */
export function getEvidenceCollector(): EvidenceCollector {
  return EvidenceCollector.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Collect evidence package
 */
export async function collectEvidence(
  options?: CollectionOptions
): Promise<EvidencePackage> {
  return getEvidenceCollector().collectEvidence(options);
}

/**
 * Collect and save evidence package
 */
export async function collectAndSaveEvidence(
  options?: CollectionOptions
): Promise<{ package: EvidencePackage; filePath: string }> {
  const collector = getEvidenceCollector();
  const pkg = await collector.collectEvidence(options);
  const filePath = await collector.savePackage(pkg);
  return { package: pkg, filePath };
}

/**
 * Collect regulation-specific evidence
 */
export async function collectRegulationEvidence(
  regulation: "GDPR" | "SOC2" | "CSSF",
  options?: Omit<CollectionOptions, "regulations" | "types">
): Promise<EvidencePackage> {
  return getEvidenceCollector().collectRegulationEvidence(regulation, options);
}

/**
 * Verify evidence package integrity
 */
export function verifyEvidence(
  evidencePackage: EvidencePackage
): { valid: boolean; errors: string[] } {
  return getEvidenceCollector().verifyPackageIntegrity(evidencePackage);
}

/**
 * List saved evidence packages
 */
export function listEvidencePackages(): ReturnType<EvidenceCollector["listPackages"]> {
  return getEvidenceCollector().listPackages();
}
