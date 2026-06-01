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
import { SecretsScanner } from "../utils/secrets-scanner.js";

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

const MAX_LOG_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per daily file (I232)

/**
 * Query Logger Class
 *
 * Logs all Q&A interactions to JSONL files for later review.
 */
export class QueryLogger {
  private static instances = new Set<QueryLogger>();
  private static processHandlersRegistered = false;

  private config: QueryLoggerConfig;
  private currentLogFile: string = "";
  private writeQueue: QueryLogEntry[] = [];
  private isWriting: boolean = false;
  /**
   * Dedicated scanner for on-disk log redaction. Uses `medium` minimum
   * severity so we don't redact legitimate base64 payloads (images, PDFs,
   * JWT payloads) that frequently appear in NotebookLM answers. Real
   * credentials live at critical/high/medium severity.
   *
   * ACCEPTED RISK (L11): the only `severity: "low"` rule in the scanner is the
   * "High Entropy String" pattern (/\b[A-Za-z0-9+/]{32,}={0,2}\b/, see
   * secrets-scanner.ts). It is DELIBERATELY NOT redacted at rest because
   * NotebookLM answers routinely contain long, high-entropy base64 that is NOT
   * a secret — inline image/PDF data-URIs, JWT payload segments, GCS object
   * names, CSRF tokens, document hashes. Redacting at "low" would shred this
   * legitimate research content (high false-positive rate) for marginal gain:
   * genuine credentials (API keys, bearer tokens, private keys, connection
   * strings) already match dedicated critical/high/medium rules and are
   * redacted regardless. The base64 false-positive cost outweighs the residual
   * risk of an unstructured low-confidence entropy hit slipping through, so the
   * threshold stays at "medium" by design.
   */
  private scanner = new SecretsScanner({ minSeverity: "medium" });
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

