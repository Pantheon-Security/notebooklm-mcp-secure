/**
 * Shared error helpers for tool handlers.
 */

const ABSOLUTE_PATH_PATTERN = /\/[^\s:,'"]+/g;

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
