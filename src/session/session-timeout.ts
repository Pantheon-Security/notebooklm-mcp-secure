/**
 * Session Timeout Manager for NotebookLM MCP Server
 *
 * Provides configurable session timeout enforcement:
 * - Hard timeout: Maximum session lifetime (default: 8 hours)
 * - Inactivity timeout: Auto-logout after idle period (default: 30 minutes)
 * - Warning callbacks before timeout
 * - Memory scrubbing on timeout
 *
 * Added by Pantheon Security for hardened fork.
 */

import { audit } from "../utils/audit-logger.js";
import { log } from "../utils/logger.js";

/**
 * Session timeout configuration
 */
export interface SessionTimeoutConfig {
  /** Maximum session lifetime in milliseconds (default: 8 hours) */
  maxLifetimeMs: number;
  /** Inactivity timeout in milliseconds (default: 30 minutes) */
  inactivityTimeoutMs: number;
  /** Warning before timeout in milliseconds (default: 5 minutes) */
  warningBeforeMs: number;
  /** Enable hard timeout (default: true) */
  enableHardTimeout: boolean;
  /** Enable inactivity timeout (default: true) */
  enableInactivityTimeout: boolean;
}

/**
 * Session timeout state
 */
interface SessionTimeoutState {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  warningIssued: boolean;
  inactivityWarningIssued: boolean;
}

/**
 * Timeout callback type
 */
export type TimeoutCallback = (sessionId: string, reason: "lifetime" | "inactivity") => Promise<void>;

/**
 * Warning callback type
 */
export type WarningCallback = (sessionId: string, reason: "lifetime" | "inactivity", remainingMs: number) => void;

/**
 * Get timeout configuration from environment
 */
function getDefaultConfig(): SessionTimeoutConfig {
  const maxLifetimeSec = parseInt(process.env.NLMCP_SESSION_MAX_LIFETIME || "28800", 10); // 8 hours
  const inactivitySec = parseInt(process.env.NLMCP_SESSION_INACTIVITY_TIMEOUT || "1800", 10); // 30 minutes
  const warningBeforeSec = parseInt(process.env.NLMCP_SESSION_WARNING_BEFORE || "300", 10); // 5 minutes

  return {
    maxLifetimeMs: maxLifetimeSec * 1000,
    inactivityTimeoutMs: inactivitySec * 1000,
    warningBeforeMs: warningBeforeSec * 1000,
    enableHardTimeout: process.env.NLMCP_SESSION_HARD_TIMEOUT !== "false",
    enableInactivityTimeout: process.env.NLMCP_SESSION_INACTIVITY !== "false",
  };
}

/**
 * Session Timeout Manager
 *
 * Manages session timeouts with configurable lifetime and inactivity limits.
 */
export class SessionTimeoutManager {
  private config: SessionTimeoutConfig;
  private sessions: Map<string, SessionTimeoutState> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private onTimeout: TimeoutCallback | null = null;
  private onWarning: WarningCallback | null = null;

  constructor(config?: Partial<SessionTimeoutConfig>) {
    this.config = { ...getDefaultConfig(), ...config };

    // Start periodic check
    this.startPeriodicCheck();

    log.info(`🕐 Session timeout manager initialized`);
    log.info(`   Max lifetime: ${this.formatDuration(this.config.maxLifetimeMs)}`);
    log.info(`   Inactivity timeout: ${this.formatDuration(this.config.inactivityTimeoutMs)}`);
  }

  /**
   * Format duration for logging
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Register a new session
   */
  startSession(sessionId: string): void {
    const now = Date.now();
    this.sessions.set(sessionId, {
      sessionId,
      createdAt: now,
      lastActivity: now,
      warningIssued: false,
      inactivityWarningIssued: false,
    });

    log.info(`🕐 Session ${sessionId} registered with timeout manager`);

    audit.session("session_timeout_started", sessionId, {
      max_lifetime_ms: this.config.maxLifetimeMs,
      inactivity_timeout_ms: this.config.inactivityTimeoutMs,
    });
  }

