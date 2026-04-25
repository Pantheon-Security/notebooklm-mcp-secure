/**
 * Shared error helpers for tool handlers.
 */

import type { HandlerContext } from "./types.js";
import { log } from "../../utils/logger.js";

const ABSOLUTE_PATH_PATTERN = /\/[^\s:,'"]+/g;

/**
 * Resolve a notebook URL from either an explicit URL, a notebook ID, or the
 * currently active notebook.  Throws if no notebook can be identified.
 */
export function resolveNotebookUrl(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): string {
  if (args.notebook_url) return args.notebook_url;

  if (args.notebook_id) {
    const notebook = ctx.library.getNotebook(args.notebook_id);
    if (!notebook) throw new Error(`Notebook not found in library: ${args.notebook_id}`);
    log.info(`  Resolved notebook: ${notebook.name}`);
    return notebook.url;
  }

  const active = ctx.library.getActiveNotebook();
  if (active) {
    log.info(`  Using active notebook: ${active.name}`);
    return active.url;
  }

  throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
}

export function sanitizeErrorMessage(errorMsg: string): string {
  return errorMsg.replace(ABSOLUTE_PATH_PATTERN, "[path]");
}

export function getSanitizedErrorMessage(error: unknown): string {
  return sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
}

export function getErrorAuditArgs(tool: string, error: unknown): Record<string, string> {
  return {
    tool,
    error: getSanitizedErrorMessage(error),
  };
}
