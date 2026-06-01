/**
 * Security Utilities for NotebookLM MCP Server
 *
 * Provides input validation, sanitization, and security hardening.
 * Added by Pantheon Security for hardened fork.
 */

import path from "path";
import { log } from "./logger.js";

// Pre-compiled regex patterns for sanitizeForLogging (avoid recompilation per call)
const EMAIL_SANITIZE_PATTERN = /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]*)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
// Protocol-agnostic credential-in-URL pattern (I208)
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+\-.]*:\/\/)[^/:@\s]+:[^/@\s]+@/gi;
const SECRET_SANITIZE_PATTERNS = [
  /password[=:]\s*["']?([^"'\s]+)/gi,
  /secret[=:]\s*["']?([^"'\s]+)/gi,
  /token[=:]\s*["']?([^"'\s]+)/gi,
  /api[_-]?key[=:]\s*["']?([^"'\s]+)/gi,
  /auth[=:]\s*["']?([^"'\s]+)/gi,
];

/**
 * Allowed URL patterns for NotebookLM
 */
const ALLOWED_NOTEBOOK_DOMAINS = [
  'notebooklm.google.com',
  'notebooklm.google.co.uk',
  'notebooklm.google.de',
  'notebooklm.google.fr',
  'notebooklm.google.es',
  'notebooklm.google.it',
  'notebooklm.google.nl',
  'notebooklm.google.com.au',
  'notebooklm.google.ca',
];

// Auth domains (reserved for future use)
// const ALLOWED_AUTH_DOMAINS = ['accounts.google.com'];

/**
 * Shared validation for HTTPS URLs: trims, rejects empty/dangerous-protocol/unparseable
 * inputs, and enforces HTTPS. Returns the parsed URL for caller-specific checks.
 *
 * @param url - The raw URL string
 * @param errors - Caller-specific error messages so each public function keeps its distinct wording
 * @returns Parsed URL object (HTTPS, non-dangerous)
 */
function parseHttpsUrl(
  url: string,
  errors: {
    notString: string;
    empty: string;
    dangerousProtocol: (protocol: string) => string;
    invalidFormat: string;
    notHttps: string;
  }
): URL {
  if (!url || typeof url !== 'string') {
    throw new SecurityError(errors.notString);
  }

  // Trim whitespace
  const trimmed = url.trim();

  // Block empty URLs
  if (trimmed.length === 0) {
    throw new SecurityError(errors.empty);
  }

  // Block dangerous protocols
  const lowerUrl = trimmed.toLowerCase();
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:'];
  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      throw new SecurityError(errors.dangerousProtocol(protocol));
    }
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    log.debug(`security: parsing URL: ${err instanceof Error ? err.message : String(err)}`);
    throw new SecurityError(errors.invalidFormat);
  }

  // Enforce HTTPS
  if (parsed.protocol !== 'https:') {
    throw new SecurityError(errors.notHttps);
  }

  return parsed;
}

/**
 * Returns true if the hostname targets an obvious internal/loopback/link-local
 * destination. Defense-in-depth against SSRF; intentionally conservative so that
 * arbitrary public source URLs are not blocked.
 */
function isInternalHost(hostname: string): boolean {
  // Strip IPv6 brackets (URL.hostname keeps them, e.g. "[::1]")
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    return true;
  }

  // RFC1918 / loopback / link-local IPv4 ranges (anchored to avoid over-restriction)
  return (
    /^127\./.test(host) ||                    // loopback 127.0.0.0/8
    /^10\./.test(host) ||                     // private 10.0.0.0/8
    /^192\.168\./.test(host) ||               // private 192.168.0.0/16
    /^169\.254\./.test(host) ||               // link-local 169.254.0.0/16
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) // private 172.16.0.0/12
  );
}

/**
 * Validate and sanitize a NotebookLM URL
 * Prevents URL injection, javascript: URLs, and other attacks
 *
 * @param url - The URL to validate
 * @returns Validated URL or throws error
 */
export function validateNotebookUrl(url: string): string {
  const parsed = parseHttpsUrl(url, {
    notString: 'URL is required and must be a string',
    empty: 'URL cannot be empty',
    dangerousProtocol: (protocol) => `Dangerous protocol not allowed: ${protocol}`,
    invalidFormat: 'Invalid URL format',
    notHttps: 'Only HTTPS URLs are allowed',
  });

  // Validate domain
  const hostname = parsed.hostname.toLowerCase();
  const isAllowedNotebook = ALLOWED_NOTEBOOK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));

  if (!isAllowedNotebook) {
    throw new SecurityError(`Domain not allowed: ${hostname}. Only NotebookLM domains are permitted.`);
  }

  // Block path traversal attempts (URL.pathname already normalises percent-encoding)
  const decodedPath = decodeURIComponent(parsed.pathname).toLowerCase();
  if (decodedPath.includes('..')) {
    throw new SecurityError('Path traversal not allowed');
  }

  // Return the validated, normalized URL
  return parsed.href;
}

