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

/**
 * Handle setup_auth tool
 *
 * Opens a browser window for manual login with live progress updates.
 * The operation waits synchronously for login completion (up to 10 minutes).
 */
export async function handleSetupAuth(
  ctx: HandlerContext,
  args: {
    show_browser?: boolean;
    browser_options?: BrowserOptions;
  },
  sendProgress?: ProgressCallback
): Promise<
  ToolResult<{
    status: string;
    message: string;
    authenticated: boolean;
    duration_seconds?: number;
  }>
> {
  const { show_browser } = args;

  // CRITICAL: Send immediate progress to reset timeout from the very start
  await sendProgress?.("Initializing authentication setup...", 0, 10);

  log.info(`🔧 [TOOL] setup_auth called`);
  if (show_browser !== undefined) {
    log.info(`  Show browser: ${show_browser}`);
  }

  // Guard: setup_auth ALWAYS clears all saved credentials before re-logging in.
  // Calling it headlessly will wipe auth and then fail to restore it, leaving
  // all sessions permanently unauthenticated. Require show_browser:true.
  if (!show_browser) {
    log.error("❌ setup_auth requires show_browser:true — cannot login interactively in headless mode");
    return {
      success: false,
      data: null,
      authenticated: false,
      error: "setup_auth requires show_browser:true. " +
        "Calling it without a visible browser wipes your saved credentials then fails to restore them. " +
        "Run the auth-now.mjs script instead, or pass show_browser:true.",
    } as any;
  }

  const startTime = Date.now();

  try {
    // Progress: Starting
    await sendProgress?.("Preparing authentication browser...", 1, 10);

    log.info(`  🌐 Opening browser for interactive login...`);

    // Progress: Opening browser
    await sendProgress?.("Opening browser window...", 2, 10);

    // Perform setup with progress updates; pass show_browser so the caller
    // can force a visible browser even when HEADLESS=true is set in env
    const success = await ctx.authManager.performSetup(sendProgress, show_browser);

    const durationSeconds = (Date.now() - startTime) / 1000;

    if (success) {
      // Progress: Complete
      await sendProgress?.("Authentication saved successfully!", 10, 10);

      log.success(`✅ [TOOL] setup_auth completed (${durationSeconds.toFixed(1)}s)`);

      // Audit: successful authentication
      await audit.auth("setup_auth", true, { duration_seconds: durationSeconds });
      await audit.tool("setup_auth", {}, true, Date.now() - startTime);

      return {
        success: true,
        data: {
          status: "authenticated",
          message: "Successfully authenticated and saved browser state",
          authenticated: true,
          duration_seconds: durationSeconds,
        },
      };
    } else {
      log.error(`❌ [TOOL] setup_auth failed (${durationSeconds.toFixed(1)}s)`);

      // Audit: failed authentication
      await audit.auth("setup_auth", false, { reason: "cancelled_or_failed" });
      await audit.tool(
        "setup_auth",
        getErrorAuditArgs("setup_auth", "Authentication failed or was cancelled"),
        false,
        Date.now() - startTime,
        "Authentication failed or was cancelled"
      );

      return {
        success: false,
        data: null,
        error: "Authentication failed or was cancelled",
      };
    }
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    const durationSeconds = (Date.now() - startTime) / 1000;
    log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);

    // Audit: auth error
    await audit.auth("setup_auth", false, { error: errorMessage });
    await audit.tool(
      "setup_auth",
      getErrorAuditArgs("setup_auth", errorMessage),
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
  args: {
    show_browser?: boolean;
    browser_options?: BrowserOptions;
  },
  sendProgress?: ProgressCallback
): Promise<
  ToolResult<{
    status: string;
    message: string;
    authenticated: boolean;
    duration_seconds?: number;
  }>
> {
  const { show_browser } = args;

  await sendProgress?.("Preparing re-authentication...", 0, 12);
  log.info(`🔧 [TOOL] re_auth called`);
  if (show_browser !== undefined) {
    log.info(`  Show browser: ${show_browser}`);
  }

  // Guard: re_auth requires a visible browser — Google login is interactive.
  // Calling without show_browser:true would wipe saved credentials then fail,
  // leaving all sessions permanently unauthenticated.
  if (!show_browser) {
    log.error("❌ re_auth requires show_browser:true — cannot login interactively in headless mode");
    return {
      success: false,
      data: null,
      error: "re_auth requires show_browser:true. Google login is interactive and cannot complete " +
        "in headless mode. Calling re_auth headlessly wipes your saved credentials then fails to " +
        "restore them, destroying auth for all concurrent sessions. Pass show_browser:true.",
    };
  }

  const startTime = Date.now();

  try {
    // 1. Close all active sessions
    await sendProgress?.("Closing all active sessions...", 1, 12);
    log.info("  🛑 Closing all sessions...");
    await ctx.sessionManager.closeAllSessions();
    log.success("  ✅ All sessions closed");

    // 2. Clear all auth data
    await sendProgress?.("Clearing authentication data...", 2, 12);
    log.info("  🗑️  Clearing all auth data...");
    await ctx.authManager.clearAllAuthData();
    log.success("  ✅ Auth data cleared");

    // 3. Perform fresh setup
    await sendProgress?.("Starting fresh authentication...", 3, 12);
    log.info("  🌐 Starting fresh authentication setup...");
    const success = await ctx.authManager.performSetup(sendProgress);

    const durationSeconds = (Date.now() - startTime) / 1000;

    if (success) {
      await sendProgress?.("Re-authentication complete!", 12, 12);
      log.success(`✅ [TOOL] re_auth completed (${durationSeconds.toFixed(1)}s)`);

      // Audit: successful re-auth
      await audit.auth("re_auth", true, { duration_seconds: durationSeconds });
      await audit.tool("re_auth", {}, true, Date.now() - startTime);

      return {
        success: true,
        data: {
          status: "authenticated",
          message:
            "Successfully re-authenticated with new account. All previous sessions have been closed.",
          authenticated: true,
          duration_seconds: durationSeconds,
        },
      };
    } else {
      log.error(`❌ [TOOL] re_auth failed (${durationSeconds.toFixed(1)}s)`);

      // Audit: failed re-auth
      await audit.auth("re_auth", false, { reason: "cancelled_or_failed" });
      await audit.tool(
        "re_auth",
        getErrorAuditArgs("re_auth", "Re-authentication failed or was cancelled"),
        false,
        Date.now() - startTime,
        "Re-authentication failed or was cancelled"
      );

      return {
        success: false,
        data: null,
        error: "Re-authentication failed or was cancelled",
      };
    }
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    const durationSeconds = (Date.now() - startTime) / 1000;
    log.error(
      `❌ [TOOL] re_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`
    );

    // Audit: re-auth error
    await audit.auth("re_auth", false, { error: errorMessage });
    await audit.tool(
      "re_auth",
      getErrorAuditArgs("re_auth", errorMessage),
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
