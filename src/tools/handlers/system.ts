/**
 * System handler functions
 *
 * Handles export_library, get_project_info, get_quota, set_quota_tier, and cleanup_data tools.
 */

import path from "path";
import os from "os";
import type { HandlerContext } from "./types.js";
import type { ToolResult } from "../../types.js";
import { log } from "../../utils/logger.js";
import { getQuotaManager } from "../../quota/index.js";
import { CleanupManager } from "../../utils/cleanup-manager.js";

/**
 * Sanitize a CSV field to prevent formula injection (CWE-1236).
 * Cells beginning with =, +, -, @, tab, or carriage return are interpreted
 * as formulas by Excel/LibreOffice/Google Sheets and can trigger DDE RCE.
 */
function csvSafe(value: string): string {
  const escaped = value.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

/**
 * Resolve and validate an export path, rejecting traversal outside the
 * configured base directory. Returns the absolute resolved path or throws.
 */
function resolveExportPath(userPath: string | undefined, defaultName: string): string {
  // Allowed base directories, in priority order:
  //   1. NLMCP_EXPORT_DIR env override
  //   2. user home directory
  const envDir = process.env.NLMCP_EXPORT_DIR?.trim();
  const baseDirRaw = envDir && envDir.length > 0 ? envDir : os.homedir();
  const baseDir = path.resolve(baseDirRaw);

  // If no user path, write under baseDir with the default name.
  const candidate = userPath && userPath.trim().length > 0
    ? path.resolve(baseDir, userPath)
    : path.resolve(baseDir, defaultName);

  // Defence in depth: ensure resolved path is still inside the base dir.
  const rel = path.relative(baseDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `output_path must resolve inside ${baseDir} (got '${candidate}'). ` +
      `Set NLMCP_EXPORT_DIR to allow another base directory.`
    );
  }
  return candidate;
}

