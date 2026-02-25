/**
 * Retention Policy Engine
 *
 * Enforces data retention policies automatically.
 * Supports GDPR storage limitation and CSSF 7-year retention requirements.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getAuditLogger } from "../utils/audit-logger.js";
import { DataClassification, type RetentionPolicy } from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Default retention policies
 */
const DEFAULT_POLICIES: RetentionPolicy[] = [
  {
    id: "policy_audit_logs",
    name: "Audit Log Retention",
    data_types: ["audit_logs", "compliance_events", "security_logs"],
    classifications: [DataClassification.REGULATED],
    retention_days: 7 * 365, // 7 years (CSSF requirement)
    action: "archive",
    schedule: "monthly",
    regulatory_requirement: "CSSF Circular 20/750",
  },
  {
    id: "policy_consent",
    name: "Consent Record Retention",
    data_types: ["consent_records"],
    retention_days: 7 * 365, // 7 years
    action: "archive",
    schedule: "monthly",
    regulatory_requirement: "GDPR Article 7",
  },
  {
    id: "policy_session",
    name: "Session Data Cleanup",
    data_types: ["session_state", "browser_local_storage"],
    retention_days: 14, // 14 days — auth cookies are valid for 2-4 weeks
    action: "delete",
    schedule: "daily",
  },
  {
    id: "policy_browser_cache",
    name: "Browser Cache Cleanup",
    data_types: ["browser_cache"],
    retention_days: 7,
    action: "delete",
    schedule: "weekly",
  },
  {
    id: "policy_error_logs",
    name: "Error Log Cleanup",
    data_types: ["error_logs"],
    retention_days: 30,
    action: "delete",
    schedule: "monthly",
  },
];

/**
 * Retention execution result
 */
interface RetentionResult {
  policy_id: string;
  policy_name: string;
  executed_at: string;
  data_type: string;
  action: "delete" | "archive" | "anonymize";
  items_processed: number;
  bytes_freed: number;
  success: boolean;
  error?: string;
}

/**
 * Retention Engine class
 */
export class RetentionEngine {
  private static instance: RetentionEngine;
  private policiesFile: string;
  private policies: Map<string, RetentionPolicy> = new Map();
  private loaded: boolean = false;
  private archiveDir: string;
  private lastRunFile: string;

