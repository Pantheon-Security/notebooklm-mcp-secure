/**
 * Auth domain handlers — setup_auth & re_auth
 */

import type { HandlerContext } from "./types.js";
import type { BrowserOptions } from "../../notebook-creation/browser-options.js";
import type { ToolResult, ProgressCallback } from "../../types.js";
import { log } from "../../utils/logger.js";
import { audit } from "../../utils/audit-logger.js";
import {
  getErrorAuditArgs,
  getSanitizedErrorMessage,
} from "./error-utils.js";

type AuthToolName = "setup_auth" | "re_auth";

interface AuthHandlerArgs {
  show_browser?: boolean;
  browser_options?: BrowserOptions;
}

export interface AuthResult {
  status: string;
  message: string;
  authenticated: boolean;
  duration_seconds?: number;
}

interface AuthModeConfig {
  toolName: AuthToolName;
  totalSteps: number;
  initialProgress: string;
  preparingProgress: string;
  successProgress: string;
  failureMessage: string;
  headlessError: string;
  successMessage: string;
  clearExisting: boolean;
}

const AUTH_MODES: Record<AuthToolName, AuthModeConfig> = {
  setup_auth: {
    toolName: "setup_auth",
    totalSteps: 10,
    initialProgress: "Initializing authentication setup...",
    preparingProgress: "Preparing authentication browser...",
    successProgress: "Authentication saved successfully!",
    failureMessage: "Authentication failed or was cancelled",
    headlessError:
      "setup_auth requires show_browser:true. Calling it without a visible browser wipes your saved credentials then fails to restore them. Run the auth-now.mjs script instead, or pass show_browser:true.",
    successMessage: "Successfully authenticated and saved browser state",
    clearExisting: false,
  },
  re_auth: {
    toolName: "re_auth",
    totalSteps: 12,
    initialProgress: "Preparing re-authentication...",
    preparingProgress: "Starting fresh authentication...",
    successProgress: "Re-authentication complete!",
    failureMessage: "Re-authentication failed or was cancelled",
    headlessError:
      "re_auth requires show_browser:true. Google login is interactive and cannot complete in headless mode. Calling re_auth headlessly wipes your saved credentials then fails to restore them, destroying auth for all concurrent sessions. Pass show_browser:true.",
    successMessage:
      "Successfully re-authenticated with new account. All previous sessions have been closed.",
    clearExisting: true,
  },
};

async function authenticate(
  ctx: HandlerContext,
  args: AuthHandlerArgs,
  mode: AuthToolName,
  sendProgress?: ProgressCallback
): Promise<ToolResult<AuthResult>> {
  const config = AUTH_MODES[mode];
  const { show_browser } = args;

  await sendProgress?.(config.initialProgress, 0, config.totalSteps);
  log.info(`🔧 [TOOL] ${config.toolName} called`);
  if (show_browser !== undefined) {
    log.info(`  Show browser: ${show_browser}`);
  }

  // Google login is interactive. Refuse headless operation before clearing
  // any credentials, otherwise a failed headless login would break all sessions.
  if (!show_browser) {
    log.error(`❌ ${config.toolName} requires show_browser:true — cannot login interactively in headless mode`);
    return {
      success: false,
      data: mode === "setup_auth"
        ? { status: "error", message: "setup_auth requires show_browser:true", authenticated: false }
        : null,
      error: config.headlessError,
    };
  }

  const startTime = Date.now();

  try {
    if (config.clearExisting) {
      await sendProgress?.("Closing all active sessions...", 1, config.totalSteps);
      log.info("  🛑 Closing all sessions...");
      await ctx.sessionManager.closeAllSessions();
      log.success("  ✅ All sessions closed");

      await sendProgress?.("Clearing authentication data...", 2, config.totalSteps);
      log.info("  🗑️  Clearing all auth data...");
      await ctx.authManager.clearAllAuthData();
      log.success("  ✅ Auth data cleared");
    }

    await sendProgress?.(config.preparingProgress, config.clearExisting ? 3 : 1, config.totalSteps);
    log.info("  🌐 Opening browser for interactive login...");
    await sendProgress?.("Opening browser window...", config.clearExisting ? 4 : 2, config.totalSteps);

    const success = await ctx.authManager.performSetup(sendProgress, show_browser);
    const durationSeconds = (Date.now() - startTime) / 1000;

    if (success) {
      await sendProgress?.(config.successProgress, config.totalSteps, config.totalSteps);
      log.success(`✅ [TOOL] ${config.toolName} completed (${durationSeconds.toFixed(1)}s)`);
      await audit.auth(config.toolName, true, { duration_seconds: durationSeconds });
      await audit.tool(config.toolName, {}, true, Date.now() - startTime);

      return {
        success: true,
        data: {
          status: "authenticated",
          message: config.successMessage,
          authenticated: true,
          duration_seconds: durationSeconds,
        },
      };
    }

    log.error(`❌ [TOOL] ${config.toolName} failed (${durationSeconds.toFixed(1)}s)`);
    await audit.auth(config.toolName, false, { reason: "cancelled_or_failed" });
    await audit.tool(
      config.toolName,
      getErrorAuditArgs(config.toolName, config.failureMessage),
      false,
      Date.now() - startTime,
      config.failureMessage
    );

    return {
      success: false,
      data: null,
      error: config.failureMessage,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    const durationSeconds = (Date.now() - startTime) / 1000;
    log.error(`❌ [TOOL] ${config.toolName} failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);
    await audit.auth(config.toolName, false, { error: errorMessage });
    await audit.tool(
      config.toolName,
      getErrorAuditArgs(config.toolName, errorMessage),
      false,
      Date.now() - startTime,
      errorMessage
    );

    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle setup_auth tool
 *
 * Opens a browser window for manual login with live progress updates.
 * The operation waits synchronously for login completion (up to 10 minutes).
 */
export async function handleSetupAuth(
  ctx: HandlerContext,
  args: AuthHandlerArgs,
  sendProgress?: ProgressCallback
): Promise<ToolResult<AuthResult>> {
  return authenticate(ctx, args, "setup_auth", sendProgress);
}

/**
 * Handle re_auth tool
 *
 * Performs a complete re-authentication:
 * 1. Closes all active browser sessions
 * 2. Deletes all saved authentication data (cookies, Chrome profile)
 * 3. Opens browser for fresh Google login
 *
 * Use for switching Google accounts or recovering from rate limits.
 */
export async function handleReAuth(
  ctx: HandlerContext,
  args: AuthHandlerArgs,
  sendProgress?: ProgressCallback
): Promise<ToolResult<AuthResult>> {
  return authenticate(ctx, args, "re_auth", sendProgress);
}
