/**
 * Query Logger for NotebookLM MCP Server
 *
 * Provides persistent logging of all Q&A interactions with NotebookLM:
 * - Full question and answer content
 * - Session and notebook context
 * - Quota information at time of query
 * - Duration and metadata
 *
 * Features:
 * - JSONL format with daily rotation
 * - 90-day retention (configurable)
 * - Search and retrieval by session, notebook, date
 * - Full content storage for research review
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CONFIG } from "../config.js";
import {
  mkdirSecure,
  appendFileSecure,
  PERMISSION_MODES,
} from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";

/**
 * Query log entry structure
 */
export interface QueryLogEntry {
  timestamp: string;
  queryId: string;
  sessionId: string;
  notebookId?: string;
  notebookUrl: string;
  notebookName?: string;
  question: string;
  answer: string;
  answerLength: number;
  durationMs: number;
  quotaInfo: {
    used: number;
    limit: number;
    remaining: number;
    tier: string;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Query logger configuration
 */
export interface QueryLoggerConfig {
  enabled: boolean;
  logDir: string;
  retentionDays: number;
}

/**
 * Search options for query retrieval
 */
export interface QuerySearchOptions {
  limit?: number;
  startDate?: string;
  endDate?: string;
  caseSensitive?: boolean;
}

/**
 * Get query logger configuration from environment
 */
function getQueryLoggerConfig(): QueryLoggerConfig {
  return {
    enabled: process.env.NLMCP_QUERY_LOG_ENABLED !== "false",
    logDir: process.env.NLMCP_QUERY_LOG_DIR || path.join(CONFIG.dataDir, "query_logs"),
    retentionDays: parseInt(process.env.NLMCP_QUERY_LOG_RETENTION_DAYS || "90", 10),
  };
}

/**
 * Generate unique query ID
 */
function generateQueryId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Query Logger Class
 *
 * Logs all Q&A interactions to JSONL files for later review.
 */
export class QueryLogger {
  private config: QueryLoggerConfig;
  private currentLogFile: string = "";
  private writeQueue: QueryLogEntry[] = [];
  private isWriting: boolean = false;
  private stats = {
    totalQueries: 0,
    queriesThisSession: 0,
  };

  constructor(config?: Partial<QueryLoggerConfig>) {
    this.config = { ...getQueryLoggerConfig(), ...config };

    if (this.config.enabled) {
      this.ensureLogDirectory();
      this.initializeLogFile();
      this.cleanOldLogs();
    }
  }

  /**
   * Ensure query log directory exists
   */
  private ensureLogDirectory(): void {
    mkdirSecure(this.config.logDir, PERMISSION_MODES.OWNER_FULL);
  }

  /**
   * Initialize log file for today
   */
  private initializeLogFile(): void {
    const today = new Date().toISOString().split("T")[0];
    this.currentLogFile = path.join(this.config.logDir, `query-log-${today}.jsonl`);
  }

  /**
   * Clean up old log files based on retention policy
   */
  private cleanOldLogs(): void {
    try {
      const files = fs.readdirSync(this.config.logDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

      let deletedCount = 0;
      for (const file of files) {
        if (!file.startsWith("query-log-") || !file.endsWith(".jsonl")) continue;

        // Extract date from filename (query-log-YYYY-MM-DD.jsonl)
        const dateStr = file.slice(10, 20);
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.config.logDir, file));
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        log.info(`🗑️ Cleaned ${deletedCount} old query log files`);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Write entry to log file
   */
  private async writeEntry(entry: QueryLogEntry): Promise<void> {
    this.writeQueue.push(entry);

    if (this.isWriting) return;

    this.isWriting = true;

    try {
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 100);
        const lines = batch.map(e => JSON.stringify(e)).join("\n") + "\n";

        // Check if we need to rotate to new day's file
        const today = new Date().toISOString().split("T")[0];
        const expectedFile = path.join(this.config.logDir, `query-log-${today}.jsonl`);
        if (this.currentLogFile !== expectedFile) {
          this.currentLogFile = expectedFile;
        }

        appendFileSecure(this.currentLogFile, lines, PERMISSION_MODES.OWNER_READ_WRITE);
      }
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Log a query (Q&A pair)
   */
  async logQuery(entry: Omit<QueryLogEntry, "timestamp" | "queryId">): Promise<string> {
    if (!this.config.enabled) return "";

    const queryId = generateQueryId();
    const fullEntry: QueryLogEntry = {
      timestamp: new Date().toISOString(),
      queryId,
      ...entry,
    };

    this.stats.totalQueries++;
    this.stats.queriesThisSession++;

    await this.writeEntry(fullEntry);

    log.debug(`📝 Logged query ${queryId} (${entry.question.slice(0, 50)}...)`);

    return queryId;
  }

  /**
   * Get all queries for a specific session
   */
  async getQueriesForSession(sessionId: string): Promise<QueryLogEntry[]> {
    return this.filterQueries(entry => entry.sessionId === sessionId);
  }

  /**
   * Get all queries for a specific notebook URL
   */
  async getQueriesForNotebook(notebookUrl: string): Promise<QueryLogEntry[]> {
    return this.filterQueries(entry => entry.notebookUrl === notebookUrl);
  }

  /**
   * Get all queries for a specific notebook ID
   */
  async getQueriesForNotebookId(notebookId: string): Promise<QueryLogEntry[]> {
    return this.filterQueries(entry => entry.notebookId === notebookId);
  }

  /**
   * Get all queries for a specific date (YYYY-MM-DD)
   */
  async getQueriesForDate(date: string): Promise<QueryLogEntry[]> {
    const logFile = path.join(this.config.logDir, `query-log-${date}.jsonl`);
    return this.readLogFile(logFile);
  }

  /**
   * Get recent queries
   */
  async getRecentQueries(limit: number = 50): Promise<QueryLogEntry[]> {
    const allQueries = await this.getAllQueries();
    // Sort by timestamp descending (most recent first)
    allQueries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return allQueries.slice(0, limit);
  }

  /**
   * Search queries by pattern in question or answer
   */
  async searchQueries(pattern: string, options?: QuerySearchOptions): Promise<QueryLogEntry[]> {
    const limit = options?.limit ?? 100;
    const caseSensitive = options?.caseSensitive ?? false;

    const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();

    const matches = await this.filterQueries(entry => {
      const question = caseSensitive ? entry.question : entry.question.toLowerCase();
      const answer = caseSensitive ? entry.answer : entry.answer.toLowerCase();
      return question.includes(searchPattern) || answer.includes(searchPattern);
    });

    // Sort by timestamp descending
    matches.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return matches.slice(0, limit);
  }

  /**
   * Get all available log files
   */
  getLogFiles(): string[] {
    try {
      const files = fs.readdirSync(this.config.logDir);
      return files
        .filter(f => f.startsWith("query-log-") && f.endsWith(".jsonl"))
        .sort()
        .reverse(); // Most recent first
    } catch {
      return [];
    }
  }

  /**
   * Get statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Force flush any pending writes
   */
  async flush(): Promise<void> {
    while (this.isWriting || this.writeQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Read and parse a log file
   */
  private readLogFile(filePath: string): QueryLogEntry[] {
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      return lines.map(line => JSON.parse(line) as QueryLogEntry);
    } catch (error) {
      log.warning(`⚠️ Failed to read query log ${filePath}: ${error}`);
      return [];
    }
  }

  /**
   * Get all queries from all log files
   */
  private async getAllQueries(): Promise<QueryLogEntry[]> {
    const logFiles = this.getLogFiles();
    const allQueries: QueryLogEntry[] = [];

    for (const file of logFiles) {
      const filePath = path.join(this.config.logDir, file);
      const entries = this.readLogFile(filePath);
      allQueries.push(...entries);
    }

    return allQueries;
  }

  /**
   * Filter queries across all log files
   */
  private async filterQueries(
    predicate: (entry: QueryLogEntry) => boolean
  ): Promise<QueryLogEntry[]> {
    const allQueries = await this.getAllQueries();
    return allQueries.filter(predicate);
  }
}

/**
 * Global query logger instance
 */
let globalQueryLogger: QueryLogger | null = null;

/**
 * Get or create the global query logger
 */
export function getQueryLogger(): QueryLogger {
  if (!globalQueryLogger) {
    globalQueryLogger = new QueryLogger();
  }
  return globalQueryLogger;
}

/**
 * Convenience function for quick query logging
 */
export async function logQuery(
  entry: Omit<QueryLogEntry, "timestamp" | "queryId">
): Promise<string> {
  return getQueryLogger().logQuery(entry);
}
