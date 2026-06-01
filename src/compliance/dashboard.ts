/**
 * Compliance Dashboard
 *
 * Provides a unified view of compliance status across all regulations.
 * Aggregates data from all compliance components for reporting.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import { getComplianceLogger } from "./compliance-logger.js";
import { getConsentManager } from "./consent-manager.js";
import { getDataInventory } from "./data-inventory.js";
import { getRetentionEngine } from "./retention-engine.js";
import { getDataErasureManager } from "./data-erasure.js";
import { getDSARHandler } from "./dsar-handler.js";
import { getAlertManager } from "./alert-manager.js";
import { getBreachDetector } from "./breach-detection.js";
import { getIncidentManager } from "./incident-manager.js";
import { getHealthMonitor } from "./health-monitor.js";
import { getChangeLog } from "./change-log.js";
import { getPolicyDocManager } from "./policy-docs.js";
import type { IncidentType, IncidentSeverity, IncidentStatus } from "./types.js";

/**
 * Dashboard data structure
 */
export interface DashboardData {
  generated_at: string;
  overall_status: "compliant" | "at_risk" | "non_compliant";
  health: HealthSummary;
  gdpr: GDPRDashboard;
  soc2: SOC2Dashboard;
  cssf: CSSFDashboard;
  security: SecurityDashboard;
  recent_activity: RecentActivity;
}

/**
 * Health summary
 */
interface HealthSummary {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  uptime_seconds: number;
  uptime_formatted: string;
  last_check?: string;
  components_up: number;
  components_down: number;
  components_degraded: number;
}

/**
 * GDPR compliance dashboard
 */
interface GDPRDashboard {
  status: "compliant" | "at_risk" | "non_compliant";
  consent: {
    valid_consents: number;
    expired_consents: number;
    total_purposes: number;
  };
  data_inventory: {
    total_categories: number;
    exportable: number;
    erasable: number;
  };
  data_subjects: {
    pending_dsars: number;
    completed_dsars_30d: number;
    pending_erasures: number;
    completed_erasures_30d: number;
  };
  retention: {
    active_policies: number;
    items_due_for_deletion: number;
    last_cleanup?: string;
  };
}

/**
 * SOC2 compliance dashboard
 */
interface SOC2Dashboard {
  status: "compliant" | "at_risk" | "non_compliant";
  availability: {
    current_status: string;
    // True availability % requires downtime/incident-duration accounting that is
    // not tracked (health-monitor only exposes process uptime_seconds). Reported
    // as null + a flag rather than a hardcoded SOC2 figure derived from the
    // instantaneous health status, which would misrepresent a measured control.
    uptime_percentage: number | null;
    uptime_percentage_measured: boolean;
    last_incident?: string;
  };
  security: {
    encryption_enabled: boolean;
    auth_enabled: boolean;
    cert_pinning_enabled: boolean;
    open_incidents: number;
  };
  change_management: {
    changes_30d: number;
    high_impact_changes_30d: number;
    pending_approvals: number;
  };
  logging: {
    audit_enabled: boolean;
    compliance_logging_enabled: boolean;
    integrity_valid: boolean;
  };
}

/**
 * CSSF compliance dashboard
 */
interface CSSFDashboard {
  status: "compliant" | "at_risk" | "non_compliant";
  audit_trail: {
    enabled: boolean;
    retention_years: number;
    total_events: number;
    integrity_valid: boolean;
  };
  incident_response: {
    documented_procedures: boolean;
    open_incidents: number;
    mean_time_to_respond_hours?: number;
  };
  policies: {
    total_policies: number;
    enforced_policies: number;
    due_for_review: number;
  };
}

/**
 * Security dashboard
 */
interface SecurityDashboard {
  status: "secure" | "at_risk" | "compromised";
  incidents: {
    total_incidents: number;
    open_incidents: number;
    by_severity: Record<IncidentSeverity, number>;
    by_status: Record<IncidentStatus, number>;
    by_type: Record<IncidentType, number>;
  };
  alerts: {
    // Counts of alerts sent in the last 24h, measured from AlertManager's
    // in-process rolling window (resets on restart). Honest, not estimated.
    total_24h: number;
    critical_24h: number;
    // No acknowledgment workflow exists, so this cannot be measured. Reported
    // as null rather than a fabricated 0 so auditors are not misled.
    unacknowledged: number | null;
    unacknowledged_tracked: boolean;
  };
  breach_detection: {
    enabled: boolean;
    active_rules: number;
    blocked_patterns: number;
  };
}

