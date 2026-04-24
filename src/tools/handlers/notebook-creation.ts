/**
 * Notebook creation and source management handlers
 *
 * Extracted from handlers.ts — handles create_notebook, batch_create_notebooks,
 * sync_library, list_sources, add_source, add_folder, and remove_source.
 */

import type { HandlerContext } from "./types.js";
import type { ToolResult, ProgressCallback } from "../../types.js";
import type {
  CreateNotebookInput,
  CreatedNotebook,
  NotebookSource,
} from "../../notebook-creation/types.js";
import type { SyncResult } from "../../notebook-creation/notebook-sync.js";
import type {
  ListSourcesResult,
  AddSourceResult,
  RemoveSourceResult,
} from "../../notebook-creation/source-manager.js";
import { NotebookCreator } from "../../notebook-creation/notebook-creator.js";
import { NotebookSync } from "../../notebook-creation/notebook-sync.js";
import { SourceManager } from "../../notebook-creation/source-manager.js";
import { validateNotebookUrl } from "../../utils/security.js";
import { getQuotaManager } from "../../quota/index.js";
import { log } from "../../utils/logger.js";
import { audit } from "../../utils/audit-logger.js";
import {
  getErrorAuditArgs,
  getSanitizedErrorMessage,
} from "./error-utils.js";

