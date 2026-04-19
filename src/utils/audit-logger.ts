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
import { withLock } from "./file-lock.js";
import { log as logger } from "./logger.js";

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
 * Get audit configuration from environment.
 *
 * Retention default is 7 years (2555 days) to match the CSSF claim in
 * package.json `enterpriseCompliance.cssf.sevenYearRetention`. Operators
 * can override via `NLMCP_AUDIT_RETENTION_DAYS` for shorter environments
 * (dev, test) where long retention is unnecessary.
 *
 * Note: the audit log integrity cluster (I216–I223) is still being hardened;
 * this default change only extends the retention window — durability and
 * cross-process concurrency fixes are tracked separately.
 */
function getAuditConfig(): AuditConfig {
  return {
    enabled: process.env.NLMCP_AUDIT_ENABLED !== "false",
    logDir: process.env.NLMCP_AUDIT_DIR || path.join(CONFIG.dataDir, "audit"),
    retentionDays: parseInt(process.env.NLMCP_AUDIT_RETENTION_DAYS || "2555", 10),
    includeDetails: process.env.NLMCP_AUDIT_INCLUDE_DETAILS !== "false",
    hashChainEnabled: process.env.NLMCP_AUDIT_HASH_CHAIN !== "false",
  };
}

/**
 * Queue entry for durable writes. `event` is stored without `hash` and
 * `previousHash` — both are computed at drain time against the on-disk
 * tail so cross-process writers stay in sync.
 */
interface QueueEntry {
  event: Omit<AuditEvent, "hash" | "previousHash">;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * Audit Logger Class
 *
 * Tamper-evident audit logging. Guarantees:
 *   - Callers awaiting `audit.*()` observe durability (the log line is
 *     on disk before the returned promise resolves).
 *   - Hash chain is computed at drain time against the on-disk tail;
 *     multi-process writers serialize via cross-process file lock and
 *     stay in chain.
 *   - Corruption detected at startup is surfaced as a `chain_reset`
 *     sentinel event so verifiers can distinguish corruption from
 *     attacker tampering.
 *   - Chain integrity is verified on startup and any break is recorded
 *     as a `chain_violation` event.
 */
/** Listener fired AFTER an event has been durably written. Errors
 * thrown from listeners are logged and swallowed so a faulty subscriber
 * can't break the audit path. */
export type AuditListener = (event: AuditEvent) => void | Promise<void>;

export class AuditLogger {
  private config: AuditConfig;
  private currentLogFile: string = "";
  private writeQueue: QueueEntry[] = [];
  private isWriting: boolean = false;
  private listeners: AuditListener[] = [];
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