    QueryLogger.instances.add(this);
    this.registerProcessHandlers();
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
      // Filenames are UTC dates (toISOString) and new Date("YYYY-MM-DD") parses as
      // UTC midnight, so compute the cutoff at UTC midnight too — using local
      // setDate/getDate would skew the comparison by up to a day near TZ boundaries (L13).
      const cutoffDate = new Date();
      cutoffDate.setUTCHours(0, 0, 0, 0);
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.config.retentionDays);

      let deletedCount = 0;
      for (const file of files) {
        if (!file.startsWith("query-log-") || !file.endsWith(".jsonl")) continue;

        // Extract date from filename (query-log-YYYY-MM-DD.jsonl). The fixed-width
        // slice(10,20) yields "YYYY-MM-DD" for both base and rotated
        // (query-log-DATE.NNN.jsonl) names, so this guard does NOT exclude rotated files
        // from retention — it only rejects genuinely malformed names before feeding
        // new Date, which would otherwise parse to Invalid Date or a misread cutoff (L13).
        // Matches audit-logger's guard.
        const dateStr = file.slice(10, 20);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
        const fileDate = new Date(dateStr);

        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.config.logDir, file));
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        log.info(`🗑️ Cleaned ${deletedCount} old query log files`);
      }
    } catch (err) {
      log.debug(`query-logger: cleaning up old log files: ${err instanceof Error ? err.message : String(err)}`);
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

        // Check if we need to rotate to new day's file
        const today = new Date().toISOString().split("T")[0];
        const expectedFile = path.join(this.config.logDir, `query-log-${today}.jsonl`);
        if (this.currentLogFile !== expectedFile) {
          this.currentLogFile = expectedFile;
        }

        // Enforce per-file size cap (I232). When the cap would be exceeded we ROTATE to
        // a sequence-suffixed file (query-log-DATE.NNN.jsonl) instead of silently
        // truncating Q&A content (M9) — the old behaviour permanently lost research
        // data with no record. Each rotation emits a mandatory log.warning so the event
        // is visible. The current file size is re-read after each rotation; the next
        // suffix is determined by scanning the directory so the cap holds across writers
        // and process restarts (per-process counters did not).
        let currentFileSize = (() => {
          try { return fs.statSync(this.currentLogFile).size; } catch { return 0; }
        })();

        const linesToWrite: string[] = [];
        for (const e of batch) {
          const serialized = JSON.stringify(e);
          const entryBytes = Buffer.byteLength(serialized + "\n");

          if (currentFileSize > 0 && currentFileSize + entryBytes > MAX_LOG_FILE_BYTES) {
            // Flush what we have to the current file before rotating.
            if (linesToWrite.length > 0) {
              appendFileSecure(this.currentLogFile, linesToWrite.join("\n") + "\n", PERMISSION_MODES.OWNER_READ_WRITE);
              linesToWrite.length = 0;
            }
            const rotatedFile = this.nextRotatedFile(today);
            log.warning(`⚠️ Query log ${path.basename(this.currentLogFile)} reached ${MAX_LOG_FILE_BYTES} byte cap — rotating to ${path.basename(rotatedFile)} (no content truncated)`);
            this.currentLogFile = rotatedFile;
            currentFileSize = (() => {
              try { return fs.statSync(this.currentLogFile).size; } catch { return 0; }
            })();
          }

          linesToWrite.push(serialized);
          currentFileSize += entryBytes;
        }

        if (linesToWrite.length > 0) {
          appendFileSecure(this.currentLogFile, linesToWrite.join("\n") + "\n", PERMISSION_MODES.OWNER_READ_WRITE);
        }
      }
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * Determine the next sequence-suffixed log file for `date` when the base file (or a
   * prior rotation) has hit the size cap (M9). Scans the directory for the highest
   * existing query-log-DATE.NNN.jsonl suffix and returns the next one, so rotation is
   * correct across writers and restarts rather than relying on a per-process counter.
   */
  private nextRotatedFile(date: string): string {
    let maxSeq = 0;
    try {
      const re = new RegExp(`^query-log-${date}\\.(\\d{3})\\.jsonl$`);
      for (const f of fs.readdirSync(this.config.logDir)) {
        const m = f.match(re);
        if (m) {
          const seq = parseInt(m[1], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      }
    } catch (err) {
      log.debug(`query-logger: scanning for rotated files: ${err instanceof Error ? err.message : String(err)}`);
    }
    const nextSeq = String(maxSeq + 1).padStart(3, "0");
    return path.join(this.config.logDir, `query-log-${date}.${nextSeq}.jsonl`);
  }

  /**
   * Log a query (Q&A pair).
   *
   * Question and answer text are passed through the secrets scanner before
   * persistence so leaked credentials (API keys, tokens, private keys) are
   * redacted at rest. The original in-memory entry is never mutated — only
   * the on-disk record is sanitized.
   */
  async logQuery(entry: Omit<QueryLogEntry, "timestamp" | "queryId">): Promise<string> {
    if (!this.config.enabled) return "";

    const queryId = generateQueryId();

    const [redactedQuestion, redactedAnswer] = await Promise.all([
      this.scanner.scanAndRedact(entry.question),
      this.scanner.scanAndRedact(entry.answer),
    ]);

    const fullEntry: QueryLogEntry = {
      timestamp: new Date().toISOString(),
      queryId,
      ...entry,
      question: redactedQuestion.clean,
      answer: redactedAnswer.clean,
    };

    this.stats.totalQueries++;
    this.stats.queriesThisSession++;

    await this.writeEntry(fullEntry);

    // Preview removed: earlier versions logged `question.slice(0, 50)` which
    // leaked plaintext fragments to stderr and bypassed the redaction above.
    log.debug(`📝 Logged query ${queryId}`);

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
    // Include any size-cap rotations for the day (query-log-DATE.NNN.jsonl), not just
    // the base file, so rotated entries are not missed (M9).
    const baseFile = path.join(this.config.logDir, `query-log-${date}.jsonl`);
    const entries = this.readLogFile(baseFile);

    const rotatedRe = new RegExp(`^query-log-${date}\\.\\d{3}\\.jsonl$`);
    try {
      const rotated = fs.readdirSync(this.config.logDir)
        .filter(f => rotatedRe.test(f))
        .sort();
      for (const f of rotated) {
        entries.push(...this.readLogFile(path.join(this.config.logDir, f)));
      }
    } catch (err) {
      log.debug(`query-logger: reading rotated files for date ${date}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return entries;
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
    } catch (err) {
      log.debug(`query-logger: reading log directory in getLogFiles: ${err instanceof Error ? err.message : String(err)}`);
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

  private registerProcessHandlers(): void {
    if (QueryLogger.processHandlersRegistered) return;
    process.on("beforeExit", () => QueryLogger.flushAllSync());
    process.on("SIGTERM", () => QueryLogger.flushAllSync());
    // Mirror SIGTERM for SIGINT (Ctrl-C) and SIGHUP so buffered Q&A is flushed
    // synchronously on those signals too (M5). Additive flush-only safety nets — the
    // process entry point owns termination, so these do not suppress exit or hang.
    process.on("SIGINT", () => QueryLogger.flushAllSync());
    process.on("SIGHUP", () => QueryLogger.flushAllSync());
    QueryLogger.processHandlersRegistered = true;
  }

  private static flushAllSync(): void {
    for (const instance of QueryLogger.instances) {
      instance.flushQueueSync();
    }
  }

  private flushQueueSync(): void {
    if (!this.config.enabled || this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0, this.writeQueue.length);
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(this.config.logDir, `query-log-${today}.jsonl`);
    const lines = batch.map(e => JSON.stringify(e)).join("\n") + "\n";
    try {
      appendFileSecure(logFile, lines, PERMISSION_MODES.OWNER_READ_WRITE);
    } catch (err) {
      log.debug(`query-logger: sync flush on shutdown: ${err instanceof Error ? err.message : String(err)}`);
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
  private async getAllQueries(limit: number = 1000): Promise<QueryLogEntry[]> {
    const logFiles = this.getLogFiles();
    const allQueries: QueryLogEntry[] = [];

    for (const file of logFiles) {
      if (allQueries.length >= limit) break;
      const filePath = path.join(this.config.logDir, file);
      const entries = this.readLogFile(filePath);
      allQueries.push(...entries);
    }

    return allQueries.slice(0, limit);
  }

  /**
   * Filter queries across all log files
   */
  private async filterQueries(
    predicate: (entry: QueryLogEntry) => boolean,
    limit: number = 1000
  ): Promise<QueryLogEntry[]> {
    const allQueries = await this.getAllQueries(limit * 10); // over-fetch to account for filter
    return allQueries.filter(predicate).slice(0, limit);
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
