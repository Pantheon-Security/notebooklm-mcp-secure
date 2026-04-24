/**
 * Research handlers — async 3-step source discovery flow.
 */

import type { HandlerContext } from "./types.js";
import { log } from "../../utils/logger.js";
import { validateNotebookUrl } from "../../utils/security.js";
import type { ToolResult } from "../../types.js";
import {
  ResearchManager,
  type ResearchMode,
  type ResearchCorpus,
  type ResearchImportAction,
  type TriggerResearchResult,
  type ResearchStatusResult,
  type ImportResearchResult,
} from "../../notebook-creation/research-manager.js";

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

export async function handleResearchSources(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    query: string;
    mode?: ResearchMode;
    corpus?: ResearchCorpus;
  }
): Promise<ToolResult<TriggerResearchResult>> {
  log.info(`🔧 [TOOL] research_sources called (mode=${args.mode || "fast"}, corpus=${args.corpus || "web"})`);
  try {
    if (!args.query || !args.query.trim()) {
      return { success: false, error: "query is required" };
    }
    const safeUrl = resolveNotebookUrl(ctx, args, "research_sources");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new ResearchManager(ctx.authManager, contextManager);
    const result = await manager.triggerResearch(safeUrl, {
      query: args.query,
      mode: args.mode,
      corpus: args.corpus,
    });
    if (result.success) {
      log.success(`✅ [TOOL] research_sources triggered`);
    } else {
      log.warning(`⚠️ [TOOL] research_sources: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] research_sources failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleGetSourceDiscoveryStatus(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): Promise<ToolResult<ResearchStatusResult>> {
  log.info(`🔧 [TOOL] get_source_discovery_status called`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "get_source_discovery_status");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new ResearchManager(ctx.authManager, contextManager);
    const result = await manager.getResearchStatus(safeUrl);
    log.success(`✅ [TOOL] get_source_discovery_status: ${result.status}`);
    return { success: true, data: result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_source_discovery_status failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleImportResearchResults(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    action?: ResearchImportAction;
  }
): Promise<ToolResult<ImportResearchResult>> {
  const action = args.action || "import";
  log.info(`🔧 [TOOL] import_research_results called (action=${action})`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "import_research_results");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new ResearchManager(ctx.authManager, contextManager);
    const result = await manager.importResearchResults(safeUrl, action);
    if (result.success) {
      log.success(`✅ [TOOL] import_research_results: ${action}, ${result.sourcesBefore}→${result.sourcesAfter}`);
    } else {
      log.warning(`⚠️ [TOOL] import_research_results: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] import_research_results failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