export async function handleCreateNotebook(
  ctx: HandlerContext,
  args: CreateNotebookInput,
  sendProgress?: ProgressCallback
): Promise<ToolResult<CreatedNotebook>> {
  log.info(`🔧 [TOOL] create_notebook called`);
  log.info(`  Name: ${args.name}`);
  log.info(`  Sources: ${args.sources?.length || 0}`);

  try {
    // Validate inputs
    if (!args.name || typeof args.name !== "string") {
      throw new Error("Notebook name is required");
    }

    if (!args.sources || !Array.isArray(args.sources) || args.sources.length === 0) {
      throw new Error("At least one source is required");
    }

    // Validate each source
    for (const source of args.sources) {
      if (!source.type || !["url", "text", "file"].includes(source.type)) {
        throw new Error(`Invalid source type: ${source.type}. Must be url, text, or file.`);
      }
      if (!source.value || typeof source.value !== "string") {
        throw new Error("Source value is required");
      }
      if (source.type === "url") {
        try {
          new URL(source.value);
        } catch (err) {
          log.debug(`notebook-creation: validating source URL: ${err instanceof Error ? err.message : String(err)}`);
          throw new Error(`Invalid URL: ${source.value}`);
        }
      }
    }

    // === QUOTA CHECK ===
    const quotaManager = getQuotaManager();
    const canCreate = quotaManager.canCreateNotebook();
    if (!canCreate.allowed) {
      log.warning(`⚠️ Quota limit: ${canCreate.reason}`);
      return {
        success: false,
        data: null,
        error: canCreate.reason || "Notebook quota limit reached",
      };
    }

    // Check source limit
    const sourceLimits = quotaManager.getLimits();
    if (args.sources.length > sourceLimits.sourcesPerNotebook) {
      const reason = `Too many sources (${args.sources.length}). Limit is ${sourceLimits.sourcesPerNotebook} per notebook.`;
      log.warning(`⚠️ Quota limit: ${reason}`);
      return {
        success: false,
        data: null,
        error: reason,
      };
    }

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Create notebook
    const creator = new NotebookCreator(ctx.authManager, contextManager);
    const result = await creator.createNotebook({
      name: args.name,
      sources: args.sources,
      sendProgress,
      browserOptions: args.browser_options || (args.show_browser ? { show: true } : undefined),
    });

    // Auto-add to library if requested (default: true)
    if (args.auto_add_to_library !== false) {
      try {
        ctx.library.addNotebook({
          url: result.url,
          name: args.name,
          description: args.description || `Created ${new Date().toLocaleDateString()}`,
          topics: args.topics || [],
        });
        log.success(`✅ Added notebook to library: ${args.name}`);
      } catch (libError) {
        log.warning(`⚠️ Failed to add to library: ${libError}`);
        // Don't fail the whole operation
      }
    }

    // Update quota tracking
    quotaManager.incrementNotebookCount();

    // Audit log
    await audit.tool("create_notebook", {
      name: args.name,
      sourceCount: args.sources.length,
      url: result.url,
    }, true, 0);

    log.success(`✅ [TOOL] create_notebook completed: ${result.url}`);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] create_notebook failed: ${errorMessage}`);

    await audit.tool(
      "create_notebook",
      getErrorAuditArgs("create_notebook", errorMessage),
      false,
      0,
      errorMessage
    );

    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleBatchCreateNotebooks(
  ctx: HandlerContext,
  args: {
    notebooks: Array<{
      name: string;
      sources: Array<{ type: "url" | "text" | "file"; value: string; title?: string }>;
      description?: string;
      topics?: string[];
    }>;
    stop_on_error?: boolean;
    show_browser?: boolean;
  },
  sendProgress?: ProgressCallback
): Promise<ToolResult<{
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    name: string;
    success: boolean;
    url?: string;
    error?: string;
  }>;
}>> {
  log.info(`🔧 [TOOL] batch_create_notebooks called`);
  log.info(`  Notebooks: ${args.notebooks.length}`);
  log.info(`  Stop on error: ${args.stop_on_error || false}`);

  try {
    // Validate input
    if (!args.notebooks || !Array.isArray(args.notebooks)) {
      throw new Error("notebooks array is required");
    }

    if (args.notebooks.length === 0) {
      throw new Error("At least one notebook is required");
    }

    if (args.notebooks.length > 10) {
      throw new Error("Maximum 10 notebooks per batch");
    }

    const results: Array<{
      name: string;
      success: boolean;
      url?: string;
      error?: string;
    }> = [];

    const total = args.notebooks.length;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < args.notebooks.length; i++) {
      const notebook = args.notebooks[i];

      await sendProgress?.(
        `Creating notebook ${i + 1}/${total}: ${notebook.name}`,
        i,
        total
      );

      log.info(`  📓 Creating notebook ${i + 1}/${total}: ${notebook.name}`);

      try {
        const result = await handleCreateNotebook(ctx, {
          name: notebook.name,
          sources: notebook.sources,
          description: notebook.description,
          topics: notebook.topics,
          auto_add_to_library: true,
          show_browser: args.show_browser,
        });

        if (result.success && result.data) {
          results.push({
            name: notebook.name,
            success: true,
            url: result.data.url,
          });
          succeeded++;
          log.success(`    ✅ Created: ${result.data.url}`);
        } else {
          results.push({
            name: notebook.name,
            success: false,
            error: result.error || "Unknown error",
          });
          failed++;
          log.error(`    ❌ Failed: ${result.error}`);

          if (args.stop_on_error) {
            log.warning(`  ⚠️ Stopping batch due to error (stop_on_error=true)`);
            break;
          }
        }
      } catch (error) {
        const errorMessage = getSanitizedErrorMessage(error);
        results.push({
          name: notebook.name,
          success: false,
          error: errorMessage,
        });
        failed++;
        log.error(`    ❌ Exception: ${errorMessage}`);

        if (args.stop_on_error) {
          log.warning(`  ⚠️ Stopping batch due to exception (stop_on_error=true)`);
          break;
        }
      }

      // Delay between notebooks to avoid rate limiting
      if (i < args.notebooks.length - 1) {
        const delay = 2000 + Math.random() * 2000; // 2-4 seconds
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    await sendProgress?.(`Batch complete: ${succeeded}/${total} succeeded`, total, total);

    log.success(`✅ [TOOL] batch_create_notebooks completed: ${succeeded}/${total} succeeded`);

    return {
      success: failed === 0,
      data: {
        total,
        succeeded,
        failed,
        results,
      },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] batch_create_notebooks failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleSyncLibrary(
  ctx: HandlerContext,
  args: { auto_fix?: boolean; show_browser?: boolean }
): Promise<ToolResult<SyncResult>> {
  log.info(`🔧 [TOOL] sync_library called`);
  log.info(`  Auto-fix: ${args.auto_fix || false}`);
  log.info(`  Show browser: ${args.show_browser || false}`);

  try {
    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Sync library
    const sync = new NotebookSync(ctx.authManager, contextManager, ctx.library);
    const result = await sync.syncLibrary({
      autoFix: args.auto_fix,
      showBrowser: args.show_browser,
    });

    // Audit log
    await audit.tool("sync_library", {
      matched: result.matched.length,
      stale: result.staleEntries.length,
      missing: result.missingNotebooks.length,
      autoFix: args.auto_fix,
    }, true, 0);

    log.success(`✅ [TOOL] sync_library completed`);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] sync_library failed: ${errorMessage}`);

    await audit.tool(
      "sync_library",
      getErrorAuditArgs("sync_library", errorMessage),
      false,
      0,
      errorMessage
    );

    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleListSources(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<ListSourcesResult>> {
  log.info(`🔧 [TOOL] list_sources called`);

  try {
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // List sources
    const sourceManager = new SourceManager(ctx.authManager, contextManager);
    const result = await sourceManager.listSources(safeUrl);

    log.success(`✅ [TOOL] list_sources completed (${result.count} sources)`);
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] list_sources failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleAddSource(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    source: NotebookSource;
  }
): Promise<ToolResult<AddSourceResult>> {
  log.info(`🔧 [TOOL] add_source called`);
  log.info(`  Source type: ${args.source?.type}`);

  try {
    // Validate source
    if (!args.source || !args.source.type || !args.source.value) {
      throw new Error("Source with type and value is required");
    }

    if (!["url", "text", "file"].includes(args.source.type)) {
      throw new Error(`Invalid source type: ${args.source.type}. Must be url, text, or file.`);
    }

    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Add source
    const sourceManager = new SourceManager(ctx.authManager, contextManager);
    const result = await sourceManager.addSource(safeUrl, args.source);

    if (result.success) {
      log.success(`✅ [TOOL] add_source completed`);
    } else {
      log.warning(`⚠️ [TOOL] add_source failed: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] add_source failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Resolve `add_folder` input path and enforce the allowlist/denylist.
 *
 * - Allowlist: `NLMCP_FOLDER_ALLOWLIST` (colon-separated absolute paths).
 *   Defaults to the user's home directory when unset.
 * - Denylist: paths that touch common credential/config dirs are rejected
 *   even when inside an allowed base (defence in depth).
 *
 * Rationale: `add_folder` uploads every file it finds to Google's NotebookLM.
 * Without constraints an authenticated caller can exfiltrate SSH keys,
 * cloud credentials, or kernel interfaces via a legitimate-looking user
 * action. See ISSUES.md:I316.
 */
async function resolveFolderPath(userPath: string): Promise<string> {
  const path = await import("path");
  const os = await import("os");

  if (!userPath || userPath.trim().length === 0) {
    throw new Error("folder_path is required");
  }

  const resolved = path.resolve(userPath);

  // Allowlist.
  const envList = process.env.NLMCP_FOLDER_ALLOWLIST?.trim();
  const allowedBases = envList && envList.length > 0
    ? envList.split(":").map((p) => path.resolve(p.trim())).filter((p) => p.length > 0)
    : [path.resolve(os.homedir())];

  const inAllowedBase = allowedBases.some((base) => {
    const rel = path.relative(base, resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!inAllowedBase) {
    throw new Error(
      `folder_path must be inside one of: ${allowedBases.join(", ")}. ` +
      `Set NLMCP_FOLDER_ALLOWLIST to extend the list.`
    );
  }

  // Denylist (sensitive subpaths — checked after allowlist).
  const deniedSegments = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".kube",
    ".config/gcloud",
    ".config/git",
    ".netrc",
    ".npmrc",
    ".mcpregistry_github_token",
    ".mcpregistry_registry_token",
  ];
  const deniedAbsolute = ["/etc", "/root", "/proc", "/sys", "/var/log"];

  const segments = resolved.split(path.sep);
  for (const denied of deniedSegments) {
    const parts = denied.split("/");
    for (let i = 0; i <= segments.length - parts.length; i++) {
      if (parts.every((p, j) => segments[i + j] === p)) {
        throw new Error(
          `folder_path traverses a sensitive directory (${denied}); refusing to upload.`
        );
      }
    }
  }
  for (const denied of deniedAbsolute) {
    if (resolved === denied || resolved.startsWith(denied + path.sep)) {
      throw new Error(
        `folder_path is inside a protected system directory (${denied}); refusing to upload.`
      );
    }
  }

  return resolved;
}

export async function handleAddFolder(
  ctx: HandlerContext,
  args: {
    folder_path: string;
    notebook_id?: string;
    notebook_url?: string;
    recursive?: boolean;
    file_types?: string[];
    dry_run?: boolean;
    notebook_name_prefix?: string;
  },
  sendProgress?: ProgressCallback
): Promise<
  ToolResult<{
    files_found: number;
    files_added: number;
    files_failed: number;
    files_skipped: number;
    notebooks_used: string[];
    failed_files: Array<{ file: string; error: string }>;
    dry_run: boolean;
  }>
> {
  const { promises: fs } = await import("fs");
  const path = await import("path");

  // Validate and resolve first so the denylist runs before any filesystem read.
  let folderPath: string;
  try {
    folderPath = await resolveFolderPath(args.folder_path);
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] add_folder failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
  const recursive = args.recursive ?? false;
  const dryRun = args.dry_run ?? false;
  const fileTypes = (args.file_types ?? [".pdf", ".txt", ".md", ".docx"]).map((e) =>
    e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`
  );

  log.info(`🔧 [TOOL] add_folder called`);
  log.info(`  Folder: ${folderPath}`);
  log.info(`  File types: ${fileTypes.join(", ")}`);
  log.info(`  Recursive: ${recursive}`);
  log.info(`  Dry run: ${dryRun}`);

  try {
    // ── 1. Validate folder ───────────────────────────────────────────────
    let stat: import("fs").Stats;
    try {
      stat = await fs.stat(folderPath);
    } catch (err) {
      log.debug(`notebook-creation: stat-ing folder path in bulk create handler: ${err instanceof Error ? err.message : String(err)}`);
      throw new Error(`Folder not found: ${folderPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${folderPath}`);
    }

    // ── 2. Scan files ────────────────────────────────────────────────────
    const scanDir = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && recursive) {
          files.push(...(await scanDir(fullPath)));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (fileTypes.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
      return files.sort();
    };

    await sendProgress?.("Scanning folder...", 0, 10);
    const allFiles = await scanDir(folderPath);

    if (allFiles.length === 0) {
      return {
        success: true,
        data: {
          files_found: 0,
          files_added: 0,
          files_failed: 0,
          files_skipped: 0,
          notebooks_used: [],
          failed_files: [],
          dry_run: dryRun,
        },
        error: `No supported files found in ${folderPath} (looking for: ${fileTypes.join(", ")})`,
      };
    }

    log.info(`  Found ${allFiles.length} files`);
    await sendProgress?.(`Found ${allFiles.length} files`, 1, 10);

    // ── 3. Dry run — return preview ──────────────────────────────────────
    if (dryRun) {
      return {
        success: true,
        data: {
          files_found: allFiles.length,
          files_added: 0,
          files_failed: 0,
          files_skipped: 0,
          notebooks_used: [],
          failed_files: [],
          dry_run: true,
        },
      };
    }

    // ── 4. Resolve target notebook ───────────────────────────────────────
    let notebookUrl = args.notebook_url;
    let notebookName = args.notebook_name_prefix ?? path.basename(folderPath);

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) throw new Error(`Notebook not found: ${args.notebook_id}`);
      notebookUrl = notebook.url;
      notebookName = notebook.name;
      log.info(`  Target notebook: ${notebookName}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        notebookName = active.name;
        log.info(`  Using active notebook: ${notebookName}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // ── 5. Check tier limit and chunk files ──────────────────────────────
    const limits = getQuotaManager().getLimits();
    const chunkSize = limits.sourcesPerNotebook;
    const chunks: string[][] = [];
    for (let i = 0; i < allFiles.length; i += chunkSize) {
      chunks.push(allFiles.slice(i, i + chunkSize));
    }
    log.info(`  Tier limit: ${chunkSize} sources/notebook → ${chunks.length} chunk(s)`);

    // ── 6. Add files ─────────────────────────────────────────────────────
    const contextManager = ctx.sessionManager.getContextManager();
    const notebooksUsed: string[] = [];
    const failedFiles: Array<{ file: string; error: string }> = [];
    let totalAdded = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];

      // Determine notebook URL for this chunk
      let targetUrl: string;
      if (chunkIdx === 0) {
        targetUrl = validateNotebookUrl(notebookUrl!);
      } else {
        // Auto-create overflow notebook
        const overflowName =
          chunks.length === 2
            ? `${notebookName} (2/2)`
            : `${notebookName} (${chunkIdx + 1}/${chunks.length})`;
        await sendProgress?.(
          `Creating overflow notebook: ${overflowName}`,
          2,
          10
        );
        log.info(`  Creating overflow notebook: ${overflowName}`);
        const created = await handleCreateNotebook(
          ctx,
          { name: overflowName, sources: [], auto_add_to_library: true },
          sendProgress
        );
        if (!created.success || !created.data?.url) {
          failedFiles.push(
            ...chunk.map((f) => ({ file: f, error: `Could not create overflow notebook ${overflowName}` }))
          );
          continue;
        }
        targetUrl = validateNotebookUrl(created.data.url);
        notebooksUsed.push(overflowName);
      }

      if (chunkIdx === 0) {
        notebooksUsed.unshift(notebookName);
      }

      const sourceManager = new SourceManager(ctx.authManager, contextManager);

      for (let i = 0; i < chunk.length; i++) {
        const filePath = chunk[i];
        const fileName = path.basename(filePath);
        const globalIdx = chunkIdx * chunkSize + i + 1;
        const progressStep = Math.min(9, 2 + Math.floor((globalIdx / allFiles.length) * 7));

        await sendProgress?.(
          `Adding file ${globalIdx}/${allFiles.length}: ${fileName}`,
          progressStep,
          10
        );
        log.info(`  [${globalIdx}/${allFiles.length}] Adding: ${fileName}`);

        try {
          const result = await sourceManager.addSource(targetUrl, {
            type: "file",
            value: filePath,
          });
          if (result.success) {
            totalAdded++;
          } else {
            failedFiles.push({ file: filePath, error: result.error ?? "Unknown error" });
            log.warning(`  ⚠️  Failed: ${fileName} — ${result.error}`);
          }
        } catch (err) {
          const msg = getSanitizedErrorMessage(err);
          failedFiles.push({ file: filePath, error: msg });
          log.warning(`  ⚠️  Error: ${fileName} — ${msg}`);
        }
      }
    }

    await sendProgress?.("Done!", 10, 10);
    log.success(
      `✅ [TOOL] add_folder complete: ${totalAdded}/${allFiles.length} added, ${failedFiles.length} failed`
    );

    return {
      success: failedFiles.length === 0,
      data: {
        files_found: allFiles.length,
        files_added: totalAdded,
        files_failed: failedFiles.length,
        files_skipped: allFiles.length - totalAdded - failedFiles.length,
        notebooks_used: notebooksUsed,
        failed_files: failedFiles,
        dry_run: false,
      },
      ...(failedFiles.length > 0 && {
        error: `${failedFiles.length} file(s) failed to add`,
      }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] add_folder failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

export async function handleRemoveSource(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    source_id: string;
  }
): Promise<ToolResult<RemoveSourceResult>> {
  log.info(`🔧 [TOOL] remove_source called`);
  log.info(`  Source ID: ${args.source_id}`);

  try {
    // Validate source_id
    if (!args.source_id) {
      throw new Error("source_id is required");
    }

    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Remove source
    const sourceManager = new SourceManager(ctx.authManager, contextManager);
    const result = await sourceManager.removeSource(safeUrl, args.source_id);

    if (result.success) {
      log.success(`✅ [TOOL] remove_source completed`);
    } else {
      log.warning(`⚠️ [TOOL] remove_source failed: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] remove_source failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}
