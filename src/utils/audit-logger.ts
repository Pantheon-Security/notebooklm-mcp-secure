/**
 * Audit Logger for NotebookLM MCP Server
 *
 * Provides comprehensive audit logging with:
 * - Tool invocation logging
 * - Authentication event logging
 * - Session lifecycle logging
 * - Security event logging
 * - Tamper detection via hash chaining
 * - Log rotation and retention
 *
 * Added by Pantheon Security for hardened fork.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CONFIG } from "../config.js";
import { sanitizeForLogging } from "./security.js";
import { withLock } from "./file-lock.js";
import { logger } from "./logger.js";
import {
  mkdirSecure,
  appendFileSecure,
  PERMISSION_MODES,
} from "./file-permissions.js";

/**
 * Audit event types
 */
export type AuditEventType =
  | "tool"          // Tool invocations
  | "auth"          // Authentication events
  | "session"       // Session lifecycle
  | "security"      // Security events
  | "system"        // System events
  | "compliance"    // Compliance events (GDPR, SOC2, CSSF)
  | "data_access"   // Data access events (for DSAR)
  | "configuration" // Configuration changes
  | "retention";    // Data retention events

/**
 * Security severity levels
 */
export type SecuritySeverity = "info" | "warning" | "error" | "critical";

/**
 * Audit event structure
 */
export interface AuditEvent {
  timestamp: string;
  eventType: AuditEventType;
  eventName: string;
  success: boolean;
  duration_ms?: number;
  details: Record<string, unknown>;
  hash: string;
  previousHash: string;
}

/**
 * Audit logger configuration
 */
export interface AuditConfig {
  enabled: boolean;
  logDir: string;
  retentionDays: number;
  includeDetails: boolean;
  hashChainEnabled: boolean;
}

/**
 * Get audit configuration from environment
 */
function getAuditConfig(): AuditConfig {
  return {
    enabled: process.env.NLMCP_AUDIT_ENABLED !== "false",
    logDir: process.env.NLMCP_AUDIT_DIR || path.join(CONFIG.dataDir, "audit"),
    retentionDays: parseInt(process.env.NLMCP_AUDIT_RETENTION_DAYS || "30", 10),
    includeDetails: process.env.NLMCP_AUDIT_INCLUDE_DETAILS !== "false",
    hashChainEnabled: process.env.NLMCP_AUDIT_HASH_CHAIN !== "false",
  };
}

/**
 * Audit Logger Class
 *
 * Thread-safe audit logging with hash chain integrity verification.
 */
export class AuditLogger {
  private static readonly MISSING_HASH_WARNING =
    "audit chain broken: event missing hash field — chain verification disabled for this session";
  private static instances = new Set<AuditLogger>();
  private static processHandlersRegistered = false;

  private config: AuditConfig;
  private currentLogFile: string = "";
  private previousHash: string = "GENESIS";
  private writeQueue: Promise<void> = Promise.resolve();
  private pendingEvents: AuditEvent[] = [];
  private hashChainWarningLogged: boolean = false;
  private writeFailureLogged: boolean = false;
  private eventSubscribers: Array<(event: AuditEvent) => Promise<void>> = [];
  private stats = {
    totalEvents: 0,
    toolEvents: 0,
    authEvents: 0,
    sessionEvents: 0,
    securityEvents: 0,
    systemEvents: 0,
    complianceEvents: 0,
    data_accessEvents: 0,
    configurationEvents: 0,
    retentionEvents: 0,
  };

  constructor(config?: Partial<AuditConfig>) {
    this.config = { ...getAuditConfig(), ...config };
    AuditLogger.instances.add(this);
    this.registerProcessHandlers();

    if (this.config.enabled) {
      this.ensureLogDirectory();
      this.initializeLogFile();
      this.cleanOldLogs();
    }
  }

  /**
   * Ensure audit log directory exists
   */
  private ensureLogDirectory(): void {
    mkdirSecure(this.config.logDir, PERMISSION_MODES.OWNER_FULL);
  }

  /**
   * Initialize log file for today
   */
  private initializeLogFile(): void {
    // Day boundary is UTC (ISO 8601 date). Log rotation happens at UTC midnight. (I221)
    const today = new Date().toISOString().split("T")[0];
    this.currentLogFile = path.join(this.config.logDir, `audit-${today}.jsonl`);

    // Read last hash from existing file if present
    if (fs.existsSync(this.currentLogFile)) {
      try {
        const content = fs.readFileSync(this.currentLogFile, "utf-8");
        const lines = content.trim().split("\n").filter(l => l.length > 0);
        if (lines.length > 0) {
          const lastEvent = JSON.parse(lines[lines.length - 1]) as AuditEvent;
          if (typeof lastEvent.hash === "string" && lastEvent.hash.length > 0) {
            this.previousHash = lastEvent.hash;
          } else {
            this.disableHashChainForSession();
            this.previousHash = "GENESIS";
          }
        }
      } catch {
        // Start fresh if file is corrupted
        this.previousHash = "GENESIS";
      }
    }
  }

