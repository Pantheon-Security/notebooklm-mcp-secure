/**
 * Security Utilities for NotebookLM MCP Server
 *
 * Provides input validation, sanitization, and security hardening.
 * Added by Pantheon Security for hardened fork.
 */

import path from "path";

// Pre-compiled regex patterns for sanitizeForLogging (avoid recompilation per call)
const EMAIL_SANITIZE_PATTERN = /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]*)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
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
 * Validate and sanitize a NotebookLM URL
 * Prevents URL injection, javascript: URLs, and other attacks
 *
 * @param url - The URL to validate
 * @returns Validated URL or throws error
 */
export function validateNotebookUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new SecurityError('URL is required and must be a string');
  }

  // Trim whitespace
  const trimmed = url.trim();

  // Block empty URLs
  if (trimmed.length === 0) {
    throw new SecurityError('URL cannot be empty');
  }

  // Block dangerous protocols
  const lowerUrl = trimmed.toLowerCase();
  const dangerousProtocols = ['javascript:', 'data:', 'vbscript:', 'file:', 'about:'];
  for (const protocol of dangerousProtocols) {
    if (lowerUrl.startsWith(protocol)) {
      throw new SecurityError(`Dangerous protocol not allowed: ${protocol}`);
    }
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SecurityError('Invalid URL format');
  }

  // Enforce HTTPS
  if (parsed.protocol !== 'https:') {
    throw new SecurityError('Only HTTPS URLs are allowed');
  }

  // Validate domain
  const hostname = parsed.hostname.toLowerCase();
  const isAllowedNotebook = ALLOWED_NOTEBOOK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));

  if (!isAllowedNotebook) {
    throw new SecurityError(`Domain not allowed: ${hostname}. Only NotebookLM domains are permitted.`);
  }

  // Block path traversal attempts
  if (parsed.pathname.includes('..') || parsed.pathname.includes('%2e%2e')) {
    throw new SecurityError('Path traversal not allowed');
  }

  // Return the validated, normalized URL
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

  // Mask email addresses (show first char and domain)
  EMAIL_SANITIZE_PATTERN.lastIndex = 0;
  const emailMasked = value.replace(
    EMAIL_SANITIZE_PATTERN,
    (_, first, rest, domain) => `${first}${'*'.repeat(Math.min(rest.length, 8))}@${domain}`
  );

  // Mask anything that looks like a password or secret
  let result = emailMasked;
  for (const pattern of SECRET_SANITIZE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match, _secret) => {
      const prefix = match.split(/[=:]/)[0];
      return `${prefix}=[REDACTED]`;
    });
  }

  return result;
}

/**
 * Mask an email for logging (more aggressive than general sanitization)
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return '***@***.***';
  }

  const [name, domain] = email.split('@');
  if (name.length <= 2) {
    return `${'*'.repeat(name.length)}@${domain}`;
  }
  return `${name[0]}${'*'.repeat(name.length - 2)}${name[name.length - 1]}@${domain}`;
}

/**
 * Validate file path to prevent path traversal
 */
export function validateFilePath(basePath: string, filePath: string): string {
  // Resolve to absolute path
  const resolved = path.resolve(basePath, filePath);

  // Ensure it's within the base path
  const normalizedBase = path.normalize(basePath);
  const normalizedResolved = path.normalize(resolved);

  if (!normalizedResolved.startsWith(normalizedBase)) {
    throw new SecurityError('Path traversal detected: file must be within allowed directory');
  }

  return normalizedResolved;
}

/**
 * Rate limiter for preventing abuse
 */
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
