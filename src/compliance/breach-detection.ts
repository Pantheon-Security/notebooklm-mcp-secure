/**
 * Breach Detection
 *
 * Detects potential security breaches and policy violations.
 * Implements detection rules with configurable thresholds and actions.
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
import type { BreachRule, BreachAction, IncidentSeverity } from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Default breach detection rules
 */
const DEFAULT_RULES: BreachRule[] = [
  {
    id: "rule_brute_force",
    name: "Brute Force Attack",
    description: "Multiple failed authentication attempts in short time window",
    severity: "high",
    event_pattern: "auth_failed",
    threshold: 10,
    window_seconds: 300,
    actions: ["log", "block", "alert", "create_incident"],
    notification_required: true,
    notification_deadline_hours: 72,
  },
  {
    id: "rule_secrets_leaked",
    name: "Secrets Leaked in Output",
    description: "Detected credentials or secrets in tool output",
    severity: "critical",
    event_pattern: "secrets_detected",
    threshold: 1,
    window_seconds: 1,
    actions: ["log", "alert", "create_incident"],
    notification_required: true,
    notification_deadline_hours: 24,
  },
  {
    // Rule retained as a stub for API/report-shape compatibility; the
    // `cert_pinning_violation` event source was removed when cert pinning
    // was deleted, so this rule never fires.
    id: "rule_cert_violation",
    name: "Certificate Pinning Violation (disabled)",
    description: "Dormant — cert pinning removed; no event source fires this rule",
    severity: "critical",
    event_pattern: "cert_pinning_violation",
    threshold: 1,
    window_seconds: 1,
    actions: ["log", "block", "alert", "create_incident"],
    notification_required: true,
    notification_deadline_hours: 24,
  },
  {
    id: "rule_prompt_injection",
    name: "Prompt Injection Attempt",
    description: "Detected prompt injection patterns in response",
    severity: "high",
    event_pattern: "prompt_injection",
    threshold: 1,
    window_seconds: 1,
    actions: ["log", "alert"],
    notification_required: false,
  },
  {
    id: "rule_unusual_access",
    name: "Unusual Access Pattern",
    description: "Access patterns outside normal behavior",
    severity: "medium",
    event_pattern: "unusual_access",
    threshold: 5,
    window_seconds: 3600,
    actions: ["log", "alert"],
    notification_required: false,
  },
  {
    id: "rule_mass_export",
    name: "Mass Data Export",
    description: "Large data export request",
    severity: "medium",
    event_pattern: "data_export",
    threshold: 3,
    window_seconds: 3600,
    actions: ["log", "notify_admin"],
    notification_required: false,
  },
  {
    id: "rule_encryption_failure",
    name: "Encryption Failure",
    description: "Encryption or decryption operation failed",
    severity: "high",
    event_pattern: "encryption_error",
    threshold: 3,
    window_seconds: 300,
    actions: ["log", "alert"],
    notification_required: false,
  },
  {
    id: "rule_auth_lockout",
    name: "Authentication Lockout",
    description: "Account locked due to failed attempts",
    severity: "medium",
    event_pattern: "auth_lockout",
    threshold: 1,
    window_seconds: 1,
    actions: ["log", "alert"],
    notification_required: false,
  },
];

/**
 * Event tracking for threshold detection
 */
interface EventTracker {
  rule_id: string;
  events: { timestamp: number; details?: Record<string, unknown> }[];
}

/**
 * Breach detection result
 */
interface BreachDetection {
  id: string;
  detected_at: string;
  rule: BreachRule;
  event_count: number;
  window_start: string;
  window_end: string;
  actions_taken: BreachAction[];
  incident_id?: string;
  blocked: boolean;
}

/**
 * Breach Detector class
 */
export class BreachDetector {
  private static instance: BreachDetector;
  private rulesFile: string;
  private rules: Map<string, BreachRule> = new Map();
  private eventTrackers: Map<string, EventTracker> = new Map();
  private detections: BreachDetection[] = [];
  private loaded: boolean = false;
  private enabled: boolean;
  private blockedPatterns: Set<string> = new Set();

  private constructor() {
    const config = CONFIG;
    this.rulesFile = path.join(config.configDir, "breach-rules.json");
    this.enabled = process.env.NLMCP_BREACH_DETECTION !== "false";
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): BreachDetector {
    if (!BreachDetector.instance) {
      BreachDetector.instance = new BreachDetector();
    }
    return BreachDetector.instance;
  }

