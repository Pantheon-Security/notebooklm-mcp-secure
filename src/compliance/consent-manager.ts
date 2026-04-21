/**
 * Consent Manager
 *
 * Tracks and manages user consent for data processing activities.
 * Implements GDPR Article 6 legal basis requirements.
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
import type {
  ConsentRecord,
  ConsentPurpose,
  LegalBasis,
  DataCategory,
} from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Default consent version
 */
const DEFAULT_CONSENT_VERSION = "1.0.0";

/**
 * Default legal bases for automatic consent (no explicit user action required)
 */
const AUTOMATIC_LEGAL_BASES: Record<ConsentPurpose, LegalBasis> = {
  "service_provision": "contract",
  "session_management": "contract",
  "security_logging": "legitimate_interest",
  "error_diagnostics": "legitimate_interest",
  "usage_analytics": "consent", // This one requires explicit consent
};

/**
 * Data categories processed for each purpose
 */
const PURPOSE_DATA_CATEGORIES: Record<ConsentPurpose, DataCategory[]> = {
  "service_provision": ["session_data", "notebook_metadata"],
  "session_management": ["session_data", "credentials"],
  "security_logging": ["audit_logs"],
  "error_diagnostics": ["usage_data"],
  "usage_analytics": ["usage_data"],
};

/**
 * Consent Manager class
 */
export class ConsentManager {
  private static instance: ConsentManager;
  private consentFile: string;
  private consents: ConsentRecord[] = [];
  private loaded: boolean = false;
  private consentVersion: string;
  private requireConsent: boolean;

