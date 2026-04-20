/**
 * Change Log
 *
 * Tracks all configuration changes for SOC2 compliance.
 * Provides audit trail for system modifications.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { mkdirSecure, appendFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import type { ChangeRecord } from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Change Log class
 */
export class ChangeLog {
  private static instance: ChangeLog;
  private logDir: string;
  private currentLogFile: string = "";

  private constructor() {
    const config = getConfig();
    this.logDir = path.join(config.dataDir, "compliance", "changes");
    mkdirSecure(this.logDir);
    this.initializeLogFile();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ChangeLog {
    if (!ChangeLog.instance) {
      ChangeLog.instance = new ChangeLog();
    }
    return ChangeLog.instance;
  }

  /**
   * Initialize log file for current month
   */
  private initializeLogFile(): void {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    this.currentLogFile = path.join(this.logDir, `changes-${year}-${month}.jsonl`);
  }

  /**
   * Record a configuration change
   */
  public async recordChange(
    component: string,
    setting: string,
    oldValue: unknown,
    newValue: unknown,
    options: {
      changedBy?: "user" | "system" | "admin";
      method?: "cli" | "env" | "api" | "config_file";
      requiresApproval?: boolean;
      approvedBy?: string;
      impact?: "low" | "medium" | "high";
      affectedCompliance?: string[];
    } = {}
  ): Promise<ChangeRecord> {
    // Ensure log file is current
    this.initializeLogFile();

    const record: ChangeRecord = {
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      component,
      setting,
      old_value: this.sanitizeValue(oldValue),
      new_value: this.sanitizeValue(newValue),
      changed_by: options.changedBy || "system",
      method: options.method || "api",
      requires_approval: options.requiresApproval || false,
      approved_by: options.approvedBy,
      approved_at: options.approvedBy ? new Date().toISOString() : undefined,
      impact: options.impact || "low",
      affected_compliance: options.affectedCompliance || [],
    };

    // Write to log file
    const line = JSON.stringify(record) + "\n";
    appendFileSecure(this.currentLogFile, line);

    // Also log to compliance logger
    const logger = getComplianceLogger();
    await logger.logPolicyChange(
      setting,
      oldValue,
      newValue,
      record.changed_by
    );

    return record;
  }

  /**
   * Sanitize value for logging (remove sensitive data)
   */
  private sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      // Check for sensitive patterns
      if (
        /password|secret|token|key|credential|auth/i.test(value) ||
        value.length > 100
      ) {
        return "[REDACTED]";
      }
      return value;
    }

    if (typeof value === "object") {
      return "[object]";
    }

