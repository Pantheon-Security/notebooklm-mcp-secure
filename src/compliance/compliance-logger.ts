/**
 * Compliance Logger
 *
 * Structured logging for compliance events, separate from operational audit logs.
 * Implements hash-chaining for tamper detection and supports 7-year retention (CSSF).
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { mkdirSecure, appendFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import { getConfig } from "../config.js";
import type {
  ComplianceEvent,
  ComplianceEventCategory,
  ComplianceActor,
  ComplianceResource,
  LegalBasis,
  DataCategory,
} from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Compute SHA-256 hash
 */
function computeHash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Mask IP address (zero last octet for privacy)
 */
function maskIP(ip: string): string {
  if (!ip) return "";

  // IPv4
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      parts[3] = "0";
      return parts.join(".");
    }
  }

  // IPv6 - mask last segment
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length > 0) {
      parts[parts.length - 1] = "0";
      return parts.join(":");
    }
  }

  return ip;
}

/**
 * Compliance Logger class
 */
export class ComplianceLogger {
  private static instance: ComplianceLogger;
  private complianceDir: string;
  private enabled: boolean;
  private retentionYears: number;
  private lastHash: string = "0".repeat(64); // Genesis hash

  private constructor() {
    const config = getConfig();
    const envEnabled = process.env.NLMCP_COMPLIANCE_ENABLED;

    this.enabled = envEnabled !== undefined
      ? envEnabled.toLowerCase() === "true"
      : true; // Enabled by default

    this.complianceDir = process.env.NLMCP_COMPLIANCE_DIR ||
      path.join(config.dataDir, "compliance");

    this.retentionYears = parseInt(
      process.env.NLMCP_COMPLIANCE_RETENTION_YEARS || "7",
      10
    );

    if (this.enabled) {
      this.ensureComplianceDir();
      this.loadLastHash();
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ComplianceLogger {
    if (!ComplianceLogger.instance) {
      ComplianceLogger.instance = new ComplianceLogger();
    }
    return ComplianceLogger.instance;
  }

  /**
   * Ensure compliance directory exists
   */
  private ensureComplianceDir(): void {
    mkdirSecure(this.complianceDir);
  }

  /**
   * Get the current log file path (monthly rotation)
   */
  private getLogFilePath(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return path.join(this.complianceDir, `events-${year}-${month}.jsonl`);
  }

  /**
   * Load the last hash from the current log file
   */
  private loadLastHash(): void {
    try {
      const logPath = this.getLogFilePath();
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf-8");
        const lines = content.trim().split("\n").filter(line => line);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          const lastEvent = JSON.parse(lastLine) as ComplianceEvent;
          this.lastHash = lastEvent.hash;
        }
      }
    } catch (err) {
      log.debug(`compliance-logger: loadLastHash read log file: ${err instanceof Error ? err.message : String(err)}`);
      // If we can't read the hash, start fresh
      this.lastHash = "0".repeat(64);
    }
  }

  /**
   * Create a compliance event
   */
  private createEvent(
    category: ComplianceEventCategory,
    eventType: string,
    actor: Partial<ComplianceActor>,
    outcome: "success" | "failure" | "pending",
    options: {
      resource?: ComplianceResource;
      details?: Record<string, unknown>;
      legalBasis?: LegalBasis;
      dataCategories?: DataCategory[];
      retentionDays?: number;
      failureReason?: string;
    } = {}
  ): ComplianceEvent {
    const timestamp = new Date().toISOString();

    const event: ComplianceEvent = {
      id: generateUUID(),
      timestamp,
      category,
      event_type: eventType,
      actor: {
        type: actor.type || "system",
        id: actor.id,
        ip: actor.ip ? maskIP(actor.ip) : undefined,
      },
      resource: options.resource,
      details: options.details,
      legal_basis: options.legalBasis,
      data_categories: options.dataCategories,
      retention_days: options.retentionDays || this.retentionYears * 365,
      outcome,
      failure_reason: options.failureReason,
      hash: "", // Will be computed
      previous_hash: this.lastHash,
    };

    // Compute hash (exclude hash field itself)
    const hashInput = JSON.stringify({
      ...event,
      hash: undefined,
    });
    event.hash = computeHash(hashInput);
    this.lastHash = event.hash;

    return event;
  }

  /**
   * Write event to log file
   */
  private async writeEvent(event: ComplianceEvent): Promise<void> {
    if (!this.enabled) return;

    const logPath = this.getLogFilePath();
    const line = JSON.stringify(event) + "\n";
    appendFileSecure(logPath, line);
  }

