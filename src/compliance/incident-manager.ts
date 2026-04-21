/**
 * Incident Manager
 *
 * Tracks and manages security incidents.
 * Implements incident lifecycle management for SOC2 compliance.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { CONFIG } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getAlertManager } from "./alert-manager.js";
import type {
  SecurityIncident,
  IncidentType,
  IncidentStatus,
  IncidentSeverity,
  IncidentAction,
} from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Incident Manager class
 */
export class IncidentManager {
  private static instance: IncidentManager;
  private incidentsFile: string;
  private incidents: Map<string, SecurityIncident> = new Map();
  private loaded: boolean = false;

  private constructor() {
    const config = CONFIG;
    this.incidentsFile = path.join(config.dataDir, "compliance", "incidents.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): IncidentManager {
    if (!IncidentManager.instance) {
      IncidentManager.instance = new IncidentManager();
    }
    return IncidentManager.instance;
  }

  /**
   * Load incidents from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.incidentsFile)) {
        const content = fs.readFileSync(this.incidentsFile, "utf-8");
        const data = JSON.parse(content);
        if (data.incidents && Array.isArray(data.incidents)) {
          for (const incident of data.incidents) {
            this.incidents.set(incident.id, incident);
          }
        }
      }
    } catch (err) {
      log.debug(`incident-manager: load incidents from file: ${err instanceof Error ? err.message : String(err)}`);
      this.incidents = new Map();
    }

    this.loaded = true;
  }

  /**
   * Save incidents to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.incidentsFile);
    mkdirSecure(dir);

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      incidents: Array.from(this.incidents.values()),
    };

    writeFileSecure(this.incidentsFile, JSON.stringify(data, null, 2));
  }

  /**
   * Create a new incident
   */
  public async createIncident(
    type: IncidentType,
    severity: IncidentSeverity,
    title: string,
    description: string,
    options: {
      affected_data?: string[];
      affected_systems?: string[];
      related_events?: string[];
      notification_required?: boolean;
    } = {}
  ): Promise<SecurityIncident> {
    await this.load();

    const now = new Date().toISOString();

    const incident: SecurityIncident = {
      id: `INC-${Date.now().toString(36).toUpperCase()}-${generateUUID().slice(0, 4).toUpperCase()}`,
      type,
      severity,
      status: "open",
      detected_at: now,
      title,
      description,
      affected_data: options.affected_data || [],
      affected_systems: options.affected_systems || ["notebooklm-mcp"],
      actions_taken: [
        {
          timestamp: now,
          action: "Incident created",
          performed_by: "system",
        },
      ],
      notification_required: options.notification_required ?? this.isNotificationRequired(severity, type),
      related_events: options.related_events || [],
    };

    // Set notification deadline for critical/high severity
    if (incident.notification_required) {
      const deadline = new Date();
      deadline.setHours(deadline.getHours() + 72); // GDPR 72-hour requirement
      incident.notification_deadline = deadline.toISOString();
    }

    this.incidents.set(incident.id, incident);
    await this.save();

    // Log the incident creation
    const logger = getComplianceLogger();
    await logger.logSecurityIncident(
      "incident_created",
      severity,
      {
        incident_id: incident.id,
        type,
        title,
        notification_required: incident.notification_required,
      }
    );

    // Alert for high/critical severity
    if (severity === "high" || severity === "critical") {
      const alertManager = getAlertManager();
      // Map incident severity to alert severity
      const alertSeverity = severity === "high" ? "error" : "critical";
      await alertManager.sendAlert(
        alertSeverity,
        `Security Incident: ${title}`,
        description,
        "incident-manager",
        {
          incident_id: incident.id,
          type,
          status: "open",
        }
      );
    }

    return incident;
  }

  /**
   * Determine if notification is required based on severity and type
   */
  private isNotificationRequired(severity: IncidentSeverity, type: IncidentType): boolean {
    // Critical severity always requires notification
    if (severity === "critical") return true;

    // Data breach always requires notification
    if (type === "data_breach") return true;

    // Unauthorized access with high severity requires notification
    if (type === "unauthorized_access" && severity === "high") return true;

    return false;
  }

  /**
   * Update incident status
   */
  public async updateStatus(
    incidentId: string,
    status: IncidentStatus,
    notes?: string,
    performedBy: string = "system"
  ): Promise<SecurityIncident | null> {
    await this.load();

    const incident = this.incidents.get(incidentId);
    if (!incident) return null;

    const now = new Date().toISOString();
    const previousStatus = incident.status;
    incident.status = status;

    // Update timestamps based on status
    switch (status) {
      case "investigating":
        incident.reported_at = incident.reported_at || now;
        break;
      case "contained":
        incident.contained_at = now;
        break;
      case "resolved":
        incident.resolved_at = now;
        break;
      case "closed":
        incident.closed_at = now;
        break;
    }

    // Add action record
    incident.actions_taken.push({
      timestamp: now,
      action: `Status changed from ${previousStatus} to ${status}`,
      performed_by: performedBy,
      notes,
    });

    await this.save();

    // Log the status change
    const logger = getComplianceLogger();
    await logger.logSecurityIncident(
      "incident_status_changed",
      incident.severity,
      {
        incident_id: incidentId,
        previous_status: previousStatus,
        new_status: status,
        notes,
      }
    );

    return incident;
  }

  /**
   * Add action to incident
   */
  public async addAction(
    incidentId: string,
    action: string,
    performedBy: string = "system",
    notes?: string
  ): Promise<SecurityIncident | null> {
    await this.load();

    const incident = this.incidents.get(incidentId);
    if (!incident) return null;

    const actionRecord: IncidentAction = {
      timestamp: new Date().toISOString(),
      action,
      performed_by: performedBy,
      notes,
    };

    incident.actions_taken.push(actionRecord);
    await this.save();

    return incident;
  }

  /**
   * Set root cause analysis
   */
  public async setRootCause(
    incidentId: string,
    rootCause: string,
    remediation: string
  ): Promise<SecurityIncident | null> {
    await this.load();

    const incident = this.incidents.get(incidentId);
    if (!incident) return null;

    incident.root_cause = rootCause;
    incident.remediation = remediation;

    incident.actions_taken.push({
      timestamp: new Date().toISOString(),
      action: "Root cause analysis completed",
      performed_by: "system",
      notes: rootCause,
    });

    await this.save();

    return incident;
  }

  /**
   * Mark notification as sent
   */
  public async markNotificationSent(incidentId: string): Promise<SecurityIncident | null> {
    await this.load();

    const incident = this.incidents.get(incidentId);
    if (!incident) return null;

    incident.notification_sent = true;

    incident.actions_taken.push({
      timestamp: new Date().toISOString(),
      action: "Notification sent to relevant parties",
      performed_by: "system",
    });

    await this.save();

    // Log the notification
    const logger = getComplianceLogger();
    await logger.logSecurityIncident(
      "incident_notification_sent",
      incident.severity,
      {
        incident_id: incidentId,
        notification_deadline: incident.notification_deadline,
      }
    );

    return incident;
  }

  /**
   * Get incident by ID
   */
  public async getIncident(incidentId: string): Promise<SecurityIncident | null> {
    await this.load();
    return this.incidents.get(incidentId) || null;
  }

  /**
   * Get all incidents
   */
  public async getAllIncidents(): Promise<SecurityIncident[]> {
    await this.load();
    return Array.from(this.incidents.values());
  }

  /**
   * Get open incidents
   */
  public async getOpenIncidents(): Promise<SecurityIncident[]> {
    await this.load();
    return Array.from(this.incidents.values()).filter(
      i => i.status === "open" || i.status === "investigating" || i.status === "contained"
    );
  }

  /**
   * Get incidents requiring notification
   */
  public async getIncidentsRequiringNotification(): Promise<SecurityIncident[]> {
    await this.load();
    return Array.from(this.incidents.values()).filter(
      i => i.notification_required && !i.notification_sent
    );
  }

  /**
   * Get incidents approaching notification deadline
   */
  public async getIncidentsNearDeadline(hoursRemaining: number = 24): Promise<SecurityIncident[]> {
    await this.load();

    const now = new Date();
    const deadline = new Date(now.getTime() + hoursRemaining * 60 * 60 * 1000);

    return Array.from(this.incidents.values()).filter(i => {
      if (!i.notification_required || i.notification_sent) return false;
      if (!i.notification_deadline) return false;

      const incidentDeadline = new Date(i.notification_deadline);
      return incidentDeadline <= deadline && incidentDeadline > now;
    });
  }

  /**
   * Get incidents by type
   */
  public async getIncidentsByType(type: IncidentType): Promise<SecurityIncident[]> {
    await this.load();
    return Array.from(this.incidents.values()).filter(i => i.type === type);
  }

  /**
   * Get incidents by severity
   */
  public async getIncidentsBySeverity(severity: IncidentSeverity): Promise<SecurityIncident[]> {
    await this.load();
    return Array.from(this.incidents.values()).filter(i => i.severity === severity);
  }

  /**
   * Get incident statistics
   */
  public async getStatistics(): Promise<{
    total_incidents: number;
    open_incidents: number;
    closed_incidents: number;
    by_type: Record<IncidentType, number>;
    by_severity: Record<IncidentSeverity, number>;
    by_status: Record<IncidentStatus, number>;
    pending_notifications: number;
    average_resolution_hours?: number;
  }> {
    await this.load();

    const incidents = Array.from(this.incidents.values());

    const byType: Record<IncidentType, number> = {
      unauthorized_access: 0,
      data_breach: 0,
      malware: 0,
      dos_attack: 0,
      policy_violation: 0,
      data_loss: 0,
      configuration_error: 0,
      other: 0,
    };

    const bySeverity: Record<IncidentSeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    const byStatus: Record<IncidentStatus, number> = {
      open: 0,
      investigating: 0,
      contained: 0,
      resolved: 0,
      closed: 0,
    };

    let totalResolutionHours = 0;
    let resolvedCount = 0;

    for (const incident of incidents) {
      byType[incident.type]++;
      bySeverity[incident.severity]++;
      byStatus[incident.status]++;

      // Calculate resolution time
      if (incident.resolved_at && incident.detected_at) {
        const detected = new Date(incident.detected_at);
        const resolved = new Date(incident.resolved_at);
        totalResolutionHours += (resolved.getTime() - detected.getTime()) / (1000 * 60 * 60);
        resolvedCount++;
      }
    }

    const pendingNotifications = incidents.filter(
      i => i.notification_required && !i.notification_sent
    ).length;

    return {
      total_incidents: incidents.length,
      open_incidents: incidents.filter(i =>
        i.status === "open" || i.status === "investigating" || i.status === "contained"
      ).length,
      closed_incidents: incidents.filter(i => i.status === "closed").length,
      by_type: byType,
      by_severity: bySeverity,
      by_status: byStatus,
      pending_notifications: pendingNotifications,
      average_resolution_hours: resolvedCount > 0
        ? Math.round((totalResolutionHours / resolvedCount) * 100) / 100
        : undefined,
    };
  }

  /**
   * Export incidents for reporting
   */
  public async exportIncidents(
    from?: Date,
    to?: Date
  ): Promise<SecurityIncident[]> {
    await this.load();

    let incidents = Array.from(this.incidents.values());

    if (from) {
      incidents = incidents.filter(i => new Date(i.detected_at) >= from);
    }

    if (to) {
      incidents = incidents.filter(i => new Date(i.detected_at) <= to);
    }

    return incidents.sort((a, b) =>
      new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
    );
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the incident manager instance
 */
export function getIncidentManager(): IncidentManager {
  return IncidentManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Create a new incident
 */
export async function createIncident(
  type: IncidentType,
  severity: IncidentSeverity,
  title: string,
  description: string,
  options?: {
    affected_data?: string[];
    affected_systems?: string[];
    related_events?: string[];
    notification_required?: boolean;
  }
): Promise<SecurityIncident> {
  return getIncidentManager().createIncident(type, severity, title, description, options);
}

/**
 * Get all open incidents
 */
export async function getOpenIncidents(): Promise<SecurityIncident[]> {
  return getIncidentManager().getOpenIncidents();
}

/**
 * Update incident status
 */
export async function updateIncidentStatus(
  incidentId: string,
  status: IncidentStatus,
  notes?: string
): Promise<SecurityIncident | null> {
  return getIncidentManager().updateStatus(incidentId, status, notes);
}

/**
 * Get incident statistics
 */
export async function getIncidentStatistics(): Promise<ReturnType<IncidentManager["getStatistics"]>> {
  return getIncidentManager().getStatistics();
}
