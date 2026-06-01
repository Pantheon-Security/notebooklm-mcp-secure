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
import { withLock, STALE_LOCK_THRESHOLD_MS } from "./file-lock.js";
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
    retentionDays: parseInt(process.env.NLMCP_AUDIT_RETENTION_DAYS || "2555", 10), // 7 years (I220)
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
  // M6: external tamper anchor (chosen over a co-located sequence counter — see note
  // below). The checkpoint persists the latest chain hash to a sidecar file OUTSIDE
  // the audit log dir. Threat model, honestly stated:
  //   - Location separation defends only against tampering scoped to the audit-*.jsonl
  //     files (a tool/path that rewrites the logs but doesn't know about the sidecar).
  //   - An attacker with broad filesystem write can also rewrite the sidecar. The HMAC
  //     SIGNATURE is the only real defense against that, and only if
  //     NLMCP_AUDIT_CHECKPOINT_KEY is stored where the attacker cannot read it.
  // A co-located sequence counter was rejected: the same broad-write attacker would
  // renumber it contiguously, so it would not close the stated threat, and it would
  // touch the hashed payload (breaking the existing chain tests). The checkpoint leaves
  // the hashed payload untouched. Set NLMCP_AUDIT_CHECKPOINT_PATH to place the sidecar
  // on a different volume/trust domain for genuine location separation.
  private checkpointPath: string = "";
  private checkpointKey: string | undefined = process.env.NLMCP_AUDIT_CHECKPOINT_KEY;
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

    // M6: place the tamper-anchor checkpoint OUTSIDE the audit log dir but in a
    // directory that is guaranteed to exist at write time. The parent of logDir
    // (dataDir in production) is created by ensureLogDirectory() in this constructor
    // before any checkpoint write; configDir is intentionally never created by the app
    // (see config.ts), so we do NOT use it — that would make this a silent no-op.
    // NLMCP_AUDIT_CHECKPOINT_PATH lets ops relocate the sidecar to another trust domain.
    this.checkpointPath = process.env.NLMCP_AUDIT_CHECKPOINT_PATH
      || path.join(path.dirname(this.config.logDir), ".audit-checkpoint.json");

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
      } catch (err) {
        // A corrupt tail on the current day must NOT silently reset to a fresh GENESIS
        // chain — that would let an attacker append one garbage byte to force a chain
        // restart and launder the break behind a new valid-looking chain (M7, was I217).
        // Instead, quarantine the chain for this session (disable hash chaining) and
        // surface a security-level warning. The "corruption detected" wording is also
        // relied upon by tests/audit-logger.test.ts.
        logger.warning(`audit log chain corruption detected in ${this.currentLogFile}: ${err instanceof Error ? err.message : String(err)}. Hash chain quarantined for this session.`);
        this.disableHashChainForSession();
        this.previousHash = "GENESIS";
      }
    }

    // If today's file has no content yet, link the chain from the previous day's
    // last hash so cross-day gaps cannot be exploited by replacing a whole day's file.
    // Skip this if the chain has been quarantined (M7) so a corrupted session does not
    // re-link to a previous hash and produce a fresh valid-looking chain.
    if (this.config.hashChainEnabled && this.previousHash === "GENESIS") {
      const prevHash = this.findPreviousDayLastHash(today);
      if (prevHash) {
        this.previousHash = prevHash;
        logger.info(`audit chain linked from previous day (…${prevHash.slice(-8)})`);
      }
    }
  }

  /** Return the last hash from the most recent audit file before `today`, or null. */
  private findPreviousDayLastHash(today: string): string | null {
    try {
      const files = fs.readdirSync(this.config.logDir);
      const candidates = files
        .filter(f => {
          if (!f.startsWith("audit-") || !f.endsWith(".jsonl")) return false;
          const dateStr = f.slice(6, 16);
          return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < today;
        })
        .sort()
        .reverse(); // most recent first

      for (const file of candidates) {
        try {
          const filePath = path.join(this.config.logDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.trim().split("\n").filter(l => l.length > 0);
          if (lines.length === 0) continue;
          const lastEvent = JSON.parse(lines[lines.length - 1]) as AuditEvent;
          if (typeof lastEvent.hash === "string" && lastEvent.hash.length > 0) {
            return lastEvent.hash;
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      logger.debug(`audit-logger: reading previous day hash for cross-day chain: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  /**
   * Clean up old log files based on retention policy
   */
  private cleanOldLogs(): void {
    try {
      const files = fs.readdirSync(this.config.logDir);
      // Filenames are UTC dates (toISOString) and new Date("YYYY-MM-DD") parses as
      // UTC midnight, so compute the cutoff at UTC midnight too — using local
      // setDate/getDate would skew the comparison by up to a day near TZ boundaries (L13).
      const cutoffDate = new Date();
      cutoffDate.setUTCHours(0, 0, 0, 0);
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.config.retentionDays);

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

      // Skip sensitive keys entirely. Anchored to exact key names (L14) so benign keys
      // like author / keywords / tokenCount / monkey are no longer stomped to [REDACTED]
      // by a loose substring match. The bare `auth` key is kept as an exact alternative so
      // we retain full parity with the old loose regex (which matched `auth`) — `author`
      // etc. are not exactly "auth" so they still pass through. accessToken / refreshToken
      // / secretKey etc. are NOT matched here on purpose — their string values are still
      // caught by the broad substring net in the string-value branch below, which we
      // deliberately keep loose so real compound-named secrets do not leak.
      if (/^(password|secret|token|api_?key|credential|auth|authorization)$/i.test(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      // Sanitize string values
      if (typeof value === "string") {
        // Intentionally broad (substring) safety net: this is what keeps camelCase
        // compound secret keys (accessToken, refreshToken, secretKey, authToken) redacted
        // now that the key-path above is exact-match (L14). Accepted tradeoff: a benign
        // key holding a long (>8 char) string and containing one of these substrings
        // (e.g. "keywords", "monkey") is still redacted here — preferred over leaking a
        // real secret.
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

    try {
      await withLock(logFile, async () => {
        if (!this.pendingEvents.includes(event)) {
          return;
        }

        // Stamp the chain link and compute the hash inside the serialized critical section
        // so the pointer advances atomically per event in write order (H20). Computing this
        // at log() time would let concurrent calls share a previousHash and fork the chain.
        if (this.config.hashChainEnabled) {
          event.previousHash = this.previousHash;
          const { hash: _ignored, ...eventWithoutHash } = event;
          event.hash = this.computeHash(eventWithoutHash);
        }

        const line = `${JSON.stringify(event)}\n`;
        this.currentLogFile = logFile;
        appendFileSecure(logFile, line, PERMISSION_MODES.OWNER_READ_WRITE);
        this.pendingEvents = this.pendingEvents.filter((pendingEvent) => pendingEvent !== event);
        // Advance the chain pointer only after the write physically succeeds (I228)
        if (this.config.hashChainEnabled && event.hash) {
          this.previousHash = event.hash;
          // Anchor the latest hash externally after it advances (M6).
          this.writeCheckpoint(event.hash);
        }
      });

      // Fan-out to subscribers after successful write (I244)
      for (const sub of this.eventSubscribers) {
        // Fire-and-forget so a slow/failing SIEM/compliance subscriber never blocks
        // audit writes, but surface the failure at debug level so it is observable (L12).
        sub(event).catch(err => logger.debug(`audit-logger: subscriber fan-out error: ${err instanceof Error ? err.message : String(err)}`));
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

    // The previousHash and hash are NOT computed here. Concurrent log() calls would
    // otherwise read the same this.previousHash before any write completes and fork the
    // chain. Instead they are assigned inside flushEvent's serialized critical section, in
    // write order, so the chain pointer advances atomically per event (H20).
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      eventName,
      success,
      duration_ms,
      details: sanitizedDetails,
      previousHash: "",
      hash: "",
    };

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

    // M8: free-text fields from compliance tools (report_security_incident
    // title/description, request_data_erasure reason, submit_dsar details) carry
    // user-supplied PII. sanitizeDetails only redacts by KEY name and short values pass
    // through verbatim, so these would persist in the audit log for the 2555-day
    // retention. Hash + length-stamp them here (the single choke point for all tool
    // calls) so the audit record stays useful (correlatable, length known) without
    // storing raw PII.
    const FREE_TEXT_PII = /^(description|reason|details|title)$/i;

    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") {
        if (FREE_TEXT_PII.test(key)) {
          const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
          summary[key] = `[redacted PII, ${value.length} chars, sha256:${digest}]`;
          continue;
        }
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

      // Determine the expected starting hash. For a file that follows a previous
      // day's file, the first event's previousHash must equal that file's last hash
      // (not "GENESIS"), or the cross-day chain has been broken.
      let expectedPreviousHash = "GENESIS";
      if (this.config.hashChainEnabled && lines.length > 0) {
        const dateMatch = path.basename(file).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (dateMatch) {
          const prevHash = this.findPreviousDayLastHash(dateMatch[1]);
          if (prevHash) {
            expectedPreviousHash = prevHash;
          }
        }
      }

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

      // M6: verify against the external tamper anchor. Log-file-scoped tampering that
      // recomputes a self-consistent chain but does not also update the out-of-dir
      // sidecar is caught here; broad filesystem tampering is caught only when an HMAC
      // key (NLMCP_AUDIT_CHECKPOINT_KEY) is configured and held out of reach.
      // Tolerate a missing checkpoint (first run / arbitrary historical file) — only
      // flag when a checkpoint exists, so this never spuriously fails a clean log.
      if (this.config.hashChainEnabled && lines.length > 0) {
        const checkpoint = this.readCheckpoint();
        if (checkpoint) {
          // Only anchor-check the live current-day file: the checkpoint tracks the
          // latest hash written, which belongs to the most recent file.
          const isCurrentFile = path.resolve(file) === path.resolve(this.currentLogFile);
          if (isCurrentFile) {
            if (this.checkpointKey) {
              const expectedSig = this.signCheckpoint(checkpoint.hash);
              if (!checkpoint.signature || checkpoint.signature !== expectedSig) {
                errors.push("Tamper anchor: checkpoint signature invalid (checkpoint may have been forged or key changed).");
              }
            }
            if (checkpoint.hash !== expectedPreviousHash) {
              errors.push(`Tamper anchor: external checkpoint hash does not match log tail. Expected ${checkpoint.hash}, log ends at ${expectedPreviousHash}. The log may have been rewritten.`);
            }
          }
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

  // ============================================================================
  // M6: external tamper-anchor checkpoint
  // ============================================================================

  /** Compute the HMAC signature for a checkpoint hash, or null when no key is set. */
  private signCheckpoint(hash: string): string | null {
    if (!this.checkpointKey) return null;
    return crypto.createHmac("sha256", this.checkpointKey).update(hash).digest("hex");
  }

  /**
   * Persist the latest chain hash to the external checkpoint (outside the log dir).
   * Best-effort: a failure here must never break audit writes.
   */
  private writeCheckpoint(hash: string): void {
    if (!this.config.hashChainEnabled || !hash || hash === "GENESIS") return;
    try {
      const payload: Record<string, unknown> = {
        hash,
        updatedAt: new Date().toISOString(),
      };
      const signature = this.signCheckpoint(hash);
      if (signature) payload.signature = signature;
      fs.writeFileSync(this.checkpointPath, JSON.stringify(payload), { mode: 0o600 });
    } catch (err) {
      logger.debug(`audit-logger: writing tamper-anchor checkpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read the external checkpoint, returning null if absent or unreadable. */
  private readCheckpoint(): { hash: string; signature?: string } | null {
    try {
      if (!fs.existsSync(this.checkpointPath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.checkpointPath, "utf-8")) as { hash?: string; signature?: string };
      if (typeof parsed.hash !== "string" || parsed.hash.length === 0) return null;
      return { hash: parsed.hash, signature: parsed.signature };
    } catch (err) {
      logger.debug(`audit-logger: reading tamper-anchor checkpoint: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
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

    // Mirror SIGTERM for SIGINT (Ctrl-C) and SIGHUP so buffered audit events are
    // flushed synchronously on those signals too (M5). The process entry point owns
    // termination (it calls process.exit after its own async shutdown), so these are
    // additive flush-only safety nets and do not suppress termination or hang.
    process.on("SIGTERM", () => {
      AuditLogger.flushAllSync();
    });

    process.on("SIGINT", () => {
      AuditLogger.flushAllSync();
    });

    process.on("SIGHUP", () => {
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

    // Re-chain the batch in write order before serializing. Buffered events were created
    // with empty previousHash/hash (those are stamped inside flushEvent's lock on the async
    // path); on the shutdown path we must stamp them here, advancing the running pointer
    // per event, or the chain forks. Uses the same computeHash as the normal path so
    // verifyIntegrity passes (H20).
    if (this.config.hashChainEnabled) {
      for (const event of this.pendingEvents) {
        event.previousHash = this.previousHash;
        const { hash: _ignored, ...eventWithoutHash } = event;
        event.hash = this.computeHash(eventWithoutHash);
        this.previousHash = event.hash;
      }
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
      } catch (err) {
        logger.debug(`audit-logger: writing log during shutdown flush: ${err instanceof Error ? err.message : String(err)}`);
        // Ignore shutdown flush failures.
      }
      this.currentLogFile = logFile;
    }

    // Anchor the final advanced hash externally on the shutdown path too (M6).
    if (this.config.hashChainEnabled && this.previousHash && this.previousHash !== "GENESIS") {
      this.writeCheckpoint(this.previousHash);
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
          // Use the shared stale-lock threshold (L15) so this sync shutdown path and the
          // async FileLock util agree on staleness for locks on the SAME audit files.
          if (typeof existing.timestamp === "number" && Date.now() - existing.timestamp > STALE_LOCK_THRESHOLD_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (err) {
          logger.debug(`audit-logger: reading stale lock file content in writeWithSyncLock: ${err instanceof Error ? err.message : String(err)}`);
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch (err) {
            logger.debug(`audit-logger: removing stale lock file in writeWithSyncLock: ${err instanceof Error ? err.message : String(err)}`);
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
      } catch (err) {
        logger.debug(`audit-logger: removing lock file in writeWithSyncLock finally block: ${err instanceof Error ? err.message : String(err)}`);
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