  /**
   * Log a compliance event
   */
  public async log(
    category: ComplianceEventCategory,
    eventType: string,
    actor: Partial<ComplianceActor>,
    outcome: "success" | "failure" | "pending",
    options: {
      resource?: ComplianceResource;
      details?: Record<string, unknown>;
      legalBasis?: LegalBasis;
      dataCategories?: DataCategory[];
      retentionDays?: number;
      failureReason?: string;
    } = {}
  ): Promise<ComplianceEvent> {
    const event = this.createEvent(category, eventType, actor, outcome, options);
    await this.writeEvent(event);
    return event;
  }

  // ============================================
  // CONVENIENCE METHODS
  // ============================================

  /**
   * Log consent event
   */
  public async logConsent(
    action: "granted" | "revoked" | "updated",
    actor: Partial<ComplianceActor>,
    purposes: string[],
    success: boolean,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "consent",
      `consent_${action}`,
      actor,
      success ? "success" : "failure",
      {
        details: { ...details, purposes },
        legalBasis: "consent",
      }
    );
  }

  /**
   * Log data access event
   */
  public async logDataAccess(
    action: "view" | "export" | "delete" | "request",
    actor: Partial<ComplianceActor>,
    dataType: string,
    success: boolean,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "data_access",
      `data_${action}`,
      actor,
      success ? "success" : "failure",
      {
        resource: { type: dataType },
        details,
      }
    );
  }

  /**
   * Log data export event (GDPR Article 20)
   */
  public async logDataExport(
    actor: Partial<ComplianceActor>,
    dataTypes: string[],
    success: boolean,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "data_export",
      "data_portability_export",
      actor,
      success ? "success" : "failure",
      {
        details: { ...details, data_types: dataTypes },
        legalBasis: "consent",
      }
    );
  }

  /**
   * Log data deletion event (GDPR Article 17)
   */
  public async logDataDeletion(
    actor: Partial<ComplianceActor>,
    dataType: string,
    itemCount: number,
    success: boolean,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "data_deletion",
      "erasure_completed",
      actor,
      success ? "success" : "failure",
      {
        resource: { type: dataType },
        details: { ...details, items_deleted: itemCount },
      }
    );
  }

  /**
   * Log security incident
   */
  public async logSecurityIncident(
    incidentType: string,
    severity: "low" | "medium" | "high" | "critical",
    details: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "security_incident",
      incidentType,
      { type: "system" },
      "success",
      {
        details: { ...details, severity },
      }
    );
  }

  /**
   * Log policy change
   */
  public async logPolicyChange(
    setting: string,
    oldValue: unknown,
    newValue: unknown,
    changedBy: "user" | "system" | "admin"
  ): Promise<ComplianceEvent> {
    return this.log(
      "policy_change",
      "configuration_changed",
      { type: changedBy },
      "success",
      {
        resource: { type: "configuration", id: setting },
        details: { old_value: oldValue, new_value: newValue },
      }
    );
  }

  /**
   * Log access control event
   */
  public async logAccessControl(
    action: "login" | "logout" | "auth_failed" | "locked_out",
    actor: Partial<ComplianceActor>,
    success: boolean,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "access_control",
      action,
      actor,
      success ? "success" : "failure",
      { details }
    );
  }

  /**
   * Log retention event
   */
  public async logRetention(
    action: "cleanup" | "archive" | "delete",
    dataType: string,
    itemCount: number,
    details?: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "retention",
      `retention_${action}`,
      { type: "system" },
      "success",
      {
        resource: { type: dataType },
        details: { ...details, items_affected: itemCount },
      }
    );
  }

  /**
   * Log breach notification
   */
  public async logBreach(
    breachType: string,
    severity: "low" | "medium" | "high" | "critical",
    notificationSent: boolean,
    details: Record<string, unknown>
  ): Promise<ComplianceEvent> {
    return this.log(
      "breach",
      breachType,
      { type: "system" },
      "success",
      {
        details: {
          ...details,
          severity,
          notification_sent: notificationSent,
        },
      }
    );
  }

  // ============================================
  // RETRIEVAL METHODS
  // ============================================

  /**
   * Get events by category
   */
  public async getEvents(
    category?: ComplianceEventCategory,
    from?: Date,
    to?: Date,
    limit: number = 100
  ): Promise<ComplianceEvent[]> {
    if (!this.enabled) return [];

    const events: ComplianceEvent[] = [];
    const files = this.getLogFiles();

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.trim().split("\n").filter(line => line);

        for (const line of lines) {
          const event = JSON.parse(line) as ComplianceEvent;

          // Filter by category
          if (category && event.category !== category) continue;

          // Filter by date range
          const eventDate = new Date(event.timestamp);
          if (from && eventDate < from) continue;
          if (to && eventDate > to) continue;

          events.push(event);

          if (events.length >= limit) break;
        }

        if (events.length >= limit) break;
      } catch (err) {
        log.debug(`compliance-logger: getEvents read log file: ${err instanceof Error ? err.message : String(err)}`);
        // Skip corrupted files
      }
    }

    return events;
  }

  /**
   * Get log files sorted by date (newest first)
   */
  private getLogFiles(): string[] {
    if (!fs.existsSync(this.complianceDir)) return [];

    const files = fs.readdirSync(this.complianceDir)
      .filter(f => f.startsWith("events-") && f.endsWith(".jsonl"))
      .map(f => path.join(this.complianceDir, f))
      .sort()
      .reverse();

    return files;
  }

  /**
   * Verify hash chain integrity
   */
  public async verifyIntegrity(): Promise<{
    valid: boolean;
    lastValidEvent?: string;
    firstInvalidEvent?: string;
    totalEvents: number;
    validEvents: number;
  }> {
    if (!this.enabled) {
      return { valid: true, totalEvents: 0, validEvents: 0 };
    }

    let totalEvents = 0;
    let validEvents = 0;
    let expectedHash = "0".repeat(64);
    let lastValidEventId: string | undefined;
    let firstInvalidEventId: string | undefined;

    const files = this.getLogFiles().reverse(); // Oldest first

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.trim().split("\n").filter(line => line);

        for (const line of lines) {
          totalEvents++;
          const event = JSON.parse(line) as ComplianceEvent;

          // Verify previous hash link
          if (event.previous_hash !== expectedHash) {
            if (!firstInvalidEventId) {
              firstInvalidEventId = event.id;
            }
            continue;
          }

          // Verify event hash
          const hashInput = JSON.stringify({
            ...event,
            hash: undefined,
          });
          const computedHash = computeHash(hashInput);

          if (computedHash !== event.hash) {
            if (!firstInvalidEventId) {
              firstInvalidEventId = event.id;
            }
            continue;
          }

          validEvents++;
          lastValidEventId = event.id;
          expectedHash = event.hash;
        }
      } catch (err) {
        log.debug(`compliance-logger: verifyIntegrity read log file: ${err instanceof Error ? err.message : String(err)}`);
        // Skip corrupted files
      }
    }

    return {
      valid: validEvents === totalEvents,
      lastValidEvent: lastValidEventId,
      firstInvalidEvent: firstInvalidEventId,
      totalEvents,
      validEvents,
    };
  }

  /**
   * Get compliance log statistics
   */
  public async getStats(): Promise<{
    enabled: boolean;
    retentionYears: number;
    complianceDir: string;
    logFileCount: number;
    totalEvents: number;
    eventsByCategory: Record<ComplianceEventCategory, number>;
  }> {
    const stats: {
      enabled: boolean;
      retentionYears: number;
      complianceDir: string;
      logFileCount: number;
      totalEvents: number;
      eventsByCategory: Record<ComplianceEventCategory, number>;
    } = {
      enabled: this.enabled,
      retentionYears: this.retentionYears,
      complianceDir: this.complianceDir,
      logFileCount: 0,
      totalEvents: 0,
      eventsByCategory: {
        consent: 0,
        data_access: 0,
        data_export: 0,
        data_deletion: 0,
        data_processing: 0,
        security_incident: 0,
        policy_change: 0,
        access_control: 0,
        retention: 0,
        breach: 0,
      },
    };

    if (!this.enabled) return stats;

    const files = this.getLogFiles();
    stats.logFileCount = files.length;

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.trim().split("\n").filter(line => line);

        for (const line of lines) {
          stats.totalEvents++;
          const event = JSON.parse(line) as ComplianceEvent;
          if (event.category in stats.eventsByCategory) {
            stats.eventsByCategory[event.category]++;
          }
        }
      } catch (err) {
        log.debug(`compliance-logger: getStats read log file: ${err instanceof Error ? err.message : String(err)}`);
        // Skip corrupted files
      }
    }

    return stats;
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the compliance logger instance
 */
export function getComplianceLogger(): ComplianceLogger {
  return ComplianceLogger.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Log a compliance event (convenience function)
 */
export async function logComplianceEvent(
  category: ComplianceEventCategory,
  eventType: string,
  actor: Partial<ComplianceActor>,
  outcome: "success" | "failure" | "pending",
  options?: {
    resource?: ComplianceResource;
    details?: Record<string, unknown>;
    legalBasis?: LegalBasis;
    dataCategories?: DataCategory[];
    retentionDays?: number;
    failureReason?: string;
  }
): Promise<ComplianceEvent> {
  return getComplianceLogger().log(category, eventType, actor, outcome, options);
}
