/**
 * Data Erasure Tool
 *
 * Deletion of user data with best-effort logical wiping.
 * Implements GDPR Article 17 (Right to Erasure / Right to be Forgotten).
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { CONFIG, type Config } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { AuthManager } from "../auth/auth-manager.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getConsentManager } from "./consent-manager.js";
import { getPrivacyNoticeManager } from "./privacy-notice.js";
import type { ErasureRequest, ErasureScope, ErasureResult } from "./types.js";

type ErasureResultWithError = ErasureResult & { error?: string };

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Default erasure scope
 */
const DEFAULT_SCOPE: ErasureScope = {
  notebooks: true,
  settings: true,
  browser_data: true,
  audit_logs: false, // Audit logs have legal retention requirements
  compliance_events: false, // Must keep erasure record
  encryption_keys: false, // Careful with this!
  complete_erasure: false,
};

/**
 * Best-effort logical wipe before deletion.
 * On SSDs and CoW filesystems (btrfs, APFS) physical erasure cannot be guaranteed;
 * GDPR compliance requires full-disk encryption at rest.
 */
function secureOverwrite(filePath: string): void {
  const stats = fs.statSync(filePath);
  const size = stats.size;
  const fd = fs.openSync(filePath, "r+");

  try {
    const zeros = Buffer.alloc(Math.min(size, 1024 * 1024), 0);
    let written = 0;

    while (written < size) {
      const chunkSize = Math.min(zeros.length, size - written);
      fs.writeSync(fd, zeros, 0, chunkSize, written);
      written += chunkSize;
    }

    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.unlinkSync(filePath);
}

/**
 * Recursively delete a directory with best-effort logical wiping
 */
function secureDeleteDirectory(
  dirPath: string,
  secureWipe: boolean = true
): { files: number; bytes: number; errors: string[] } {
  let files = 0;
  let bytes = 0;
  const errors: string[] = [];

  try {
    if (!fs.existsSync(dirPath)) {
      return { files, bytes, errors };
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        const result = secureDeleteDirectory(fullPath, secureWipe);
        files += result.files;
        bytes += result.bytes;
        errors.push(...result.errors);
      } else {
        try {
          const stats = fs.statSync(fullPath);
          bytes += stats.size;
          files++;

          if (secureWipe) {
            secureOverwrite(fullPath);
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Remove the directory itself
    fs.rmdirSync(dirPath);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { files, bytes, errors };
}

async function clearChromeProfile(chromeProfileDir: string): Promise<{ files: number; bytes: number; errors: string[] }> {
  const authManager = new AuthManager();
  if (await authManager.hasSavedState()) {
    log.warning("Chrome may still be running; profile deletion may be incomplete.");
  }

  return secureDeleteDirectory(chromeProfileDir, true);
}

/**
 * Data Erasure Manager class
 */
export class DataErasureManager {
  private static instance: DataErasureManager;
  private erasureLogFile: string;
  private erasureRequests: ErasureRequest[] = [];
  private loaded: boolean = false;

  private constructor() {
    const config = CONFIG;
    this.erasureLogFile = path.join(config.dataDir, "compliance", "erasure-log.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DataErasureManager {
    if (!DataErasureManager.instance) {
      DataErasureManager.instance = new DataErasureManager();
    }
    return DataErasureManager.instance;
  }

  /**
   * Load erasure history from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.erasureLogFile)) {
        const content = fs.readFileSync(this.erasureLogFile, "utf-8");
        const data = JSON.parse(content);
        this.erasureRequests = data.requests || [];
      }
    } catch (err) {
      log.debug(`data-erasure: load erasure log from file: ${err instanceof Error ? err.message : String(err)}`);
      this.erasureRequests = [];
    }

    this.loaded = true;
  }

  /**
   * Save erasure history to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.erasureLogFile);
    mkdirSecure(dir);

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      requests: this.erasureRequests,
    };

    writeFileSecure(this.erasureLogFile, JSON.stringify(data, null, 2));
  }

  /**
   * Create a new erasure request
   */
  public async createRequest(
    scope: Partial<ErasureScope> = {}
  ): Promise<ErasureRequest> {
    await this.load();

    const fullScope: ErasureScope = { ...DEFAULT_SCOPE, ...scope };

    // Explicitly note when audit_logs is excluded (I262)
    if (!fullScope.audit_logs) {
      log.info("  ℹ️  audit_logs excluded from erasure scope (legal retention requirement). Set scope.audit_logs=true to include.");
    }

    // If complete_erasure is true, set all to true except compliance_events
    if (fullScope.complete_erasure) {
      fullScope.notebooks = true;
      fullScope.settings = true;
      fullScope.browser_data = true;
      fullScope.audit_logs = true;
      fullScope.encryption_keys = true;
      // compliance_events stays false - we need to keep the erasure record
    }

    const request: ErasureRequest = {
      request_id: generateUUID(),
      requested_at: new Date().toISOString(),
      scope: fullScope,
      confirmed: false,
      confirmation_method: "explicit",
      items_deleted: [],
      erasure_record_retention_days: 7 * 365, // 7 years per CSSF
    };

    this.erasureRequests.push(request);
    await this.save();

    // Log the request
    const logger = getComplianceLogger();
    await logger.log(
      "data_deletion",
      "erasure_requested",
      { type: "user" },
      "pending",
      {
        details: {
          request_id: request.request_id,
          scope: fullScope,
        },
      }
    );

    return request;
  }

  /**
   * Confirm and execute an erasure request
   */
  public async confirmAndExecute(requestId: string): Promise<ErasureRequest | null> {
    await this.load();

    const request = this.erasureRequests.find(r => r.request_id === requestId);
    if (!request) {
      return null;
    }

    if (request.confirmed) {
      return request; // Already executed
    }

    const config = CONFIG;
    const results: ErasureResult[] = [];

    // Execute erasure based on scope
    if (request.scope.notebooks) {
      const result = await this.eraseNotebooks(config);
      results.push(result);
    }

    if (request.scope.settings) {
      const result = await this.eraseSettings(config);
      results.push(result);
    }

    if (request.scope.browser_data) {
      const result = await this.eraseBrowserData(config);
      results.push(result);
    }

    if (request.scope.audit_logs) {
      const result = await this.eraseAuditLogs(config);
      results.push(result);
    }

    if (request.scope.encryption_keys) {
      const result = await this.eraseEncryptionKeys(config);
      results.push(result);
    }

    // Also erase consent and privacy acknowledgment records
    if (request.scope.complete_erasure || request.scope.settings) {
      await this.eraseConsentRecords();
      await this.erasePrivacyAcknowledgments();
    }

    // Update request
    request.confirmed = true;
    request.confirmation_method = "explicit";
    request.executed_at = new Date().toISOString();
    request.items_deleted = results;

    await this.save();

    // Log completion
    const logger = getComplianceLogger();
    const totalItems = results.reduce((sum, r) => sum + r.items_deleted, 0);
    const totalBytes = results.reduce((sum, r) => sum + r.size_bytes, 0);

    await logger.logDataDeletion(
      { type: "user" },
      "multiple_data_types",
      totalItems,
      true,
      {
        request_id: requestId,
        total_bytes: totalBytes,
        data_types: results.map(r => r.data_type),
      }
    );

    return request;
  }

  /**
   * Erase notebook library
   */
  private async eraseNotebooks(config: Config): Promise<ErasureResult> {
    const libraryPath = path.join(config.configDir, "library.json");
    const result: ErasureResultWithError = {
      data_type: "notebook_library",
      path: libraryPath,
      items_deleted: 0,
      size_bytes: 0,
      method: "overwrite",
      verified: false,
    };

    try {
      if (fs.existsSync(libraryPath)) {
        const stats = fs.statSync(libraryPath);
        result.size_bytes = stats.size;
        result.items_deleted = 1;

        secureOverwrite(libraryPath);
        result.verified = !fs.existsSync(libraryPath);
      } else {
        result.verified = true;
      }
    } catch (err) {
      result.verified = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Erase user settings
   */
  private async eraseSettings(config: Config): Promise<ErasureResult> {
    const settingsPath = path.join(config.configDir, "settings.json");
    const result: ErasureResultWithError = {
      data_type: "user_settings",
      path: settingsPath,
      items_deleted: 0,
      size_bytes: 0,
      method: "delete",
      verified: false,
    };

    try {
      if (fs.existsSync(settingsPath)) {
        const stats = fs.statSync(settingsPath);
        result.size_bytes = stats.size;
        result.items_deleted = 1;

        fs.unlinkSync(settingsPath);
        result.verified = !fs.existsSync(settingsPath);
      } else {
        result.verified = true;
      }
    } catch (err) {
      result.verified = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Erase browser data
   */
  private async eraseBrowserData(config: Config): Promise<ErasureResult> {
    const browserStateDir = path.join(config.dataDir, "browser_state");
    const chromeProfileDir = path.join(config.dataDir, "chrome_profile");

    const result: ErasureResultWithError = {
      data_type: "browser_data",
      path: config.dataDir,
      items_deleted: 0,
      size_bytes: 0,
      method: "overwrite",
      verified: false,
    };

    try {
      const errors: string[] = [];

      // Erase browser state (encrypted cookies, etc.)
      if (fs.existsSync(browserStateDir)) {
        const browserResult = secureDeleteDirectory(browserStateDir, true);
        result.items_deleted += browserResult.files;
        result.size_bytes += browserResult.bytes;
        errors.push(...browserResult.errors);
      }

      // Erase Chrome profile
      if (fs.existsSync(chromeProfileDir)) {
        const chromeResult = await clearChromeProfile(chromeProfileDir);
        result.items_deleted += chromeResult.files;
        result.size_bytes += chromeResult.bytes;
        errors.push(...chromeResult.errors);
      }

      // Erase session files
      const sessionsDir = path.join(config.dataDir, "sessions");
      if (fs.existsSync(sessionsDir)) {
        const sessionResult = secureDeleteDirectory(sessionsDir, true);
        result.items_deleted += sessionResult.files;
        result.size_bytes += sessionResult.bytes;
        errors.push(...sessionResult.errors);
      }

      result.verified = !fs.existsSync(browserStateDir) &&
                        !fs.existsSync(chromeProfileDir) &&
                        !fs.existsSync(sessionsDir);

      if (errors.length > 0) {
        result.error = errors.join("; ");
      }
    } catch (err) {
      result.verified = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Erase audit logs
   */
  private async eraseAuditLogs(config: Config): Promise<ErasureResult> {
    const auditDir = path.join(config.dataDir, "audit");

    const result: ErasureResultWithError = {
      data_type: "audit_logs",
      path: auditDir,
      items_deleted: 0,
      size_bytes: 0,
      method: "overwrite",
      verified: false,
    };

    if (fs.existsSync(auditDir)) {
      const auditResult = secureDeleteDirectory(auditDir, true);
      result.items_deleted = auditResult.files;
      result.size_bytes = auditResult.bytes;
      result.verified = !fs.existsSync(auditDir);
      if (auditResult.errors.length > 0) {
        result.error = auditResult.errors.join("; ");
      }
    } else {
      result.verified = true;
    }

    return result;
  }

  /**
   * Erase encryption keys (crypto shred)
   */
  private async eraseEncryptionKeys(config: Config): Promise<ErasureResult> {
    const keysPath = path.join(config.dataDir, "pq-keys.enc");

    const result: ErasureResultWithError = {
      data_type: "encryption_keys",
      path: keysPath,
      items_deleted: 0,
      size_bytes: 0,
      method: "crypto_shred",
      verified: false,
    };

    try {
      if (fs.existsSync(keysPath)) {
        const stats = fs.statSync(keysPath);
        result.size_bytes = stats.size;
        result.items_deleted = 1;

        secureOverwrite(keysPath);
        result.verified = !fs.existsSync(keysPath);
      } else {
        result.verified = true;
      }
    } catch (err) {
      result.verified = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Erase consent records
   */
  private async eraseConsentRecords(): Promise<void> {
    const consentManager = getConsentManager();
    await consentManager.deleteAllConsents();
  }

  /**
   * Erase privacy acknowledgments
   */
  private async erasePrivacyAcknowledgments(): Promise<void> {
    const privacyManager = getPrivacyNoticeManager();
    await privacyManager.deleteAllRecords();
  }

  /**
   * Get erasure request by ID
   */
  public async getRequest(requestId: string): Promise<ErasureRequest | null> {
    await this.load();
    return this.erasureRequests.find(r => r.request_id === requestId) || null;
  }

  /**
   * Get all erasure requests
   */
  public async getAllRequests(): Promise<ErasureRequest[]> {
    await this.load();
    return [...this.erasureRequests];
  }

  /**
   * Get pending erasure requests
   */
  public async getPendingRequests(): Promise<ErasureRequest[]> {
    await this.load();
    return this.erasureRequests.filter(r => !r.confirmed);
  }

  /**
   * Cancel a pending erasure request
   */
  public async cancelRequest(requestId: string): Promise<boolean> {
    await this.load();

    const index = this.erasureRequests.findIndex(r => r.request_id === requestId);
    if (index === -1) {
      return false;
    }

    const request = this.erasureRequests[index];
    if (request.confirmed) {
      return false; // Can't cancel executed requests
    }

    this.erasureRequests.splice(index, 1);
    await this.save();

    // Log cancellation
    const logger = getComplianceLogger();
    await logger.log(
      "data_deletion",
      "erasure_cancelled",
      { type: "user" },
      "success",
      {
        details: { request_id: requestId },
      }
    );

    return true;
  }

  /**
   * Get erasure summary
   */
  public async getSummary(): Promise<{
    total_requests: number;
    pending_requests: number;
    completed_requests: number;
    total_items_deleted: number;
    total_bytes_deleted: number;
  }> {
    await this.load();

    const completed = this.erasureRequests.filter(r => r.confirmed);
    const pending = this.erasureRequests.filter(r => !r.confirmed);

    const totalItems = completed.reduce(
      (sum, r) => sum + r.items_deleted.reduce((s, i) => s + i.items_deleted, 0),
      0
    );

    const totalBytes = completed.reduce(
      (sum, r) => sum + r.items_deleted.reduce((s, i) => s + i.size_bytes, 0),
      0
    );

    return {
      total_requests: this.erasureRequests.length,
      pending_requests: pending.length,
      completed_requests: completed.length,
      total_items_deleted: totalItems,
      total_bytes_deleted: totalBytes,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the data erasure manager instance
 */
export function getDataErasureManager(): DataErasureManager {
  return DataErasureManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Create a new erasure request
 */
export async function createErasureRequest(
  scope: Partial<ErasureScope> = {}
): Promise<ErasureRequest> {
  return getDataErasureManager().createRequest(scope);
}

/**
 * Confirm and execute an erasure request
 */
export async function executeErasureRequest(requestId: string): Promise<ErasureRequest | null> {
  return getDataErasureManager().confirmAndExecute(requestId);
}

/**
 * Get pending erasure requests
 */
export async function getPendingErasureRequests(): Promise<ErasureRequest[]> {
  return getDataErasureManager().getPendingRequests();
}