    return value;
  }

  /**
   * Get changes by component
   */
  public async getChangesByComponent(
    component: string,
    limit: number = 100
  ): Promise<ChangeRecord[]> {
    const changes = await this.getAllChanges(limit * 10);
    return changes
      .filter(c => c.component === component)
      .slice(0, limit);
  }

  /**
   * Get changes by setting
   */
  public async getChangesBySetting(
    setting: string,
    limit: number = 100
  ): Promise<ChangeRecord[]> {
    const changes = await this.getAllChanges(limit * 10);
    return changes
      .filter(c => c.setting === setting)
      .slice(0, limit);
  }

  /**
   * Get changes within date range
   */
  public async getChangesInRange(
    from: Date,
    to: Date,
    limit: number = 1000
  ): Promise<ChangeRecord[]> {
    const changes = await this.getAllChanges(limit * 2);
    return changes
      .filter(c => {
        const date = new Date(c.timestamp);
        return date >= from && date <= to;
      })
      .slice(0, limit);
  }

  /**
   * Get all changes (most recent first)
   */
  public async getAllChanges(limit: number = 100): Promise<ChangeRecord[]> {
    const changes: ChangeRecord[] = [];

    try {
      if (!fs.existsSync(this.logDir)) {
        return changes;
      }

      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith("changes-") && f.endsWith(".jsonl"))
        .sort()
        .reverse();

      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(l => l);

        for (const line of lines.reverse()) {
          try {
            const record = JSON.parse(line) as ChangeRecord;
            changes.push(record);
            if (changes.length >= limit) break;
          } catch (err) {
            log.debug(`change-log: parse change record line: ${err instanceof Error ? err.message : String(err)}`);
            // Skip malformed lines
          }
        }

        if (changes.length >= limit) break;
      }
    } catch (err) {
      log.debug(`change-log: read change log files: ${err instanceof Error ? err.message : String(err)}`);
      // Return what we have
    }

    return changes;
  }

  /**
   * Get high-impact changes
   */
  public async getHighImpactChanges(limit: number = 100): Promise<ChangeRecord[]> {
    const changes = await this.getAllChanges(limit * 5);
    return changes
      .filter(c => c.impact === "high")
      .slice(0, limit);
  }

  /**
   * Get changes affecting compliance
   */
  public async getComplianceAffectingChanges(
    regulation?: string,
    limit: number = 100
  ): Promise<ChangeRecord[]> {
    const changes = await this.getAllChanges(limit * 5);
    return changes
      .filter(c => {
        if (c.affected_compliance.length === 0) return false;
        if (regulation) {
          return c.affected_compliance.includes(regulation);
        }
        return true;
      })
      .slice(0, limit);
  }

  /**
   * Get change statistics
   */
  public async getStatistics(
    from?: Date,
    to?: Date
  ): Promise<{
    total_changes: number;
    by_component: Record<string, number>;
    by_impact: Record<string, number>;
    by_method: Record<string, number>;
    requiring_approval: number;
    compliance_affecting: number;
  }> {
    const allChanges = await this.getAllChanges(10000);

    let changes = allChanges;
    if (from) {
      changes = changes.filter(c => new Date(c.timestamp) >= from);
    }
    if (to) {
      changes = changes.filter(c => new Date(c.timestamp) <= to);
    }

    const byComponent: Record<string, number> = {};
    const byImpact: Record<string, number> = {};
    const byMethod: Record<string, number> = {};
    let requiringApproval = 0;
    let complianceAffecting = 0;

    for (const change of changes) {
      byComponent[change.component] = (byComponent[change.component] || 0) + 1;
      byImpact[change.impact] = (byImpact[change.impact] || 0) + 1;
      byMethod[change.method] = (byMethod[change.method] || 0) + 1;

      if (change.requires_approval) requiringApproval++;
      if (change.affected_compliance.length > 0) complianceAffecting++;
    }

    return {
      total_changes: changes.length,
      by_component: byComponent,
      by_impact: byImpact,
      by_method: byMethod,
      requiring_approval: requiringApproval,
      compliance_affecting: complianceAffecting,
    };
  }

  /**
   * Export changes for audit
   */
  public async exportForAudit(
    from: Date,
    to: Date
  ): Promise<{
    period: { from: string; to: string };
    total_changes: number;
    high_impact_changes: number;
    compliance_affecting_changes: number;
    changes: ChangeRecord[];
  }> {
    const changes = await this.getChangesInRange(from, to, 10000);

    return {
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
      total_changes: changes.length,
      high_impact_changes: changes.filter(c => c.impact === "high").length,
      compliance_affecting_changes: changes.filter(c => c.affected_compliance.length > 0).length,
      changes,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the change log instance
 */
export function getChangeLog(): ChangeLog {
  return ChangeLog.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Record a configuration change
 */
export async function recordConfigChange(
  component: string,
  setting: string,
  oldValue: unknown,
  newValue: unknown,
  options?: {
    changedBy?: "user" | "system" | "admin";
    method?: "cli" | "env" | "api" | "config_file";
    requiresApproval?: boolean;
    approvedBy?: string;
    impact?: "low" | "medium" | "high";
    affectedCompliance?: string[];
  }
): Promise<ChangeRecord> {
  return getChangeLog().recordChange(component, setting, oldValue, newValue, options);
}

/**
 * Get recent configuration changes
 */
export async function getRecentChanges(limit: number = 100): Promise<ChangeRecord[]> {
  return getChangeLog().getAllChanges(limit);
}

/**
 * Get change statistics
 */
export async function getChangeStatistics(
  from?: Date,
  to?: Date
): Promise<ReturnType<ChangeLog["getStatistics"]>> {
  return getChangeLog().getStatistics(from, to);
}