  private constructor() {
    const config = CONFIG;
    this.consentFile = path.join(config.configDir, "consent.json");
    this.consentVersion = process.env.NLMCP_CONSENT_VERSION || DEFAULT_CONSENT_VERSION;
    this.requireConsent = process.env.NLMCP_CONSENT_REQUIRED?.toLowerCase() !== "false";
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ConsentManager {
    if (!ConsentManager.instance) {
      ConsentManager.instance = new ConsentManager();
    }
    return ConsentManager.instance;
  }

  /**
   * Load consents from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.consentFile)) {
        const content = fs.readFileSync(this.consentFile, "utf-8");
        const data = JSON.parse(content);
        this.consents = data.consents || [];
      }
    } catch (err) {
      log.debug(`consent-manager: load consents from file: ${err instanceof Error ? err.message : String(err)}`);
      // Start fresh if file is corrupted
      this.consents = [];
    }

    this.loaded = true;
  }

  /**
   * Save consents to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.consentFile);
    mkdirSecure(dir);

    const data = {
      version: this.consentVersion,
      consents: this.consents,
      last_updated: new Date().toISOString(),
    };

    writeFileSecure(this.consentFile, JSON.stringify(data, null, 2));
  }

  /**
   * Check if this is the first run (no consent recorded)
   */
  public async isFirstRun(): Promise<boolean> {
    await this.load();
    return this.consents.length === 0;
  }

  /**
   * Check if consent is required for this installation
   */
  public isConsentRequired(): boolean {
    return this.requireConsent;
  }

  /**
   * Grant consent for specified purposes
   */
  public async grantConsent(
    purposes: ConsentPurpose[],
    options: {
      legalBasis?: LegalBasis;
      method?: "explicit" | "implicit" | "contractual";
      evidence?: string;
      expiresAt?: string;
    } = {}
  ): Promise<ConsentRecord> {
    await this.load();

    // Collect all data categories for these purposes
    const dataCategories: DataCategory[] = [];
    for (const purpose of purposes) {
      const categories = PURPOSE_DATA_CATEGORIES[purpose] || [];
      for (const cat of categories) {
        if (!dataCategories.includes(cat)) {
          dataCategories.push(cat);
        }
      }
    }

    // Determine legal basis
    const legalBasis = options.legalBasis || this.determineLegalBasis(purposes);

    const consent: ConsentRecord = {
      id: generateUUID(),
      version: this.consentVersion,
      granted_at: new Date().toISOString(),
      expires_at: options.expiresAt,
      purposes,
      data_categories: dataCategories,
      legal_basis: legalBasis,
      method: options.method || "explicit",
      evidence: options.evidence,
    };

    this.consents.push(consent);
    await this.save();

    // Log consent event
    const logger = getComplianceLogger();
    await logger.logConsent(
      "granted",
      { type: "user" },
      purposes,
      true,
      { consent_id: consent.id, legal_basis: legalBasis }
    );

    return consent;
  }

  /**
   * Revoke consent
   */
  public async revokeConsent(consentId: string, reason?: string): Promise<boolean> {
    await this.load();

    const consent = this.consents.find(c => c.id === consentId);
    if (!consent) {
      return false;
    }

    consent.revoked = true;
    consent.revoked_at = new Date().toISOString();
    consent.revocation_reason = reason;

    await this.save();

    // Log revocation event
    const logger = getComplianceLogger();
    await logger.logConsent(
      "revoked",
      { type: "user" },
      consent.purposes,
      true,
      { consent_id: consentId, reason }
    );

    return true;
  }

  /**
   * Check if consent exists for a specific purpose
   */
  public async hasConsent(purpose: ConsentPurpose): Promise<boolean> {
    await this.load();

    // Check for implicit consent based on legal basis
    const implicitBasis = AUTOMATIC_LEGAL_BASES[purpose];
    if (implicitBasis !== "consent") {
      // These purposes don't require explicit consent
      return true;
    }

    // Check for explicit consent
    const now = new Date();
    return this.consents.some(c => {
      // Must not be revoked
      if (c.revoked) return false;

      // Must include the purpose
      if (!c.purposes.includes(purpose)) return false;

      // Must not be expired
      if (c.expires_at && new Date(c.expires_at) < now) return false;

      return true;
    });
  }

  /**
   * Get all active (non-revoked, non-expired) consents
   */
  public async getActiveConsents(): Promise<ConsentRecord[]> {
    await this.load();

    const now = new Date();
    return this.consents.filter(c => {
      if (c.revoked) return false;
      if (c.expires_at && new Date(c.expires_at) < now) return false;
      return true;
    });
  }

  /**
   * Get full consent history (for DSAR)
   */
  public async getConsentHistory(): Promise<ConsentRecord[]> {
    await this.load();
    return [...this.consents].sort((a, b) =>
      new Date(b.granted_at).getTime() - new Date(a.granted_at).getTime()
    );
  }

  /**
   * Export consent records for DSAR
   */
  public async exportConsents(): Promise<string> {
    const history = await this.getConsentHistory();

    const exportData = {
      export_date: new Date().toISOString(),
      consent_version: this.consentVersion,
      total_consents: history.length,
      active_consents: history.filter(c => !c.revoked).length,
      revoked_consents: history.filter(c => c.revoked).length,
      consents: history.map(c => ({
        id: c.id,
        version: c.version,
        granted_at: c.granted_at,
        expires_at: c.expires_at,
        purposes: c.purposes,
        data_categories: c.data_categories,
        legal_basis: c.legal_basis,
        method: c.method,
        revoked: c.revoked || false,
        revoked_at: c.revoked_at,
        revocation_reason: c.revocation_reason,
      })),
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Check if privacy notice needs to be shown (new version or first run)
   */
  public async needsPrivacyNotice(): Promise<boolean> {
    await this.load();

    // First run - need to show notice
    if (this.consents.length === 0) {
      return true;
    }

    // Check if there's a consent for the current version
    const currentVersionConsent = this.consents.find(
      c => c.version === this.consentVersion && !c.revoked
    );

    return !currentVersionConsent;
  }

  /**
   * Record acknowledgment of privacy notice
   */
  public async acknowledgePrivacyNotice(): Promise<ConsentRecord> {
    // Grant consent for all standard purposes (not usage_analytics)
    const standardPurposes: ConsentPurpose[] = [
      "service_provision",
      "session_management",
      "security_logging",
      "error_diagnostics",
    ];

    return this.grantConsent(standardPurposes, {
      method: "explicit",
      evidence: "Privacy notice acknowledged via CLI",
    });
  }

  /**
   * Get consent status summary
   */
  public async getConsentSummary(): Promise<{
    firstRun: boolean;
    consentVersion: string;
    activeConsents: number;
    revokedConsents: number;
    purposes: Record<ConsentPurpose, boolean>;
    lastConsentDate?: string;
  }> {
    await this.load();

    const active = await this.getActiveConsents();
    const revoked = this.consents.filter(c => c.revoked);

    // Check each purpose
    const purposes: Record<ConsentPurpose, boolean> = {
      "service_provision": await this.hasConsent("service_provision"),
      "session_management": await this.hasConsent("session_management"),
      "security_logging": await this.hasConsent("security_logging"),
      "error_diagnostics": await this.hasConsent("error_diagnostics"),
      "usage_analytics": await this.hasConsent("usage_analytics"),
    };

    // Find the most recent consent
    const sortedConsents = [...this.consents].sort((a, b) =>
      new Date(b.granted_at).getTime() - new Date(a.granted_at).getTime()
    );

    return {
      firstRun: this.consents.length === 0,
      consentVersion: this.consentVersion,
      activeConsents: active.length,
      revokedConsents: revoked.length,
      purposes,
      lastConsentDate: sortedConsents[0]?.granted_at,
    };
  }

  /**
   * Delete all consent records (for data erasure)
   */
  public async deleteAllConsents(): Promise<number> {
    await this.load();

    const count = this.consents.length;

    // Log before deletion
    const logger = getComplianceLogger();
    await logger.logDataDeletion(
      { type: "user" },
      "consent_records",
      count,
      true,
      { action: "erasure_request" }
    );

    // Clear consents
    this.consents = [];
    await this.save();

    return count;
  }

  /**
   * Determine appropriate legal basis for purposes
   */
  private determineLegalBasis(purposes: ConsentPurpose[]): LegalBasis {
    // If any purpose requires explicit consent, return "consent"
    for (const purpose of purposes) {
      if (AUTOMATIC_LEGAL_BASES[purpose] === "consent") {
        return "consent";
      }
    }

    // If all purposes are contract-based, return "contract"
    const allContract = purposes.every(
      p => AUTOMATIC_LEGAL_BASES[p] === "contract"
    );
    if (allContract) {
      return "contract";
    }

    // Mixed or legitimate interest
    return "legitimate_interest";
  }

  /**
   * Validate that all required consents are in place
   */
  public async validateConsents(): Promise<{
    valid: boolean;
    missing: ConsentPurpose[];
  }> {
    const requiredPurposes: ConsentPurpose[] = [
      "service_provision",
      "session_management",
    ];

    const missing: ConsentPurpose[] = [];

    for (const purpose of requiredPurposes) {
      const hasIt = await this.hasConsent(purpose);
      if (!hasIt) {
        missing.push(purpose);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the consent manager instance
 */
export function getConsentManager(): ConsentManager {
  return ConsentManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Check if this is the first run
 */
export async function isFirstRun(): Promise<boolean> {
  return getConsentManager().isFirstRun();
}

/**
 * Check if consent exists for a purpose
 */
export async function hasConsent(purpose: ConsentPurpose): Promise<boolean> {
  return getConsentManager().hasConsent(purpose);
}

/**
 * Grant consent for purposes
 */
export async function grantConsent(
  purposes: ConsentPurpose[],
  options?: {
    legalBasis?: LegalBasis;
    method?: "explicit" | "implicit" | "contractual";
    evidence?: string;
    expiresAt?: string;
  }
): Promise<ConsentRecord> {
  return getConsentManager().grantConsent(purposes, options);
}

/**
 * Revoke a consent
 */
export async function revokeConsent(consentId: string, reason?: string): Promise<boolean> {
  return getConsentManager().revokeConsent(consentId, reason);
}