  /**
   * Clean up old log files based on retention policy
   */
  private cleanOldLogs(): void {
    try {
      const files = fs.readdirSync(this.config.logDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

      for (const file of files) {
        if (!file.startsWith("audit-") || !file.endsWith(".jsonl")) continue;

        // Extract date from filename (audit-YYYY-MM-DD.jsonl)
        const dateStr = file.slice(6, 16);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.config.logDir, file));
        }
      }
    } catch (err) {
      logger.warning(`audit log cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Compute hash for an event (includes previous hash for chaining)
   */
  private computeHash(event: Omit<AuditEvent, "hash">): string {
    const data = JSON.stringify({
      timestamp: event.timestamp,
      eventType: event.eventType,
      eventName: event.eventName,
      success: event.success,
      duration_ms: event.duration_ms,
      details: event.details,
      previousHash: event.previousHash,
    });

    return crypto.createHash("sha256").update(data).digest("hex");
  }

  /**
   * Sanitize details object for logging (remove sensitive data)
   */
  private sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      const lowerKey = key.toLowerCase();

      // Skip sensitive keys entirely
      if (/password|secret|token|key|credential|auth/i.test(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      // Sanitize string values
      if (typeof value === "string") {
        if (
          value.length > 8 &&
          /password|token|secret|key|credential/.test(lowerKey)
        ) {
          sanitized[key] = "[REDACTED]";
        } else {
          sanitized[key] = sanitizeForLogging(value);
        }
      } else if (typeof value === "object" && value !== null) {
        // Recursively sanitize objects
        sanitized[key] = this.sanitizeDetails(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Write event to log file
   */
  private async writeEvent(event: AuditEvent): Promise<void> {
    this.pendingEvents.push(event);
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => this.flushEvent(event));
    await this.writeQueue;
  }

  private async flushEvent(event: AuditEvent): Promise<void> {
    if (!this.pendingEvents.includes(event)) {
      return;
    }

    const logFile = this.getLogFilePathForTimestamp(event.timestamp);
    const line = `${JSON.stringify(event)}\n`;

    try {
      await withLock(logFile, async () => {
        if (!this.pendingEvents.includes(event)) {
          return;
        }

        this.currentLogFile = logFile;
        appendFileSecure(logFile, line, PERMISSION_MODES.OWNER_READ_WRITE);
        this.pendingEvents = this.pendingEvents.filter((pendingEvent) => pendingEvent !== event);
      });

      // Fan-out to subscribers after successful write (I244)
      for (const sub of this.eventSubscribers) {
        sub(event).catch(() => {}); // fire-and-forget, never block audit writes
      }
    } catch (error) {
      this.handleWriteFailure(event, error);
    }
  }

  /**
   * Subscribe to audit events as they are written to disk (I244)
   */
  onEvent(handler: (event: AuditEvent) => Promise<void>): void {
    this.eventSubscribers.push(handler);
  }

  /**
   * Log a generic event
   */
  private async log(
    eventType: AuditEventType,
    eventName: string,
    success: boolean,
    details: Record<string, unknown> = {},
    duration_ms?: number
  ): Promise<void> {
    if (!this.config.enabled) return;

    // Update stats
    this.stats.totalEvents++;
    this.stats[`${eventType}Events` as keyof typeof this.stats]++;

    const sanitizedDetails = this.config.includeDetails
      ? this.sanitizeDetails(details)
      : {};

    const eventWithoutHash: Omit<AuditEvent, "hash"> = {
      timestamp: new Date().toISOString(),
      eventType,
      eventName,
      success,
      duration_ms,
      details: sanitizedDetails,
      previousHash: this.config.hashChainEnabled ? this.previousHash : "",
    };

    const hash = this.config.hashChainEnabled
      ? this.computeHash(eventWithoutHash)
      : "";

    const event: AuditEvent = {
      ...eventWithoutHash,
      hash,
    };

    if (this.config.hashChainEnabled) {
      this.previousHash = hash;
    }

    await this.writeEvent(event);
  }

  // ============================================================================
  // Public Logging Methods
  // ============================================================================

  /**
   * Log a tool invocation
   */
  async logToolCall(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    duration_ms: number,
    error?: string
  ): Promise<void> {
    await this.log("tool", toolName, success, {
      args_summary: this.summarizeArgs(args),
      error: error ? sanitizeForLogging(error) : undefined,
    }, duration_ms);
  }

  /**
   * Log an authentication event
   */
  async logAuthEvent(
    eventName: string,
    success: boolean,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("auth", eventName, success, details);
  }

  /**
   * Log a session lifecycle event
   */
  async logSessionEvent(
    eventName: string,
    sessionId: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("session", eventName, true, {
      session_id: sessionId,
      ...details,
    });
  }

  /**
   * Log a security event
   */
  async logSecurityEvent(
    eventName: string,
    severity: SecuritySeverity,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const success = severity === "info";
    await this.log("security", eventName, success, {
      severity,
      ...details,
    });
  }

  /**
   * Log a system event
   */
  async logSystemEvent(
    eventName: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("system", eventName, true, details);
  }

  /**
   * Log a compliance event (GDPR, SOC2, CSSF)
   */
  async logComplianceEvent(
    eventName: string,
    category: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("compliance", eventName, true, {
      compliance_category: category,
      ...details,
    });
  }

  /**
   * Log a data access event (for DSAR tracking)
   */
  async logDataAccessEvent(
    action: "view" | "export" | "delete" | "request",
    dataType: string,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("data_access", `data_${action}`, true, {
      data_type: dataType,
      action,
      ...details,
    });
  }

  /**
   * Log a configuration change event
   */
  async logConfigChange(
    setting: string,
    oldValue: unknown,
    newValue: unknown,
    changedBy: string = "system"
  ): Promise<void> {
    await this.log("configuration", "config_changed", true, {
      setting,
      old_value: typeof oldValue === "string" ? sanitizeForLogging(String(oldValue)) : "[complex]",
      new_value: typeof newValue === "string" ? sanitizeForLogging(String(newValue)) : "[complex]",
      changed_by: changedBy,
    });
  }

  /**
   * Log a data retention event
   */
  async logRetentionEvent(
    action: "cleanup" | "archive" | "delete",
    dataType: string,
    count: number,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.log("retention", `retention_${action}`, true, {
      data_type: dataType,
      items_affected: count,
      action,
      ...details,
    });
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Summarize tool arguments (avoid logging full content)
   */
  private summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") {
        // Log length for long strings, actual value for short ones
        if (value.length > 100) {
          summary[key] = `[string, ${value.length} chars]`;
        } else {
          summary[key] = sanitizeForLogging(value);
        }
      } else if (Array.isArray(value)) {
        summary[key] = `[array, ${value.length} items]`;
      } else if (typeof value === "object" && value !== null) {
        summary[key] = `[object]`;
      } else {
        summary[key] = value;
      }
    }

    return summary;
  }

  /**
   * Get audit statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Verify integrity of audit log file
   */
  async verifyIntegrity(logFile?: string): Promise<{ valid: boolean; errors: string[] }> {
    const file = logFile || this.currentLogFile;
    const errors: string[] = [];

    if (!fs.existsSync(file)) {
      return { valid: false, errors: ["Log file does not exist"] };
    }

    try {
      const content = fs.readFileSync(file, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);

      let expectedPreviousHash = "GENESIS";

      for (let i = 0; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]) as AuditEvent;

          // Verify hash chain
          if (this.config.hashChainEnabled) {
            if (typeof event.hash !== "string" || event.hash.length === 0) {
              this.disableHashChainForSession();
              break;
            }

            if (event.previousHash !== expectedPreviousHash) {
              errors.push(`Line ${i + 1}: Hash chain broken. Expected previous hash ${expectedPreviousHash}, got ${event.previousHash}`);
            }

            // Recompute hash to verify
            const { hash, ...eventWithoutHash } = event;
            const computedHash = this.computeHash(eventWithoutHash);
            if (computedHash !== hash) {
              errors.push(`Line ${i + 1}: Hash mismatch. Event may have been tampered.`);
            }

            expectedPreviousHash = event.hash;
          }
        } catch (e) {
          errors.push(`Line ${i + 1}: Invalid JSON`);
        }
      }

      return { valid: errors.length === 0, errors };
    } catch (e) {
      return { valid: false, errors: [`Failed to read log file: ${e}`] };
    }
  }

  /**
   * Force flush any pending writes
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private getLogFilePathForTimestamp(timestamp: string): string {
    const date = timestamp.split("T")[0];
    return path.join(this.config.logDir, `audit-${date}.jsonl`);
  }

  private disableHashChainForSession(): void {
    if (!this.hashChainWarningLogged) {
      logger.warning(AuditLogger.MISSING_HASH_WARNING);
      this.hashChainWarningLogged = true;
    }

    this.config.hashChainEnabled = false;
  }

  private handleWriteFailure(event: AuditEvent, error: unknown): void {
    this.pendingEvents = this.pendingEvents.filter((pendingEvent) => pendingEvent !== event);

    const err = error as NodeJS.ErrnoException;
    if ((err.code === "EACCES" || err.code === "EPERM") && !this.writeFailureLogged) {
      logger.warning(`audit logging disabled: unable to write audit log file (${err.message})`);
      this.writeFailureLogged = true;
      this.config.enabled = false;
      this.pendingEvents = [];
    }
  }

  private registerProcessHandlers(): void {
    if (AuditLogger.processHandlersRegistered) {
      return;
    }

    process.on("beforeExit", () => {
      AuditLogger.flushAllSync();
    });

    process.on("SIGTERM", () => {
      AuditLogger.flushAllSync();
    });

    AuditLogger.processHandlersRegistered = true;
  }

  private static flushAllSync(): void {
    for (const instance of AuditLogger.instances) {
      instance.flushPendingEventsSync();
    }
  }

  private flushPendingEventsSync(): void {
    if (!this.config.enabled || this.pendingEvents.length === 0) {
      return;
    }

    const groupedEvents = new Map<string, AuditEvent[]>();
    for (const event of this.pendingEvents) {
      const logFile = this.getLogFilePathForTimestamp(event.timestamp);
      const events = groupedEvents.get(logFile) ?? [];
      events.push(event);
      groupedEvents.set(logFile, events);
    }

    for (const [logFile, events] of groupedEvents) {
      const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      try {
        this.writeWithSyncLock(logFile, lines);
      } catch {
        // Ignore shutdown flush failures.
      }
      this.currentLogFile = logFile;
    }

    this.pendingEvents = [];
  }

  private writeWithSyncLock(logFile: string, lines: string): void {
    const lockPath = `${logFile}.lock`;
    const lockPayload = JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      hostname: process.env.HOSTNAME || process.env.COMPUTERNAME,
    });
    const timeoutAt = Date.now() + 10000;
    let lockAcquired = false;

    while (Date.now() < timeoutAt) {
      try {
        fs.writeFileSync(lockPath, lockPayload, {
          flag: "wx",
          mode: 0o600,
        });
        lockAcquired = true;
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") {
          throw error;
        }

        try {
          const content = fs.readFileSync(lockPath, "utf-8");
          const existing = JSON.parse(content) as { timestamp?: number };
          if (typeof existing.timestamp === "number" && Date.now() - existing.timestamp > 30000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch {
            // Another process may still own the lock.
          }
        }

        // Synchronous best-effort retry during process shutdown.
      }
    }

    if (!lockAcquired) {
      return;
    }

    try {
      appendFileSecure(logFile, lines, PERMISSION_MODES.OWNER_READ_WRITE);
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore lock cleanup failures during process exit.
      }
    }
  }
}

/**
 * Global audit logger instance
 */
let globalAuditLogger: AuditLogger | null = null;

/**
 * Get or create the global audit logger
 */
export function getAuditLogger(): AuditLogger {
  if (!globalAuditLogger) {
    globalAuditLogger = new AuditLogger();
  }
  return globalAuditLogger;
}

/**
 * Convenience functions for quick logging
 */
export const audit = {
  tool: (name: string, args: Record<string, unknown>, success: boolean, duration_ms: number, error?: string) =>
    getAuditLogger().logToolCall(name, args, success, duration_ms, error),

  auth: (event: string, success: boolean, details?: Record<string, unknown>) =>
    getAuditLogger().logAuthEvent(event, success, details),

  session: (event: string, sessionId: string, details?: Record<string, unknown>) =>
    getAuditLogger().logSessionEvent(event, sessionId, details),

  security: (event: string, severity: SecuritySeverity, details?: Record<string, unknown>) =>
    getAuditLogger().logSecurityEvent(event, severity, details),

  system: (event: string, details?: Record<string, unknown>) =>
    getAuditLogger().logSystemEvent(event, details),

  // New compliance-related convenience functions
  compliance: (event: string, category: string, details?: Record<string, unknown>) =>
    getAuditLogger().logComplianceEvent(event, category, details),

  dataAccess: (action: "view" | "export" | "delete" | "request", dataType: string, details?: Record<string, unknown>) =>
    getAuditLogger().logDataAccessEvent(action, dataType, details),

  configChange: (setting: string, oldValue: unknown, newValue: unknown, changedBy?: string) =>
    getAuditLogger().logConfigChange(setting, oldValue, newValue, changedBy),

  retention: (action: "cleanup" | "archive" | "delete", dataType: string, count: number, details?: Record<string, unknown>) =>
    getAuditLogger().logRetentionEvent(action, dataType, count, details),
};
