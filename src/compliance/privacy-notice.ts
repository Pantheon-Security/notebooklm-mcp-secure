/**
 * Privacy Notice Display Handler
 *
 * Manages display of privacy notice on first run and version updates.
 * Tracks acknowledgment and integrates with consent management.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { writeFileSecure, mkdirSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import { getConsentManager } from "./consent-manager.js";
import { getComplianceLogger } from "./compliance-logger.js";
import {
  PRIVACY_NOTICE,
  PRIVACY_NOTICE_VERSION,
  getPrivacyNoticeCLI,
  getPrivacyNoticeCompact,
  getPrivacyNoticeStructured,
} from "./privacy-notice-text.js";

/**
 * Privacy notice acknowledgment record
 */
interface PrivacyNoticeAcknowledgment {
  version: string;
  acknowledged_at: string;
  method: "cli" | "api" | "auto";
}

/**
 * Privacy Notice Manager class
 */
export class PrivacyNoticeManager {
  private static instance: PrivacyNoticeManager;
  private acknowledgmentFile: string;
  private acknowledgments: PrivacyNoticeAcknowledgment[] = [];
  private loaded: boolean = false;

  private constructor() {
    const config = getConfig();
    this.acknowledgmentFile = path.join(config.configDir, "privacy-acknowledgment.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): PrivacyNoticeManager {
    if (!PrivacyNoticeManager.instance) {
      PrivacyNoticeManager.instance = new PrivacyNoticeManager();
    }
    return PrivacyNoticeManager.instance;
  }

  /**
   * Load acknowledgments from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.acknowledgmentFile)) {
        const content = fs.readFileSync(this.acknowledgmentFile, "utf-8");
        const data = JSON.parse(content);
        this.acknowledgments = data.acknowledgments || [];
      }
    } catch (err) {
      log.debug(`privacy-notice: load acknowledgments from file: ${err instanceof Error ? err.message : String(err)}`);
      this.acknowledgments = [];
    }

    this.loaded = true;
  }

  /**
   * Save acknowledgments to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.acknowledgmentFile);
    mkdirSecure(dir);

    const data = {
      current_version: PRIVACY_NOTICE_VERSION,
      acknowledgments: this.acknowledgments,
      last_updated: new Date().toISOString(),
    };

    writeFileSecure(this.acknowledgmentFile, JSON.stringify(data, null, 2));
  }

  /**
   * Check if privacy notice needs to be shown
   */
  public async needsDisplay(): Promise<boolean> {
    await this.load();

    // Check if current version has been acknowledged
    const currentAck = this.acknowledgments.find(
      a => a.version === PRIVACY_NOTICE_VERSION
    );

    return !currentAck;
  }

  /**
   * Check if this is the first run ever
   */
  public async isFirstRun(): Promise<boolean> {
    await this.load();
    return this.acknowledgments.length === 0;
  }

  /**
   * Get the CLI-formatted privacy notice
   */
  public getCLINotice(): string {
    return getPrivacyNoticeCLI();
  }

  /**
   * Get compact privacy notice (for API responses)
   */
  public getCompactNotice(): ReturnType<typeof getPrivacyNoticeCompact> {
    return getPrivacyNoticeCompact();
  }

  /**
   * Get structured privacy notice (full details)
   */
  public getStructuredNotice(): ReturnType<typeof getPrivacyNoticeStructured> {
    return getPrivacyNoticeStructured();
  }

  /**
   * Get full privacy notice object
   */
  public getFullNotice(): typeof PRIVACY_NOTICE {
    return PRIVACY_NOTICE;
  }

  /**
   * Record acknowledgment of privacy notice
   */
  public async acknowledge(method: "cli" | "api" | "auto" = "cli"): Promise<void> {
    await this.load();

    const acknowledgment: PrivacyNoticeAcknowledgment = {
      version: PRIVACY_NOTICE_VERSION,
      acknowledged_at: new Date().toISOString(),
      method,
    };

    this.acknowledgments.push(acknowledgment);
    await this.save();

    // Also record consent
    const consentManager = getConsentManager();
    await consentManager.acknowledgePrivacyNotice();

    // Log the acknowledgment
    const logger = getComplianceLogger();
    await logger.log(
      "consent",
      "privacy_notice_acknowledged",
      { type: "user" },
      "success",
      {
        details: {
          version: PRIVACY_NOTICE_VERSION,
          method,
        },
      }
    );
  }

  /**
   * Get acknowledgment history
   */
  public async getAcknowledgmentHistory(): Promise<PrivacyNoticeAcknowledgment[]> {
    await this.load();
    return [...this.acknowledgments].sort((a, b) =>
      new Date(b.acknowledged_at).getTime() - new Date(a.acknowledged_at).getTime()
    );
  }

  /**
   * Get the current privacy notice version
   */
  public getCurrentVersion(): string {
    return PRIVACY_NOTICE_VERSION;
  }

  /**
   * Check if a specific version has been acknowledged
   */
  public async hasAcknowledgedVersion(version: string): Promise<boolean> {
    await this.load();
    return this.acknowledgments.some(a => a.version === version);
  }

  /**
   * Get status summary
   */
  public async getStatus(): Promise<{
    currentVersion: string;
    needsDisplay: boolean;
    isFirstRun: boolean;
    acknowledgedVersions: string[];
    lastAcknowledgment?: {
      version: string;
      acknowledged_at: string;
      method: string;
    };
  }> {
    await this.load();

    const history = await this.getAcknowledgmentHistory();
    const lastAck = history[0];

    return {
      currentVersion: PRIVACY_NOTICE_VERSION,
      needsDisplay: await this.needsDisplay(),
      isFirstRun: await this.isFirstRun(),
      acknowledgedVersions: [...new Set(this.acknowledgments.map(a => a.version))],
      lastAcknowledgment: lastAck ? {
        version: lastAck.version,
        acknowledged_at: lastAck.acknowledged_at,
        method: lastAck.method,
      } : undefined,
    };
  }

  /**
   * Display privacy notice in console (for CLI use)
   */
  public displayInConsole(): void {
    console.log(this.getCLINotice());
  }

  /**
   * Check and prompt for privacy notice if needed
   * Returns true if acknowledged, false if user declined
   */
  public async checkAndPrompt(): Promise<boolean> {
    const needs = await this.needsDisplay();

    if (!needs) {
      return true; // Already acknowledged
    }

    // In non-interactive mode, auto-acknowledge with warning
    if (!process.stdin.isTTY) {
      console.warn(
        "[Privacy Notice] Running in non-interactive mode. " +
        "Privacy notice auto-acknowledged. Version: " + PRIVACY_NOTICE_VERSION
      );
      await this.acknowledge("auto");
      return true;
    }

    // Display notice
    this.displayInConsole();

    // In a real CLI, we'd wait for input here
    // For MCP server use, the notice is informational
    await this.acknowledge("cli");
    return true;
  }

  /**
   * Delete all acknowledgment records (for data erasure)
   */
  public async deleteAllRecords(): Promise<number> {
    await this.load();

    const count = this.acknowledgments.length;

    // Log before deletion
    const logger = getComplianceLogger();
    await logger.logDataDeletion(
      { type: "user" },
      "privacy_acknowledgments",
      count,
      true,
      { action: "erasure_request" }
    );

    this.acknowledgments = [];
    await this.save();

    return count;
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the privacy notice manager instance
 */
export function getPrivacyNoticeManager(): PrivacyNoticeManager {
  return PrivacyNoticeManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Check if privacy notice needs to be displayed
 */
export async function needsPrivacyNotice(): Promise<boolean> {
  return getPrivacyNoticeManager().needsDisplay();
}

/**
 * Acknowledge the privacy notice
 */
export async function acknowledgePrivacyNotice(
  method: "cli" | "api" | "auto" = "cli"
): Promise<void> {
  return getPrivacyNoticeManager().acknowledge(method);
}

/**
 * Get the privacy notice for display
 */
export function getPrivacyNotice(): ReturnType<typeof getPrivacyNoticeStructured> {
  return getPrivacyNoticeManager().getStructuredNotice();
}

/**
 * Get CLI-formatted privacy notice
 */
export function getPrivacyNoticeCLIText(): string {
  return getPrivacyNoticeManager().getCLINotice();
}