/**
 * Validate a user-supplied source URL (content inputs, not notebook navigation).
 * Enforces HTTPS and blocks dangerous schemes without restricting domain.
 */
export function validateSourceUrl(url: string): string {
  const parsed = parseHttpsUrl(url, {
    notString: 'Source URL is required and must be a string',
    empty: 'Source URL cannot be empty',
    dangerousProtocol: (protocol) => `Dangerous protocol not allowed in source URL: ${protocol}`,
    invalidFormat: 'Invalid source URL format',
    notHttps: 'Only HTTPS source URLs are allowed',
  });

  // Defense-in-depth SSRF guard: block obvious internal/loopback targets.
  // The URL is fetched server-side downstream, so this only blocks the clearly
  // internal cases — public hosts of any kind remain allowed.
  if (isInternalHost(parsed.hostname)) {
    throw new SecurityError(`Source URL targets an internal address: ${parsed.hostname}`);
  }

  return parsed.href;
}

/**
 * Validate notebook ID format
 * NotebookLM IDs are typically alphanumeric with dashes
 */
export function validateNotebookId(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new SecurityError('Notebook ID is required and must be a string');
  }

  const trimmed = id.trim();

  // Allow alphanumeric, dashes, underscores (typical Google ID format)
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validPattern.test(trimmed)) {
    throw new SecurityError('Invalid notebook ID format. Only alphanumeric characters, dashes, and underscores allowed.');
  }

  // Reasonable length limit
  if (trimmed.length > 128) {
    throw new SecurityError('Notebook ID too long (max 128 characters)');
  }

  return trimmed;
}

/**
 * Validate session ID format
 */
export function validateSessionId(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new SecurityError('Session ID is required and must be a string');
  }

  const trimmed = id.trim();

  // UUID-like format or alphanumeric
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validPattern.test(trimmed)) {
    throw new SecurityError('Invalid session ID format');
  }

  if (trimmed.length > 64) {
    throw new SecurityError('Session ID too long (max 64 characters)');
  }

  return trimmed;
}

/**
 * Validate question input
 * Prevents extremely long inputs that could cause DoS
 */
export function validateQuestion(question: string): string {
  if (!question || typeof question !== 'string') {
    throw new SecurityError('Question is required and must be a string');
  }

  const trimmed = question.trim();

  if (trimmed.length === 0) {
    throw new SecurityError('Question cannot be empty');
  }

  // Reasonable max length (NotebookLM has its own limits)
  const MAX_QUESTION_LENGTH = 32000;
  if (trimmed.length > MAX_QUESTION_LENGTH) {
    throw new SecurityError(`Question too long (max ${MAX_QUESTION_LENGTH} characters)`);
  }

  return trimmed;
}

/**
 * Sanitize a string for safe logging
 * Masks sensitive information like passwords, tokens, etc.
 */
export function sanitizeForLogging(value: string): string {
  if (!value || typeof value !== 'string') {
    return '[invalid]';
  }

  // Mask email addresses via maskEmail — preserves neither local part nor domain (I207)
  EMAIL_SANITIZE_PATTERN.lastIndex = 0;
  const emailMasked = value.replace(EMAIL_SANITIZE_PATTERN, (match) => maskEmail(match));

  // Mask anything that looks like a password or secret
  let result = emailMasked;
  for (const pattern of SECRET_SANITIZE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, _secret) => {
      const prefix = match.split(/[=:]/)[0];
      return `${prefix}=[REDACTED]`;
    });
  }

  // Redact credentials embedded in any URL scheme (I208)
  URL_CREDENTIAL_PATTERN.lastIndex = 0;
  result = result.replace(URL_CREDENTIAL_PATTERN, "$1***:***@");

  return result;
}

