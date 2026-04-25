/**
 * Custom Error Types for NotebookLM MCP Server
 */

/**
 * Error thrown when NotebookLM rate limit is exceeded
 *
 * Free users have 50 queries/day limit.
 * This error indicates the user should:
 * - Use re_auth tool to switch Google accounts
 * - Wait until tomorrow for quota reset
 * - Upgrade to Google AI Pro/Ultra for higher limits
 */
export class RateLimitError extends Error {
  constructor(message: string = "NotebookLM rate limit reached (50 queries/day for free accounts)") {
    super(message);
    this.name = "RateLimitError";

    // Maintain proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RateLimitError);
    }
  }
}

/**
 * Error thrown when authentication fails
 *
 * This error can suggest cleanup workflow for persistent issues.
 * Especially useful when upgrading from old installation (notebooklm-mcp-nodejs).
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthenticationError);
    }
  }
}

export class ValidationError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ValidationError);
  }
}

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
    if (Error.captureStackTrace) Error.captureStackTrace(this, QuotaError);
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
    if (Error.captureStackTrace) Error.captureStackTrace(this, NotFoundError);
  }
}

export class UpstreamError extends Error {
  statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    if (Error.captureStackTrace) Error.captureStackTrace(this, UpstreamError);
  }
}

export class BrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserError";
    if (Error.captureStackTrace) Error.captureStackTrace(this, BrowserError);
  }
}

export class SessionExpiredError extends Error {
  sessionId?: string;
  constructor(message: string, sessionId?: string) {
    super(message);
    this.name = "SessionExpiredError";
    this.sessionId = sessionId;
    if (Error.captureStackTrace) Error.captureStackTrace(this, SessionExpiredError);
  }
}