  /**
   * Update session activity (reset inactivity timer)
   */
  touchSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.lastActivity = Date.now();
      state.inactivityWarningIssued = false; // Reset warning after activity
    }
  }

  /**
   * Remove a session from tracking
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.info(`🕐 Session ${sessionId} removed from timeout manager`);
  }

  /**
   * Check if a session has expired
   */
  isExpired(sessionId: string): { expired: boolean; reason?: "lifetime" | "inactivity" } {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return { expired: false };
    }

    const now = Date.now();

    // Check hard timeout (max lifetime)
    if (this.config.enableHardTimeout) {
      const age = now - state.createdAt;
      if (age >= this.config.maxLifetimeMs) {
        return { expired: true, reason: "lifetime" };
      }
    }

    // Check inactivity timeout
    if (this.config.enableInactivityTimeout) {
      const inactive = now - state.lastActivity;
      if (inactive >= this.config.inactivityTimeoutMs) {
        return { expired: true, reason: "inactivity" };
      }
    }

    return { expired: false };
  }

  /**
   * Get time remaining for a session
   */
  getTimeRemaining(sessionId: string): { lifetime: number; inactivity: number } | null {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return null;
    }

    const now = Date.now();

    const lifetimeRemaining = this.config.enableHardTimeout
      ? Math.max(0, this.config.maxLifetimeMs - (now - state.createdAt))
      : Infinity;

    const inactivityRemaining = this.config.enableInactivityTimeout
      ? Math.max(0, this.config.inactivityTimeoutMs - (now - state.lastActivity))
      : Infinity;

    return {
      lifetime: lifetimeRemaining,
      inactivity: inactivityRemaining,
    };
  }

  /**
   * Get session info for all tracked sessions
   */
  getAllSessionsInfo(): Array<{
    sessionId: string;
    createdAt: number;
    lastActivity: number;
    ageMs: number;
    inactiveMs: number;
    lifetimeRemainingMs: number;
    inactivityRemainingMs: number;
  }> {
    const now = Date.now();
    const results: Array<{
      sessionId: string;
      createdAt: number;
      lastActivity: number;
      ageMs: number;
      inactiveMs: number;
      lifetimeRemainingMs: number;
      inactivityRemainingMs: number;
    }> = [];

    for (const state of this.sessions.values()) {
      const remaining = this.getTimeRemaining(state.sessionId);
      results.push({
        sessionId: state.sessionId,
        createdAt: state.createdAt,
        lastActivity: state.lastActivity,
        ageMs: now - state.createdAt,
        inactiveMs: now - state.lastActivity,
        lifetimeRemainingMs: remaining?.lifetime ?? 0,
        inactivityRemainingMs: remaining?.inactivity ?? 0,
      });
    }

    return results;
  }

  /**
   * Set callback for when a session times out
   */
  setTimeoutCallback(callback: TimeoutCallback): void {
    this.onTimeout = callback;
  }

  /**
   * Set callback for timeout warnings
   */
  setWarningCallback(callback: WarningCallback): void {
    this.onWarning = callback;
  }

  /**
   * Start periodic timeout check
   */
  private startPeriodicCheck(): void {
    // Check every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkAllSessions();
    }, 30000);

    // Don't prevent process exit
    this.checkInterval.unref();
  }

  /**
   * Check all sessions for expiry and warnings
   */
  private async checkAllSessions(): Promise<void> {
    const now = Date.now();

    for (const state of this.sessions.values()) {
      // Check for expiry
      const expiry = this.isExpired(state.sessionId);
      if (expiry.expired && expiry.reason) {
        log.warning(`🕐 Session ${state.sessionId} expired due to ${expiry.reason}`);

        await audit.session("session_timeout_expired", state.sessionId, {
          reason: expiry.reason,
          age_ms: now - state.createdAt,
          inactive_ms: now - state.lastActivity,
        });

        if (this.onTimeout) {
          await this.onTimeout(state.sessionId, expiry.reason);
        }

        this.sessions.delete(state.sessionId);
        continue;
      }

      // Check for warnings
      const remaining = this.getTimeRemaining(state.sessionId);
      if (!remaining) continue;

      // Lifetime warning
      if (
        this.config.enableHardTimeout &&
        !state.warningIssued &&
        remaining.lifetime <= this.config.warningBeforeMs
      ) {
        state.warningIssued = true;
        log.warning(
          `🕐 Session ${state.sessionId} will expire in ${this.formatDuration(remaining.lifetime)} (max lifetime)`
        );

        if (this.onWarning) {
          this.onWarning(state.sessionId, "lifetime", remaining.lifetime);
        }

        await audit.session("session_timeout_warning", state.sessionId, {
          reason: "lifetime",
          remaining_ms: remaining.lifetime,
        });
      }

      // Inactivity warning
      if (
        this.config.enableInactivityTimeout &&
        !state.inactivityWarningIssued &&
        remaining.inactivity <= this.config.warningBeforeMs
      ) {
        state.inactivityWarningIssued = true;
        log.warning(
          `🕐 Session ${state.sessionId} will expire in ${this.formatDuration(remaining.inactivity)} (inactivity)`
        );

        if (this.onWarning) {
          this.onWarning(state.sessionId, "inactivity", remaining.inactivity);
        }

        await audit.session("session_timeout_warning", state.sessionId, {
          reason: "inactivity",
          remaining_ms: remaining.inactivity,
        });
      }
    }
  }

  /**
   * Stop the timeout manager
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.sessions.clear();
    log.info(`🕐 Session timeout manager stopped`);
  }

  /**
   * Get configuration
   */
  getConfig(): SessionTimeoutConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SessionTimeoutConfig>): void {
    this.config = { ...this.config, ...config };
    log.info(`🕐 Session timeout config updated`);
  }
}

/**
 * Global timeout manager instance
 */
let globalTimeoutManager: SessionTimeoutManager | null = null;

/**
 * Get or create the global timeout manager
 */
export function getSessionTimeoutManager(): SessionTimeoutManager {
  if (!globalTimeoutManager) {
    globalTimeoutManager = new SessionTimeoutManager();
  }
  return globalTimeoutManager;
}
