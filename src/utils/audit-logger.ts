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
import {
  mkdirSecure,
  appendFileSecure,
  PERMISSION_MODES,
} from "./file-permissions.js";

/**
 * Audit event types
 */
export type AuditEventType = "tool" | "auth" | "session" | "security" | "system";

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
  private config: AuditConfig;
  private currentLogFile: string = "";
  private previousHash: string = "GENESIS";
  private writeQueue: AuditEvent[] = [];
  private isWriting: boolean = false;
  private stats = {
    totalEvents: 0,
    toolEvents: 0,
    authEvents: 0,
    sessionEvents: 0,
    securityEvents: 0,
    systemEvents: 0,
  };

  constructor(config?: Partial<AuditConfig>) {
    this.config = { ...getAuditConfig(), ...config };

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
    const today = new Date().toISOString().split("T")[0];
    this.currentLogFile = path.join(this.config.logDir, `audit-${today}.jsonl`);

    // Read last hash from existing file if present
    if (fs.existsSync(this.currentLogFile)) {
      try {
        const content = fs.readFileSync(this.currentLogFile, "utf-8");
        const lines = content.trim().split("\n").filter(l => l.length > 0);
        if (lines.length > 0) {
          const lastEvent = JSON.parse(lines[lines.length - 1]) as AuditEvent;
          this.previousHash = lastEvent.hash;
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
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.config.logDir, file));
        }
      }
    } catch {
      // Ignore cleanup errors
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

    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  /**
   * Sanitize details object for logging (remove sensitive data)
   */
  private sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      // Skip sensitive keys entirely
      if (/password|secret|token|key|credential|auth/i.test(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      // Sanitize string values
      if (typeof value === "string") {
        sanitized[key] = sanitizeForLogging(value);
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
    this.writeQueue.push(event);

    if (this.isWriting) return;

    this.isWriting = true;

    try {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 100); // Write up to 100 events at once
        const lines = batch.map(e => JSON.stringify(e)).join("\n") + "\n";

        // Check if we need to rotate to new day's file
        const today = new Date().toISOString().split("T")[0];
        const expectedFile = path.join(this.config.logDir, `audit-${today}.jsonl`);
        if (this.currentLogFile !== expectedFile) {
          this.currentLogFile = expectedFile;
        }

        appendFileSecure(this.currentLogFile, lines, PERMISSION_MODES.OWNER_READ_WRITE);
      }
    } finally {
      this.isWriting = false;
    }
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
    // Wait for any pending writes to complete
    while (this.isWriting || this.writeQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
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
};
