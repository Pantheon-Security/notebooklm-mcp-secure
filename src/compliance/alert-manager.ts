/**
 * Alert Manager
 *
 * Sends alerts for security and compliance events.
 * Supports multiple channels: console, file, webhook, email.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import https from "https";
import { CONFIG } from "../config.js";
import { mkdirSecure, appendFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import type { Alert, AlertConfig, AlertSeverity } from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Get alert configuration from environment
 */
function getAlertConfig(): AlertConfig {
  return {
    enabled: process.env.NLMCP_ALERTS_ENABLED !== "false",
    channels: {
      console: true,
      file: process.env.NLMCP_ALERTS_FILE ? {
        path: process.env.NLMCP_ALERTS_FILE,
        format: "json",
      } : undefined,
      webhook: process.env.NLMCP_ALERTS_WEBHOOK_URL ? {
        url: process.env.NLMCP_ALERTS_WEBHOOK_URL,
        headers: process.env.NLMCP_ALERTS_WEBHOOK_HEADERS
          ? JSON.parse(process.env.NLMCP_ALERTS_WEBHOOK_HEADERS)
          : undefined,
      } : undefined,
    },
    min_severity: (process.env.NLMCP_ALERTS_MIN_SEVERITY as AlertSeverity) || "warning",
    cooldown_seconds: parseInt(process.env.NLMCP_ALERTS_COOLDOWN || "300", 10),
    max_alerts_per_hour: parseInt(process.env.NLMCP_ALERTS_MAX_PER_HOUR || "60", 10),
  };
}

/**
 * Severity level ordering
 */
const SEVERITY_LEVELS: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/**
 * Alert Manager class
 */
export class AlertManager {
  private static instance: AlertManager;
  private config: AlertConfig;
  private alertHistory: Map<string, number> = new Map(); // key -> last alert timestamp
  private hourlyAlerts: { timestamp: number }[] = [];
  private alertsDir: string;

