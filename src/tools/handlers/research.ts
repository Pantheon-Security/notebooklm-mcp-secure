/**
 * Research handler — Fast/Deep Research source discovery.
 */

import type { HandlerContext } from "./types.js";
import { log } from "../../utils/logger.js";
import { validateNotebookUrl } from "../../utils/security.js";
import type { ToolResult } from "../../types.js";
import {
  ResearchManager,
  type ResearchMode,
  type ResearchCorpus,
  type ResearchSourcesResult,
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
    auto_import?: boolean;
    timeout_ms?: number;
  }
): Promise<ToolResult<ResearchSourcesResult>> {
  log.info(`🔧 [TOOL] research_sources called (mode=${args.mode || "fast"}, corpus=${args.corpus || "web"}, auto_import=${!!args.auto_import})`);

  try {
    if (!args.query || !args.query.trim()) {
      return { success: false, error: "query is required" };
    }
    const safeUrl = resolveNotebookUrl(ctx, args, "research_sources");
    const contextManager = ctx.sessionManager.getContextManager();
    const manager = new ResearchManager(ctx.authManager, contextManager);
    const result = await manager.researchSources(safeUrl, {
      query: args.query,
      mode: args.mode,
      corpus: args.corpus,
      autoImport: args.auto_import,
      timeoutMs: args.timeout_ms,
    });
    if (result.success) {
      log.success(`✅ [TOOL] research_sources completed (imported=${result.imported}, +${result.sourcesAfter - result.sourcesBefore} sources)`);
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
