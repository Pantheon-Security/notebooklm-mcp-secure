/**
 * SIEM Exporter
 *
 * Exports logs to external Security Information and Event Management systems.
 * Supports CEF, LEEF, Syslog, Splunk HEC, and JSON formats.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import https from "https";
import dgram from "dgram";
import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { mkdirSecure, appendFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import type { SIEMConfig, SIEMFormat, AlertSeverity } from "./types.js";

/**
 * Get SIEM configuration from environment
 */
function getSIEMConfig(): SIEMConfig {
  return {
    enabled: process.env.NLMCP_SIEM_ENABLED === "true",
    format: (process.env.NLMCP_SIEM_FORMAT as SIEMFormat) || "cef",
    endpoint: process.env.NLMCP_SIEM_ENDPOINT,
    syslog_host: process.env.NLMCP_SIEM_SYSLOG_HOST,
    syslog_port: parseInt(process.env.NLMCP_SIEM_SYSLOG_PORT || "514", 10),
    api_key: process.env.NLMCP_SIEM_API_KEY,
    min_severity: (process.env.NLMCP_SIEM_MIN_SEVERITY as AlertSeverity) || "warning",
    event_types: process.env.NLMCP_SIEM_EVENT_TYPES?.split(",") || [],
    batch_size: parseInt(process.env.NLMCP_SIEM_BATCH_SIZE || "100", 10),
    flush_interval_ms: parseInt(process.env.NLMCP_SIEM_FLUSH_INTERVAL_MS || "5000", 10),
    retry_attempts: parseInt(process.env.NLMCP_SIEM_RETRY_ATTEMPTS || "3", 10),
    queue_max_size: parseInt(process.env.NLMCP_SIEM_QUEUE_MAX_SIZE || "10000", 10),
  };
}

/**
 * Severity to numeric level mapping
 */
const SEVERITY_LEVELS: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/**
 * Severity to CEF level mapping (0-10)
 */
const CEF_SEVERITY: Record<AlertSeverity, number> = {
  info: 3,
  warning: 5,
  error: 7,
  critical: 10,
};

/**
 * Severity to syslog priority mapping
 */
const SYSLOG_SEVERITY: Record<AlertSeverity, number> = {
  info: 6,    // Informational
  warning: 4, // Warning
  error: 3,   // Error
  critical: 2, // Critical
};

/**
 * SIEM event structure
 */
interface SIEMEvent {
  timestamp: string;
  event_type: string;
  event_name: string;
  severity: AlertSeverity;
  source: string;
  message: string;
  details: Record<string, unknown>;
}

/**
 * SIEM Exporter class
 */
export class SIEMExporter {
  private static instance: SIEMExporter;
  private config: SIEMConfig;
  private eventQueue: SIEMEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isExporting: boolean = false;
  private failedDir: string;

  private constructor() {
    this.config = getSIEMConfig();
    const config = getConfig();
    this.failedDir = path.join(config.dataDir, "siem_failed");

    if (this.config.enabled) {
      mkdirSecure(this.failedDir);
      this.startFlushTimer();
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): SIEMExporter {
    if (!SIEMExporter.instance) {
      SIEMExporter.instance = new SIEMExporter();
    }
    return SIEMExporter.instance;
  }

  /**
   * Start the flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Ignore flush errors
      });
    }, this.config.flush_interval_ms);
  }

  /**
   * Stop the flush timer
   */
  public stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Check if event meets minimum severity
   */
  private meetsMinimumSeverity(severity: AlertSeverity): boolean {
    return SEVERITY_LEVELS[severity] >= SEVERITY_LEVELS[this.config.min_severity];
  }

  /**
   * Check if event type is allowed
   */
  private isEventTypeAllowed(eventType: string): boolean {
    if (this.config.event_types.length === 0) {
      return true; // All types allowed if no filter
    }
    return this.config.event_types.includes(eventType);
  }

  /**
   * Queue an event for export
   */
  public async queueEvent(event: SIEMEvent): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    // Check filters
    if (!this.meetsMinimumSeverity(event.severity)) {
      return false;
    }

    if (!this.isEventTypeAllowed(event.event_type)) {
      return false;
    }

    // Check queue size
    if (this.eventQueue.length >= this.config.queue_max_size) {
      // Drop oldest event
      this.eventQueue.shift();
    }

    this.eventQueue.push(event);

    // Flush if batch size reached
    if (this.eventQueue.length >= this.config.batch_size) {
      await this.flush();
    }

    return true;
  }

