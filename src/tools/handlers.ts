/**
 * MCP Tool Handlers
 *
 * Implements the logic for all MCP tools.
 */

import { SessionManager } from "../session/session-manager.js";
import { AuthManager } from "../auth/auth-manager.js";
import { NotebookLibrary } from "../library/notebook-library.js";
import type { AddNotebookInput, UpdateNotebookInput } from "../library/types.js";
import { CONFIG, applyBrowserOptions, type BrowserOptions } from "../config.js";
import { log } from "../utils/logger.js";
import type {
  AskQuestionResult,
  ToolResult,
  ProgressCallback,
} from "../types.js";
import { RateLimitError } from "../errors.js";
import {
  validateNotebookUrl,
  validateNotebookId,
  validateSessionId,
  validateQuestion,
  sanitizeForLogging,
  RateLimiter,
  SecurityError,
} from "../utils/security.js";
import { audit } from "../utils/audit-logger.js";
import { validateResponse } from "../utils/response-validator.js";
import { CleanupManager } from "../utils/cleanup-manager.js";

const FOLLOW_UP_REMINDER =
  "\n\nEXTREMELY IMPORTANT: Is that ALL you need to know? You can always ask another question using the same session ID! Think about it carefully: before you reply to the user, review their original request and this answer. If anything is still unclear or missing, ask me another question first.";

/**
 * MCP Tool Handlers
 */
export class ToolHandlers {
  private sessionManager: SessionManager;
  private authManager: AuthManager;
  private library: NotebookLibrary;
  private rateLimiter: RateLimiter;

