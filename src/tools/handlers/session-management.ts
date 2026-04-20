/**
 * Session Management Handlers
 *
 * Handles list_sessions, close_session, reset_session, and get_health tools.
 */

import type { HandlerContext } from "./types.js";
import type { ToolResult } from "../../types.js";
import { CONFIG } from "../../config.js";
import { log } from "../../utils/logger.js";
import { getSanitizedErrorMessage } from "./error-utils.js";

/**
 * Handle list_sessions tool
 */
export async function handleListSessions(ctx: HandlerContext): Promise<
  ToolResult<{
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    oldest_session_seconds: number;
    total_messages: number;
    sessions: Array<{
      id: string;
      created_at: number;
      last_activity: number;
      age_seconds: number;
      inactive_seconds: number;
      message_count: number;
      notebook_url: string;
    }>;
  }>
> {
  log.info(`🔧 [TOOL] list_sessions called`);

  try {
    const stats = ctx.sessionManager.getStats();
    const sessions = ctx.sessionManager.getAllSessionsInfo();

    const result = {
      active_sessions: stats.active_sessions,
      max_sessions: stats.max_sessions,
      session_timeout: stats.session_timeout,
      oldest_session_seconds: stats.oldest_session_seconds,
      total_messages: stats.total_messages,
      sessions: sessions.map((info) => ({
        id: info.id,
        created_at: info.created_at,
        last_activity: info.last_activity,
        age_seconds: info.age_seconds,
        inactive_seconds: info.inactive_seconds,
        message_count: info.message_count,
        notebook_url: info.notebook_url,
      })),
    };

    log.success(
      `✅ [TOOL] list_sessions completed (${result.active_sessions} sessions)`
    );
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle close_session tool
 */
export async function handleCloseSession(
  ctx: HandlerContext,
  args: { session_id: string }
): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
  const { session_id } = args;

  log.info(`🔧 [TOOL] close_session called`);
  log.info(`  Session ID: ${session_id}`);

  try {
    const closed = await ctx.sessionManager.closeSession(session_id);

    if (closed) {
      log.success(`✅ [TOOL] close_session completed`);
      return {
        success: true,
        data: {
          status: "success",
          message: `Session ${session_id} closed successfully`,
          session_id,
        },
      };
    } else {
      log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
      return {
        success: false,
        data: null,
        error: `Session ${session_id} not found`,
      };
    }
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle reset_session tool
 */
export async function handleResetSession(
  ctx: HandlerContext,
  args: { session_id: string }
): Promise<ToolResult<{ status: string; message: string; session_id: string }>> {
  const { session_id } = args;

  log.info(`🔧 [TOOL] reset_session called`);
  log.info(`  Session ID: ${session_id}`);

  try {
    const session = ctx.sessionManager.getSession(session_id);

    if (!session) {
      log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
      return {
        success: false,
        data: null,
        error: `Session ${session_id} not found`,
      };
    }

    await session.reset();

    log.success(`✅ [TOOL] reset_session completed`);
    return {
      success: true,
      data: {
        status: "success",
        message: `Session ${session_id} reset successfully`,
        session_id,
      },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

/**
 * Handle get_health tool
 */
export async function handleGetHealth(
  ctx: HandlerContext,
  args?: {
    deep_check?: boolean;
    notebook_id?: string;
  }
): Promise<
  ToolResult<{
    status: string;
    authenticated: boolean;
    notebook_url: string;
    active_sessions: number;
    max_sessions: number;
    session_timeout: number;
    total_messages: number;
    headless: boolean;
    auto_login_enabled: boolean;
    stealth_enabled: boolean;
    chat_ui_accessible?: boolean;
    deep_check_notebook?: string;
    troubleshooting_tip?: string;
  }>
> {
  log.info(`🔧 [TOOL] get_health called${args?.deep_check ? ' (deep check)' : ''}`);

  try {
    // Check authentication status
    const statePath = await ctx.authManager.getValidStatePath();
    const authenticated = statePath !== null;

    // Get session stats
    const stats = ctx.sessionManager.getStats();

    // Deep check: actually verify the chat UI loads
    let chatUiAccessible: boolean | undefined;
    let deepCheckNotebook: string | undefined;

    if (args?.deep_check && authenticated) {
      log.info(`  🔍 Running deep check - verifying chat UI loads...`);

      try {
        // Find a notebook to test with
        let notebookUrl: string | undefined;

        if (args.notebook_id) {
          const notebook = ctx.library.getNotebook(args.notebook_id);
          if (notebook) {
            notebookUrl = notebook.url;
            deepCheckNotebook = notebook.name || args.notebook_id;
          }
        }

        if (!notebookUrl) {
          const activeNotebook = ctx.library.getActiveNotebook();
          if (activeNotebook) {
            notebookUrl = activeNotebook.url;
            deepCheckNotebook = activeNotebook.name || "active notebook";
          }
        }

        if (!notebookUrl) {
          // Try to get any notebook from library
          const notebooks = ctx.library.listNotebooks();
          if (notebooks.length > 0) {
            notebookUrl = notebooks[0].url;
            deepCheckNotebook = notebooks[0].name || "first notebook";
          }
        }

        if (notebookUrl) {
          // Create a temporary session to test
          const sessionId = `health-check-${Date.now()}`;
          const session = await ctx.sessionManager.getOrCreateSession(sessionId, notebookUrl);

          try {
            const page = session.getPage();
            if (page) {
              // Wait for page to load
              await page.waitForTimeout(3000);

              // Check for chat input element
              const chatInput = await page.$('textarea, [contenteditable="true"], .chat-input, .query-input, input[type="text"]');
              chatUiAccessible = chatInput !== null;

              if (!chatUiAccessible) {
                // Also check for common NotebookLM chat selectors
                const altSelectors = await page.$('.chat-container, .query-container, .message-input-container');
                chatUiAccessible = altSelectors !== null;
              }

              log.info(`  📊 Chat UI accessible: ${chatUiAccessible}`);
            } else {
              chatUiAccessible = false;
            }
          } finally {
            // Clean up the test session
            await ctx.sessionManager.closeSession(sessionId);
          }
        } else {
          log.warning(`  ⚠️ No notebook available for deep check`);
          deepCheckNotebook = "none available";
        }
      } catch (deepCheckError) {
        log.warning(`  ⚠️ Deep check failed: ${getSanitizedErrorMessage(deepCheckError)}`);
        chatUiAccessible = false;
      }
    }

    const result = {
      status: "ok",
      authenticated,
      notebook_url: CONFIG.notebookUrl || "not configured",
      active_sessions: stats.active_sessions,
      max_sessions: stats.max_sessions,
      session_timeout: stats.session_timeout,
      total_messages: stats.total_messages,
      headless: CONFIG.headless,
      auto_login_enabled: CONFIG.autoLoginEnabled,
      stealth_enabled: CONFIG.stealthEnabled,
      // Include deep check results if performed
      ...(args?.deep_check && {
        chat_ui_accessible: chatUiAccessible,
        deep_check_notebook: deepCheckNotebook,
      }),
      // Add troubleshooting tip if not authenticated or chat UI not accessible
      ...(((! authenticated) || (args?.deep_check && chatUiAccessible === false)) && {
        troubleshooting_tip: chatUiAccessible === false
          ? "Chat UI not accessible. Session may be stale. Run re_auth(show_browser:true) to refresh."
          : "Not authenticated. Run setup_auth(show_browser:true) to log in via a visible browser window. " +
            "Do NOT call cleanup_data — it does not help with auth and is not needed here."
      }),
    };

    log.success(`✅ [TOOL] get_health completed`);
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}
