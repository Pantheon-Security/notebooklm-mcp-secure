/**
 * Health Monitor
 *
 * Monitors system health and availability.
 * Implements SOC2 availability and monitoring requirements.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import os from "os";
import fs from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getConsentManager } from "./consent-manager.js";
import { getRetentionEngine } from "./retention-engine.js";
import { getIncidentManager } from "./incident-manager.js";
import { getAlertManager } from "./alert-manager.js";
import type {
  HealthMetrics,
  ComponentHealth,
  ResourceMetrics,
  SecurityStatus,
  ComplianceStatus,
} from "./types.js";

/**
 * Health check result
 */
interface HealthCheck {
  name: string;
  check: () => Promise<ComponentHealth>;
}

/**
 * Health Monitor class
 */
export class HealthMonitor {
  private static instance: HealthMonitor;
  private startTime: number;
  private enabled: boolean;
  private checkIntervalSeconds: number;
  private checkTimer: NodeJS.Timeout | null = null;
  private lastMetrics: HealthMetrics | null = null;
  private checks: HealthCheck[] = [];

  private constructor() {
    this.startTime = Date.now();
    this.enabled = process.env.NLMCP_HEALTH_MONITORING !== "false";
    this.checkIntervalSeconds = parseInt(
      process.env.NLMCP_HEALTH_CHECK_INTERVAL || "60",
      10
    );

    this.initializeChecks();

    if (this.enabled) {
      this.startMonitoring();
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): HealthMonitor {
    if (!HealthMonitor.instance) {
      HealthMonitor.instance = new HealthMonitor();
    }
    return HealthMonitor.instance;
  }

  /**
   * Initialize health checks
   */
  private initializeChecks(): void {
    this.checks = [
      {
        name: "data_directory",
        check: () => this.checkDataDirectory(),
      },
      {
        name: "config_directory",
        check: () => this.checkConfigDirectory(),
      },
      {
        name: "audit_logging",
        check: () => this.checkAuditLogging(),
      },
      {
        name: "compliance_logging",
        check: () => this.checkComplianceLogging(),
      },
      {
        name: "encryption",
        check: () => this.checkEncryption(),
      },
    ];
  }

  /**
   * Start periodic health monitoring
   */
  private startMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    // Run initial check
    this.runHealthCheck().catch(() => {});

    // Schedule periodic checks
    this.checkTimer = setInterval(() => {
      this.runHealthCheck().catch(() => {});
    }, this.checkIntervalSeconds * 1000);
  }