  private constructor() {
    this.config = getAlertConfig();
    const config = CONFIG;
    this.alertsDir = path.join(config.dataDir, "alerts");

    if (this.config.enabled && this.config.channels.file) {
      mkdirSecure(this.alertsDir);
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): AlertManager {
    if (!AlertManager.instance) {
      AlertManager.instance = new AlertManager();
    }
    return AlertManager.instance;
  }

  /**
   * Check if alert should be sent based on severity
   */
  private meetsMinimumSeverity(severity: AlertSeverity): boolean {
    return SEVERITY_LEVELS[severity] >= SEVERITY_LEVELS[this.config.min_severity];
  }

  /**
   * Check if alert is within cooldown period
   */
  private isInCooldown(key: string): boolean {
    const lastAlert = this.alertHistory.get(key);
    if (!lastAlert) return false;

    const elapsed = (Date.now() - lastAlert) / 1000;
    return elapsed < this.config.cooldown_seconds;
  }

  /**
   * Check if hourly limit is exceeded
   */
  private isHourlyLimitExceeded(): boolean {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.hourlyAlerts = this.hourlyAlerts.filter(a => a.timestamp > oneHourAgo);
    return this.hourlyAlerts.length >= this.config.max_alerts_per_hour;
  }

  /**
   * Record that an alert was sent
   */
  private recordAlert(key: string): void {
    this.alertHistory.set(key, Date.now());
    this.hourlyAlerts.push({ timestamp: Date.now() });
  }

  /**
   * Generate a unique key for deduplication
   */
  private generateKey(severity: AlertSeverity, title: string, source: string): string {
    return `${severity}:${title}:${source}`;
  }

  /**
   * Send an alert
   */
  public async sendAlert(
    severity: AlertSeverity,
    title: string,
    message: string,
    source: string,
    details?: Record<string, unknown>
  ): Promise<Alert | null> {
    if (!this.config.enabled) {
      return null;
    }

    // Check severity
    if (!this.meetsMinimumSeverity(severity)) {
      return null;
    }

    // Check cooldown
    const key = this.generateKey(severity, title, source);
    if (this.isInCooldown(key)) {
      return null;
    }

    // Check hourly limit
    if (this.isHourlyLimitExceeded()) {
      // Log that we're rate limiting, but only once per hour
      if (!this.isInCooldown("rate_limit_warning")) {
        console.warn("[AlertManager] Hourly alert limit exceeded, suppressing alerts");
        this.recordAlert("rate_limit_warning");
      }
      return null;
    }

    // Create alert
    const alert: Alert = {
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      severity,
      title,
      message,
      source,
      details,
      sent_to: [],
    };

    // Send to all configured channels
    const results = await Promise.allSettled([
      this.sendToConsole(alert),
      this.sendToFile(alert),
      this.sendToWebhook(alert),
    ]);

    // Record sent channels
    if (results[0].status === "fulfilled" && results[0].value) {
      alert.sent_to.push("console");
    }
    if (results[1].status === "fulfilled" && results[1].value) {
      alert.sent_to.push("file");
    }
    if (results[2].status === "fulfilled" && results[2].value) {
      alert.sent_to.push("webhook");
    }

    // Record this alert
    this.recordAlert(key);

    return alert;
  }

  /**
   * Send alert to console
   */
  private async sendToConsole(alert: Alert): Promise<boolean> {
    if (!this.config.channels.console) {
      return false;
    }

    const icon = this.getSeverityIcon(alert.severity);
    const timestamp = new Date(alert.timestamp).toLocaleTimeString();

    console.log(`${icon} [${timestamp}] ${alert.title}`);
    console.log(`   ${alert.message}`);
    if (alert.details) {
      console.log(`   Details: ${JSON.stringify(alert.details)}`);
    }

    return true;
  }

  /**
   * Send alert to file
   */
  private async sendToFile(alert: Alert): Promise<boolean> {
    if (!this.config.channels.file) {
      return false;
    }

    try {
      const filePath = this.config.channels.file.path || path.join(
        this.alertsDir,
        `alerts-${new Date().toISOString().split("T")[0]}.jsonl`
      );

      const line = this.config.channels.file.format === "json"
        ? JSON.stringify(alert) + "\n"
        : `${alert.timestamp} [${alert.severity.toUpperCase()}] ${alert.title}: ${alert.message}\n`;

      appendFileSecure(filePath, line);
      return true;
    } catch (err) {
      log.debug(`alert-manager: sendToFile write alert: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Send alert to webhook
   */
  private async sendToWebhook(alert: Alert): Promise<boolean> {
    if (!this.config.channels.webhook?.url) {
      return false;
    }

    try {
      const url = new URL(this.config.channels.webhook.url);

      // Format message for common webhook services
      const body = this.formatWebhookBody(alert);

      return new Promise((resolve) => {
        const req = https.request(
          {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...this.config.channels.webhook?.headers,
            },
            timeout: 10000,
          },
          (res) => {
            resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
          }
        );

        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });

        req.write(JSON.stringify(body));
        req.end();
      });
    } catch (err) {
      log.debug(`alert-manager: sendToWebhook HTTP request: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Format webhook body for common services (Slack, Teams, generic)
   */
  private formatWebhookBody(alert: Alert): Record<string, unknown> {
    const url = this.config.channels.webhook?.url || "";

    // Slack format
    if (url.includes("slack.com")) {
      return {
        text: `${this.getSeverityIcon(alert.severity)} *${alert.title}*`,
        attachments: [
          {
            color: this.getSeverityColor(alert.severity),
            text: alert.message,
            fields: alert.details
              ? Object.entries(alert.details).map(([k, v]) => ({
                  title: k,
                  value: String(v),
                  short: true,
                }))
              : [],
            footer: `Source: ${alert.source}`,
            ts: Math.floor(new Date(alert.timestamp).getTime() / 1000),
          },
        ],
      };
    }

    // Microsoft Teams format
    if (url.includes("office.com") || url.includes("microsoft.com")) {
      return {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: this.getSeverityColor(alert.severity).replace("#", ""),
        summary: alert.title,
        sections: [
          {
            activityTitle: `${this.getSeverityIcon(alert.severity)} ${alert.title}`,
            activitySubtitle: alert.source,
            facts: alert.details
              ? Object.entries(alert.details).map(([k, v]) => ({
                  name: k,
                  value: String(v),
                }))
              : [],
            text: alert.message,
          },
        ],
      };
    }

    // Generic format
    return {
      alert_id: alert.id,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      source: alert.source,
      timestamp: alert.timestamp,
      details: alert.details,
    };
  }

  /**
   * Get severity icon
   */
  private getSeverityIcon(severity: AlertSeverity): string {
    switch (severity) {
      case "critical":
        return "🚨";
      case "error":
        return "❌";
      case "warning":
        return "⚠️";
      case "info":
        return "ℹ️";
    }
  }

  /**
   * Get severity color (for webhooks)
   */
  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case "critical":
        return "#FF0000";
      case "error":
        return "#FF6600";
      case "warning":
        return "#FFCC00";
      case "info":
        return "#0066FF";
    }
  }

  // ============================================
  // CONVENIENCE METHODS
  // ============================================

  /**
   * Send a critical alert
   */
  public async critical(
    title: string,
    message: string,
    source: string,
    details?: Record<string, unknown>
  ): Promise<Alert | null> {
    return this.sendAlert("critical", title, message, source, details);
  }

  /**
   * Send an error alert
   */
  public async error(
    title: string,
    message: string,
    source: string,
    details?: Record<string, unknown>
  ): Promise<Alert | null> {
    return this.sendAlert("error", title, message, source, details);
  }

  /**
   * Send a warning alert
   */
  public async warning(
    title: string,
    message: string,
    source: string,
    details?: Record<string, unknown>
  ): Promise<Alert | null> {
    return this.sendAlert("warning", title, message, source, details);
  }

  /**
   * Send an info alert
   */
  public async info(
    title: string,
    message: string,
    source: string,
    details?: Record<string, unknown>
  ): Promise<Alert | null> {
    return this.sendAlert("info", title, message, source, details);
  }

  /**
   * Get alert statistics
   */
  public getStats(): {
    enabled: boolean;
    min_severity: AlertSeverity;
    cooldown_seconds: number;
    max_alerts_per_hour: number;
    alerts_this_hour: number;
    channels: string[];
  } {
    const channels: string[] = [];
    if (this.config.channels.console) channels.push("console");
    if (this.config.channels.file) channels.push("file");
    if (this.config.channels.webhook) channels.push("webhook");

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const alertsThisHour = this.hourlyAlerts.filter(a => a.timestamp > oneHourAgo).length;

    return {
      enabled: this.config.enabled,
      min_severity: this.config.min_severity,
      cooldown_seconds: this.config.cooldown_seconds,
      max_alerts_per_hour: this.config.max_alerts_per_hour,
      alerts_this_hour: alertsThisHour,
      channels,
    };
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(updates: Partial<AlertConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the alert manager instance
 */
export function getAlertManager(): AlertManager {
  return AlertManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Send an alert
 */
export async function sendAlert(
  severity: AlertSeverity,
  title: string,
  message: string,
  source: string,
  details?: Record<string, unknown>
): Promise<Alert | null> {
  return getAlertManager().sendAlert(severity, title, message, source, details);
}

/**
 * Send a critical alert
 */
export async function alertCritical(
  title: string,
  message: string,
  source: string,
  details?: Record<string, unknown>
): Promise<Alert | null> {
  return getAlertManager().critical(title, message, source, details);
}

/**
 * Send a warning alert
 */
export async function alertWarning(
  title: string,
  message: string,
  source: string,
  details?: Record<string, unknown>
): Promise<Alert | null> {
  return getAlertManager().warning(title, message, source, details);
}