export async function handleExportLibrary(
  ctx: HandlerContext,
  args: {
    format?: "json" | "csv";
    output_path?: string;
  }
): Promise<ToolResult<{
  file_path: string;
  format: string;
  notebook_count: number;
  size_bytes: number;
}>> {
  const format = args.format || "json";
  log.info(`🔧 [TOOL] export_library called`);
  log.info(`  Format: ${format}`);

  try {
    const notebooks = ctx.library.listNotebooks();
    const stats = ctx.library.getStats();

    const date = new Date().toISOString().split("T")[0];
    const defaultName = `notebooklm-library-backup-${date}.${format}`;
    const outputPath = resolveExportPath(args.output_path, defaultName);

    let content: string;

    if (format === "csv") {
      // CSV format: name, url, topics, last_used, use_count
      const headers = ["name", "url", "topics", "description", "last_used", "use_count"];
      const rows = notebooks.map((nb: { name?: string; url: string; topics?: string[]; description?: string; last_used?: string; use_count?: number }) => [
        csvSafe(nb.name || ""),
        csvSafe(nb.url),
        csvSafe((nb.topics || []).join("; ")),
        csvSafe(nb.description || ""),
        csvSafe(nb.last_used || ""),
        String(nb.use_count || 0),
      ]);
      content = [headers.join(","), ...rows.map((r: string[]) => r.join(","))].join("\n");
    } else {
      // JSON format: full library data
      content = JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          version: "1.0",
          stats: {
            total_notebooks: stats.total_notebooks,
            total_queries: stats.total_queries,
          },
          notebooks: notebooks,
        },
        null,
        2
      );
    }

    // Write file with secure permissions
    const fs = await import("fs");
    fs.writeFileSync(outputPath, content, { mode: 0o600 });

    const fileStats = fs.statSync(outputPath);

    log.success(`✅ [TOOL] export_library completed: ${outputPath}`);
    return {
      success: true,
      data: {
        file_path: outputPath,
        format,
        notebook_count: notebooks.length,
        size_bytes: fileStats.size,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] export_library failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function handleGetProjectInfo(
  ctx: HandlerContext
): Promise<ToolResult<{
  project: { id: string; name: string; path: string; type: string } | null;
  library_path: string;
  is_project_library: boolean;
  detected_project: { id: string; name: string; path: string; type: string } | null;
}>> {
  log.info(`🔧 [TOOL] get_project_info called`);

  try {
    // Get info from the library instance
    const projectInfo = ctx.library.getProjectInfo();
    const libraryPath = ctx.library.getLibraryPath();
    const isProjectLibrary = ctx.library.isProjectLibrary();

    // Also detect what project would be detected from cwd
    const { NotebookLibrary: NL } = await import("../../library/notebook-library.js");
    const detectedProject = NL.detectCurrentProject();

    log.success(`✅ [TOOL] get_project_info completed`);
    return {
      success: true,
      data: {
        project: projectInfo,
        library_path: libraryPath,
        is_project_library: isProjectLibrary,
        detected_project: detectedProject,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_project_info failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function handleGetQuota(
  ctx: HandlerContext,
  args: { sync?: boolean } = {}
): Promise<ToolResult<{
  tier: string;
  notebooks: { used: number; limit: number; remaining: number; percent: number };
  sources: { limit: number };
  queries: { used: number; limit: number; remaining: number; percent: number; should_stop: boolean; reset_time: string };
  warnings: string[];
  auto_detected: boolean;
  last_updated: string;
  synced_from_google: boolean;
  google_quota?: { used: number; limit: number } | null;
  rate_limit_detected?: boolean;
}>> {
  const { sync = false } = args;
  log.info(`🔧 [TOOL] get_quota called (sync=${sync})`);

  try {
    const quotaManager = getQuotaManager();

    let syncedFromGoogle = false;
    let googleQuota: { used: number; limit: number } | null = null;
    let rateLimitDetected = false;

    // If sync requested, navigate to NotebookLM and scrape quota
    if (sync) {
      log.info("📊 Syncing quota from Google NotebookLM...");
      try {
        // Get the shared context manager from session manager
        const contextManager = ctx.sessionManager.getContextManager();
        const context = await contextManager.getOrCreateContext();

        // Create a new page to check quota
        const page = await context.newPage();
        try {
          // Navigate to NotebookLM homepage
          await page.goto("https://notebooklm.google.com/", {
            waitUntil: "networkidle",
            timeout: 30000,
          });

          // Wait for page to load
          await page.waitForTimeout(2000);

          // Update quota from UI
          const syncResult = await quotaManager.updateFromUI(page);
          syncedFromGoogle = true;
          googleQuota = syncResult.queryUsageFromGoogle;
          rateLimitDetected = syncResult.rateLimitDetected;

          log.success(`✅ Synced quota from Google: ${googleQuota ? `${googleQuota.used}/${googleQuota.limit}` : "usage not displayed in UI"}`);
        } finally {
          await page.close();
        }
      } catch (syncError) {
        const syncErrorMsg = syncError instanceof Error ? syncError.message : String(syncError);
        log.warning(`⚠️ Could not sync from Google: ${syncErrorMsg}. Using local tracking.`);
      }
    }

    const detailedStatus = quotaManager.getDetailedStatus();
    const settings = quotaManager.getSettings();

    log.success(`✅ [TOOL] get_quota completed (tier: ${detailedStatus.tier}, ${detailedStatus.queries.remaining} queries remaining, synced=${syncedFromGoogle})`);
    return {
      success: true,
      data: {
        tier: detailedStatus.tier,
        notebooks: {
          used: detailedStatus.notebooks.used,
          limit: detailedStatus.notebooks.limit,
          remaining: detailedStatus.notebooks.remaining,
          percent: detailedStatus.notebooks.percentUsed,
        },
        sources: detailedStatus.sources,
        queries: {
          used: detailedStatus.queries.used,
          limit: detailedStatus.queries.limit,
          remaining: detailedStatus.queries.remaining,
          percent: detailedStatus.queries.percentUsed,
          should_stop: detailedStatus.queries.shouldStop,
          reset_time: detailedStatus.queries.resetTime,
        },
        warnings: detailedStatus.warnings,
        auto_detected: settings.autoDetected,
        last_updated: settings.usage.lastUpdated,
        synced_from_google: syncedFromGoogle,
        google_quota: googleQuota,
        rate_limit_detected: rateLimitDetected,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_quota failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function handleSetQuotaTier(
  _ctx: HandlerContext,
  args: {
    tier: "free" | "pro" | "ultra";
  }
): Promise<ToolResult<{
  tier: string;
  limits: { notebooks: number; sourcesPerNotebook: number; queriesPerDay: number };
  message: string;
}>> {
  log.info(`🔧 [TOOL] set_quota_tier called`);
  log.info(`  Tier: ${args.tier}`);

  try {
    const quotaManager = getQuotaManager();
    quotaManager.setTier(args.tier);
    const settings = quotaManager.getSettings();

    log.success(`✅ [TOOL] set_quota_tier completed (tier: ${args.tier})`);
    return {
      success: true,
      data: {
        tier: settings.tier,
        limits: {
          notebooks: settings.limits.notebooks,
          sourcesPerNotebook: settings.limits.sourcesPerNotebook,
          queriesPerDay: settings.limits.queriesPerDay,
        },
        message: `License tier set to ${args.tier}. Limits updated accordingly.`,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] set_quota_tier failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export async function handleCleanupData(
  _ctx: HandlerContext,
  args: { confirm: boolean; preserve_library?: boolean }
): Promise<
  ToolResult<{
    status: string;
    mode: string;
    preview?: {
      categories: Array<{ name: string; description: string; paths: string[]; totalBytes: number; optional: boolean }>;
      totalPaths: number;
      totalSizeBytes: number;
    };
    result?: {
      deletedPaths: string[];
      failedPaths: string[];
      totalSizeBytes: number;
      categorySummary: Record<string, { count: number; bytes: number }>;
    };
  }>
> {
  const { confirm, preserve_library = false } = args;

  log.info(`🔧 [TOOL] cleanup_data called`);
  log.info(`  Confirm: ${confirm}`);
  log.info(`  Preserve Library: ${preserve_library}`);

  const cleanupManager = new CleanupManager();

  try {
    // Always run in deep mode
    const mode = "deep";

    if (!confirm) {
      // Preview mode - show what would be deleted
      log.info(`  📋 Generating cleanup preview (mode: ${mode})...`);

      const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
      const platformInfo = cleanupManager.getPlatformInfo();

      log.info(`  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`);
      log.info(`  Platform: ${platformInfo.platform}`);

      return {
        success: true,
        data: {
          status: "preview",
          mode,
          preview: {
            categories: preview.categories,
            totalPaths: preview.totalPaths.length,
            totalSizeBytes: preview.totalSizeBytes,
          },
        },
      };
    } else {
      // Cleanup mode - actually delete files
      log.info(`  🗑️  Performing cleanup (mode: ${mode})...`);

      const result = await cleanupManager.performCleanup(mode, preserve_library);

      if (result.success) {
        log.success(`✅ [TOOL] cleanup_data completed - deleted ${result.deletedPaths.length} items`);
      } else {
        log.warning(`⚠️  [TOOL] cleanup_data completed with ${result.failedPaths.length} errors`);
      }

      return {
        success: result.success,
        data: {
          status: result.success ? "completed" : "partial",
          mode,
          result: {
            deletedPaths: result.deletedPaths,
            failedPaths: result.failedPaths,
            totalSizeBytes: result.totalSizeBytes,
            categorySummary: result.categorySummary,
          },
        },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}