  constructor(sessionManager: SessionManager, authManager: AuthManager, library: NotebookLibrary) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
    // Rate limit: 100 requests per minute per session (protective limit)
    this.rateLimiter = new RateLimiter(100, 60000);
  }

  /**
   * Handle ask_question tool
   */
  async handleAskQuestion(
    args: {
      question: string;
      session_id?: string;
      notebook_id?: string;
      notebook_url?: string;
      show_browser?: boolean;
      browser_options?: BrowserOptions;
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<AskQuestionResult>> {
    const { show_browser, browser_options } = args;
    const startTime = Date.now();

    log.info(`🔧 [TOOL] ask_question called`);

    // === SECURITY: Input validation ===
    let safeQuestion: string;
    let safeSessionId: string | undefined;
    let safeNotebookId: string | undefined;
    let safeNotebookUrl: string | undefined;

    try {
      // Validate question (required)
      safeQuestion = validateQuestion(args.question);
      log.info(`  Question: "${sanitizeForLogging(safeQuestion.substring(0, 100))}"...`);

      // Validate optional session_id
      if (args.session_id) {
        safeSessionId = validateSessionId(args.session_id);
        log.info(`  Session ID: ${safeSessionId}`);
      }

      // Validate optional notebook_id
      if (args.notebook_id) {
        safeNotebookId = validateNotebookId(args.notebook_id);
        log.info(`  Notebook ID: ${safeNotebookId}`);
      }

      // Validate optional notebook_url (CRITICAL - prevents URL injection)
      if (args.notebook_url) {
        safeNotebookUrl = validateNotebookUrl(args.notebook_url);
        log.info(`  Notebook URL: ${safeNotebookUrl}`);
      }

      // Rate limiting check
      const rateLimitKey = safeSessionId || 'global';
      if (!this.rateLimiter.isAllowed(rateLimitKey)) {
        log.warning(`🚫 Rate limit exceeded for ${rateLimitKey}`);
        await audit.security("rate_limit_exceeded", "warning", {
          session_id: rateLimitKey,
          remaining: this.rateLimiter.getRemaining(rateLimitKey),
        });
        await audit.tool("ask_question", args, false, Date.now() - startTime, "Rate limit exceeded");
        return {
          success: false,
          error: `Rate limit exceeded. Please wait before making more requests. Remaining: ${this.rateLimiter.getRemaining(rateLimitKey)}`,
        };
      }
    } catch (error) {
      if (error instanceof SecurityError) {
        log.error(`🛡️ [SECURITY] Validation failed: ${error.message}`);
        await audit.security("validation_failed", "error", {
          tool: "ask_question",
          error: error.message,
        });
        await audit.tool("ask_question", args, false, Date.now() - startTime, error.message);
        return {
          success: false,
          error: `Security validation failed: ${error.message}`,
        };
      }
      throw error;
    }

    try {
      // Resolve notebook URL (using validated values)
      let resolvedNotebookUrl = safeNotebookUrl;

      if (!resolvedNotebookUrl && safeNotebookId) {
        const notebook = this.library.incrementUseCount(safeNotebookId);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${safeNotebookId}`);
        }

        resolvedNotebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!resolvedNotebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          const notebook = this.library.incrementUseCount(active.id);
          if (!notebook) {
            throw new Error(`Active notebook not found: ${active.id}`);
          }
          resolvedNotebookUrl = notebook.url;
          log.info(`  Using active notebook: ${notebook.name}`);
        }
      }

      // Progress: Getting or creating session
      await sendProgress?.("Getting or creating browser session...", 1, 5);

      // Apply browser options temporarily
      const originalConfig = { ...CONFIG };
      const effectiveConfig = applyBrowserOptions(browser_options, show_browser);
      Object.assign(CONFIG, effectiveConfig);

      // Calculate overrideHeadless parameter for session manager
      // show_browser takes precedence over browser_options.headless
      let overrideHeadless: boolean | undefined = undefined;
      if (show_browser !== undefined) {
        overrideHeadless = show_browser;
      } else if (browser_options?.show !== undefined) {
        overrideHeadless = browser_options.show;
      } else if (browser_options?.headless !== undefined) {
        overrideHeadless = !browser_options.headless;
      }

      try {
        // Get or create session (with headless override to handle mode changes)
        const session = await this.sessionManager.getOrCreateSession(
          safeSessionId,
          resolvedNotebookUrl,
          overrideHeadless
        );

      // Progress: Asking question
      await sendProgress?.("Asking question to NotebookLM...", 2, 5);

      // Ask the question (pass progress callback) - using validated question
      const rawAnswer = await session.ask(safeQuestion, sendProgress);

      // === SECURITY: Validate response for prompt injection & malicious content ===
      await sendProgress?.("Validating response security...", 4, 5);
      const validationResult = await validateResponse(rawAnswer);

      // Use sanitized response if issues were found
      let finalAnswer: string;
      let securityWarnings: string[] = [];

      if (!validationResult.safe) {
        log.warning(`🛡️ Response contained blocked content, using sanitized version`);
        finalAnswer = validationResult.sanitized;
        securityWarnings = validationResult.blocked;
      } else if (validationResult.warnings.length > 0) {
        log.info(`⚠️ Response had ${validationResult.warnings.length} warnings`);
        finalAnswer = rawAnswer;
        securityWarnings = validationResult.warnings;
      } else {
        finalAnswer = rawAnswer;
      }

      const answer = `${finalAnswer.trimEnd()}${FOLLOW_UP_REMINDER}`;

      // Get session info
      const sessionInfo = session.getInfo();

      const result: AskQuestionResult = {
        status: "success",
        question: safeQuestion,
        answer,
        session_id: session.sessionId,
        notebook_url: session.notebookUrl,
        session_info: {
          age_seconds: sessionInfo.age_seconds,
          message_count: sessionInfo.message_count,
          last_activity: sessionInfo.last_activity,
        },
        // Include security warnings if any
        ...(securityWarnings.length > 0 && { security_warnings: securityWarnings }),
      };

        // Progress: Complete
        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);

        // Audit: successful tool call
        await audit.tool("ask_question", {
          question_length: safeQuestion.length,
          session_id: safeSessionId,
          notebook_id: safeNotebookId,
        }, true, Date.now() - startTime);

        return {
          success: true,
          data: result,
        };
      } finally {
        // Restore original CONFIG
        Object.assign(CONFIG, originalConfig);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Special handling for rate limit errors
      if (error instanceof RateLimitError || errorMessage.toLowerCase().includes("rate limit")) {
        log.error(`🚫 [TOOL] Rate limit detected`);
        await audit.security("notebooklm_rate_limit", "warning", {
          session_id: safeSessionId,
        });
        await audit.tool("ask_question", args, false, Date.now() - startTime, "NotebookLM rate limit");
        return {
          success: false,
          error:
            "NotebookLM rate limit reached (50 queries/day for free accounts).\n\n" +
            "You can:\n" +
            "1. Use the 're_auth' tool to login with a different Google account\n" +
            "2. Wait until tomorrow for the quota to reset\n" +
            "3. Upgrade to Google AI Pro/Ultra for 5x higher limits\n\n" +
            `Original error: ${errorMessage}`,
        };
      }

      log.error(`❌ [TOOL] ask_question failed: ${errorMessage}`);
      await audit.tool("ask_question", args, false, Date.now() - startTime, errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_sessions tool
   */
  async handleListSessions(): Promise<
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
      const stats = this.sessionManager.getStats();
      const sessions = this.sessionManager.getAllSessionsInfo();

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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sessions failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle close_session tool
   */
  async handleCloseSession(args: { session_id: string }): Promise<
    ToolResult<{ status: string; message: string; session_id: string }>
  > {
    const { session_id } = args;

    log.info(`🔧 [TOOL] close_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const closed = await this.sessionManager.closeSession(session_id);

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
          error: `Session ${session_id} not found`,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] close_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle reset_session tool
   */
  async handleResetSession(args: { session_id: string }): Promise<
    ToolResult<{ status: string; message: string; session_id: string }>
  > {
    const { session_id } = args;

    log.info(`🔧 [TOOL] reset_session called`);
    log.info(`  Session ID: ${session_id}`);

    try {
      const session = this.sessionManager.getSession(session_id);

      if (!session) {
        log.warning(`⚠️  [TOOL] Session ${session_id} not found`);
        return {
          success: false,
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] reset_session failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_health tool
   */
  async handleGetHealth(): Promise<
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
      troubleshooting_tip?: string;
    }> 
  > {
    log.info(`🔧 [TOOL] get_health called`);

    try {
      // Check authentication status
      const statePath = await this.authManager.getValidStatePath();
      const authenticated = statePath !== null;

      // Get session stats
      const stats = this.sessionManager.getStats();

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
        // Add troubleshooting tip if not authenticated
        ...((!authenticated) && {
          troubleshooting_tip:
            "For fresh start with clean browser session: Close all Chrome instances → " +
            "cleanup_data(confirm=true, preserve_library=true) → setup_auth"
        }),
      };

      log.success(`✅ [TOOL] get_health completed`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_health failed: ${errorMessage}`);
      return {
        success: false,
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
  async handleSetupAuth(
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
    const { show_browser, browser_options } = args;

    // CRITICAL: Send immediate progress to reset timeout from the very start
    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    // Apply browser options temporarily
    const originalConfig = { ...CONFIG };
    const effectiveConfig = applyBrowserOptions(browser_options, show_browser);
    Object.assign(CONFIG, effectiveConfig);

    try {
      // Progress: Starting
      await sendProgress?.("Preparing authentication browser...", 1, 10);

      log.info(`  🌐 Opening browser for interactive login...`);

      // Progress: Opening browser
      await sendProgress?.("Opening browser window...", 2, 10);

      // Perform setup with progress updates (uses CONFIG internally)
      const success = await this.authManager.performSetup(sendProgress);

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
        await audit.tool("setup_auth", {}, false, Date.now() - startTime, "Authentication failed or was cancelled");

        return {
          success: false,
          error: "Authentication failed or was cancelled",
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const durationSeconds = (Date.now() - startTime) / 1000;
      log.error(`❌ [TOOL] setup_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`);

      // Audit: auth error
      await audit.auth("setup_auth", false, { error: errorMessage });
      await audit.tool("setup_auth", {}, false, Date.now() - startTime, errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Restore original CONFIG
      Object.assign(CONFIG, originalConfig);
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
  async handleReAuth(
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
    const { show_browser, browser_options } = args;

    await sendProgress?.("Preparing re-authentication...", 0, 12);
    log.info(`🔧 [TOOL] re_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

    // Apply browser options temporarily
    const originalConfig = { ...CONFIG };
    const effectiveConfig = applyBrowserOptions(browser_options, show_browser);
    Object.assign(CONFIG, effectiveConfig);

    try {
      // 1. Close all active sessions
      await sendProgress?.("Closing all active sessions...", 1, 12);
      log.info("  🛑 Closing all sessions...");
      await this.sessionManager.closeAllSessions();
      log.success("  ✅ All sessions closed");

      // 2. Clear all auth data
      await sendProgress?.("Clearing authentication data...", 2, 12);
      log.info("  🗑️  Clearing all auth data...");
      await this.authManager.clearAllAuthData();
      log.success("  ✅ Auth data cleared");

      // 3. Perform fresh setup
      await sendProgress?.("Starting fresh authentication...", 3, 12);
      log.info("  🌐 Starting fresh authentication setup...");
      const success = await this.authManager.performSetup(sendProgress);

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
        await audit.tool("re_auth", {}, false, Date.now() - startTime, "Re-authentication failed or was cancelled");

        return {
          success: false,
          error: "Re-authentication failed or was cancelled",
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationSeconds = (Date.now() - startTime) / 1000;
      log.error(
        `❌ [TOOL] re_auth failed: ${errorMessage} (${durationSeconds.toFixed(1)}s)`
      );

      // Audit: re-auth error
      await audit.auth("re_auth", false, { error: errorMessage });
      await audit.tool("re_auth", {}, false, Date.now() - startTime, errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // Restore original CONFIG
      Object.assign(CONFIG, originalConfig);
    }
  }

  /**
   * Handle add_notebook tool
   */
  async handleAddNotebook(args: AddNotebookInput): Promise<ToolResult<{ notebook: any }>> {
    log.info(`🔧 [TOOL] add_notebook called`);
    log.info(`  Name: ${args.name}`);

    try {
      const notebook = this.library.addNotebook(args);
      log.success(`✅ [TOOL] add_notebook completed: ${notebook.id}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle list_notebooks tool
   */
  async handleListNotebooks(): Promise<ToolResult<{ notebooks: any[] }>> {
    log.info(`🔧 [TOOL] list_notebooks called`);

    try {
      const notebooks = this.library.listNotebooks();
      log.success(`✅ [TOOL] list_notebooks completed (${notebooks.length} notebooks)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_notebook tool
   */
  async handleGetNotebook(args: { id: string }): Promise<ToolResult<{ notebook: any }>> {
    log.info(`🔧 [TOOL] get_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      log.success(`✅ [TOOL] get_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle select_notebook tool
   */
  async handleSelectNotebook(args: { id: string }): Promise<ToolResult<{ notebook: any }>> {
    log.info(`🔧 [TOOL] select_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.selectNotebook(args.id);
      log.success(`✅ [TOOL] select_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] select_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle update_notebook tool
   */
  async handleUpdateNotebook(args: UpdateNotebookInput): Promise<ToolResult<{ notebook: any }>> {
    log.info(`🔧 [TOOL] update_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.updateNotebook(args);
      log.success(`✅ [TOOL] update_notebook completed: ${notebook.name}`);
      return {
        success: true,
        data: { notebook },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] update_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_notebook tool
   */
  async handleRemoveNotebook(args: { id: string }): Promise<ToolResult<{ removed: boolean; closed_sessions: number }>> {
    log.info(`🔧 [TOOL] remove_notebook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const notebook = this.library.getNotebook(args.id);
      if (!notebook) {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }

      const removed = this.library.removeNotebook(args.id);
      if (removed) {
        const closedSessions = await this.sessionManager.closeSessionsForNotebook(
          notebook.url
        );
        log.success(`✅ [TOOL] remove_notebook completed`);
        return {
          success: true,
          data: { removed: true, closed_sessions: closedSessions },
        };
      } else {
        log.warning(`⚠️  [TOOL] Notebook not found: ${args.id}`);
        return {
          success: false,
          error: `Notebook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_notebook failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle search_notebooks tool
   */
  async handleSearchNotebooks(args: { query: string }): Promise<ToolResult<{ notebooks: any[] }>> {
    log.info(`🔧 [TOOL] search_notebooks called`);
    log.info(`  Query: "${args.query}"`);

    try {
      const notebooks = this.library.searchNotebooks(args.query);
      log.success(`✅ [TOOL] search_notebooks completed (${notebooks.length} results)`);
      return {
        success: true,
        data: { notebooks },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] search_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_library_stats tool
   */
  async handleGetLibraryStats(): Promise<ToolResult<any>> {
    log.info(`🔧 [TOOL] get_library_stats called`);

    try {
      const stats = this.library.getStats();
      log.success(`✅ [TOOL] get_library_stats completed`);
      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_library_stats failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle cleanup_data tool
   *
   * ULTRATHINK Deep Cleanup - scans entire system for ALL NotebookLM MCP files
   */
  async handleCleanupData(
    args: { confirm: boolean; preserve_library?: boolean }
  ): Promise<
    ToolResult<{
      status: string;
      mode: string;
      preview?: {
        categories: Array<{ name: string; description: string; paths: string[]; totalBytes: number; optional: boolean }>;
        totalPaths: number;
        totalSizeBytes: number;
      };
      result?: {
        deletedPaths: string[];
        failedPaths: string[];
        totalSizeBytes: number;
        categorySummary: Record<string, { count: number; bytes: number }>;
      };
    }> 
  > {
    const { confirm, preserve_library = false } = args;

    log.info(`🔧 [TOOL] cleanup_data called`);
    log.info(`  Confirm: ${confirm}`);
    log.info(`  Preserve Library: ${preserve_library}`);

    const cleanupManager = new CleanupManager();

    try {
      // Always run in deep mode
      const mode = "deep";

      if (!confirm) {
        // Preview mode - show what would be deleted
        log.info(`  📋 Generating cleanup preview (mode: ${mode})...`);

        const preview = await cleanupManager.getCleanupPaths(mode, preserve_library);
        const platformInfo = cleanupManager.getPlatformInfo();

        log.info(`  Found ${preview.totalPaths.length} items (${cleanupManager.formatBytes(preview.totalSizeBytes)})`);
        log.info(`  Platform: ${platformInfo.platform}`);

        return {
          success: true,
          data: {
            status: "preview",
            mode,
            preview: {
              categories: preview.categories,
              totalPaths: preview.totalPaths.length,
              totalSizeBytes: preview.totalSizeBytes,
            },
          },
        };
      } else {
        // Cleanup mode - actually delete files
        log.info(`  🗑️  Performing cleanup (mode: ${mode})...`);

        const result = await cleanupManager.performCleanup(mode, preserve_library);

        if (result.success) {
          log.success(`✅ [TOOL] cleanup_data completed - deleted ${result.deletedPaths.length} items`);
        } else {
          log.warning(`⚠️  [TOOL] cleanup_data completed with ${result.failedPaths.length} errors`);
        }

        return {
          success: result.success,
          data: {
            status: result.success ? "completed" : "partial",
            mode,
            result: {
              deletedPaths: result.deletedPaths,
              failedPaths: result.failedPaths,
              totalSizeBytes: result.totalSizeBytes,
              categorySummary: result.categorySummary,
            },
          },
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] cleanup_data failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.closeAllSessions();
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
