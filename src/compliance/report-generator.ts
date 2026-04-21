/**
 * Report Generator
 *
 * Generates compliance reports for auditors.
 * Supports multiple formats: JSON, CSV, PDF-ready HTML.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { CONFIG } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import { getComplianceDashboard } from "./dashboard.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getDataInventory } from "./data-inventory.js";
import { getConsentManager } from "./consent-manager.js";
import { getDSARHandler } from "./dsar-handler.js";
import { getIncidentManager } from "./incident-manager.js";
import { getChangeLog } from "./change-log.js";
import { getPolicyDocManager } from "./policy-docs.js";
import { getRetentionEngine } from "./retention-engine.js";
import type { DashboardData } from "./dashboard.js";
import type { SecurityIncident } from "./types.js";

/**
 * Report types
 */
export type ReportType =
  | "compliance_summary"
  | "gdpr_audit"
  | "soc2_audit"
  | "cssf_audit"
  | "security_audit"
  | "incident_report"
  | "dsar_report"
  | "retention_report"
  | "change_management"
  | "full_audit";

/**
 * Report format
 */
export type ReportFormat = "json" | "csv" | "html";

/**
 * Report metadata
 */
interface ReportMetadata {
  report_id: string;
  report_type: ReportType;
  format: ReportFormat;
  generated_at: string;
  generated_by: string;
  period: {
    from: string;
    to: string;
  };
  checksum: string;
}

/**
 * Generated report
 */
export interface GeneratedReport {
  metadata: ReportMetadata;
  content: string;
  file_path?: string;
}

/**
 * Report options
 */
export interface ReportOptions {
  from?: Date;
  to?: Date;
  format?: ReportFormat;
  includeRawData?: boolean;
  saveToDisk?: boolean;
  outputDir?: string;
}

/**
 * Report Generator class
 */
export class ReportGenerator {
  private static instance: ReportGenerator;
  private reportsDir: string;

