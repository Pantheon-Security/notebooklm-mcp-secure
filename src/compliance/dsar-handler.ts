/**
 * Data Subject Access Request (DSAR) Handler
 *
 * Handles Data Subject Access Requests as required by GDPR Article 15.
 * Provides users with information about their personal data processing.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import crypto from "crypto";
import path from "path";
import fs from "fs";
import { CONFIG } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { withLock } from "../utils/file-lock.js";
import { log } from "../utils/logger.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getDataInventory } from "./data-inventory.js";
import type { DSARResponse, DataInventoryEntry } from "./types.js";

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * DSAR request record
 */
interface DSARRequest {
  request_id: string;
  submitted_at: string;
  type: "access" | "portability" | "erasure" | "rectification" | "restriction" | "objection";
  status: "pending" | "processing" | "completed" | "rejected";
  completed_at?: string;
  response?: DSARResponse;
  notes?: string;
}

/**
 * DSAR Handler class
 */
export class DSARHandler {
  private static instance: DSARHandler;
  private requestsFile: string;
  private requests: DSARRequest[] = [];
  private loadPromise: Promise<void> | null = null;
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor() {
    const config = CONFIG;
    this.requestsFile = path.join(config.dataDir, "compliance", "dsar-requests.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): DSARHandler {
    if (!DSARHandler.instance) {
      DSARHandler.instance = new DSARHandler();
    }
    return DSARHandler.instance;
  }

  /**
   * Load requests from storage
   */
  private load(forceReload: boolean = false): Promise<void> {
    if (forceReload || !this.loadPromise) {
      this.loadPromise = this._load();
    }
    return this.loadPromise;
  }

  private async _load(): Promise<void> {
    try {
      if (fs.existsSync(this.requestsFile)) {
        const content = fs.readFileSync(this.requestsFile, "utf-8");
        const data = JSON.parse(content);
        this.requests = data.requests || [];
      } else {
        this.requests = [];
      }
    } catch (err) {
      log.debug(`dsar-handler: load requests from file: ${err instanceof Error ? err.message : String(err)}`);
      this.requests = [];
    }

  }

  /**
   * Save requests to storage
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.requestsFile);
    mkdirSecure(dir);

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      requests: this.requests,
    };

    writeFileSecure(this.requestsFile, JSON.stringify(data, null, 2));
  }

  /**
   * Serialize in-process mutations to avoid overlapping load/save cycles.
   */
  private async queueWrite<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;

    const run = this.pendingWrite.then(async () => {
      result = await operation();
    });

    this.pendingWrite = run.then(() => undefined, () => undefined);
    await run;
    return result;
  }

  /**
   * Submit a new DSAR
   */
  public async submitRequest(
    type: DSARRequest["type"] = "access"
  ): Promise<DSARRequest> {
    const request = await this.queueWrite(() =>
      withLock(this.requestsFile, async () => {
        await this.load(true);

        const nextRequest: DSARRequest = {
          request_id: generateUUID(),
          submitted_at: new Date().toISOString(),
          type,
          status: "pending",
        };

        this.requests.push(nextRequest);
        await this.save();

        return nextRequest;
      })
    );

    // Log the request
    const logger = getComplianceLogger();
    await logger.logDataAccess(
      "request",
      { type: "user" },
      "dsar",
      true,
      {
        request_id: request.request_id,
        request_type: type,
      }
    );

    return request;
  }

  /**
   * Process a DSAR and generate response
   */
  public async processRequest(requestId: string): Promise<DSARResponse | null> {
    let requestType: DSARRequest["type"] | undefined;

    const response = await this.queueWrite(() =>
      withLock(this.requestsFile, async () => {
        await this.load(true);

        const request = this.requests.find(r => r.request_id === requestId);
        if (!request) {
          return null;
        }

        requestType = request.type;

        request.status = "processing";
        await this.save();

        // Generate response based on request type
        const generatedResponse = await this.generateResponse(request);

        request.status = "completed";
        request.completed_at = new Date().toISOString();
        request.response = generatedResponse;
        await this.save();

        return generatedResponse;
      })
    );

    if (!response) {
      return null;
    }

    // Log completion
    const logger = getComplianceLogger();
    await logger.logDataAccess(
      "view",
      { type: "user" },
      "dsar_response",
      true,
      {
        request_id: requestId,
        request_type: requestType,
        data_categories: response.personal_data.length,
      }
    );

    return response;
  }

