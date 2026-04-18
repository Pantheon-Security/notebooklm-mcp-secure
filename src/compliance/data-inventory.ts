/**
 * Data Inventory
 *
 * Maintains a registry of all personal data stored by the application.
 * Supports GDPR Article 30 (Records of Processing Activities).
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { getConfig } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { getDataClassifier } from "./data-classification.js";
import { getComplianceLogger } from "./compliance-logger.js";
import {
  DataClassification,
  type DataInventoryEntry,
  type DataCategory,
  type LegalBasis,
} from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Data Inventory class
 */
export class DataInventory {
  private static instance: DataInventory;
  private inventoryFile: string;
  private entries: Map<string, DataInventoryEntry> = new Map();
  private loaded: boolean = false;

  private constructor() {
    const config = getConfig();
    this.inventoryFile = path.join(config.configDir, "data-inventory.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DataInventory {
    if (!DataInventory.instance) {
      DataInventory.instance = new DataInventory();
    }
    return DataInventory.instance;
  }

  /**
   * Load inventory from storage
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(this.inventoryFile)) {
        const content = fs.readFileSync(this.inventoryFile, "utf-8");
        const data = JSON.parse(content);
        if (data.entries && Array.isArray(data.entries)) {
          for (const entry of data.entries) {
            this.entries.set(entry.id, entry);
          }
        }
      }
    } catch {
      // Start fresh if file is corrupted
      this.entries = new Map();
    }

    // Auto-discover data on first load
    await this.autoDiscover();

    this.loaded = true;
  }

  /**
   * Save inventory to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.inventoryFile);
    mkdirSecure(dir);

    const data = {
      version: "1.0.0",
      generated_at: new Date().toISOString(),
      entries: Array.from(this.entries.values()),
    };

    writeFileSecure(this.inventoryFile, JSON.stringify(data, null, 2));
  }

  /**
   * Auto-discover data based on known data types and locations
   */
  private async autoDiscover(): Promise<void> {
    const config = getConfig();
    const classifier = getDataClassifier();

    // Known data locations
    const dataLocations: { dataType: string; location: string }[] = [
      { dataType: "notebook_library", location: path.join(config.configDir, "library.json") },
      { dataType: "user_settings", location: path.join(config.configDir, "settings.json") },
      { dataType: "consent_records", location: path.join(config.configDir, "consent.json") },
      { dataType: "browser_cookies", location: path.join(config.dataDir, "browser_state") },
      { dataType: "session_state", location: path.join(config.dataDir, "sessions") },
      { dataType: "audit_logs", location: path.join(config.dataDir, "audit") },
      { dataType: "compliance_events", location: path.join(config.dataDir, "compliance") },
      { dataType: "encryption_keys", location: path.join(config.dataDir, "pq-keys.enc") },
      { dataType: "mcp_auth_token", location: path.join(config.configDir, "auth-token.hash") },
    ];

    for (const { dataType, location } of dataLocations) {
      // Check if we already have an entry for this data type
      const existingEntry = Array.from(this.entries.values()).find(
        e => e.data_type === dataType
      );

      if (!existingEntry) {
        const entry = classifier.buildInventoryEntry(dataType, location);
        if (entry) {
          this.entries.set(entry.id, entry);
        }
      }
    }
  }

  /**
   * Register a new data type in the inventory
   */
  public async register(
    dataType: string,
    storageLocation: string,
    options: {
      description?: string;
      classification?: DataClassification;
      dataCategories?: DataCategory[];
      legalBasis?: LegalBasis;
      retentionDays?: number | "indefinite";
      encrypted?: boolean;
      exportable?: boolean;
      erasable?: boolean;
    } = {}
  ): Promise<DataInventoryEntry> {
    await this.load();

    const classifier = getDataClassifier();
    const baseEntry = classifier.buildInventoryEntry(dataType, storageLocation);

    const entry: DataInventoryEntry = {
      id: generateUUID(),
      data_type: dataType,
      description: options.description || baseEntry?.description || `Data of type: ${dataType}`,
      classification: options.classification || baseEntry?.classification || DataClassification.INTERNAL,
      data_categories: options.dataCategories || baseEntry?.data_categories || [],
      storage_location: storageLocation,
      encrypted: options.encrypted ?? baseEntry?.encrypted ?? false,
      retention_policy: baseEntry?.retention_policy || "30_days",
      retention_days: options.retentionDays || baseEntry?.retention_days || 30,
      legal_basis: options.legalBasis || baseEntry?.legal_basis || "legitimate_interest",
      processing_purposes: baseEntry?.processing_purposes || ["service_provision"],
      who_can_access: ["owner"],
      exportable: options.exportable ?? baseEntry?.exportable ?? true,
      erasable: options.erasable ?? baseEntry?.erasable ?? true,
      last_updated: new Date().toISOString(),
    };

    this.entries.set(entry.id, entry);
    await this.save();

    // Log the registration
    const logger = getComplianceLogger();
    await logger.log(
      "data_processing",
      "data_type_registered",
      { type: "system" },
      "success",
      {
        resource: { type: dataType },
        details: { storage_location: storageLocation },
      }
    );

    return entry;
  }

  /**
   * Update an existing entry
   */
  public async update(
    entryId: string,
    updates: Partial<Omit<DataInventoryEntry, "id" | "data_type">>
  ): Promise<DataInventoryEntry | null> {
    await this.load();

    const entry = this.entries.get(entryId);
    if (!entry) return null;

    const updatedEntry: DataInventoryEntry = {
      ...entry,
      ...updates,
      last_updated: new Date().toISOString(),
    };

    this.entries.set(entryId, updatedEntry);
    await this.save();

    return updatedEntry;
  }

  /**
   * Remove an entry from the inventory
   */
  public async remove(entryId: string): Promise<boolean> {
    await this.load();

    if (!this.entries.has(entryId)) {
      return false;
    }

    this.entries.delete(entryId);
    await this.save();

    return true;
  }

  /**
   * Get all inventory entries
   */
  public async getAll(): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values());
  }

  /**
   * Get entry by ID
   */
  public async getById(entryId: string): Promise<DataInventoryEntry | null> {
    await this.load();
    return this.entries.get(entryId) || null;
  }

  /**
   * Get entries by data type
   */
  public async getByDataType(dataType: string): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e => e.data_type === dataType);
  }

  /**
   * Get entries by classification
   */
  public async getByClassification(classification: DataClassification): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e => e.classification === classification);
  }

  /**
   * Get entries by data category
   */
  public async getByCategory(category: DataCategory): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e =>
      e.data_categories.includes(category)
    );
  }

  /**
   * Get exportable data entries (for GDPR data portability)
   */
  public async getExportable(): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e => e.exportable);
  }

  /**
   * Get erasable data entries (for GDPR right to erasure)
   */
  public async getErasable(): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e => e.erasable);
  }

  /**
   * Get personal data entries (for DSAR)
   */
  public async getPersonalData(): Promise<DataInventoryEntry[]> {
    await this.load();
    return Array.from(this.entries.values()).filter(e =>
      e.data_categories.includes("personal_data") ||
      e.data_categories.includes("sensitive_data")
    );
  }

  /**
   * Generate GDPR Article 30 Records of Processing Activities
   */
  public async generateROPA(): Promise<{
    controller: string;
    purposes: string[];
    categories_of_data_subjects: string[];
    categories_of_personal_data: string[];
    recipients: string[];
    transfers_to_third_countries: string[];
    retention_periods: { data_type: string; period: string }[];
    security_measures: string[];
  }> {
    await this.load();

    const entries = Array.from(this.entries.values());

    // Collect all unique purposes
    const purposes = [...new Set(entries.flatMap(e => e.processing_purposes))];

    // Collect all retention periods
    const retentionPeriods = entries.map(e => ({
      data_type: e.data_type,
      period: typeof e.retention_days === "number"
        ? `${e.retention_days} days`
        : e.retention_days,
    }));

    return {
      controller: "Pantheon Security (local processing)",
      purposes,
      categories_of_data_subjects: ["Users of NotebookLM MCP Server"],
      categories_of_personal_data: [
        ...new Set(entries.flatMap(e => e.data_categories)),
      ],
      recipients: ["None - all data is processed locally"],
      transfers_to_third_countries: ["None"],
      retention_periods: retentionPeriods,
      security_measures: [
        "At-rest hybrid post-quantum encryption (ML-KEM-768 + ChaCha20-Poly1305)",
        "Memory scrubbing for sensitive data",
        "Tamper-evident audit logging",
        "Secure file permissions",
      ],
    };
  }

  /**
   * Get inventory summary
   */
  public async getSummary(): Promise<{
    total_entries: number;
    by_classification: Record<DataClassification, number>;
    exportable_count: number;
    erasable_count: number;
    personal_data_count: number;
    encrypted_count: number;
  }> {
    await this.load();

    const entries = Array.from(this.entries.values());

    const byClassification: Record<DataClassification, number> = {
      [DataClassification.PUBLIC]: 0,
      [DataClassification.INTERNAL]: 0,
      [DataClassification.CONFIDENTIAL]: 0,
      [DataClassification.RESTRICTED]: 0,
      [DataClassification.REGULATED]: 0,
    };

    for (const entry of entries) {
      byClassification[entry.classification]++;
    }

    return {
      total_entries: entries.length,
      by_classification: byClassification,
      exportable_count: entries.filter(e => e.exportable).length,
      erasable_count: entries.filter(e => e.erasable).length,
      personal_data_count: entries.filter(e =>
        e.data_categories.includes("personal_data")
      ).length,
      encrypted_count: entries.filter(e => e.encrypted).length,
    };
  }

  /**
   * Export inventory for compliance reporting
   */
  public async export(): Promise<string> {
    await this.load();

    const data = {
      export_date: new Date().toISOString(),
      version: "1.0.0",
      summary: await this.getSummary(),
      ropa: await this.generateROPA(),
      entries: Array.from(this.entries.values()),
    };

    return JSON.stringify(data, null, 2);
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the data inventory instance
 */
export function getDataInventory(): DataInventory {
  return DataInventory.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Get all data inventory entries
 */
export async function getAllDataInventory(): Promise<DataInventoryEntry[]> {
  return getDataInventory().getAll();
}

/**
 * Get exportable data entries
 */
export async function getExportableData(): Promise<DataInventoryEntry[]> {
  return getDataInventory().getExportable();
}

/**
 * Get erasable data entries
 */
export async function getErasableData(): Promise<DataInventoryEntry[]> {
  return getDataInventory().getErasable();
}