  /**
   * Load rules from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    // Load default rules
    for (const rule of DEFAULT_RULES) {
      this.rules.set(rule.id, rule);
    }

    // Load custom rules
    try {
      if (fs.existsSync(this.rulesFile)) {
        const content = fs.readFileSync(this.rulesFile, "utf-8");
        const data = JSON.parse(content);
        if (data.rules && Array.isArray(data.rules)) {
          for (const rule of data.rules) {
            this.rules.set(rule.id, rule);
          }
        }
      }
    } catch (err) {
      log.debug(`breach-detection: load rules from file: ${err instanceof Error ? err.message : String(err)}`);
      // Use defaults if file is corrupted
    }

    this.loaded = true;
  }

  /**
   * Save custom rules to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.rulesFile);
    mkdirSecure(dir);

    // Only save custom rules
    const customRules = Array.from(this.rules.values()).filter(
      r => !DEFAULT_RULES.find(dr => dr.id === r.id)
    );

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      rules: customRules,
    };

    writeFileSecure(this.rulesFile, JSON.stringify(data, null, 2));
  }

  /**
   * Check an event against all rules
   */
  public async checkEvent(
    eventPattern: string,
    details?: Record<string, unknown>
  ): Promise<BreachDetection | null> {
    if (!this.enabled) {
      return null;
    }

    await this.load();

    const now = Date.now();

    // Find matching rules
    for (const rule of this.rules.values()) {
      if (!this.matchesPattern(eventPattern, rule.event_pattern)) {
        continue;
      }

      // Get or create event tracker
      let tracker = this.eventTrackers.get(rule.id);
      if (!tracker) {
        tracker = { rule_id: rule.id, events: [] };
        this.eventTrackers.set(rule.id, tracker);
      }

      // Add this event
      tracker.events.push({ timestamp: now, details });

      // Clean up old events outside window
      const windowStart = now - (rule.window_seconds || 1) * 1000;
      tracker.events = tracker.events.filter(e => e.timestamp >= windowStart);

      // Check threshold
      if (tracker.events.length >= (rule.threshold || 1)) {
        // Breach detected!
        const detection = await this.handleBreach(rule, tracker.events, details);

        // Reset tracker after breach
        tracker.events = [];

        return detection;
      }
    }

    return null;
  }