    if (this.config.enabled) {
      this.ensureLogDirectory();
      this.initializeLogFile();
      this.cleanOldLogs();
      // Fire-and-forget startup verification. If the chain is broken,
      // record a chain_violation event but keep the server running.
      if (process.env.NLMCP_AUDIT_VERIFY_ON_STARTUP !== "false") {
        void this.verifyAndRecordStartup().catch((err) =>
          logger.warning(`Audit startup verify failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  }

  /**
   * Ensure audit log directory exists
   */
  private ensureLogDirectory(): void {
    mkdirSecure(this.config.logDir, PERMISSION_MODES.OWNER_FULL);
  }

  /**
   * Initialize log file for today.
   *
   * On parse failure we do NOT silently reset to GENESIS — an attacker
   * tampering any byte of an old line would otherwise produce a fresh
   * chain that validates from scratch. Instead, we compute the hash of
   * the raw (unparseable) content and write a `chain_reset` sentinel
   * event so the new chain links to the corruption boundary explicitly.
   */
  private initializeLogFile(): void {
    const today = new Date().toISOString().split("T")[0];
    this.currentLogFile = path.join(this.config.logDir, `audit-${today}.jsonl`);

    if (!fs.existsSync(this.currentLogFile)) return;

    let rawContent = "";
    try {
      rawContent = fs.readFileSync(this.currentLogFile, "utf-8");
      const lines = rawContent.trim().split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) return;
      const lastEvent = JSON.parse(lines[lines.length - 1]) as AuditEvent;
      if (typeof lastEvent.hash !== "string" || lastEvent.hash.length === 0) {
        throw new Error("tail event missing hash");
      }
      // Tail OK; drain will re-read from disk when it next writes.
    } catch (err) {
      // Corruption. Emit a synchronous chain_reset sentinel so the new
      // chain carries a pointer to the corruption boundary.
      const lastValidHash = crypto
        .createHash("sha256")
        .update(rawContent)
        .digest("hex")
        .slice(0, 32);
      logger.warning(
        `⚠️ Audit log corruption detected at startup — writing chain_reset sentinel (last_valid_hash=${lastValidHash.slice(0, 8)}, reason=${err instanceof Error ? err.message : String(err)})`,
      );
      this.writeChainResetSentinel(lastValidHash, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Write a chain_reset sentinel synchronously (used only from
   * initializeLogFile when corruption is detected at startup). Uses
   * fs.appendFileSync to avoid recursing through the async drain loop,
   * which isn't ready yet during constructor.
   */
  private writeChainResetSentinel(lastValidHash: string, reason: string): void {
    const eventWithoutHash = {
      timestamp: new Date().toISOString(),
      eventType: "system" as const,
      eventName: "chain_reset",
      success: false,
      details: {
        reason: "corruption_detected",
        error: sanitizeForLogging(reason).slice(0, 200),
        last_valid_hash: lastValidHash,
      },
      previousHash: lastValidHash,
    };
    const hash = this.computeHash(eventWithoutHash);
    const event: AuditEvent = { ...eventWithoutHash, hash };
    try {
      fs.appendFileSync(this.currentLogFile, JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch (writeErr) {
      // If we can't even append the sentinel, the drain will fall back
      // to reading the corrupt tail and throw, rejecting the first
      // event's promise. Keep the log message loud.
      logger.error(`Failed to write chain_reset sentinel: ${writeErr}`);
    }
  }

  /**
   * Read the tail hash of a log file. Used by the drain loop (under the
   * cross-process lock) so each batch chains to the true on-disk tail.
   */
  private readTailHash(file: string): string {
    if (!fs.existsSync(file)) return "GENESIS";
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return "GENESIS";
    const last = JSON.parse(lines[lines.length - 1]) as AuditEvent;
    if (typeof last.hash !== "string" || last.hash.length === 0) {
      throw new Error("tail event missing hash field — refusing to write without a valid chain anchor");
    }
    return last.hash;
  }

  /**
   * Ensure `this.currentLogFile` matches today's date. If the day has
   * rolled over, adopt the new day's tail hash so per-file verifiers
   * see an unbroken chain. Called under the drain lock.
   */
  private checkDayRollover(): void {
    const today = new Date().toISOString().split("T")[0];
    const expectedFile = path.join(this.config.logDir, `audit-${today}.jsonl`);
    if (this.currentLogFile === expectedFile) return;
    this.currentLogFile = expectedFile;
    // Drain re-reads tail under the lock; nothing to do here beyond the
    // path switch.
  }

  /**
   * Verify chain integrity of today's log on startup. If broken, record
   * a `chain_violation` event with line numbers so operators know to
   * investigate. Does not throw — availability > strict enforcement.
   */
  private async verifyAndRecordStartup(): Promise<void> {
    const result = await this.verifyIntegrity(this.currentLogFile);
    if (!result.valid) {
      logger.warning(`⚠️ Audit log chain verification failed for ${path.basename(this.currentLogFile)}:`);
      for (const err of result.errors.slice(0, 5)) logger.warning(`    - ${err}`);
      await this.log("security", "chain_violation", false, {
        severity: "critical",
        file: path.basename(this.currentLogFile),
        first_errors: result.errors.slice(0, 3),
        total_errors: result.errors.length,
      });
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

    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 32);
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
   * Enqueue an event and return a promise that resolves only when the
   * event has been durably appended to disk. Failure (lock timeout, I/O
   * error, corrupt tail) rejects the returned promise so callers can
   * react rather than silently lose audit records.
   *
   * Events are stored without hash/previousHash; those are computed at
   * drain time under the cross-process lock so multi-process writers
   * share one chain.
   */
  private writeEvent(event: Omit<AuditEvent, "hash" | "previousHash">): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ event, resolve, reject });
      if (!this.isWriting) {
        void this.drain();
      }
    });
  }

  private async drain(): Promise<void> {
    if (this.isWriting) return;
    this.isWriting = true;
    try {
      while (this.writeQueue.length > 0) {
        this.checkDayRollover();
        const batch = this.writeQueue.splice(0, 100);
        // Reconstructed full events for listener dispatch after the write
        // succeeds. Kept outside the lock block so listeners run after the
        // lock releases.
        const durableEvents: AuditEvent[] = [];
        try {
          await withLock(
            this.currentLogFile,
            async () => {
              // Re-read the on-disk tail hash inside the lock so
              // concurrent Node processes chain from the true tail.
              let previousHash = this.readTailHash(this.currentLogFile);
              const lines: string[] = [];
              for (const entry of batch) {
                const eventWithPrev: Omit<AuditEvent, "hash"> = {
                  ...entry.event,
                  previousHash: this.config.hashChainEnabled ? previousHash : "",
                };
                const hash = this.config.hashChainEnabled ? this.computeHash(eventWithPrev) : "";
                const fullEvent: AuditEvent = { ...eventWithPrev, hash };
                lines.push(JSON.stringify(fullEvent));
                durableEvents.push(fullEvent);
                if (this.config.hashChainEnabled) previousHash = hash;
              }
              appendFileSecure(
                this.currentLogFile,
                lines.join("\n") + "\n",
                PERMISSION_MODES.OWNER_READ_WRITE,
              );
            },
            { timeout: 15000 },
          );
          for (const entry of batch) entry.resolve();
          // Fire listeners after durability — best-effort, don't await
          // sequentially and never let a subscriber error break the loop.
          for (const event of durableEvents) {
            for (const listener of this.listeners) {
              void Promise.resolve()
                .then(() => listener(event))
                .catch((err) => logger.warning(`audit listener failed: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error(`Audit drain failed: ${error.message}`);
          for (const entry of batch) entry.reject(error);
        }
      }
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Subscribe to durable audit events. Listener fires AFTER the event is
   * on disk. Returns an unsubscribe function.
   */
  public onEvent(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Log a generic event. Resolves only after the event is durably on
   * disk (see writeEvent / drain contract).
   */
  private async log(
    eventType: AuditEventType,
    eventName: string,
    success: boolean,
    details: Record<string, unknown> = {},
    duration_ms?: number,
  ): Promise<void> {
    if (!this.config.enabled) return;

    this.stats.totalEvents++;
    this.stats[`${eventType}Events` as keyof typeof this.stats]++;

    const sanitizedDetails = this.config.includeDetails ? this.sanitizeDetails(details) : {};

    // Hash + previousHash are filled in at drain time against the on-disk
    // tail so multi-process writers stay in chain.
    await this.writeEvent({
      timestamp: new Date().toISOString(),
      eventType,
      eventName,
      success,
      duration_ms,
      details: sanitizedDetails,
    });
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
   * Force flush any pending writes. Since writeEvent now resolves only
   * after disk append, callers usually don't need this — but it's still
   * useful at shutdown to wait for in-flight drains kicked off by
   * fire-and-forget calls.
   */
  async flush(): Promise<void> {
    while (this.isWriting || this.writeQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
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
