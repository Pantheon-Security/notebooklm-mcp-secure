/**
 * Data Export Tool
 *
 * Exports all user data in machine-readable format.
 * Implements GDPR Article 20 (Right to Data Portability).
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { CONFIG, type Config } from "../config.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getConsentManager } from "./consent-manager.js";
import type { DataExport, ExportOptions, ConsentRecord, ComplianceEvent } from "./types.js";

/**
 * Compute SHA-256 checksum
 */
function computeChecksum(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Default export options
 */
const DEFAULT_OPTIONS: ExportOptions = {
  include_notebooks: true,
  include_settings: true,
  include_sessions: false, // Sessions are transient
  include_audit_logs: true,
  include_compliance_events: true,
  encrypt_export: false,
  format: "json_pretty",
};

/**
 * Data Exporter class
 */
export class DataExporter {
  private static instance: DataExporter;

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): DataExporter {
    if (!DataExporter.instance) {
      DataExporter.instance = new DataExporter();
    }
    return DataExporter.instance;
  }

  /**
   * Export all user data
   */
  public async exportAll(options: Partial<ExportOptions> = {}): Promise<DataExport> {
    const opts: ExportOptions = { ...DEFAULT_OPTIONS, ...options };
    const config = CONFIG;

    // Log the export request
    const logger = getComplianceLogger();
    await logger.logDataExport(
      { type: "user" },
      Object.keys(opts).filter(k => opts[k as keyof ExportOptions] === true),
      true,
      { format: opts.format }
    );

    // Collect all data
    const data: DataExport["data"] = {
      consent_records: await this.exportConsents(),
      notebook_library: opts.include_notebooks ? await this.exportNotebooks(config) : [],
      user_settings: opts.include_settings ? await this.exportSettings(config) : null,
      session_history: opts.include_sessions ? await this.exportSessions(config) : undefined,
      activity_log: opts.include_audit_logs ? await this.exportAuditLogs(config, opts) : [],
      compliance_events: opts.include_compliance_events ? await this.exportComplianceEvents(config, opts) : [],
    };

    // Build inventory summary
    const inventory = await this.buildInventorySummary(data);

    // Create export package
    const exportData: DataExport = {
      export_metadata: {
        version: "1.0.0",
        exported_at: new Date().toISOString(),
        format: "json",
        encryption: opts.encrypt_export ? "password" : "none",
        checksum: "", // Will be computed
      },
      data,
      data_inventory: inventory,
    };

    // Compute checksum
    const dataString = JSON.stringify(exportData.data);
    exportData.export_metadata.checksum = computeChecksum(dataString);

    return exportData;
  }

  /**
   * Export consent records
   */
  private async exportConsents(): Promise<ConsentRecord[]> {
    const consentManager = getConsentManager();
    return consentManager.getConsentHistory();
  }

  /**
   * Export notebook library
   */
  private async exportNotebooks(config: Config): Promise<unknown[]> {
    const libraryPath = path.join(config.configDir, "library.json");

    try {
      if (fs.existsSync(libraryPath)) {
        const content = fs.readFileSync(libraryPath, "utf-8");
        const data = JSON.parse(content);
        return data.notebooks || [];
      }
    } catch (err) {
      log.debug(`data-export: exportNotebooks read library file: ${err instanceof Error ? err.message : String(err)}`);
      // Return empty if file doesn't exist or is corrupted
    }

    return [];
  }

  /**
   * Export user settings
   */
  private async exportSettings(config: Config): Promise<unknown> {
    const settingsPath = path.join(config.configDir, "settings.json");

    try {
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, "utf-8");
        return JSON.parse(content);
      }
    } catch (err) {
      log.debug(`data-export: exportSettings read settings file: ${err instanceof Error ? err.message : String(err)}`);
      // Return null if file doesn't exist or is corrupted
    }

    return null;
  }

  /**
   * Export session history (if retained)
   */
  private async exportSessions(config: Config): Promise<unknown[]> {
    const sessionsDir = path.join(config.dataDir, "sessions");
    const sessions: unknown[] = [];

    try {
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir);
        for (const file of files.slice(0, 100)) { // Limit to 100 sessions
          try {
            const filePath = path.join(sessionsDir, file);
            const content = fs.readFileSync(filePath, "utf-8");
            const session = JSON.parse(content);
            // Redact sensitive session data
            sessions.push({
              id: session.id,
              created_at: session.created_at,
              last_activity: session.last_activity,
              notebook_id: session.notebook_id,
              // Don't include actual browser state
            });
          } catch (err) {
            log.debug(`data-export: exportSessions parse session file: ${err instanceof Error ? err.message : String(err)}`);
            // Skip corrupted files
          }
        }
      }
    } catch (err) {
      log.debug(`data-export: exportSessions read sessions directory: ${err instanceof Error ? err.message : String(err)}`);
      // Return empty if directory doesn't exist
    }

    return sessions;
  }

  /**
   * Export audit logs
   */
  private async exportAuditLogs(
    config: Config,
    options: ExportOptions
  ): Promise<unknown[]> {
    const auditDir = path.join(config.dataDir, "audit");
    const events: unknown[] = [];

    try {
      if (fs.existsSync(auditDir)) {
        const files = fs.readdirSync(auditDir)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();

        for (const file of files) {
          const filePath = path.join(auditDir, file);

          // Check date filter
          if (options.from_date || options.to_date) {
            const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})\.jsonl/);
            if (dateMatch) {
              const fileDate = new Date(dateMatch[1]);
              if (options.from_date && fileDate < new Date(options.from_date)) continue;
              if (options.to_date && fileDate > new Date(options.to_date)) continue;
            }
          }

          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.trim().split("\n").filter(l => l);

            for (const line of lines) {
              try {
                const event = JSON.parse(line);
                events.push(event);
                if (events.length >= 10000) break; // Limit total events
              } catch (err) {
                log.debug(`data-export: exportAuditLogs parse audit log line: ${err instanceof Error ? err.message : String(err)}`);
                // Skip malformed lines
              }
            }
          } catch (err) {
            log.debug(`data-export: exportAuditLogs read audit log file: ${err instanceof Error ? err.message : String(err)}`);
            // Skip files we can't read
          }

          if (events.length >= 10000) break;
        }
      }
    } catch (err) {
      log.debug(`data-export: exportAuditLogs read audit directory: ${err instanceof Error ? err.message : String(err)}`);
      // Return empty if directory doesn't exist
    }

    return events;
  }

  /**
   * Export compliance events
   */
  private async exportComplianceEvents(
    config: Config,
    options: ExportOptions
  ): Promise<ComplianceEvent[]> {
    const complianceDir = path.join(config.dataDir, "compliance");
    const events: ComplianceEvent[] = [];

    try {
      if (fs.existsSync(complianceDir)) {
        const files = fs.readdirSync(complianceDir)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();

        for (const file of files) {
          const filePath = path.join(complianceDir, file);

          // Check date filter
          if (options.from_date || options.to_date) {
            const dateMatch = file.match(/events-(\d{4}-\d{2})\.jsonl/);
            if (dateMatch) {
              const fileDate = new Date(dateMatch[1] + "-01");
              if (options.from_date && fileDate < new Date(options.from_date)) continue;
              if (options.to_date) {
                const toDate = new Date(options.to_date);
                if (fileDate > toDate) continue;
              }
            }
          }

          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.trim().split("\n").filter(l => l);

            for (const line of lines) {
              try {
                const event = JSON.parse(line) as ComplianceEvent;
                events.push(event);
                if (events.length >= 10000) break;
              } catch (err) {
                log.debug(`data-export: exportComplianceEvents parse compliance event line: ${err instanceof Error ? err.message : String(err)}`);
                // Skip malformed lines
              }
            }
          } catch (err) {
            log.debug(`data-export: exportComplianceEvents read compliance file: ${err instanceof Error ? err.message : String(err)}`);
            // Skip files we can't read
          }

          if (events.length >= 10000) break;
        }
      }
    } catch (err) {
      log.debug(`data-export: exportComplianceEvents read compliance directory: ${err instanceof Error ? err.message : String(err)}`);
      // Return empty if directory doesn't exist
    }

    return events;
  }

  /**
   * Build inventory summary from exported data
   */
  private async buildInventorySummary(
    data: DataExport["data"]
  ): Promise<DataExport["data_inventory"]> {
    const inventory: DataExport["data_inventory"] = [];

    // Consent records
    if (data.consent_records.length > 0) {
      const dates = data.consent_records.map(c => new Date(c.granted_at));
      inventory.push({
        category: "consent_records",
        count: data.consent_records.length,
        date_range: {
          from: new Date(Math.min(...dates.map(d => d.getTime()))).toISOString(),
          to: new Date(Math.max(...dates.map(d => d.getTime()))).toISOString(),
        },
      });
    }

    // Notebooks
    if (Array.isArray(data.notebook_library) && data.notebook_library.length > 0) {
      inventory.push({
        category: "notebook_library",
        count: data.notebook_library.length,
        date_range: { from: "", to: "" },
      });
    }

    // Settings
    if (data.user_settings) {
      inventory.push({
        category: "user_settings",
        count: 1,
        date_range: { from: "", to: "" },
      });
    }

    // Activity log
    if (data.activity_log.length > 0) {
      const timestamps = data.activity_log
        .map(e => (e as { timestamp?: string }).timestamp)
        .filter(t => t)
        .map(t => new Date(t!));

      if (timestamps.length > 0) {
        inventory.push({
          category: "activity_log",
          count: data.activity_log.length,
          date_range: {
            from: new Date(Math.min(...timestamps.map(d => d.getTime()))).toISOString(),
            to: new Date(Math.max(...timestamps.map(d => d.getTime()))).toISOString(),
          },
        });
      }
    }

    // Compliance events
    if (data.compliance_events.length > 0) {
      const timestamps = data.compliance_events
        .map(e => (e as { timestamp?: string }).timestamp)
        .filter(t => t)
        .map(t => new Date(t!));

      if (timestamps.length > 0) {
        inventory.push({
          category: "compliance_events",
          count: data.compliance_events.length,
          date_range: {
            from: new Date(Math.min(...timestamps.map(d => d.getTime()))).toISOString(),
            to: new Date(Math.max(...timestamps.map(d => d.getTime()))).toISOString(),
          },
        });
      }
    }

    return inventory;
  }

  /**
   * Export to file
   */
  public async exportToFile(
    outputPath: string,
    options: Partial<ExportOptions> = {}
  ): Promise<{ success: boolean; path: string; checksum: string }> {
    const exportData = await this.exportAll(options);

    const format = options.format || "json_pretty";
    const content = format === "json_pretty"
      ? JSON.stringify(exportData, null, 2)
      : JSON.stringify(exportData);

    fs.writeFileSync(outputPath, content, "utf-8");

    return {
      success: true,
      path: outputPath,
      checksum: exportData.export_metadata.checksum,
    };
  }

  /**
   * Export to string
   */
  public async exportToString(options: Partial<ExportOptions> = {}): Promise<string> {
    const exportData = await this.exportAll(options);

    const format = options.format || "json_pretty";
    return format === "json_pretty"
      ? JSON.stringify(exportData, null, 2)
      : JSON.stringify(exportData);
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the data exporter instance
 */
export function getDataExporter(): DataExporter {
  return DataExporter.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Export all user data
 */
export async function exportUserData(options: Partial<ExportOptions> = {}): Promise<DataExport> {
  return getDataExporter().exportAll(options);
}

/**
 * Export user data to file
 */
export async function exportUserDataToFile(
  outputPath: string,
  options: Partial<ExportOptions> = {}
): Promise<{ success: boolean; path: string; checksum: string }> {
  return getDataExporter().exportToFile(outputPath, options);
}

/**
 * Export user data to string
 */
export async function exportUserDataToString(options: Partial<ExportOptions> = {}): Promise<string> {
  return getDataExporter().exportToString(options);
}
