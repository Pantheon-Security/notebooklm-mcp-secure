/**
 * MCP Authentication for NotebookLM MCP Server
 *
 * Provides authentication for MCP requests:
 * - Token-based authentication
 * - Auto-generated tokens on first run
 * - Secure token storage (hashed)
 * - Rate limiting for failed auth attempts
 *
 * Added by Pantheon Security for hardened fork.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { secureCompare } from "../utils/secure-memory.js";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import { audit } from "../utils/audit-logger.js";
import {
  mkdirSecure,
  writeFileSecure,
  PERMISSION_MODES,
} from "../utils/file-permissions.js";

/**
 * MCP Auth configuration
 */
export interface MCPAuthConfig {
  /** Enable authentication (default: false for backwards compatibility) */
  enabled: boolean;
  /** Token from environment or file */
  token?: string;
  /** Path to token file */
  tokenFile: string;
  /** Max failed auth attempts before lockout */
  maxFailedAttempts: number;
  /** Lockout duration in milliseconds */
  lockoutDurationMs: number;
}

/**
 * Failed auth attempt tracker
 */
interface FailedAttemptTracker {
  count: number;
  lastAttempt: number;
  lockedUntil: number;
}

/**
 * Get MCP auth configuration from environment
 */
function getAuthConfig(): MCPAuthConfig {
  return {
    enabled: process.env.NLMCP_AUTH_ENABLED === "true",
    token: process.env.NLMCP_AUTH_TOKEN,
    tokenFile: process.env.NLMCP_AUTH_TOKEN_FILE ||
      path.join(CONFIG.configDir, "auth-token.hash"),
    maxFailedAttempts: parseInt(process.env.NLMCP_AUTH_MAX_FAILED || "5", 10),
    lockoutDurationMs: parseInt(process.env.NLMCP_AUTH_LOCKOUT_MS || "300000", 10), // 5 min
  };
}

/**
 * MCP Authenticator Class
 *
 * Handles token-based authentication for MCP requests.
 */
export class MCPAuthenticator {
  private config: MCPAuthConfig;
  private tokenHash: string | null = null;
  private failedAttempts: Map<string, FailedAttemptTracker> = new Map();
  private initialized: boolean = false;

  constructor(config?: Partial<MCPAuthConfig>) {
    this.config = { ...getAuthConfig(), ...config };
  }

  /**
   * Initialize the authenticator
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.config.enabled) {
      log.info("🔓 MCP authentication is disabled");
      this.initialized = true;
      return;
    }

    log.info("🔐 Initializing MCP authentication...");

    // Try to load token from environment
    if (this.config.token) {
      this.tokenHash = this.hashToken(this.config.token);
      log.success("  ✅ Using token from environment variable");
      this.initialized = true;
      return;
    }

    // Try to load token hash from file
    if (fs.existsSync(this.config.tokenFile)) {
      try {
        const content = fs.readFileSync(this.config.tokenFile, "utf-8").trim();
        if (content.length === 64) { // SHA256 hash length
          this.tokenHash = content;
          log.success("  ✅ Loaded token hash from file");
          this.initialized = true;
          return;
        }
      } catch (error) {
        log.warning(`  ⚠️  Failed to load token file: ${error}`);
      }
    }

    // Generate new token
    const newToken = this.generateToken();
    this.tokenHash = this.hashToken(newToken);
    await this.saveTokenHash();

    log.success("  ✅ Generated new authentication token");
    log.info("");
    log.info("  ╔════════════════════════════════════════════════════════════╗");
    log.info("  ║  NEW MCP AUTHENTICATION TOKEN GENERATED                     ║");
    log.info("  ╠════════════════════════════════════════════════════════════╣");
    log.info(`  ║  Token: ${newToken}  ║`);
    log.info("  ╠════════════════════════════════════════════════════════════╣");
    log.info("  ║  Add to your MCP client config:                            ║");
    log.info("  ║    NLMCP_AUTH_TOKEN=<token>                                ║");
    log.info("  ║                                                            ║");
    log.info("  ║  Or for Claude Code:                                       ║");
    log.info("  ║    claude mcp add notebooklm \\                             ║");
    log.info("  ║      --env NLMCP_AUTH_TOKEN=<token> \\                      ║");
    log.info("  ║      npx notebooklm-mcp-secure                             ║");
    log.info("  ╚════════════════════════════════════════════════════════════╝");
    log.info("");

    await audit.auth("token_generated", true, {
      token_file: this.config.tokenFile,
    });

    this.initialized = true;
  }

  /**
   * Generate a secure random token
   */
  generateToken(): string {
    return crypto.randomBytes(24).toString("base64url");
  }

  /**
   * Hash a token using SHA256
   */
  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Save token hash to file
   */
  private async saveTokenHash(): Promise<void> {
    if (!this.tokenHash) return;

    const dir = path.dirname(this.config.tokenFile);
    mkdirSecure(dir, PERMISSION_MODES.OWNER_FULL);

    writeFileSecure(
      this.config.tokenFile,
      this.tokenHash,
      PERMISSION_MODES.OWNER_READ_WRITE
    );
  }

