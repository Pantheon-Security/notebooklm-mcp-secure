/**
 * Notebook Management Handlers
 *
 * Standalone handler functions for notebook CRUD and library operations.
 */

import type { HandlerContext } from "./types.js";
import type { AddNotebookInput, UpdateNotebookInput } from "../../library/types.js";
import type { ToolResult } from "../../types.js";
import { log } from "../../utils/logger.js";
import { getSanitizedErrorMessage } from "./error-utils.js";

/**
 * Handle add_notebook tool
 */
export async function handleAddNotebook(
  ctx: HandlerContext,
  args: AddNotebookInput
): Promise<ToolResult<{ notebook: any }>> {
  log.info(`🔧 [TOOL] add_notebook called`);
  log.info(`  Name: ${args.name}`);

  try {
    const notebook = ctx.library.addNotebook(args);
    log.success(`✅ [TOOL] add_notebook completed: ${notebook.id}`);
    return {
      success: true,
      data: { notebook },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle list_notebooks tool
 */
export async function handleListNotebooks(
  ctx: HandlerContext
): Promise<ToolResult<{ notebooks: any[] }>> {
  log.info(`🔧 [TOOL] list_notebooks called`);

  try {
    const notebooks = ctx.library.listNotebooks();
    log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
    return {
      success: true,
      data: { notebooks },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle get_notebook tool
 */
export async function handleGetNotebook(
  ctx: HandlerContext,
  args: { id: string }
): Promise<ToolResult<{ notebook: any }>> {
  log.info(`🔧 [TOOL] get_notebook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const notebook = ctx.library.getNotebook(args.id);
    if (!notebook) {
      log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
      return {
        success: false,
        data: null,
        error: `Notebook not found: ${args.id}`,
      };
    }

    log.success(`✅ [TOOL] get_notebook completed: ${notebook.name}`);
    return {
      success: true,
      data: { notebook },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle select_notebook tool
 */
export async function handleSelectNotebook(
  ctx: HandlerContext,
  args: { id: string }
): Promise<ToolResult<{ notebook: any }>> {
  log.info(`🔧 [TOOL] select_notebook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const notebook = ctx.library.selectNotebook(args.id);
    log.success(`✅ [TOOL] select_notebook completed: ${notebook.name}`);
    return {
      success: true,
      data: { notebook },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle update_notebook tool
 */
export async function handleUpdateNotebook(
  ctx: HandlerContext,
  args: UpdateNotebookInput
): Promise<ToolResult<{ notebook: any }>> {
  log.info(`🔧 [TOOL] update_notebook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const notebook = ctx.library.updateNotebook(args);
    log.success(`✅ [TOOL] update_notebook completed: ${notebook.name}`);
    return {
      success: true,
      data: { notebook },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle remove_notebook tool
 */
export async function handleRemoveNotebook(
  ctx: HandlerContext,
  args: { id: string }
): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
  log.info(`🔧 [TOOL] remove_notebook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const notebook = ctx.library.getNotebook(args.id);
    if (!notebook) {
      log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
      return {
        success: false,
        data: null,
        error: `Notebook not found: ${args.id}`,
      };
    }

    const removed = ctx.library.removeNotebook(args.id);
    if (removed) {
      const closedSessions = await ctx.sessionManager.closeSessionsForNotebook(
        notebook.url
      );
      log.success(`✅ [TOOL] remove_notebook completed`);
      return {
        success: true,
        data: { removed: true, closed_sessions: closedSessions },
      };
    } else {
      log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
      return {
        success: false,
        data: null,
        error: `Notebook not found: ${args.id}`,
      };
    }
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle search_notebooks tool
 */
export async function handleSearchNotebooks(
  ctx: HandlerContext,
  args: { query: string }
): Promise<ToolResult<{ notebooks: any[] }>> {
  log.info(`🔧 [TOOL] search_notebooks called`);
  log.info(`  Query: "${args.query}"`);

  try {
    const notebooks = ctx.library.searchNotebooks(args.query);
    log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
    return {
      success: true,
      data: { notebooks },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle get_library_stats tool
 */
export async function handleGetLibraryStats(
  ctx: HandlerContext
): Promise<ToolResult<any>> {
  log.info(`🔧 [TOOL] get_library_stats called`);

  try {
    const stats = ctx.library.getStats();
    log.success(`✅ [TOOL] get_library_stats completed`);
    return {
      success: true,
      data: stats,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}