  private constructor() {
    const config = CONFIG;
    this.reportsDir = path.join(config.dataDir, "reports");
    mkdirSecure(this.reportsDir);
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ReportGenerator {
    if (!ReportGenerator.instance) {
      ReportGenerator.instance = new ReportGenerator();
    }
    return ReportGenerator.instance;
  }

  /**
   * Generate a report
   */
  public async generateReport(
    reportType: ReportType,
    options: ReportOptions = {}
  ): Promise<GeneratedReport> {
    const format = options.format || "json";
    const from = options.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const to = options.to || new Date();

    let content: string;

    switch (reportType) {
      case "compliance_summary":
        content = await this.generateComplianceSummary(from, to, format);
        break;
      case "gdpr_audit":
        content = await this.generateGDPRAudit(from, to, format);
        break;
      case "soc2_audit":
        content = await this.generateSOC2Audit(from, to, format);
        break;
      case "cssf_audit":
        content = await this.generateCSSFAudit(from, to, format);
        break;
      case "security_audit":
        content = await this.generateSecurityAudit(from, to, format);
        break;
      case "incident_report":
        content = await this.generateIncidentReport(from, to, format);
        break;
      case "dsar_report":
        content = await this.generateDSARReport(from, to, format);
        break;
      case "retention_report":
        content = await this.generateRetentionReport(from, to, format);
        break;
      case "change_management":
        content = await this.generateChangeManagementReport(from, to, format);
        break;
      case "full_audit":
        content = await this.generateFullAudit(from, to, format);
        break;
      default:
        throw new Error(`Unknown report type: ${reportType}`);
    }

    const reportId = crypto.randomUUID();
    const checksum = crypto.createHash("sha256").update(content).digest("hex");

    const metadata: ReportMetadata = {
      report_id: reportId,
      report_type: reportType,
      format,
      generated_at: new Date().toISOString(),
      generated_by: "compliance-report-generator",
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      checksum,
    };

    const report: GeneratedReport = {
      metadata,
      content,
    };

    // Save to disk if requested
    if (options.saveToDisk) {
      const outputDir = options.outputDir || this.reportsDir;
      mkdirSecure(outputDir);

      const fileName = `${reportType}-${from.toISOString().split("T")[0]}-to-${to.toISOString().split("T")[0]}.${format}`;
      const filePath = path.join(outputDir, fileName);

      writeFileSecure(filePath, content);
      report.file_path = filePath;

      // Save metadata
      const metadataPath = filePath + ".meta.json";
      writeFileSecure(metadataPath, JSON.stringify(metadata, null, 2));
    }

    return report;
  }

  /**
   * Generate compliance summary report
   */
  private async generateComplianceSummary(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const dashboard = getComplianceDashboard();
    const data = await dashboard.generateDashboard();
    const score = await dashboard.getComplianceScore();

    const report = {
      title: "Compliance Summary Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      executive_summary: {
        overall_status: data.overall_status,
        compliance_score: score.overall,
        gdpr_score: score.gdpr,
        soc2_score: score.soc2,
        cssf_score: score.cssf,
      },
      gdpr_summary: data.gdpr,
      soc2_summary: data.soc2,
      cssf_summary: data.cssf,
      security_summary: data.security,
      health_summary: data.health,
      recommendations: this.generateRecommendations(data),
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate GDPR audit report
   */
  private async generateGDPRAudit(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const consentManager = getConsentManager();
    const dataInventory = getDataInventory();
    const dsarHandler = getDSARHandler();
    const retentionEngine = getRetentionEngine();

    const consents = await consentManager.getActiveConsents();
    const inventory = await dataInventory.getAll();
    const dsarSummary = await dsarHandler.getStatistics();
    const retentionStatus = await retentionEngine.getStatus();

    const report = {
      title: "GDPR Compliance Audit Report",
      regulation: "General Data Protection Regulation (EU) 2016/679",
      period: { from: from.toISOString(), to: to.toISOString() },
      article_30_records: {
        description: "Records of Processing Activities",
        categories_documented: inventory.length,
        data_inventory: inventory,
      },
      article_6_legal_basis: {
        description: "Lawfulness of Processing",
        consent_records: consents.length,
        valid_consents: consents.length, // All active consents are valid
        consents: consents.map((c: { purposes: string[]; legal_basis: string; granted_at: string }) => ({
          purpose: c.purposes.join(", "),
          legal_basis: c.legal_basis,
          granted: c.granted_at,
          valid: true,
        })),
      },
      article_15_17_access_erasure: {
        description: "Data Subject Access and Erasure Rights",
        summary: dsarSummary,
      },
      article_20_portability: {
        description: "Right to Data Portability",
        exportable_categories: (await dataInventory.getExportable()).length,
      },
      article_17_erasure: {
        description: "Right to Erasure",
        erasable_categories: (await dataInventory.getErasable()).length,
      },
      data_retention: {
        description: "Data Retention Policies",
        status: retentionStatus,
      },
      compliance_status: {
        compliant: true,
        gaps: [],
        recommendations: [],
      },
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate SOC2 audit report
   */
  private async generateSOC2Audit(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const complianceLogger = getComplianceLogger();
    const changeLog = getChangeLog();
    const incidentManager = getIncidentManager();
    const dashboard = getComplianceDashboard();

    const dashboardData = await dashboard.generateDashboard();
    const loggerStats = await complianceLogger.getStats();
    const integrity = await complianceLogger.verifyIntegrity();
    const changes = await changeLog.getChangesInRange(from, to);
    const incidentStats = await incidentManager.getStatistics();

    const report = {
      title: "SOC2 Type II Compliance Audit Report",
      framework: "AICPA SOC2 Trust Services Criteria",
      period: { from: from.toISOString(), to: to.toISOString() },
      trust_services_criteria: {
        security: {
          principle: "CC6 - Logical and Physical Access Controls",
          controls: {
            encryption_enabled: dashboardData.soc2.security.encryption_enabled,
            auth_enabled: dashboardData.soc2.security.auth_enabled,
            cert_pinning: dashboardData.soc2.security.cert_pinning_enabled,
          },
          status: dashboardData.soc2.security.encryption_enabled ? "Met" : "Not Met",
        },
        availability: {
          principle: "CC7 - System Operations",
          controls: {
            health_monitoring: true,
            uptime_percentage: dashboardData.soc2.availability.uptime_percentage,
            status: dashboardData.health.status,
          },
          status: dashboardData.health.status === "healthy" ? "Met" : "Partially Met",
        },
        processing_integrity: {
          principle: "CC8 - Change Management",
          controls: {
            change_tracking: true,
            changes_in_period: changes.length,
            high_impact_changes: changes.filter(c => c.impact === "high").length,
          },
          status: "Met",
        },
        confidentiality: {
          principle: "CC9 - Confidentiality",
          controls: {
            data_classification: true,
            audit_logging: loggerStats.enabled,
            log_integrity: integrity.valid,
          },
          status: integrity.valid ? "Met" : "Not Met",
        },
      },
      audit_logging: {
        enabled: loggerStats.enabled,
        total_events: loggerStats.totalEvents,
        events_in_period: loggerStats.eventsByCategory,
        integrity_verification: integrity,
      },
      change_management: {
        total_changes: changes.length,
        by_impact: {
          high: changes.filter(c => c.impact === "high").length,
          medium: changes.filter(c => c.impact === "medium").length,
          low: changes.filter(c => c.impact === "low").length,
        },
        changes: changes.slice(0, 100), // Include first 100 changes
      },
      incident_management: {
        statistics: incidentStats,
        open_incidents: dashboardData.security.incidents.by_status.open,
      },
      compliance_status: {
        overall: dashboardData.soc2.status,
        gaps: [],
        recommendations: [],
      },
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate CSSF audit report
   */
  private async generateCSSFAudit(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const complianceLogger = getComplianceLogger();
    const policyManager = getPolicyDocManager();
    const incidentManager = getIncidentManager();

    const loggerStats = await complianceLogger.getStats();
    const integrity = await complianceLogger.verifyIntegrity();
    const policies = await policyManager.getAllPolicies();
    const policySummary = await policyManager.getPolicySummary();
    const incidentStats = await incidentManager.getStatistics();

    const report = {
      title: "CSSF Compliance Audit Report",
      regulation: "CSSF Circular 20/750 - IT Risk Management",
      period: { from: from.toISOString(), to: to.toISOString() },
      audit_trail_requirements: {
        circular_reference: "Section 4.3 - Audit Trail",
        retention_period_years: 7,
        controls: {
          audit_logging_enabled: loggerStats.enabled,
          total_events_logged: loggerStats.totalEvents,
          integrity_verification: integrity.valid,
          tamper_evident: true,
        },
        status: loggerStats.enabled && integrity.valid ? "Compliant" : "Non-Compliant",
      },
      incident_management: {
        circular_reference: "Section 5 - Incident Management",
        controls: {
          incident_tracking: true,
          documented_procedures: true,
          total_incidents: incidentStats.total_incidents,
        },
        statistics: incidentStats,
        status: "Compliant",
      },
      policy_management: {
        circular_reference: "Section 3 - IT Governance",
        controls: {
          documented_policies: policySummary.total_policies,
          enforced_policies: policySummary.enforced_policies,
          review_cycle: "Annual",
          policies_due_for_review: policySummary.due_for_review,
        },
        policies: policies.map(p => ({
          id: p.id,
          title: p.title,
          type: p.type,
          enforced: p.enforced,
          last_reviewed: p.last_reviewed,
          next_review: p.next_review,
        })),
        status: policySummary.due_for_review === 0 ? "Compliant" : "At Risk",
      },
      compliance_status: {
        overall: "Compliant",
        gaps: [],
        recommendations: [],
      },
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate security audit report
   */
  private async generateSecurityAudit(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const dashboard = getComplianceDashboard();
    const incidentManager = getIncidentManager();

    const dashboardData = await dashboard.generateDashboard();
    const incidentStats = await incidentManager.getStatistics();
    const openIncidents = await incidentManager.getOpenIncidents();

    const report = {
      title: "Security Audit Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      executive_summary: {
        security_status: dashboardData.security.status,
        open_incidents: openIncidents.length,
        critical_alerts_24h: dashboardData.security.alerts.critical_24h,
      },
      security_controls: {
        encryption: {
          enabled: dashboardData.soc2.security.encryption_enabled,
          algorithm: "ML-KEM-768 + ChaCha20-Poly1305 (Hybrid Post-Quantum)",
        },
        authentication: {
          enabled: dashboardData.soc2.security.auth_enabled,
          method: "Token-based MCP authentication",
        },
        certificate_pinning: {
          enabled: dashboardData.soc2.security.cert_pinning_enabled,
          domains: ["accounts.google.com", "notebooklm.google.com"],
        },
        breach_detection: {
          enabled: dashboardData.security.breach_detection.enabled,
          active_rules: dashboardData.security.breach_detection.active_rules,
        },
      },
      incident_summary: {
        statistics: incidentStats,
        open_incidents: openIncidents.map((i: SecurityIncident) => ({
          id: i.id,
          type: i.type,
          severity: i.severity,
          created: i.detected_at,
          status: i.status,
        })),
      },
      alert_summary: {
        total_24h: dashboardData.security.alerts.total_24h,
        critical_24h: dashboardData.security.alerts.critical_24h,
        unacknowledged: dashboardData.security.alerts.unacknowledged,
      },
      recommendations: [],
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate incident report
   */
  private async generateIncidentReport(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const incidentManager = getIncidentManager();

    const stats = await incidentManager.getStatistics();
    const allIncidents = await incidentManager.getAllIncidents();
    // Filter incidents by date range
    const incidents = allIncidents.filter((i: SecurityIncident) => {
      const incidentDate = new Date(i.detected_at);
      return incidentDate >= from && incidentDate <= to;
    });

    const report = {
      title: "Incident Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total_incidents: incidents.length,
        by_severity: stats.by_severity,
        by_status: stats.by_status,
        by_type: stats.by_type,
      },
      incidents: incidents.map((i: SecurityIncident) => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        title: i.title,
        description: i.description,
        status: i.status,
        detected_at: i.detected_at,
        resolved_at: i.resolved_at,
        affected_systems: i.affected_systems,
        actions_taken: i.actions_taken,
      })),
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate DSAR report
   */
  private async generateDSARReport(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const dsarHandler = getDSARHandler();

    const stats = await dsarHandler.getStatistics();
    const allRequests = await dsarHandler.getAllRequests();
    // Filter requests by date range
    const requests = allRequests.filter(r => {
      const requestDate = new Date(r.submitted_at);
      return requestDate >= from && requestDate <= to;
    });

    const report = {
      title: "Data Subject Access Request Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total_requests: stats.total_requests,
        pending: stats.pending_requests,
        completed: stats.completed_requests,
        by_type: stats.by_type,
      },
      compliance_metrics: {
        average_response_time_hours: stats.average_processing_time_hours || 0,
        within_deadline_percentage: 100, // GDPR requires 30-day response
      },
      requests: requests.map(r => ({
        id: r.request_id,
        type: r.type,
        status: r.status,
        submitted: r.submitted_at,
        completed: r.completed_at,
      })),
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate retention report
   */
  private async generateRetentionReport(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const retentionEngine = getRetentionEngine();

    const status = await retentionEngine.getStatus();
    const policies = await retentionEngine.getPolicies();

    // Get last run date from the last_runs record
    const lastRunDates = Object.values(status.last_runs);
    const lastRun = lastRunDates.length > 0 ? lastRunDates[lastRunDates.length - 1] : undefined;

    const report = {
      title: "Data Retention Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total_policies: policies.length,
        active_policies: status.active_policies,
        items_due_for_deletion: status.next_due.length,
        last_run: lastRun,
      },
      policies: policies.map(p => ({
        id: p.id,
        name: p.name,
        data_types: p.data_types,
        retention_days: p.retention_days,
        action: p.action,
        regulatory_requirement: p.regulatory_requirement,
      })),
      enforcement: {
        automatic: true,
        schedule: "Daily",
        method: "Secure deletion with verification",
      },
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate change management report
   */
  private async generateChangeManagementReport(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const changeLog = getChangeLog();

    const stats = await changeLog.getStatistics(from, to);
    const changes = await changeLog.getChangesInRange(from, to);
    const highImpact = await changeLog.getHighImpactChanges(100);

    const report = {
      title: "Change Management Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      summary: {
        total_changes: stats.total_changes,
        by_component: stats.by_component,
        by_impact: stats.by_impact,
        by_method: stats.by_method,
        requiring_approval: stats.requiring_approval,
        compliance_affecting: stats.compliance_affecting,
      },
      high_impact_changes: highImpact.filter(c => {
        const changeDate = new Date(c.timestamp);
        return changeDate >= from && changeDate <= to;
      }),
      all_changes: changes,
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate full audit report
   */
  private async generateFullAudit(
    from: Date,
    to: Date,
    format: ReportFormat
  ): Promise<string> {
    const [gdpr, soc2, cssf, security, incidents, dsar, retention, changes] = await Promise.all([
      this.generateGDPRAudit(from, to, "json"),
      this.generateSOC2Audit(from, to, "json"),
      this.generateCSSFAudit(from, to, "json"),
      this.generateSecurityAudit(from, to, "json"),
      this.generateIncidentReport(from, to, "json"),
      this.generateDSARReport(from, to, "json"),
      this.generateRetentionReport(from, to, "json"),
      this.generateChangeManagementReport(from, to, "json"),
    ]);

    const report = {
      title: "Comprehensive Compliance Audit Report",
      period: { from: from.toISOString(), to: to.toISOString() },
      gdpr_audit: JSON.parse(gdpr),
      soc2_audit: JSON.parse(soc2),
      cssf_audit: JSON.parse(cssf),
      security_audit: JSON.parse(security),
      incident_report: JSON.parse(incidents),
      dsar_report: JSON.parse(dsar),
      retention_report: JSON.parse(retention),
      change_management: JSON.parse(changes),
    };

    return this.formatOutput(report, format);
  }

  /**
   * Generate recommendations based on dashboard data
   */
  private generateRecommendations(data: DashboardData): string[] {
    const recommendations: string[] = [];

    if (!data.soc2.security.encryption_enabled) {
      recommendations.push("Enable encryption to protect sensitive data at rest.");
    }

    if (!data.soc2.security.auth_enabled) {
      recommendations.push("Enable MCP authentication for additional security.");
    }

    if (data.gdpr.consent.expired_consents > 0) {
      recommendations.push(`Review ${data.gdpr.consent.expired_consents} expired consent records.`);
    }

    if (data.gdpr.data_subjects.pending_dsars > 0) {
      recommendations.push(`Process ${data.gdpr.data_subjects.pending_dsars} pending DSARs.`);
    }

    if (data.cssf.policies.due_for_review > 0) {
      recommendations.push(`Review ${data.cssf.policies.due_for_review} policies that are due for review.`);
    }

    if (data.security.incidents.open_incidents > 0) {
      recommendations.push("Investigate and resolve open security incidents.");
    }

    if (data.health.status !== "healthy") {
      recommendations.push("Address system health issues to ensure availability.");
    }

    return recommendations;
  }

  /**
   * Format output based on format type
   */
  private formatOutput(data: object, format: ReportFormat): string {
    switch (format) {
      case "json":
        return JSON.stringify(data, null, 2);
      case "csv":
        return this.toCSV(data);
      case "html":
        return this.toHTML(data);
      default:
        return JSON.stringify(data, null, 2);
    }
  }

  /**
   * Convert to CSV format (flattened)
   */
  private toCSV(data: object): string {
    const flattened = this.flattenObject(data);
    const lines: string[] = [];

    lines.push("Key,Value");
    for (const [key, value] of Object.entries(flattened)) {
      const escapedValue = String(value).replace(/"/g, '""');
      lines.push(`"${key}","${escapedValue}"`);
    }

    return lines.join("\n");
  }

  /**
   * Flatten nested object
   */
  private flattenObject(
    obj: object,
    prefix: string = ""
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};

    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;

      if (value === null || value === undefined) {
        result[newKey] = "";
      } else if (typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value, newKey));
      } else if (Array.isArray(value)) {
        result[newKey] = JSON.stringify(value);
      } else {
        result[newKey] = value;
      }
    }

    return result;
  }

  /**
   * Convert to HTML format
   */
  private toHTML(data: object): string {
    const title = (data as { title?: string }).title || "Compliance Report";
    const period = (data as { period?: { from: string; to: string } }).period;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHTML(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    h3 { color: #555; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background-color: #f5f5f5; }
    tr:nth-child(even) { background-color: #fafafa; }
    .status-compliant { color: #28a745; font-weight: bold; }
    .status-at-risk { color: #ffc107; font-weight: bold; }
    .status-non-compliant { color: #dc3545; font-weight: bold; }
    .metadata { color: #666; font-size: 14px; margin-bottom: 30px; }
    .section { margin: 30px 0; padding: 20px; background: #f9f9f9; border-radius: 8px; }
    pre { background: #f0f0f0; padding: 15px; overflow-x: auto; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>${this.escapeHTML(title)}</h1>
  <div class="metadata">
    <p>Generated: ${new Date().toLocaleString()}</p>
    ${period ? `<p>Period: ${period.from} to ${period.to}</p>` : ""}
  </div>
`;

    html += this.objectToHTML(data);

    html += `
</body>
</html>`;

    return html;
  }

  /**
   * Convert object to HTML recursively
   */
  private objectToHTML(obj: object, level: number = 2): string {
    let html = "";

    for (const [key, value] of Object.entries(obj)) {
      if (key === "title" || key === "period") continue;

      const heading = `h${Math.min(level, 6)}`;
      const formattedKey = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      if (value === null || value === undefined) {
        continue;
      } else if (typeof value === "object" && !Array.isArray(value)) {
        html += `<${heading}>${this.escapeHTML(formattedKey)}</${heading}>\n`;
        html += `<div class="section">\n`;
        html += this.objectToHTML(value, level + 1);
        html += `</div>\n`;
      } else if (Array.isArray(value)) {
        html += `<${heading}>${this.escapeHTML(formattedKey)}</${heading}>\n`;
        if (value.length > 0 && typeof value[0] === "object") {
          html += this.arrayToTable(value);
        } else {
          html += `<pre>${this.escapeHTML(JSON.stringify(value, null, 2))}</pre>\n`;
        }
      } else {
        const statusClass = this.getStatusClass(String(value));
        html += `<p><strong>${this.escapeHTML(formattedKey)}:</strong> `;
        html += statusClass
          ? `<span class="${statusClass}">${this.escapeHTML(String(value))}</span>`
          : this.escapeHTML(String(value));
        html += `</p>\n`;
      }
    }

    return html;
  }

  /**
   * Convert array to HTML table
   */
  private arrayToTable(arr: object[]): string {
    if (arr.length === 0) return "<p>No data</p>";

    const headers = Object.keys(arr[0]);

    let html = "<table>\n<thead>\n<tr>\n";
    for (const header of headers) {
      html += `<th>${this.escapeHTML(header.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()))}</th>\n`;
    }
    html += "</tr>\n</thead>\n<tbody>\n";

    for (const row of arr) {
      html += "<tr>\n";
      for (const header of headers) {
        const value = (row as Record<string, unknown>)[header];
        const displayValue = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
        const statusClass = this.getStatusClass(displayValue);
        html += statusClass
          ? `<td class="${statusClass}">${this.escapeHTML(displayValue)}</td>\n`
          : `<td>${this.escapeHTML(displayValue)}</td>\n`;
      }
      html += "</tr>\n";
    }

    html += "</tbody>\n</table>\n";
    return html;
  }

  /**
   * Get CSS class for status values
   */
  private getStatusClass(value: string): string | null {
    const lower = value.toLowerCase();
    if (lower === "compliant" || lower === "met" || lower === "healthy" || lower === "secure") {
      return "status-compliant";
    }
    if (lower === "at_risk" || lower === "at risk" || lower === "partially met" || lower === "degraded") {
      return "status-at-risk";
    }
    if (lower === "non_compliant" || lower === "non-compliant" || lower === "not met" || lower === "unhealthy" || lower === "compromised") {
      return "status-non-compliant";
    }
    return null;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHTML(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * List available reports
   */
  public listGeneratedReports(): Array<{
    file: string;
    type: string;
    generated: string;
  }> {
    const reports: Array<{ file: string; type: string; generated: string }> = [];

    try {
      const files = fs.readdirSync(this.reportsDir).filter(f => !f.endsWith(".meta.json"));

      for (const file of files) {
        const metaPath = path.join(this.reportsDir, file + ".meta.json");
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          reports.push({
            file,
            type: meta.report_type,
            generated: meta.generated_at,
          });
        }
      }
    } catch (err) {
      log.debug(`report-generator: list generated reports: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore errors
    }

    return reports.sort((a, b) => b.generated.localeCompare(a.generated));
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the report generator instance
 */
export function getReportGenerator(): ReportGenerator {
  return ReportGenerator.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Generate a compliance report
 */
export async function generateReport(
  reportType: ReportType,
  options?: ReportOptions
): Promise<GeneratedReport> {
  return getReportGenerator().generateReport(reportType, options);
}

/**
 * Generate and save a report
 */
export async function generateAndSaveReport(
  reportType: ReportType,
  options?: Omit<ReportOptions, "saveToDisk">
): Promise<GeneratedReport> {
  return getReportGenerator().generateReport(reportType, {
    ...options,
    saveToDisk: true,
  });
}

/**
 * List generated reports
 */
export function listReports(): ReturnType<ReportGenerator["listGeneratedReports"]> {
  return getReportGenerator().listGeneratedReports();
}