  /**
   * Generate DSAR response
   */
  private async generateResponse(request: DSARRequest): Promise<DSARResponse> {
    const inventory = getDataInventory();

    // Get personal data from inventory
    const personalDataEntries = await inventory.getPersonalData();
    const allEntries = await inventory.getAll();

    // Build personal data section
    const personalData: DSARResponse["personal_data"] = [];

    for (const entry of personalDataEntries) {
      personalData.push({
        category: entry.data_type,
        data: await this.getDataSample(entry),
        source: "User interaction with NotebookLM MCP Server",
        retention_period: this.formatRetention(entry.retention_days),
      });
    }

    // Get processing purposes from all entries
    const processingPurposes = [
      ...new Set(allEntries.flatMap(e => e.processing_purposes)),
    ];

    // Get legal bases
    const legalBases = [...new Set(allEntries.map(e => e.legal_basis))];

    // Available rights
    const availableRights = [
      "Right of access (GDPR Article 15)",
      "Right to rectification (GDPR Article 16)",
      "Right to erasure (GDPR Article 17)",
      "Right to restriction (GDPR Article 18)",
      "Right to data portability (GDPR Article 20)",
      "Right to object (GDPR Article 21)",
    ];

    const response: DSARResponse = {
      request_id: request.request_id,
      submitted_at: request.submitted_at,
      completed_at: new Date().toISOString(),
      subject_verified: false, // Identity verification not implemented

      personal_data: personalData,

      processing_purposes: processingPurposes,
      legal_bases: legalBases,
      data_recipients: ["None - all data is processed locally"],

      available_rights: availableRights,

      format: "json",
      encrypted: false,
    };

    return response;
  }

  /**
   * Get a sample of actual data for DSAR (without sensitive content)
   */
  private async getDataSample(entry: DataInventoryEntry): Promise<unknown> {
    // For sensitive data types, just return metadata
    if (
      entry.data_categories.includes("credentials") ||
      entry.data_categories.includes("sensitive_data")
    ) {
      return {
        type: entry.data_type,
        classification: entry.classification,
        note: "Sensitive data not included in DSAR export for security reasons",
        exportable: entry.exportable,
      };
    }

    // For other types, return storage metadata only. Never include file content.
    try {
      if (fs.existsSync(entry.storage_location)) {
        const stats = fs.statSync(entry.storage_location);

        if (stats.isFile()) {
          return {
            type: entry.data_type,
            file_name: path.basename(entry.storage_location),
            size_bytes: stats.size,
            last_modified: stats.mtime.toISOString(),
          };
        } else if (stats.isDirectory()) {
          return {
            type: entry.data_type,
            file_name: path.basename(entry.storage_location),
            size_bytes: 0,
            last_modified: stats.mtime.toISOString(),
          };
        }
      }
    } catch (err) {
      log.debug(`dsar-handler: access data storage location: ${err instanceof Error ? err.message : String(err)}`);
      // Data might not be accessible
    }

    return {
      type: entry.data_type,
      classification: entry.classification,
      note: "Data location not accessible",
    };
  }

  /**
   * Format retention period for human readability
   */
  private formatRetention(days: number | "indefinite"): string {
    if (days === "indefinite") {
      return "Retained until user deletion";
    }

    if (days >= 365) {
      const years = Math.round(days / 365);
      return `${years} year${years > 1 ? "s" : ""}`;
    }

    if (days >= 30) {
      const months = Math.round(days / 30);
      return `${months} month${months > 1 ? "s" : ""}`;
    }

    return `${days} day${days > 1 ? "s" : ""}`;
  }