/**
 * Recent activity
 */
interface RecentActivity {
  recent_events: Array<{
    timestamp: string;
    type: string;
    description: string;
    severity: string;
  }>;
  recent_changes: Array<{
    timestamp: string;
    component: string;
    setting: string;
    impact: string;
  }>;
  recent_alerts: Array<{
    timestamp: string;
    severity: string;
    title: string;
    acknowledged: boolean;
  }>;
}

/**
 * Compliance Dashboard class
 */
export class ComplianceDashboard {
  private static instance: ComplianceDashboard;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): ComplianceDashboard {
    if (!ComplianceDashboard.instance) {
      ComplianceDashboard.instance = new ComplianceDashboard();
    }
    return ComplianceDashboard.instance;
  }

  /**
   * Generate full dashboard data
   */
  public async generateDashboard(): Promise<DashboardData> {
    const [health, gdpr, soc2, cssf, security, recentActivity] = await Promise.all([
      this.getHealthSummary(),
      this.getGDPRDashboard(),
      this.getSOC2Dashboard(),
      this.getCSSFDashboard(),
      this.getSecurityDashboard(),
      this.getRecentActivity(),
    ]);

    // Determine overall status
    const statuses = [gdpr.status, soc2.status, cssf.status];
    let overallStatus: DashboardData["overall_status"];

    if (statuses.includes("non_compliant")) {
      overallStatus = "non_compliant";
    } else if (statuses.includes("at_risk")) {
      overallStatus = "at_risk";
    } else {
      overallStatus = "compliant";
    }

    return {
      generated_at: new Date().toISOString(),
      overall_status: overallStatus,
      health,
      gdpr,
      soc2,
      cssf,
      security,
      recent_activity: recentActivity,
    };
  }

  /**
   * Get health summary
   */
  private async getHealthSummary(): Promise<HealthSummary> {
    const monitor = getHealthMonitor();
    const status = monitor.getStatus();
    const metrics = monitor.getLastMetrics();

    let componentsUp = 0;
    let componentsDown = 0;
    let componentsDegraded = 0;

    if (metrics) {
      for (const component of metrics.components) {
        if (component.status === "up") componentsUp++;
        else if (component.status === "down") componentsDown++;
        else componentsDegraded++;
      }
    }

    return {
      status: status.status,
      uptime_seconds: status.uptime_seconds,
      uptime_formatted: monitor.getUptimeFormatted(),
      last_check: status.last_check,
      components_up: componentsUp,
      components_down: componentsDown,
      components_degraded: componentsDegraded,
    };
  }

  /**
   * Get GDPR dashboard
   */
  private async getGDPRDashboard(): Promise<GDPRDashboard> {
    const consentManager = getConsentManager();
    const dataInventory = getDataInventory();
    const retentionEngine = getRetentionEngine();
    const erasureManager = getDataErasureManager();
    const dsarHandler = getDSARHandler();

    // Get consent data
    const consents = await consentManager.getActiveConsents();
    const validation = await consentManager.validateConsents();
    const now = new Date();
    const validConsents = consents.filter(c => !c.revoked && (!c.expires_at || new Date(c.expires_at) > now)).length;
    const expiredConsents = consents.filter(c => c.revoked || (c.expires_at && new Date(c.expires_at) <= now)).length;

    // Get data inventory
    const inventory = await dataInventory.getAll();
    const exportable = await dataInventory.getExportable();
    const erasable = await dataInventory.getErasable();

    // Get DSAR summary
    const dsarSummary = await dsarHandler.getStatistics();

    // Get erasure requests
    const pendingErasures = await erasureManager.getPendingRequests();

    // Get retention status
    const retentionStatus = await retentionEngine.getStatus();

    // Determine status
    let status: GDPRDashboard["status"] = "compliant";
    if (!validation.valid || pendingErasures.length > 5) {
      status = "at_risk";
    }
    // Check if any pending requests
    if (dsarSummary.pending_requests > 5) {
      status = "non_compliant";
    }

    return {
      status,
      consent: {
        valid_consents: validConsents,
        expired_consents: expiredConsents,
        total_purposes: consents.length,
      },
      data_inventory: {
        total_categories: inventory.length,
        exportable: exportable.length,
        erasable: erasable.length,
      },
      data_subjects: {
        pending_dsars: dsarSummary.pending_requests,
        completed_dsars_30d: dsarSummary.completed_requests,
        pending_erasures: pendingErasures.length,
        completed_erasures_30d: 0, // Would need historical tracking
      },
      retention: {
        active_policies: retentionStatus.active_policies,
        items_due_for_deletion: retentionStatus.next_due.length,
        last_cleanup: Object.values(retentionStatus.last_runs)[0],
      },
    };
  }

  /**
   * Get SOC2 dashboard
   */
  private async getSOC2Dashboard(): Promise<SOC2Dashboard> {
    const monitor = getHealthMonitor();
    const incidentManager = getIncidentManager();
    const changeLog = getChangeLog();
    const complianceLogger = getComplianceLogger();

    // Get health metrics
    const metrics = monitor.getLastMetrics();
    const security = metrics?.security || {
      encryption_enabled: false,
      auth_enabled: false,
      cert_pinning_enabled: false,
      open_incidents: 0,
    };

    // Get incident data
    const openIncidents = await incidentManager.getOpenIncidents();
    const lastIncident = openIncidents[0]?.detected_at;

    // Get change data (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const changes = await changeLog.getChangesInRange(thirtyDaysAgo, new Date());
    const highImpactChanges = changes.filter(c => c.impact === "high");
    const pendingApprovals = changes.filter(c => c.requires_approval && !c.approved_by);

    // Get logging status
    const loggerStats = await complianceLogger.getStats();
    const integrity = await complianceLogger.verifyIntegrity();

    // Availability percentage is intentionally NOT computed: there is no
    // downtime/incident-duration tracking, so any number here would be a
    // fabricated SOC2 metric. Report null + measured=false instead.

    // Determine status
    let status: SOC2Dashboard["status"] = "compliant";
    if (!security.encryption_enabled || openIncidents.length > 0) {
      status = "at_risk";
    }
    if (!integrity.valid || pendingApprovals.length > 10) {
      status = "non_compliant";
    }

    return {
      status,
      availability: {
        current_status: metrics?.status || "unknown",
        uptime_percentage: null,
        uptime_percentage_measured: false,
        last_incident: lastIncident,
      },
      security: {
        encryption_enabled: security.encryption_enabled,
        auth_enabled: security.auth_enabled,
        cert_pinning_enabled: security.cert_pinning_enabled,
        open_incidents: openIncidents.length,
      },
      change_management: {
        changes_30d: changes.length,
        high_impact_changes_30d: highImpactChanges.length,
        pending_approvals: pendingApprovals.length,
      },
      logging: {
        audit_enabled: loggerStats.enabled,
        compliance_logging_enabled: loggerStats.enabled,
        integrity_valid: integrity.valid,
      },
    };
  }

  /**
   * Get CSSF dashboard
   */
  private async getCSSFDashboard(): Promise<CSSFDashboard> {
    const complianceLogger = getComplianceLogger();
    const incidentManager = getIncidentManager();
    const policyManager = getPolicyDocManager();

    // Get audit trail status
    const loggerStats = await complianceLogger.getStats();
    const integrity = await complianceLogger.verifyIntegrity();

    // Get incident statistics
    const openIncidents = await incidentManager.getOpenIncidents();

    // Get policy status
    const policySummary = await policyManager.getPolicySummary();
    const dueForReview = await policyManager.getPoliciesDueForReview();

    // Calculate MTTR (Mean Time To Respond)
    let mttrHours: number | undefined;
    // Would need incident resolution data for accurate MTTR

    // Determine status
    let status: CSSFDashboard["status"] = "compliant";
    if (!integrity.valid || dueForReview.length > 2) {
      status = "at_risk";
    }
    if (!loggerStats.enabled || openIncidents.length > 5) {
      status = "non_compliant";
    }

    return {
      status,
      audit_trail: {
        enabled: loggerStats.enabled,
        retention_years: 7, // CSSF requirement
        total_events: loggerStats.totalEvents,
        integrity_valid: integrity.valid,
      },
      incident_response: {
        documented_procedures: true, // We have incident manager
        open_incidents: openIncidents.length,
        mean_time_to_respond_hours: mttrHours,
      },
      policies: {
        total_policies: policySummary.total_policies,
        enforced_policies: policySummary.enforced_policies,
        due_for_review: policySummary.due_for_review,
      },
    };
  }

  /**
   * Get security dashboard
   */
  private async getSecurityDashboard(): Promise<SecurityDashboard> {
    const incidentManager = getIncidentManager();
    const alertManager = getAlertManager();
    const breachDetector = getBreachDetector();

    // Get incident statistics
    const incidentStats = await incidentManager.getStatistics();

    // Get alert statistics
    const alertStats = alertManager.getStats();

    // Get breach detection status
    const breachRules = await breachDetector.getRules();
    const blockedPatterns = breachRules.filter(r =>
      r.actions.includes("block")
    ).length;

    // Determine status
    let status: SecurityDashboard["status"] = "secure";
    const openIncidents = incidentStats.by_status.open +
                         incidentStats.by_status.investigating;

    if (openIncidents > 0 || alertStats.alerts_this_hour > 0) {
      status = "at_risk";
    }
    if (incidentStats.by_severity.critical > 0) {
      status = "compromised";
    }

    return {
      status,
      incidents: {
        total_incidents: incidentStats.total_incidents,
        open_incidents: incidentStats.open_incidents,
        by_severity: incidentStats.by_severity,
        by_status: incidentStats.by_status,
        by_type: incidentStats.by_type,
      },
      alerts: {
        // Real 24h counts from AlertManager's rolling window (not an estimate).
        total_24h: alertStats.alerts_24h,
        critical_24h: alertStats.critical_24h,
        // No acknowledgment model exists — report not-tracked rather than a fake 0.
        unacknowledged: null,
        unacknowledged_tracked: false,
      },
      breach_detection: {
        enabled: true,
        active_rules: breachRules.length,
        blocked_patterns: blockedPatterns,
      },
    };
  }

  /**
   * Get recent activity
   */
  private async getRecentActivity(): Promise<RecentActivity> {
    const complianceLogger = getComplianceLogger();
    const changeLog = getChangeLog();

    // Get recent events
    const events = await complianceLogger.getEvents(undefined, undefined, undefined, 10);
    const recentEvents = events.map(e => ({
      timestamp: e.timestamp,
      type: e.category,
      description: e.event_type,
      severity: e.outcome,
    }));

    // Get recent changes
    const changes = await changeLog.getAllChanges(10);
    const recentChanges = changes.map(c => ({
      timestamp: c.timestamp,
      component: c.component,
      setting: c.setting,
      impact: c.impact,
    }));

    // No recent alerts API, return empty
    const recentAlerts: Array<{
      timestamp: string;
      severity: string;
      title: string;
      acknowledged: boolean;
    }> = [];

    return {
      recent_events: recentEvents,
      recent_changes: recentChanges,
      recent_alerts: recentAlerts,
    };
  }

  /**
   * Get compliance score (0-100)
   */
  public async getComplianceScore(): Promise<{
    overall: number;
    gdpr: number;
    soc2: number;
    cssf: number;
    breakdown: Record<string, number>;
  }> {
    const dashboard = await this.generateDashboard();

    // Score each regulation
    const gdprScore = this.calculateRegulationScore(dashboard.gdpr.status);
    const soc2Score = this.calculateRegulationScore(dashboard.soc2.status);
    const cssfScore = this.calculateRegulationScore(dashboard.cssf.status);

    // Calculate overall (weighted average)
    const overall = Math.round((gdprScore + soc2Score + cssfScore) / 3);

    // Detailed breakdown
    const breakdown: Record<string, number> = {
      consent_management: dashboard.gdpr.consent.expired_consents === 0 ? 100 : 70,
      data_inventory: dashboard.gdpr.data_inventory.total_categories > 0 ? 100 : 50,
      dsar_handling: dashboard.gdpr.data_subjects.pending_dsars === 0 ? 100 : 80,
      encryption: dashboard.soc2.security.encryption_enabled ? 100 : 0,
      audit_logging: dashboard.soc2.logging.audit_enabled ? 100 : 0,
      incident_response: dashboard.security.incidents.total_incidents === 0 ? 100 : 60,
      policy_management: dashboard.cssf.policies.due_for_review === 0 ? 100 : 70,
    };

    return {
      overall,
      gdpr: gdprScore,
      soc2: soc2Score,
      cssf: cssfScore,
      breakdown,
    };
  }

  /**
   * Calculate score from status
   */
  private calculateRegulationScore(
    status: "compliant" | "at_risk" | "non_compliant"
  ): number {
    switch (status) {
      case "compliant":
        return 100;
      case "at_risk":
        return 70;
      case "non_compliant":
        return 30;
      default:
        return 0;
    }
  }

  /**
   * Get compliance summary for CLI display
   */
  public async getSummaryForCLI(): Promise<string> {
    const dashboard = await this.generateDashboard();
    const score = await this.getComplianceScore();

    const lines: string[] = [
      "═══════════════════════════════════════════════════════════════",
      "                    COMPLIANCE DASHBOARD",
      "═══════════════════════════════════════════════════════════════",
      "",
      `  Overall Status: ${this.formatStatus(dashboard.overall_status)}`,
      `  Compliance Score: ${score.overall}%`,
      `  Generated: ${new Date(dashboard.generated_at).toLocaleString()}`,
      "",
      "───────────────────────────────────────────────────────────────",
      "  REGULATION STATUS",
      "───────────────────────────────────────────────────────────────",
      "",
      `  GDPR:  ${this.formatStatus(dashboard.gdpr.status)} (${score.gdpr}%)`,
      `    • Valid Consents: ${dashboard.gdpr.consent.valid_consents}`,
      `    • Pending DSARs: ${dashboard.gdpr.data_subjects.pending_dsars}`,
      `    • Pending Erasures: ${dashboard.gdpr.data_subjects.pending_erasures}`,
      "",
      `  SOC2:  ${this.formatStatus(dashboard.soc2.status)} (${score.soc2}%)`,
      `    • Encryption: ${dashboard.soc2.security.encryption_enabled ? "Enabled" : "DISABLED"}`,
      `    • Audit Logging: ${dashboard.soc2.logging.audit_enabled ? "Enabled" : "DISABLED"}`,
      `    • Open Incidents: ${dashboard.soc2.security.open_incidents}`,
      "",
      `  CSSF:  ${this.formatStatus(dashboard.cssf.status)} (${score.cssf}%)`,
      `    • Audit Trail: ${dashboard.cssf.audit_trail.enabled ? "Enabled" : "DISABLED"}`,
      `    • Policies: ${dashboard.cssf.policies.total_policies} (${dashboard.cssf.policies.due_for_review} due for review)`,
      "",
      "───────────────────────────────────────────────────────────────",
      "  SYSTEM HEALTH",
      "───────────────────────────────────────────────────────────────",
      "",
      `  Status: ${this.formatHealthStatus(dashboard.health.status)}`,
      `  Uptime: ${dashboard.health.uptime_formatted}`,
      `  Components: ${dashboard.health.components_up} up, ${dashboard.health.components_down} down, ${dashboard.health.components_degraded} degraded`,
      "",
      "───────────────────────────────────────────────────────────────",
      "  SECURITY",
      "───────────────────────────────────────────────────────────────",
      "",
      `  Status: ${this.formatSecurityStatus(dashboard.security.status)}`,
      `  Open Incidents: ${dashboard.security.incidents.open_incidents}`,
      `  Alerts (24h): ${dashboard.security.alerts.total_24h} (${dashboard.security.alerts.critical_24h} critical)`,
      `  Breach Detection Rules: ${dashboard.security.breach_detection.active_rules}`,
      "",
      "═══════════════════════════════════════════════════════════════",
    ];

    return lines.join("\n");
  }

  /**
   * Format compliance status for display
   */
  private formatStatus(status: string): string {
    switch (status) {
      case "compliant":
        return "[COMPLIANT]";
      case "at_risk":
        return "[AT RISK]";
      case "non_compliant":
        return "[NON-COMPLIANT]";
      default:
        return `[${status.toUpperCase()}]`;
    }
  }

  /**
   * Format health status for display
   */
  private formatHealthStatus(status: string): string {
    switch (status) {
      case "healthy":
        return "[HEALTHY]";
      case "degraded":
        return "[DEGRADED]";
      case "unhealthy":
        return "[UNHEALTHY]";
      default:
        return "[UNKNOWN]";
    }
  }

  /**
   * Format security status for display
   */
  private formatSecurityStatus(status: string): string {
    switch (status) {
      case "secure":
        return "[SECURE]";
      case "at_risk":
        return "[AT RISK]";
      case "compromised":
        return "[COMPROMISED]";
      default:
        return `[${status.toUpperCase()}]`;
    }
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the compliance dashboard instance
 */
export function getComplianceDashboard(): ComplianceDashboard {
  return ComplianceDashboard.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Generate full dashboard data
 */
export async function generateDashboard(): Promise<DashboardData> {
  return getComplianceDashboard().generateDashboard();
}

/**
 * Get compliance score
 */
export async function getComplianceScore(): Promise<
  ReturnType<ComplianceDashboard["getComplianceScore"]>
> {
  return getComplianceDashboard().getComplianceScore();
}

/**
 * Get CLI summary
 */
export async function getDashboardCLI(): Promise<string> {
  return getComplianceDashboard().getSummaryForCLI();
}