  /**
   * Stop health monitoring
   */
  public stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Run full health check
   */
  public async runHealthCheck(): Promise<HealthMetrics> {
    const startTime = Date.now();

    // Run all component checks
    const componentResults = await Promise.all(
      this.checks.map(async (check) => {
        try {
          return await check.check();
        } catch (error) {
          return {
            name: check.name,
            status: "down" as const,
            last_check: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    // Get resource metrics
    const resources = this.getResourceMetrics();

    // Get security status
    const security = await this.getSecurityStatus();

    // Get compliance status
    const compliance = await this.getComplianceStatus();

    // Determine overall status
    const hasDown = componentResults.some(c => c.status === "down");
    const hasDegraded = componentResults.some(c => c.status === "degraded");

    let overallStatus: HealthMetrics["status"];
    if (hasDown) {
      overallStatus = "unhealthy";
    } else if (hasDegraded) {
      overallStatus = "degraded";
    } else {
      overallStatus = "healthy";
    }

    const metrics: HealthMetrics = {
      timestamp: new Date().toISOString(),
      status: overallStatus,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      components: componentResults,
      resources,
      security,
      compliance,
    };

    this.lastMetrics = metrics;

    // Alert if unhealthy
    if (overallStatus === "unhealthy") {
      const alertManager = getAlertManager();
      const downComponents = componentResults
        .filter(c => c.status === "down")
        .map(c => c.name);

      await alertManager.sendAlert(
        "error",
        "System Health Degraded",
        `The following components are down: ${downComponents.join(", ")}`,
        "health-monitor",
        { components: downComponents }
      );
    }

    // Log health check
    const logger = getComplianceLogger();
    await logger.log(
      "data_processing",
      "health_check_completed",
      { type: "system" },
      "success",
      {
        details: {
          status: overallStatus,
          duration_ms: Date.now() - startTime,
          components_checked: componentResults.length,
        },
      }
    );

    return metrics;
  }

  /**
   * Check data directory health
   */
  private async checkDataDirectory(): Promise<ComponentHealth> {
    const startTime = Date.now();
    const config = CONFIG;

    try {
      if (!fs.existsSync(config.dataDir)) {
        return {
          name: "data_directory",
          status: "down",
          last_check: new Date().toISOString(),
          error: "Data directory does not exist",
        };
      }

      // Check if writable
      const testFile = path.join(config.dataDir, ".health_check");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);

      return {
        name: "data_directory",
        status: "up",
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: "data_directory",
        status: "down",
        last_check: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check config directory health
   */
  private async checkConfigDirectory(): Promise<ComponentHealth> {
    const startTime = Date.now();
    const config = CONFIG;

    try {
      if (!fs.existsSync(config.configDir)) {
        return {
          name: "config_directory",
          status: "down",
          last_check: new Date().toISOString(),
          error: "Config directory does not exist",
        };
      }

      // Check if readable
      fs.readdirSync(config.configDir);

      return {
        name: "config_directory",
        status: "up",
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: "config_directory",
        status: "down",
        last_check: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check audit logging health
   */
  private async checkAuditLogging(): Promise<ComponentHealth> {
    const startTime = Date.now();
    const config = CONFIG;

    try {
      const auditDir = path.join(config.dataDir, "audit");

      if (!fs.existsSync(auditDir)) {
        // Not an error if audit is disabled
        if (process.env.NLMCP_AUDIT_ENABLED === "false") {
          return {
            name: "audit_logging",
            status: "up",
            last_check: new Date().toISOString(),
            response_time_ms: Date.now() - startTime,
          };
        }

        return {
          name: "audit_logging",
          status: "degraded",
          last_check: new Date().toISOString(),
          error: "Audit directory not yet created",
        };
      }

      // Check for recent log files
      const files = fs.readdirSync(auditDir).filter(f => f.endsWith(".jsonl"));
      if (files.length === 0) {
        return {
          name: "audit_logging",
          status: "degraded",
          last_check: new Date().toISOString(),
          error: "No audit log files found",
        };
      }

      return {
        name: "audit_logging",
        status: "up",
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: "audit_logging",
        status: "down",
        last_check: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check compliance logging health
   */
  private async checkComplianceLogging(): Promise<ComponentHealth> {
    const startTime = Date.now();

    try {
      const logger = getComplianceLogger();
      const stats = await logger.getStats();

      if (!stats.enabled) {
        return {
          name: "compliance_logging",
          status: "up",
          last_check: new Date().toISOString(),
          response_time_ms: Date.now() - startTime,
        };
      }

      // Verify integrity
      const integrity = await logger.verifyIntegrity();
      if (!integrity.valid) {
        return {
          name: "compliance_logging",
          status: "degraded",
          last_check: new Date().toISOString(),
          error: "Integrity verification failed",
        };
      }

      return {
        name: "compliance_logging",
        status: "up",
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: "compliance_logging",
        status: "down",
        last_check: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check encryption health
   */
  private async checkEncryption(): Promise<ComponentHealth> {
    const startTime = Date.now();
    const config = CONFIG;

    try {
      // Check if encryption is enabled
      if (process.env.NLMCP_ENCRYPTION_ENABLED === "false") {
        return {
          name: "encryption",
          status: "degraded",
          last_check: new Date().toISOString(),
          error: "Encryption is disabled",
        };
      }

      // Check for PQ keys
      const keysPath = path.join(config.dataDir, "pq-keys.enc");
      if (!fs.existsSync(keysPath)) {
        return {
          name: "encryption",
          status: "degraded",
          last_check: new Date().toISOString(),
          error: "Post-quantum keys not yet generated",
        };
      }

      return {
        name: "encryption",
        status: "up",
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        name: "encryption",
        status: "down",
        last_check: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get resource metrics
   */
  private getResourceMetrics(): ResourceMetrics {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      memory_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
      memory_limit_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
      disk_used_mb: Math.round((totalMem - freeMem) / 1024 / 1024),
      disk_available_mb: Math.round(freeMem / 1024 / 1024),
    };
  }

  /**
   * Get security status
   */
  private async getSecurityStatus(): Promise<SecurityStatus> {
    let openIncidents = 0;

    try {
      const incidentManager = getIncidentManager();
      const incidents = await incidentManager.getOpenIncidents();
      openIncidents = incidents.length;
    } catch (err) {
      log.debug(`health-monitor: getSecurityStatus fetch open incidents: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore errors
    }

    return {
      encryption_enabled: process.env.NLMCP_ENCRYPTION_ENABLED !== "false",
      auth_enabled: process.env.NLMCP_AUTH_ENABLED === "true",
      // Certificate pinning was removed; the field is retained for API/report
      // shape compatibility and is always false.
      cert_pinning_enabled: false,
      open_incidents: openIncidents,
    };
  }

  /**
   * Get compliance status
   */
  private async getComplianceStatus(): Promise<ComplianceStatus> {
    let consentValid = true;
    let activePolicies = 0;
    let pendingErasures = 0;

    try {
      const consentManager = getConsentManager();
      const validation = await consentManager.validateConsents();
      consentValid = validation.valid;
    } catch (err) {
      log.debug(`health-monitor: getComplianceStatus validate consents: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore errors
    }

    try {
      const retentionEngine = getRetentionEngine();
      const policies = await retentionEngine.getPolicies();
      activePolicies = policies.length;
    } catch (err) {
      log.debug(`health-monitor: getComplianceStatus fetch retention policies: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore errors
    }

    return {
      consent_valid: consentValid,
      retention_policies_active: activePolicies,
      pending_erasure_requests: pendingErasures,
      last_compliance_check: new Date().toISOString(),
    };
  }

  /**
   * Get last health metrics
   */
  public getLastMetrics(): HealthMetrics | null {
    return this.lastMetrics;
  }

  /**
   * Get current status (quick check without full health run)
   */
  public getStatus(): {
    status: "healthy" | "degraded" | "unhealthy" | "unknown";
    uptime_seconds: number;
    last_check?: string;
  } {
    if (!this.lastMetrics) {
      return {
        status: "unknown",
        uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      };
    }

    return {
      status: this.lastMetrics.status,
      uptime_seconds: Math.floor((Date.now() - this.startTime) / 1000),
      last_check: this.lastMetrics.timestamp,
    };
  }

  /**
   * Register a custom health check
   */
  public registerCheck(name: string, check: () => Promise<ComponentHealth>): void {
    this.checks.push({ name, check });
  }

  /**
   * Get uptime in human-readable format
   */
  public getUptimeFormatted(): string {
    const seconds = Math.floor((Date.now() - this.startTime) / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(" ");
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the health monitor instance
 */
export function getHealthMonitor(): HealthMonitor {
  return HealthMonitor.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Run a health check
 */
export async function runHealthCheck(): Promise<HealthMetrics> {
  return getHealthMonitor().runHealthCheck();
}

/**
 * Get current health status
 */
export function getHealthStatus(): ReturnType<HealthMonitor["getStatus"]> {
  return getHealthMonitor().getStatus();
}

/**
 * Get last health metrics
 */
export function getLastHealthMetrics(): HealthMetrics | null {
  return getHealthMonitor().getLastMetrics();
}