  /**
   * Get request by ID
   */
  public async getRequest(requestId: string): Promise<DSARRequest | null> {
    await this.load();
    return this.requests.find(r => r.request_id === requestId) || null;
  }

  /**
   * Get all requests
   */
  public async getAllRequests(): Promise<DSARRequest[]> {
    await this.load();
    return [...this.requests];
  }

  /**
   * Get pending requests
   */
  public async getPendingRequests(): Promise<DSARRequest[]> {
    await this.load();
    return this.requests.filter(r => r.status === "pending" || r.status === "processing");
  }

  /**
   * Submit and process a DSAR immediately (for automated systems)
   */
  public async submitAndProcess(
    type: DSARRequest["type"] = "access"
  ): Promise<DSARResponse> {
    const request = await this.submitRequest(type);
    const response = await this.processRequest(request.request_id);

    if (!response) {
      throw new Error("Failed to process DSAR request");
    }

    return response;
  }

  /**
   * Get summary response (without full personal data)
   */
  public async getSummaryResponse(): Promise<{
    data_categories: string[];
    processing_purposes: string[];
    legal_bases: string[];
    available_rights: string[];
    data_recipients: string[];
    exportable_data_types: string[];
    erasable_data_types: string[];
  }> {
    const inventory = getDataInventory();
    const entries = await inventory.getAll();

    return {
      data_categories: [...new Set(entries.flatMap(e => e.data_categories))],
      processing_purposes: [...new Set(entries.flatMap(e => e.processing_purposes))],
      legal_bases: [...new Set(entries.map(e => e.legal_basis))],
      available_rights: [
        "Access (Article 15)",
        "Rectification (Article 16)",
        "Erasure (Article 17)",
        "Restriction (Article 18)",
        "Portability (Article 20)",
        "Objection (Article 21)",
      ],
      data_recipients: ["None - local processing only"],
      exportable_data_types: entries.filter(e => e.exportable).map(e => e.data_type),
      erasable_data_types: entries.filter(e => e.erasable).map(e => e.data_type),
    };
  }

  /**
   * Get DSAR statistics
   */
  public async getStatistics(): Promise<{
    total_requests: number;
    pending_requests: number;
    completed_requests: number;
    by_type: Record<string, number>;
    average_processing_time_hours?: number;
  }> {
    await this.load();

    const byType: Record<string, number> = {};
    let totalProcessingTime = 0;
    let processedCount = 0;

    for (const request of this.requests) {
      byType[request.type] = (byType[request.type] || 0) + 1;

      if (request.completed_at && request.submitted_at) {
        const submitted = new Date(request.submitted_at);
        const completed = new Date(request.completed_at);
        totalProcessingTime += (completed.getTime() - submitted.getTime()) / (1000 * 60 * 60);
        processedCount++;
      }
    }

    return {
      total_requests: this.requests.length,
      pending_requests: this.requests.filter(r => r.status === "pending" || r.status === "processing").length,
      completed_requests: this.requests.filter(r => r.status === "completed").length,
      by_type: byType,
      average_processing_time_hours: processedCount > 0
        ? Math.round((totalProcessingTime / processedCount) * 100) / 100
        : undefined,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the DSAR handler instance
 */
export function getDSARHandler(): DSARHandler {
  return DSARHandler.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Submit a new DSAR
 */
export async function submitDSAR(
  type: DSARRequest["type"] = "access"
): Promise<DSARRequest> {
  return getDSARHandler().submitRequest(type);
}

/**
 * Process a DSAR
 */
export async function processDSAR(requestId: string): Promise<DSARResponse | null> {
  return getDSARHandler().processRequest(requestId);
}

/**
 * Submit and process a DSAR immediately
 */
export async function handleDSAR(
  type: DSARRequest["type"] = "access"
): Promise<DSARResponse> {
  return getDSARHandler().submitAndProcess(type);
}

/**
 * Get DSAR summary response
 */
export async function getDSARSummary(): Promise<ReturnType<DSARHandler["getSummaryResponse"]>> {
  return getDSARHandler().getSummaryResponse();
}