  /**
   * Check if authentication is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check if a client identifier is locked out
   */
  private isLockedOut(clientId: string): boolean {
    const tracker = this.failedAttempts.get(clientId);
    if (!tracker) return false;

    if (tracker.lockedUntil > Date.now()) {
      return true;
    }

    // Reset if lockout expired
    if (tracker.lockedUntil > 0 && tracker.lockedUntil <= Date.now()) {
      this.failedAttempts.delete(clientId);
    }

    return false;
  }

  /**
   * Record a failed authentication attempt
   */
  private recordFailedAttempt(clientId: string): void {
    const now = Date.now();
    const tracker = this.failedAttempts.get(clientId) || {
      count: 0,
      lastAttempt: 0,
      lockedUntil: 0,
    };

    tracker.count++;
    tracker.lastAttempt = now;

    if (tracker.count >= this.config.maxFailedAttempts) {
      tracker.lockedUntil = now + this.config.lockoutDurationMs;
      log.warning(`🔒 Client ${clientId} locked out for ${this.config.lockoutDurationMs / 1000}s`);

      audit.security("auth_lockout", "warning", {
        client_id: clientId,
        failed_attempts: tracker.count,
        lockout_until: new Date(tracker.lockedUntil).toISOString(),
      });
    }

    this.failedAttempts.set(clientId, tracker);
  }

  /**
   * Clear failed attempts for a client (after successful auth)
   */
  private clearFailedAttempts(clientId: string): void {
    this.failedAttempts.delete(clientId);
  }

  /**
   * Validate a token
   *
   * @param token - Token to validate
   * @param clientId - Client identifier for rate limiting (default: "unknown")
   * @returns true if valid, false if invalid
   */
  async validateToken(token: string | undefined, clientId: string = "unknown"): Promise<boolean> {
    // If auth is disabled, always return true
    if (!this.config.enabled) {
      return true;
    }

    // Ensure initialized
    if (!this.initialized) {
      await this.initialize();
    }

    // Check lockout
    if (this.isLockedOut(clientId)) {
      log.warning(`🔒 Auth attempt from locked-out client: ${clientId}`);
      await audit.security("auth_attempt_during_lockout", "warning", {
        client_id: clientId,
      });
      return false;
    }

    // Validate token
    if (!token) {
      log.warning(`🔒 Auth failed: No token provided (client: ${clientId})`);
      this.recordFailedAttempt(clientId);
      await audit.auth("auth_failed", false, {
        client_id: clientId,
        reason: "no_token",
      });
      return false;
    }

    const providedHash = this.hashToken(token);
    const valid = secureCompare(providedHash, this.tokenHash ?? "");

    if (valid) {
      this.clearFailedAttempts(clientId);
      await audit.auth("auth_success", true, {
        client_id: clientId,
      });
      return true;
    } else {
      log.warning(`🔒 Auth failed: Invalid token (client: ${clientId})`);
      this.recordFailedAttempt(clientId);
      await audit.auth("auth_failed", false, {
        client_id: clientId,
        reason: "invalid_token",
      });
      return false;
    }
  }

  /**
   * Get authentication status for health check
   */
  getStatus(): {
    enabled: boolean;
    hasToken: boolean;
    lockedClients: number;
  } {
    return {
      enabled: this.config.enabled,
      hasToken: this.tokenHash !== null,
      lockedClients: Array.from(this.failedAttempts.values())
        .filter(t => t.lockedUntil > Date.now()).length,
    };
  }

  /**
   * Rotate the authentication token
   */
  async rotateToken(): Promise<string> {
    const newToken = this.generateToken();
    this.tokenHash = this.hashToken(newToken);
    await this.saveTokenHash();

    log.info("🔄 Authentication token rotated");
    await audit.auth("token_rotated", true);

    return newToken;
  }
}

/**
 * Global authenticator instance
 */
let globalAuthenticator: MCPAuthenticator | null = null;

/**
 * Get or create the global authenticator
 */
export function getMCPAuthenticator(): MCPAuthenticator {
  if (!globalAuthenticator) {
    globalAuthenticator = new MCPAuthenticator();
  }
  return globalAuthenticator;
}

/**
 * Middleware function for MCP request authentication
 */
export async function authenticateMCPRequest(
  token: string | undefined,
  clientId?: string
): Promise<{ authenticated: boolean; error?: string }> {
  const auth = getMCPAuthenticator();

  if (!auth.isEnabled()) {
    return { authenticated: true };
  }

  const valid = await auth.validateToken(token, clientId);

  if (!valid) {
    return {
      authenticated: false,
      error: "Authentication required. Set NLMCP_AUTH_TOKEN environment variable.",
    };
  }

  return { authenticated: true };
}