  /**
   * Check if event pattern matches rule pattern
   */
  private matchesPattern(event: string, pattern: string): boolean {
    // Exact match
    if (event === pattern) {
      return true;
    }

    // Regex pattern
    try {
      const regex = new RegExp(pattern);
      return regex.test(event);
    } catch (err) {
      log.debug(`breach-detection: compile regex pattern: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Handle a detected breach
   */
  private async handleBreach(
    rule: BreachRule,
    events: EventTracker["events"],
    details?: Record<string, unknown>
  ): Promise<BreachDetection> {
    const detection: BreachDetection = {
      id: generateUUID(),
      detected_at: new Date().toISOString(),
      rule,
      event_count: events.length,
      window_start: new Date(events[0].timestamp).toISOString(),
      window_end: new Date(events[events.length - 1].timestamp).toISOString(),
      actions_taken: [],
      blocked: false,
    };

    // Execute actions
    for (const action of rule.actions) {
      try {
        switch (action) {
          case "log":
            await this.actionLog(detection, details);
            break;
          case "alert":
            await this.actionAlert(detection, details);
            break;
          case "block":
            await this.actionBlock(detection);
            break;
          case "notify_admin":
            await this.actionNotifyAdmin(detection, details);
            break;
          case "create_incident":
            const incidentId = await this.actionCreateIncident(detection, details);
            detection.incident_id = incidentId;
            break;
        }
        detection.actions_taken.push(action);
      } catch (err) {
        log.debug(`breach-detection: execute breach action: ${err instanceof Error ? err.message : String(err)}`);
        // Continue with other actions
      }
    }

    this.detections.push(detection);

    return detection;
  }

  /**
   * Action: Log the breach
   */
  private async actionLog(
    detection: BreachDetection,
    details?: Record<string, unknown>
  ): Promise<void> {
    const logger = getComplianceLogger();
    await logger.logBreach(
      detection.rule.name,
      detection.rule.severity,
      detection.rule.notification_required,
      {
        detection_id: detection.id,
        rule_id: detection.rule.id,
        event_count: detection.event_count,
        ...details,
      }
    );
  }

  /**
   * Action: Send alert
   */
  private async actionAlert(
    detection: BreachDetection,
    details?: Record<string, unknown>
  ): Promise<void> {
    const alertManager = getAlertManager();
    // Map incident severity to alert severity
    const severityMap: Record<string, "info" | "warning" | "error" | "critical"> = {
      low: "info",
      medium: "warning",
      high: "error",
      critical: "critical",
    };
    const alertSeverity = severityMap[detection.rule.severity] || "warning";
    await alertManager.sendAlert(
      alertSeverity,
      `Breach Detected: ${detection.rule.name}`,
      detection.rule.description,
      "breach-detector",
      {
        detection_id: detection.id,
        event_count: detection.event_count,
        window: `${detection.window_start} to ${detection.window_end}`,
        ...details,
      }
    );
  }

  /**
   * Action: Block the pattern
   */
  private async actionBlock(detection: BreachDetection): Promise<void> {
    this.blockedPatterns.add(detection.rule.event_pattern);
    detection.blocked = true;
  }

  /**
   * Action: Notify admin
   */
  private async actionNotifyAdmin(
    detection: BreachDetection,
    details?: Record<string, unknown>
  ): Promise<void> {
    // Use alert manager with higher severity for admin notification
    const alertManager = getAlertManager();
    await alertManager.sendAlert(
      "warning",
      `[Admin] ${detection.rule.name}`,
      `${detection.rule.description}\n\nEvent count: ${detection.event_count}`,
      "breach-detector",
      details
    );
  }

  /**
   * Action: Create incident
   */
  private async actionCreateIncident(
    detection: BreachDetection,
    details?: Record<string, unknown>
  ): Promise<string> {
    // This would integrate with incident-manager.ts
    // For now, return a placeholder ID
    const incidentId = `incident_${detection.id.slice(0, 8)}`;

    // Log for now, incident-manager will handle full tracking
    const logger = getComplianceLogger();
    await logger.logSecurityIncident(
      "breach_incident_created",
      detection.rule.severity,
      {
        incident_id: incidentId,
        detection_id: detection.id,
        rule_name: detection.rule.name,
        ...details,
      }
    );

    return incidentId;
  }

  /**
   * Check if a pattern is blocked
   */
  public isBlocked(pattern: string): boolean {
    return this.blockedPatterns.has(pattern);
  }

  /**
   * Unblock a pattern
   */
  public unblock(pattern: string): boolean {
    return this.blockedPatterns.delete(pattern);
  }

  /**
   * Get all rules
   */
  public async getRules(): Promise<BreachRule[]> {
    await this.load();
    return Array.from(this.rules.values());
  }

  /**
   * Add a custom rule
   */
  public async addRule(rule: Omit<BreachRule, "id">): Promise<BreachRule> {
    await this.load();

    const newRule: BreachRule = {
      ...rule,
      id: `rule_${generateUUID().slice(0, 8)}`,
    };

    this.rules.set(newRule.id, newRule);
    await this.save();

    return newRule;
  }

  /**
   * Remove a rule
   */
  public async removeRule(ruleId: string): Promise<boolean> {
    await this.load();

    // Don't allow removing default rules
    if (DEFAULT_RULES.find(r => r.id === ruleId)) {
      return false;
    }

    if (!this.rules.has(ruleId)) {
      return false;
    }

    this.rules.delete(ruleId);
    await this.save();

    return true;
  }

  /**
   * Get recent detections
   */
  public getRecentDetections(limit: number = 100): BreachDetection[] {
    return this.detections.slice(-limit);
  }

  /**
   * Get detection statistics
   */
  public getStats(): {
    enabled: boolean;
    rules_count: number;
    blocked_patterns: number;
    detections_count: number;
    by_severity: Record<IncidentSeverity, number>;
    by_rule: Record<string, number>;
  } {
    const bySeverity: Record<IncidentSeverity, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    const byRule: Record<string, number> = {};

    for (const detection of this.detections) {
      bySeverity[detection.rule.severity]++;
      byRule[detection.rule.id] = (byRule[detection.rule.id] || 0) + 1;
    }

    return {
      enabled: this.enabled,
      rules_count: this.rules.size,
      blocked_patterns: this.blockedPatterns.size,
      detections_count: this.detections.length,
      by_severity: bySeverity,
      by_rule: byRule,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the breach detector instance
 */
export function getBreachDetector(): BreachDetector {
  return BreachDetector.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Check an event for breach detection
 */
export async function checkForBreach(
  eventPattern: string,
  details?: Record<string, unknown>
): Promise<BreachDetection | null> {
  return getBreachDetector().checkEvent(eventPattern, details);
}

/**
 * Check if a pattern is blocked
 */
export function isPatternBlocked(pattern: string): boolean {
  return getBreachDetector().isBlocked(pattern);
}

/**
 * Get breach detection rules
 */
export async function getBreachRules(): Promise<BreachRule[]> {
  return getBreachDetector().getRules();
}