  private constructor() {
    const config = getConfig();
    this.policiesFile = path.join(config.configDir, "retention-policies.json");
    this.archiveDir = path.join(config.dataDir, "archive");
    this.lastRunFile = path.join(config.configDir, "retention-last-run.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): RetentionEngine {
    if (!RetentionEngine.instance) {
      RetentionEngine.instance = new RetentionEngine();
    }
    return RetentionEngine.instance;
  }

  /**
   * Load policies from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    // Load default policies first
    for (const policy of DEFAULT_POLICIES) {
      this.policies.set(policy.id, policy);
    }

    // Load custom policies
    try {
      if (fs.existsSync(this.policiesFile)) {
        const content = fs.readFileSync(this.policiesFile, "utf-8");
        const data = JSON.parse(content);
        if (data.policies && Array.isArray(data.policies)) {
          for (const policy of data.policies) {
            this.policies.set(policy.id, policy);
          }
        }
      }
    } catch {
      // Use defaults if file is corrupted
    }

    this.loaded = true;
  }

  /**
   * Save policies to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.policiesFile);
    mkdirSecure(dir);

    // Only save custom policies (not default ones)
    const customPolicies = Array.from(this.policies.values()).filter(
      p => !DEFAULT_POLICIES.find(dp => dp.id === p.id)
    );

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      policies: customPolicies,
    };

    writeFileSecure(this.policiesFile, JSON.stringify(data, null, 2));
  }

  /**
   * Add a custom retention policy
   */
  public async addPolicy(policy: Omit<RetentionPolicy, "id">): Promise<RetentionPolicy> {
    await this.load();

    const newPolicy: RetentionPolicy = {
      ...policy,
      id: `policy_${generateUUID().slice(0, 8)}`,
    };

    this.policies.set(newPolicy.id, newPolicy);
    await this.save();

    return newPolicy;
  }

  /**
   * Update an existing policy
   */
  public async updatePolicy(
    policyId: string,
    updates: Partial<Omit<RetentionPolicy, "id">>
  ): Promise<RetentionPolicy | null> {
    await this.load();

    const policy = this.policies.get(policyId);
    if (!policy) return null;

    const updatedPolicy: RetentionPolicy = {
      ...policy,
      ...updates,
    };

    this.policies.set(policyId, updatedPolicy);
    await this.save();

    return updatedPolicy;
  }

  /**
   * Remove a policy
   */
  public async removePolicy(policyId: string): Promise<boolean> {
    await this.load();

    // Don't allow removing default policies
    if (DEFAULT_POLICIES.find(p => p.id === policyId)) {
      return false;
    }

    if (!this.policies.has(policyId)) {
      return false;
    }

    this.policies.delete(policyId);
    await this.save();

    return true;
  }

  /**
   * Get all policies
   */
  public async getPolicies(): Promise<RetentionPolicy[]> {
    await this.load();
    return Array.from(this.policies.values());
  }

  /**
   * Get policy by ID
   */
  public async getPolicy(policyId: string): Promise<RetentionPolicy | null> {
    await this.load();
    return this.policies.get(policyId) || null;
  }

  /**
   * Check if retention should run based on schedule
   */
  private shouldRun(policy: RetentionPolicy): boolean {
    try {
      if (!fs.existsSync(this.lastRunFile)) {
        return true;
      }

      const content = fs.readFileSync(this.lastRunFile, "utf-8");
      const data = JSON.parse(content);
      const lastRun = data.runs?.[policy.id];

      if (!lastRun) return true;

      const lastRunDate = new Date(lastRun);
      const now = new Date();
      const diffMs = now.getTime() - lastRunDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      switch (policy.schedule) {
        case "daily":
          return diffDays >= 1;
        case "weekly":
          return diffDays >= 7;
        case "monthly":
          return diffDays >= 30;
        default:
          return true;
      }
    } catch {
      return true;
    }
  }

  /**
   * Record policy execution time
   */
  private recordRun(policyId: string): void {
    try {
      let data: { runs: Record<string, string> } = { runs: {} };

      if (fs.existsSync(this.lastRunFile)) {
        const content = fs.readFileSync(this.lastRunFile, "utf-8");
        data = JSON.parse(content);
      }

      data.runs = data.runs || {};
      data.runs[policyId] = new Date().toISOString();

      const dir = path.dirname(this.lastRunFile);
      mkdirSecure(dir);
      writeFileSecure(this.lastRunFile, JSON.stringify(data, null, 2));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Execute a single retention policy
   */
  private async executePolicy(policy: RetentionPolicy): Promise<RetentionResult[]> {
    const results: RetentionResult[] = [];
    const config = getConfig();

    for (const dataType of policy.data_types) {
      const result: RetentionResult = {
        policy_id: policy.id,
        policy_name: policy.name,
        executed_at: new Date().toISOString(),
        data_type: dataType,
        action: policy.action,
        items_processed: 0,
        bytes_freed: 0,
        success: true,
      };

      try {
        // Determine the data location based on data type
        const location = this.getDataLocation(dataType, config);
        if (!location || !fs.existsSync(location)) {
          results.push(result);
          continue;
        }

        // Get files to process
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);

        const files = this.getExpiredFiles(location, cutoffDate, dataType);

        for (const file of files) {
          try {
            const stats = fs.statSync(file);
            result.bytes_freed += stats.size;
            result.items_processed++;

            switch (policy.action) {
              case "delete":
                fs.unlinkSync(file);
                break;
              case "archive":
                await this.archiveFile(file, dataType);
                fs.unlinkSync(file);
                break;
              case "anonymize":
                // Anonymization would depend on data type
                // For now, we just log that it should be anonymized
                break;
            }
          } catch {
            // Continue with other files
          }
        }

        // Log retention event
        const logger = getComplianceLogger();
        await logger.logRetention(
          policy.action === "delete" ? "delete" : policy.action === "archive" ? "archive" : "cleanup",
          dataType,
          result.items_processed,
          {
            policy_id: policy.id,
            bytes_freed: result.bytes_freed,
          }
        );
      } catch (error) {
        result.success = false;
        result.error = error instanceof Error ? error.message : String(error);
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Get the storage location for a data type
   */
  private getDataLocation(dataType: string, config: ReturnType<typeof getConfig>): string | null {
    const locations: Record<string, string> = {
      "audit_logs": path.join(config.dataDir, "audit"),
      "compliance_events": path.join(config.dataDir, "compliance"),
      "security_logs": path.join(config.dataDir, "security"),
      "session_state": path.join(config.dataDir, "sessions"),
      "browser_cache": path.join(config.dataDir, "browser_cache"),
      "browser_local_storage": path.join(config.dataDir, "browser_state"),
      "error_logs": path.join(config.dataDir, "logs"),
    };

    return locations[dataType] || null;
  }

  /**
   * Get files that have exceeded retention period
   */
  private getExpiredFiles(location: string, cutoffDate: Date, dataType: string): string[] {
    const expiredFiles: string[] = [];

    try {
      const stats = fs.statSync(location);

      if (stats.isFile()) {
        // Single file
        if (stats.mtime < cutoffDate) {
          expiredFiles.push(location);
        }
      } else if (stats.isDirectory()) {
        // Directory - check all files
        const files = fs.readdirSync(location);

        for (const file of files) {
          const filePath = path.join(location, file);
          try {
            const fileStats = fs.statSync(filePath);

            // For dated log files, extract date from filename
            if (dataType.includes("logs") || dataType.includes("events")) {
              const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})/);
              if (dateMatch) {
                const fileDate = new Date(dateMatch[1]);
                if (fileDate < cutoffDate) {
                  expiredFiles.push(filePath);
                }
                continue;
              }
            }

            // Fall back to modification time
            if (fileStats.mtime < cutoffDate) {
              expiredFiles.push(filePath);
            }
          } catch {
            // Skip files we can't access
          }
        }
      }
    } catch {
      // Location doesn't exist or can't be accessed
    }

    return expiredFiles;
  }

  /**
   * Archive a file
   */
  private async archiveFile(filePath: string, dataType: string): Promise<void> {
    mkdirSecure(this.archiveDir);

    const timestamp = new Date().toISOString().split("T")[0];
    const fileName = path.basename(filePath);
    const archiveSubDir = path.join(this.archiveDir, dataType, timestamp);
    mkdirSecure(archiveSubDir);

    const archivePath = path.join(archiveSubDir, fileName);
    fs.copyFileSync(filePath, archivePath);
  }

  /**
   * Run all due retention policies
   */
  public async runDuePolicies(): Promise<RetentionResult[]> {
    await this.load();

    const allResults: RetentionResult[] = [];

    for (const policy of this.policies.values()) {
      if (this.shouldRun(policy)) {
        const results = await this.executePolicy(policy);
        allResults.push(...results);
        this.recordRun(policy.id);
      }
    }

    // Log to audit logger
    const auditLogger = getAuditLogger();
    if (allResults.length > 0) {
      const totalItems = allResults.reduce((sum, r) => sum + r.items_processed, 0);
      const totalBytes = allResults.reduce((sum, r) => sum + r.bytes_freed, 0);
      await auditLogger.logRetentionEvent(
        "cleanup",
        "multiple",
        totalItems,
        {
          policies_executed: allResults.length,
          bytes_freed: totalBytes,
        }
      );
    }

    return allResults;
  }

  /**
   * Force run a specific policy (ignoring schedule)
   */
  public async forceRunPolicy(policyId: string): Promise<RetentionResult[]> {
    await this.load();

    const policy = this.policies.get(policyId);
    if (!policy) {
      return [];
    }

    const results = await this.executePolicy(policy);
    this.recordRun(policyId);

    return results;
  }

  /**
   * Get retention status summary
   */
  public async getStatus(): Promise<{
    total_policies: number;
    active_policies: number;
    last_runs: Record<string, string>;
    next_due: { policy_id: string; policy_name: string; due_in_days: number }[];
  }> {
    await this.load();

    const policies = Array.from(this.policies.values());
    let lastRuns: Record<string, string> = {};

    try {
      if (fs.existsSync(this.lastRunFile)) {
        const content = fs.readFileSync(this.lastRunFile, "utf-8");
        const data = JSON.parse(content);
        lastRuns = data.runs || {};
      }
    } catch {
      lastRuns = {};
    }

    // Calculate next due
    const nextDue: { policy_id: string; policy_name: string; due_in_days: number }[] = [];

    for (const policy of policies) {
      const lastRun = lastRuns[policy.id];
      let dueInDays = 0;

      if (lastRun) {
        const lastRunDate = new Date(lastRun);
        const now = new Date();
        const daysSinceRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60 * 24);

        switch (policy.schedule) {
          case "daily":
            dueInDays = Math.max(0, 1 - daysSinceRun);
            break;
          case "weekly":
            dueInDays = Math.max(0, 7 - daysSinceRun);
            break;
          case "monthly":
            dueInDays = Math.max(0, 30 - daysSinceRun);
            break;
        }
      }

      nextDue.push({
        policy_id: policy.id,
        policy_name: policy.name,
        due_in_days: Math.round(dueInDays * 10) / 10,
      });
    }

    nextDue.sort((a, b) => a.due_in_days - b.due_in_days);

    return {
      total_policies: policies.length,
      active_policies: policies.length,
      last_runs: lastRuns,
      next_due: nextDue,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the retention engine instance
 */
export function getRetentionEngine(): RetentionEngine {
  return RetentionEngine.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Run all due retention policies
 */
export async function runRetentionPolicies(): Promise<RetentionResult[]> {
  return getRetentionEngine().runDuePolicies();
}

/**
 * Get all retention policies
 */
export async function getRetentionPolicies(): Promise<RetentionPolicy[]> {
  return getRetentionEngine().getPolicies();
}

/**
 * Get retention status
 */
export async function getRetentionStatus(): Promise<ReturnType<RetentionEngine["getStatus"]>> {
  return getRetentionEngine().getStatus();
}