  /**
   * Flush queued events
   */
  public async flush(): Promise<{ sent: number; failed: number }> {
    if (!this.config.enabled || this.isExporting || this.eventQueue.length === 0) {
      return { sent: 0, failed: 0 };
    }

    this.isExporting = true;
    let sent = 0;
    let failed = 0;

    try {
      const batch = this.eventQueue.splice(0, this.config.batch_size);

      for (const event of batch) {
        const success = await this.exportEvent(event);
        if (success) {
          sent++;
        } else {
          failed++;
          // Save to failed directory
          await this.saveFailedEvent(event);
        }
      }
    } finally {
      this.isExporting = false;
    }

    return { sent, failed };
  }

  /**
   * Export a single event
   */
  private async exportEvent(event: SIEMEvent): Promise<boolean> {
    switch (this.config.format) {
      case "cef":
        return this.exportCEF(event);
      case "leef":
        return this.exportLEEF(event);
      case "syslog":
        return this.exportSyslog(event);
      case "splunk_hec":
        return this.exportSplunkHEC(event);
      case "json":
      default:
        return this.exportJSON(event);
    }
  }

  /**
   * Format event as CEF (Common Event Format)
   */
  private formatCEF(event: SIEMEvent): string {
    const cefSeverity = CEF_SEVERITY[event.severity];

    // CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
    const cef = [
      "CEF:0",
      "Pantheon Security",
      "NotebookLM MCP",
      "1.5.1",
      event.event_type,
      event.event_name,
      cefSeverity.toString(),
    ].join("|");

    // Add extension fields
    const extensions: string[] = [];
    extensions.push(`msg=${this.escapeExtension(event.message)}`);
    extensions.push(`src=${event.source}`);
    extensions.push(`rt=${new Date(event.timestamp).getTime()}`);

    if (event.details) {
      for (const [key, value] of Object.entries(event.details)) {
        extensions.push(`${key}=${this.escapeExtension(String(value))}`);
      }
    }

    return `${cef} ${extensions.join(" ")}`;
  }

  /**
   * Export event as CEF
   */
  private async exportCEF(event: SIEMEvent): Promise<boolean> {
    const cefMessage = this.formatCEF(event);
    return this.sendToEndpoint(cefMessage);
  }

  /**
   * Format event as LEEF (Log Event Extended Format)
   */
  private formatLEEF(event: SIEMEvent): string {
    // LEEF:Version|Vendor|Product|Version|EventID|attributes
    const leef = [
      "LEEF:2.0",
      "Pantheon Security",
      "NotebookLM MCP",
      "1.5.1",
      event.event_type,
    ].join("|");

    // Add attributes
    const attributes: string[] = [];
    attributes.push(`cat=${event.event_name}`);
    attributes.push(`sev=${SYSLOG_SEVERITY[event.severity]}`);
    attributes.push(`msg=${event.message}`);
    attributes.push(`src=${event.source}`);
    attributes.push(`devTime=${event.timestamp}`);

    if (event.details) {
      for (const [key, value] of Object.entries(event.details)) {
        attributes.push(`${key}=${String(value)}`);
      }
    }

    return `${leef}\t${attributes.join("\t")}`;
  }

  /**
   * Export event as LEEF
   */
  private async exportLEEF(event: SIEMEvent): Promise<boolean> {
    const leefMessage = this.formatLEEF(event);
    return this.sendToEndpoint(leefMessage);
  }

  /**
   * Format event as RFC 5424 syslog
   */
  private formatSyslog(event: SIEMEvent): string {
    const priority = (16 * 8) + SYSLOG_SEVERITY[event.severity]; // Local0 facility
    const timestamp = new Date(event.timestamp).toISOString();
    const hostname = "notebooklm-mcp";
    const appName = "nlmcp";
    const procId = process.pid.toString();
    const msgId = event.event_type;

    // RFC 5424 format
    return `<${priority}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId} - ${event.message}`;
  }

  /**
   * Export event as syslog
   */
  private async exportSyslog(event: SIEMEvent): Promise<boolean> {
    if (!this.config.syslog_host) {
      return false;
    }

    const syslogMessage = this.formatSyslog(event);

    return new Promise((resolve) => {
      const client = dgram.createSocket("udp4");
      const buffer = Buffer.from(syslogMessage);

      client.send(
        buffer,
        0,
        buffer.length,
        this.config.syslog_port || 514,
        this.config.syslog_host!,
        (err) => {
          client.close();
          resolve(!err);
        }
      );

      // Timeout
      setTimeout(() => {
        try {
          client.close();
        } catch (err) {
          log.debug(`siem-exporter: close TCP client on timeout: ${err instanceof Error ? err.message : String(err)}`);
          // Ignore
        }
        resolve(false);
      }, 5000);
    });
  }

