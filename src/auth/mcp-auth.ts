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
import { CONFIG, parseBoolean, parseInteger } from "../config.js";
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
  /** Enable authentication (default: true — secure by default) */
  enabled: boolean;
  /** Token from environment or file */
  token?: string;
  /** Path to token file */
  tokenFile: string;
  /** Max failed auth attempts before lockout */
  maxFailedAttempts: number;
  /** Lockout duration in milliseconds (initial — escalates with exponential backoff) */
  lockoutDurationMs: number;
}

/** Maximum lockout duration: 4 hours */
const MAX_LOCKOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Failed auth attempt tracker
 */
interface FailedAttemptTracker {
  count: number;
  lastAttempt: number;
  lockedUntil: number;
  /** Number of times lockout has been triggered (for exponential backoff) */
  lockoutCount: number;
}

/**
 * Get MCP auth configuration from environment
 *
 * Auth is enabled by default (secure-by-default). To explicitly disable,
 * set NLMCP_AUTH_DISABLED=true. The legacy NLMCP_AUTH_ENABLED=true is
 * still honored for backwards compatibility.
 */
function getAuthConfig(): MCPAuthConfig {
  // Secure-by-default: auth is ON unless explicitly disabled
  const explicitlyDisabled = parseBoolean(process.env.NLMCP_AUTH_DISABLED, false);
  const legacyEnabled = parseBoolean(process.env.NLMCP_AUTH_ENABLED, false);

  // If legacy env var is set to "true", respect that. Otherwise, default ON unless disabled.
  const enabled = legacyEnabled || !explicitlyDisabled;

  if (explicitlyDisabled && !legacyEnabled) {
    log.warning("⚠️  MCP authentication explicitly disabled via NLMCP_AUTH_DISABLED=true");
    log.warning("   This is NOT recommended for production use.");
  } else if (explicitlyDisabled && legacyEnabled) {
    log.warning("⚠️  Both NLMCP_AUTH_DISABLED and NLMCP_AUTH_ENABLED are set. Auth stays ENABLED (NLMCP_AUTH_ENABLED takes precedence).");
  }

  return {
    enabled,
    token: process.env.NLMCP_AUTH_TOKEN,
    tokenFile: process.env.NLMCP_AUTH_TOKEN_FILE ||
      path.join(CONFIG.configDir, "auth-token.hash"),
    maxFailedAttempts: parseInteger(process.env.NLMCP_AUTH_MAX_FAILED, 5),
    lockoutDurationMs: parseInteger(process.env.NLMCP_AUTH_LOCKOUT_MS, 300000), // 5 min
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

    // Try to load token from environment — blank env var after reading (I236)
    if (this.config.token) {
      this.tokenHash = this.hashToken(this.config.token);
      this.config.token = undefined;
      delete process.env.NLMCP_AUTH_TOKEN;
      log.success("  ✅ Using token from environment variable");
      this.initialized = true;
      return;
    }

    // Try to load token hash from file
    if (fs.existsSync(this.config.tokenFile)) {
      try {
        const content = fs.readFileSync(this.config.tokenFile, "utf-8").trim();
        if (content.length === 64 && /^[0-9a-f]{64}$/i.test(content)) { // SHA3-256 hex
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
    this.printTokenInstructions(newToken);

    await audit.auth("token_generated", true, {
      token_file: this.config.tokenFile,
    });

    this.initialized = true;
  }

  /**
   * Print token setup instructions to stderr
   */
  private printTokenInstructions(token: string): void {
    log.info("");
    log.info("  ╔══════════════════════════════════════════════════════════════════════╗");
    log.info("  ║  MCP AUTHENTICATION TOKEN                                           ║");
    log.info("  ╠══════════════════════════════════════════════════════════════════════╣");
    log.info(`  ║  Token: ${token.padEnd(58)}║`);
    log.info("  ╠══════════════════════════════════════════════════════════════════════╣");
    log.info("  ║  Add to your MCP client config:                                     ║");
    log.info(`  ║    NLMCP_AUTH_TOKEN=${token.padEnd(47)}║`);
    log.info("  ║                                                                      ║");
    log.info("  ║  Or for Claude Code:                                                 ║");
    log.info(`  ║    claude mcp add notebooklm \\${" ".repeat(37)}║`);
    log.info(`  ║      --env NLMCP_AUTH_TOKEN=${token} \\${" ".repeat(Math.max(0, 36 - token.length))}║`);
    log.info(`  ║      npx notebooklm-mcp-secure${" ".repeat(37)}║`);
    log.info("  ║                                                                      ║");
    log.info("  ║  Lost your token? Run: npx notebooklm-mcp token show                ║");
    log.info("  ║  Rotate token:         npx notebooklm-mcp token rotate               ║");
    log.info("  ╚══════════════════════════════════════════════════════════════════════╝");
    log.info("");
  }

  /**
   * Generate a secure random token
   */
  generateToken(): string {
    return crypto.randomBytes(24).toString("base64url");
  }

  /**
   * Hash a token using SHA3-256 (quantum-resistant).
   * NOTE: changing this algorithm invalidates all stored token hashes — users
   * must re-run setup_auth or rotate their token after upgrading.
   */
  hashToken(token: string): string {
    return crypto.createHash("sha3-256").update(token).digest("hex");
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
    // "unknown" clients all share one bucket — don't lock out or we DoS legit tools
    // that haven't configured a clientId.
    if (clientId === "unknown") return false;

    const tracker = this.failedAttempts.get(clientId);
    if (!tracker) return false;

    if (tracker.lockedUntil > Date.now()) {
      return true;
    }

    // Lockout expired — reset fully so legitimate users don't get permanently escalated
    if (tracker.lockedUntil > 0 && tracker.lockedUntil <= Date.now()) {
      tracker.count = 0;
      tracker.lockedUntil = 0;
      tracker.lockoutCount = 0;
    }

    return false;
  }

  /**
   * Record a failed authentication attempt
   *
   * Uses exponential backoff for lockout duration:
   * 1st lockout: 5min, 2nd: 15min, 3rd: 45min, 4th+: 4hr (capped)
   */
  private recordFailedAttempt(clientId: string): void {
    // Skip tracking for the shared "unknown" bucket — DoS vector
    if (clientId === "unknown") return;

    const now = Date.now();

    // Cap map size to prevent memory DoS: evict oldest entry when full
    if (!this.failedAttempts.has(clientId) && this.failedAttempts.size >= 10_000) {
      const oldest = this.failedAttempts.keys().next().value;
      if (oldest !== undefined) this.failedAttempts.delete(oldest);
    }

    const tracker = this.failedAttempts.get(clientId) || {
      count: 0,
      lastAttempt: 0,
      lockedUntil: 0,
      lockoutCount: 0,
    };

    tracker.count++;
    tracker.lastAttempt = now;

    if (tracker.count >= this.config.maxFailedAttempts) {
      tracker.lockoutCount++;
      // Exponential backoff: base * 3^(lockoutCount-1), capped at MAX_LOCKOUT_MS
      const backoffMs = Math.min(
        this.config.lockoutDurationMs * Math.pow(3, tracker.lockoutCount - 1),
        MAX_LOCKOUT_MS
      );
      tracker.lockedUntil = now + backoffMs;
      log.warning(`🔒 Client ${clientId} locked out for ${Math.round(backoffMs / 1000)}s (lockout #${tracker.lockoutCount})`);

      audit.security("auth_lockout", "warning", {
        client_id: clientId,
        failed_attempts: tracker.count,
        lockout_count: tracker.lockoutCount,
        lockout_duration_ms: backoffMs,
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
   * @param forceValidation - If true, validate even when auth is globally disabled (for sensitive tools)
   * @returns true if valid, false if invalid
   */
  async validateToken(token: string | undefined, clientId: string = "unknown", forceValidation: boolean = false): Promise<boolean> {
    // If auth is disabled and not forced, always return true
    if (!this.config.enabled && !forceValidation) {
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

    if (!this.tokenHash) {
      log.warning(`🔒 Auth failed: No token configured (client: ${clientId})`);
      return false;
    }

    const providedHash = this.hashToken(token);
    const valid = secureCompare(providedHash, this.tokenHash);

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
   * Rotate the authentication token.
   *
   * Records a ChangeLog entry for SOC2 change-management audit trail.
   * The token itself is never logged; only "[rotated]" markers appear
   * in the change record.
   */
  async rotateToken(): Promise<string> {
    const newToken = this.generateToken();
    this.tokenHash = this.hashToken(newToken);
    await this.saveTokenHash();

    log.info("🔄 Authentication token rotated");
    await audit.auth("token_rotated", true);

    try {
      const { getChangeLog } = await import("../compliance/change-log.js");
      await getChangeLog().recordChange("auth", "mcp_token", "[rotated]", "[rotated]", {
        changedBy: "admin",
        method: "cli",
        impact: "high",
        affectedCompliance: ["SOC2"],
      });
    } catch (err) {
      log.warning(`ChangeLog recordChange failed (auth.mcp_token): ${err instanceof Error ? err.message : String(err)}`);
    }

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
 *
 * @param token - The auth token to validate
 * @param clientId - Client identifier for rate limiting
 * @param forceAuth - If true, require auth even when globally disabled (for sensitive tools)
 */
export async function authenticateMCPRequest(
  token: string | undefined,
  clientId?: string,
  forceAuth?: boolean
): Promise<{ authenticated: boolean; error?: string }> {
  const auth = getMCPAuthenticator();

  if (!auth.isEnabled() && !forceAuth) {
    return { authenticated: true };
  }

  // For forced-auth tools when auth is globally disabled, we still need to validate
  if (forceAuth && !auth.isEnabled()) {
    if (!token) {
      return {
        authenticated: false,
        error: `This tool requires authentication. Set NLMCP_AUTH_TOKEN environment variable.`,
      };
    }
  }

  // Pass forceValidation=true so validateToken doesn't short-circuit when auth is disabled
  const valid = await auth.validateToken(token, clientId, !!forceAuth);

  if (!valid) {
    return {
      authenticated: false,
      error: "Authentication required. Set NLMCP_AUTH_TOKEN environment variable.",
    };
  }

  return { authenticated: true };
}

/**
 * CLI handler for `npx notebooklm-mcp token <subcommand>`
 *
 * Subcommands:
 *   show    — Generate a new token (or show instructions to retrieve the current one)
 *   rotate  — Rotate the token and display the new one
 *   (none)  — Print help
 */
export async function handleTokenCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const auth = getMCPAuthenticator();

  const tokenFilePath = path.join(CONFIG.configDir, "auth-token.hash");

  if (sub === "show") {
    // We can't recover the token from the hash — generate a new one
    const hasExisting = fs.existsSync(tokenFilePath);

    if (hasExisting) {
      console.log("");
      console.log("  A token hash already exists but the original token cannot be recovered.");
      console.log("  If you've lost your token, rotate it to generate a new one:");
      console.log("");
      console.log("    npx notebooklm-mcp token rotate");
      console.log("");
      console.log(`  Token hash file: ${tokenFilePath}`);
      console.log("");
    } else {
      // No token exists — initialize will auto-generate
      console.log("");
      console.log("  No token exists yet. Starting server will auto-generate one.");
      console.log("  Or run: npx notebooklm-mcp token rotate");
      console.log("");
    }
  } else if (sub === "rotate") {
    // Force initialize to load/create the authenticator
    await auth.initialize();
    const newToken = await auth.rotateToken();

    console.log("");
    console.log("  ╔══════════════════════════════════════════════════════════════════════╗");
    console.log("  ║  TOKEN ROTATED SUCCESSFULLY                                          ║");
    console.log("  ╠══════════════════════════════════════════════════════════════════════╣");
    console.log(`  ║  New Token: ${newToken.padEnd(55)}║`);
    console.log("  ╠══════════════════════════════════════════════════════════════════════╣");
    console.log("  ║  Update your MCP client config:                                      ║");
    console.log(`  ║    NLMCP_AUTH_TOKEN=${newToken.padEnd(47)}║`);
    console.log("  ║                                                                      ║");
    console.log("  ║  Any previous token is now invalid.                                   ║");
    console.log("  ╚══════════════════════════════════════════════════════════════════════╝");
    console.log("");
  } else {
    console.log(`
Usage: npx notebooklm-mcp token <command>

Commands:
  token show      Check token status (cannot recover existing token)
  token rotate    Generate a new token (invalidates the old one)

The authentication token is generated on first run and displayed once.
If you lose it, use 'token rotate' to create a new one.
    `);
  }
}
