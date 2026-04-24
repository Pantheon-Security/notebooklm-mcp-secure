/**
 * Source content / download handlers.
 */

import type { HandlerContext } from "./types.js";
import { log } from "../../utils/logger.js";
import { validateNotebookUrl } from "../../utils/security.js";
import type { ToolResult } from "../../types.js";
import {
  SourceManager,
  type SourceContentResult,
  type DownloadSourceResult,
  type SourceContentFormat,
} from "../../notebook-creation/source-manager.js";

function resolveNotebookUrl(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string },
  logPrefix: string
): string {
  let notebookUrl = args.notebook_url;
  if (!notebookUrl && args.notebook_id) {
    const notebook = ctx.library.getNotebook(args.notebook_id);
    if (!notebook) throw new Error(`Notebook not found in library: ${args.notebook_id}`);
    notebookUrl = notebook.url;
    log.info(`  [${logPrefix}] Resolved notebook: ${notebook.name}`);
  } else if (!notebookUrl) {
    const active = ctx.library.getActiveNotebook();
    if (active) {
      notebookUrl = active.url;
      log.info(`  [${logPrefix}] Using active notebook: ${active.name}`);
    } else {
      throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
    }
  }
  return validateNotebookUrl(notebookUrl);
}

export async function handleGetSourceContent(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    source_id: string;
    format?: SourceContentFormat;
  }
): Promise<ToolResult<SourceContentResult>> {
  log.info(`🔧 [TOOL] get_source_content called (source_id=${args.source_id}, format=${args.format || "markdown"})`);
  try {
    if (!args.source_id) {
      return { success: false, error: "source_id is required" };
    }
    const safeUrl = resolveNotebookUrl(ctx, args, "get_source_content");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new SourceManager(ctx.authManager, contextManager);
    const result = await manager.getSourceContent(safeUrl, args.source_id, args.format || "markdown");
    if (result.success) {
      log.success(`✅ [TOOL] get_source_content: ${result.contentLength} chars`);
    } else {
      log.warning(`⚠️ [TOOL] get_source_content: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_source_content failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleDownloadSource(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    source_id: string;
    format?: SourceContentFormat;
    output_path?: string;
  }
): Promise<ToolResult<DownloadSourceResult>> {
  log.info(`🔧 [TOOL] download_source called (source_id=${args.source_id}, format=${args.format || "markdown"})`);
  try {
    if (!args.source_id) {
      return { success: false, error: "source_id is required" };
    }
    const safeUrl = resolveNotebookUrl(ctx, args, "download_source");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new SourceManager(ctx.authManager, contextManager);
    const result = await manager.downloadSource(
      safeUrl,
      args.source_id,
      args.format || "markdown",
      args.output_path
    );
    if (result.success) {
      log.success(`✅ [TOOL] download_source: ${result.size} bytes → ${result.filePath}`);
    } else {
      log.warning(`⚠️ [TOOL] download_source: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] download_source failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