  /**
   * Export event to Splunk HEC
   */
  private async exportSplunkHEC(event: SIEMEvent): Promise<boolean> {
    if (!this.config.endpoint) {
      return false;
    }

    const splunkEvent = {
      time: new Date(event.timestamp).getTime() / 1000,
      host: "notebooklm-mcp",
      source: event.source,
      sourcetype: "notebooklm:security",
      event: {
        event_type: event.event_type,
        event_name: event.event_name,
        severity: event.severity,
        message: event.message,
        ...event.details,
      },
    };

    return this.sendToEndpoint(JSON.stringify(splunkEvent));
  }

  /**
   * Export event as JSON
   */
  private async exportJSON(event: SIEMEvent): Promise<boolean> {
    return this.sendToEndpoint(JSON.stringify(event));
  }

  /**
   * Send message to configured endpoint
   */
  private async sendToEndpoint(message: string): Promise<boolean> {
    if (!this.config.endpoint) {
      return false;
    }

    for (let attempt = 0; attempt < this.config.retry_attempts; attempt++) {
      try {
        const success = await this.httpPost(this.config.endpoint, message);
        if (success) {
          return true;
        }
      } catch (err) {
        log.debug(`siem-exporter: sendToEndpoint HTTP post attempt: ${err instanceof Error ? err.message : String(err)}`);
        // Retry
      }

      // Wait before retry
      if (attempt < this.config.retry_attempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    return false;
  }

  /**
   * HTTP POST request
   */
  private async httpPost(endpoint: string, body: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const url = new URL(endpoint);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        };

        if (this.config.api_key) {
          headers["Authorization"] = `Bearer ${this.config.api_key}`;
        }

        const req = https.request(
          {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: "POST",
            headers,
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

        req.write(body);
        req.end();
      } catch (err) {
        log.debug(`siem-exporter: httpPost create request: ${err instanceof Error ? err.message : String(err)}`);
        resolve(false);
      }
    });
  }

  /**
   * Escape CEF extension value
   */
  private escapeExtension(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/=/g, "\\=")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
  }

  /**
   * Save failed event for later retry
   */
  private async saveFailedEvent(event: SIEMEvent): Promise<void> {
    try {
      const fileName = `failed-${new Date().toISOString().split("T")[0]}.jsonl`;
      const filePath = path.join(this.failedDir, fileName);
      appendFileSecure(filePath, JSON.stringify(event) + "\n");
    } catch (err) {
      log.debug(`siem-exporter: saveFailedEvent write to file: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore save errors
    }
  }

  /**
   * Retry failed events
   */
  public async retryFailed(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    try {
      if (!fs.existsSync(this.failedDir)) {
        return { sent, failed };
      }

      const files = fs.readdirSync(this.failedDir).filter(f => f.endsWith(".jsonl"));

      for (const file of files) {
        const filePath = path.join(this.failedDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(l => l);

        const remainingEvents: SIEMEvent[] = [];

        for (const line of lines) {
          try {
            const event = JSON.parse(line) as SIEMEvent;
            const success = await this.exportEvent(event);
            if (success) {
              sent++;
            } else {
              failed++;
              remainingEvents.push(event);
            }
          } catch (err) {
            log.debug(`siem-exporter: retryFailed parse event line: ${err instanceof Error ? err.message : String(err)}`);
            // Skip malformed events
          }
        }

        // Update file with remaining events
        if (remainingEvents.length === 0) {
          fs.unlinkSync(filePath);
        } else {
          fs.writeFileSync(
            filePath,
            remainingEvents.map(e => JSON.stringify(e)).join("\n") + "\n"
          );
        }
      }
    } catch (err) {
      log.debug(`siem-exporter: retryFailed process failed events: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore retry errors
    }

    return { sent, failed };
  }

  /**
   * Get exporter statistics
   */
  public getStats(): {
    enabled: boolean;
    format: SIEMFormat;
    queue_size: number;
    endpoint_configured: boolean;
    syslog_configured: boolean;
  } {
    return {
      enabled: this.config.enabled,
      format: this.config.format,
      queue_size: this.eventQueue.length,
      endpoint_configured: !!this.config.endpoint,
      syslog_configured: !!this.config.syslog_host,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the SIEM exporter instance
 */
export function getSIEMExporter(): SIEMExporter {
  return SIEMExporter.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Queue an event for SIEM export
 */
export async function exportToSIEM(
  eventType: string,
  eventName: string,
  severity: AlertSeverity,
  message: string,
  source: string,
  details?: Record<string, unknown>
): Promise<boolean> {
  return getSIEMExporter().queueEvent({
    timestamp: new Date().toISOString(),
    event_type: eventType,
    event_name: eventName,
    severity,
    source,
    message,
    details: details || {},
  });
}

/**
 * Flush SIEM event queue
 */
export async function flushSIEM(): Promise<{ sent: number; failed: number }> {
  return getSIEMExporter().flush();
}