/**
 * Mask an email for logging (more aggressive than general sanitization)
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 2
    ? '***'
    : local[0] + '*'.repeat(Math.min(local.length - 1, 4)) + (local.length > 5 ? local.slice(-1) : '');
  const dotIdx = domain.lastIndexOf('.');
  const maskedDomain = dotIdx > 0
    ? domain[0] + '***' + domain.slice(dotIdx)
    : domain[0] + '***';
  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Validate file path to prevent path traversal
 */
export function validateFilePath(basePath: string, filePath: string): string {
  // Resolve to absolute path
  const resolved = path.resolve(basePath, filePath);

  // Ensure it's within the base path.
  // Use path.relative to avoid the prefix bug where /x/exports matches /x/exports-evil:
  // an in-base path yields "" (equal) or a relative path that does not start with "..".
  const normalizedBase = path.resolve(basePath);
  const normalizedResolved = path.normalize(resolved);
  const relative = path.relative(normalizedBase, normalizedResolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError('Path traversal detected: file must be within allowed directory');
  }

  return normalizedResolved;
}

/**
 * Rate limiter for preventing abuse
 */
const MAX_RATE_LIMITER_KEYS = 10_000;

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number = 100, windowMs: number = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /**
   * Check if a request should be allowed
   * @param key - Identifier for the rate limit (e.g., session ID, IP)
   * @returns true if allowed, false if rate limited
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Get existing requests for this key
    let requests = this.requests.get(key) || [];

    // Filter to only requests within the window
    requests = requests.filter(timestamp => timestamp > windowStart);

    // Evict empty keys to prevent unbounded Map growth
    if (requests.length === 0) {
      this.requests.delete(key);
    }

    // Check if under limit
    if (requests.length >= this.maxRequests) {
      return false;
    }

    // Evict oldest key if map is at capacity (I205)
    if (requests.length === 0 && this.requests.size >= MAX_RATE_LIMITER_KEYS) {
      const oldest = this.requests.keys().next().value;
      if (oldest !== undefined) this.requests.delete(oldest);
    }

    // Add current request
    requests.push(now);
    this.requests.set(key, requests);

    return true;
  }

  /**
   * Get remaining requests for a key
   */
  getRemaining(key: string): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const requests = (this.requests.get(key) || []).filter(t => t > windowStart);
    return Math.max(0, this.maxRequests - requests.length);
  }

  /**
   * Return number of distinct tracked keys
   */
  size(): number {
    return this.requests.size;
  }

  /**
   * Clear all rate limit data
   */
  clear(): void {
    this.requests.clear();
  }
}

/**
 * Custom security error class
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Environment variable validator
 * Ensures sensitive env vars are not logged
 */
export function getSecureEnvVar(name: string, defaultValue: string = ''): string {
  const value = process.env[name];
  return value !== undefined ? value : defaultValue;
}

/**
 * Check if running in a secure context
 */
export function checkSecurityContext(): { secure: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Check for plaintext credentials in env
  if (process.env.LOGIN_PASSWORD) {
    warnings.push('LOGIN_PASSWORD is set in environment - consider using a secrets manager');
  }

  // Check for authentication disabled
  if (process.env.NLMCP_AUTH_DISABLED === 'true' || process.env.NLMCP_AUTH_ENABLED === 'false') {
    warnings.push('MCP authentication is disabled (NLMCP_AUTH_DISABLED) - all tools are accessible without a token');
  }

  // Check for debug mode
  if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
    warnings.push('Running in debug/development mode - ensure this is intentional');
  }

  // Check for headless mode (visible browser can leak info)
  if (process.env.HEADLESS === 'false') {
    warnings.push('Browser is running in visible mode - screen may expose sensitive data');
  }

  return {
    secure: warnings.length === 0,
    warnings,
  };
}
