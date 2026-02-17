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
import { NotebookCreator } from "../notebook-creation/notebook-creator.js";
import { NotebookSync, type SyncResult } from "../notebook-creation/notebook-sync.js";
import { SourceManager, type ListSourcesResult, type AddSourceResult, type RemoveSourceResult } from "../notebook-creation/source-manager.js";
import { AudioManager, type AudioStatus, type GenerateAudioResult, type DownloadAudioResult } from "../notebook-creation/audio-manager.js";
import { VideoManager, type VideoStatus, type GenerateVideoResult, type VideoStyle, type VideoFormat } from "../notebook-creation/video-manager.js";
import { DataTableManager, type GenerateDataTableResult, type GetDataTableResult } from "../notebook-creation/data-table-manager.js";
import type { CreateNotebookInput, CreatedNotebook, NotebookSource } from "../notebook-creation/types.js";
import { getWebhookDispatcher, type WebhookConfig, type WebhookStats } from "../webhooks/index.js";
import type { EventType } from "../events/event-types.js";
import { getQuotaManager } from "../quota/index.js";
import { getQueryLogger } from "../logging/index.js";
import {
  GeminiClient,
  type GeminiInteraction,
  type DeepResearchResult,
  type GeminiQueryResult,
  type GeminiTool,
  type GeminiModel,
} from "../gemini/index.js";

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
  private geminiClient: GeminiClient;

  constructor(sessionManager: SessionManager, authManager: AuthManager, library: NotebookLibrary) {
    this.sessionManager = sessionManager;
    this.authManager = authManager;
    this.library = library;
    // Rate limit: 100 requests per minute per session (protective limit)
    this.rateLimiter = new RateLimiter(100, 60000);
    // Initialize Gemini client (may be unavailable if no API key)
    this.geminiClient = new GeminiClient();
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

      // === QUOTA CHECK ===
      const quotaManager = getQuotaManager();
      const canQuery = quotaManager.canMakeQuery();
      if (!canQuery.allowed) {
        log.warning(`⚠️ Quota limit: ${canQuery.reason}`);
        await audit.tool("ask_question", args, false, Date.now() - startTime, canQuery.reason || "Query quota exceeded");
        return {
          success: false,
          error: canQuery.reason || "Daily query limit reached. Try again tomorrow or upgrade your plan.",
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

      // Get quota status for response visibility
      const quotaStatus = getQuotaManager().getDetailedStatus();

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
        // Include quota info for visibility
        quota_info: {
          queries_remaining: quotaStatus.queries.remaining,
          queries_used_today: quotaStatus.queries.used,
          queries_limit: quotaStatus.queries.limit,
          should_stop: quotaStatus.queries.shouldStop,
          tier: quotaStatus.tier,
          warnings: quotaStatus.warnings,
        },
        // Include security warnings if any
        ...(securityWarnings.length > 0 && { security_warnings: securityWarnings }),
      };

        // Progress: Complete
        await sendProgress?.("Question answered successfully!", 5, 5);

        log.success(`✅ [TOOL] ask_question completed successfully`);

        // Update quota tracking (atomic for concurrent session safety)
        await getQuotaManager().incrementQueryCountAtomic();

        // Log query for research history (Phase 1)
        const queryLogger = getQueryLogger();
        const resolvedNotebook = safeNotebookId ? this.library.getNotebook(safeNotebookId) : null;
        await queryLogger.logQuery({
          sessionId: session.sessionId,
          notebookId: safeNotebookId,
          notebookUrl: session.notebookUrl,
          notebookName: resolvedNotebook?.name,
          question: safeQuestion,
          answer: finalAnswer,
          answerLength: finalAnswer.length,
          durationMs: Date.now() - startTime,
          quotaInfo: {
            used: quotaStatus.queries.used + 1, // +1 because we just incremented
            limit: quotaStatus.queries.limit,
            remaining: quotaStatus.queries.remaining - 1,
            tier: quotaStatus.tier,
          },
        });

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
  async handleGetHealth(args?: {
    deep_check?: boolean;
    notebook_id?: string;
  }): Promise<
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
      const statePath = await this.authManager.getValidStatePath();
      const authenticated = statePath !== null;

      // Get session stats
      const stats = this.sessionManager.getStats();

      // Deep check: actually verify the chat UI loads
      let chatUiAccessible: boolean | undefined;
      let deepCheckNotebook: string | undefined;

      if (args?.deep_check && authenticated) {
        log.info(`  🔍 Running deep check - verifying chat UI loads...`);

        try {
          // Find a notebook to test with
          let notebookUrl: string | undefined;

          if (args.notebook_id) {
            const notebook = this.library.getNotebook(args.notebook_id);
            if (notebook) {
              notebookUrl = notebook.url;
              deepCheckNotebook = notebook.name || args.notebook_id;
            }
          }

          if (!notebookUrl) {
            const activeNotebook = this.library.getActiveNotebook();
            if (activeNotebook) {
              notebookUrl = activeNotebook.url;
              deepCheckNotebook = activeNotebook.name || "active notebook";
            }
          }

          if (!notebookUrl) {
            // Try to get any notebook from library
            const notebooks = this.library.listNotebooks();
            if (notebooks.length > 0) {
              notebookUrl = notebooks[0].url;
              deepCheckNotebook = notebooks[0].name || "first notebook";
            }
          }

          if (notebookUrl) {
            // Create a temporary session to test
            const sessionId = `health-check-${Date.now()}`;
            const session = await this.sessionManager.getOrCreateSession(sessionId, notebookUrl);

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
              await this.sessionManager.closeSession(sessionId);
            }
          } else {
            log.warning(`  ⚠️ No notebook available for deep check`);
            deepCheckNotebook = "none available";
          }
        } catch (deepCheckError) {
          log.warning(`  ⚠️ Deep check failed: ${deepCheckError instanceof Error ? deepCheckError.message : String(deepCheckError)}`);
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
        ...(((!authenticated) || (args?.deep_check && chatUiAccessible === false)) && {
          troubleshooting_tip: chatUiAccessible === false
            ? "Chat UI not accessible. Session may be stale. Run re_auth to refresh authentication."
            : "For fresh start with clean browser session: Close all Chrome instances → " +
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
    const { show_browser } = args;

    // CRITICAL: Send immediate progress to reset timeout from the very start
    await sendProgress?.("Initializing authentication setup...", 0, 10);

    log.info(`🔧 [TOOL] setup_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

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
    const { show_browser } = args;

    await sendProgress?.("Preparing re-authentication...", 0, 12);
    log.info(`🔧 [TOOL] re_auth called`);
    if (show_browser !== undefined) {
      log.info(`  Show browser: ${show_browser}`);
    }

    const startTime = Date.now();

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
   * Handle export_library tool
   *
   * Exports notebook library to a backup file (JSON or CSV).
   */
  async handleExportLibrary(args: {
    format?: "json" | "csv";
    output_path?: string;
  }): Promise<ToolResult<{
    file_path: string;
    format: string;
    notebook_count: number;
    size_bytes: number;
  }>> {
    const format = args.format || "json";
    log.info(`🔧 [TOOL] export_library called`);
    log.info(`  Format: ${format}`);

    try {
      const notebooks = this.library.listNotebooks();
      const stats = this.library.getStats();

      // Generate default output path if not provided
      const date = new Date().toISOString().split("T")[0];
      const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
      const defaultPath = `${homeDir}/notebooklm-library-backup-${date}.${format}`;
      const outputPath = args.output_path || defaultPath;

      let content: string;

      if (format === "csv") {
        // CSV format: name, url, topics, last_used, use_count
        const headers = ["name", "url", "topics", "description", "last_used", "use_count"];
        const rows = notebooks.map((nb: { name?: string; url: string; topics?: string[]; description?: string; last_used?: string; use_count?: number }) => [
          `"${(nb.name || "").replace(/"/g, '""')}"`,
          `"${nb.url}"`,
          `"${(nb.topics || []).join("; ")}"`,
          `"${(nb.description || "").replace(/"/g, '""')}"`,
          nb.last_used || "",
          String(nb.use_count || 0),
        ]);
        content = [headers.join(","), ...rows.map((r: string[]) => r.join(","))].join("\n");
      } else {
        // JSON format: full library data
        content = JSON.stringify(
          {
            exported_at: new Date().toISOString(),
            version: "1.0",
            stats: {
              total_notebooks: stats.total_notebooks,
              total_queries: stats.total_queries,
            },
            notebooks: notebooks,
          },
          null,
          2
        );
      }

      // Write file with secure permissions
      const fs = await import("fs");
      fs.writeFileSync(outputPath, content, { mode: 0o600 });

      const fileStats = fs.statSync(outputPath);

      log.success(`✅ [TOOL] export_library completed: ${outputPath}`);
      return {
        success: true,
        data: {
          file_path: outputPath,
          format,
          notebook_count: notebooks.length,
          size_bytes: fileStats.size,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] export_library failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_project_info tool
   *
   * Returns current project context and library location.
   */
  async handleGetProjectInfo(): Promise<ToolResult<{
    project: { id: string; name: string; path: string; type: string } | null;
    library_path: string;
    is_project_library: boolean;
    detected_project: { id: string; name: string; path: string; type: string } | null;
  }>> {
    log.info(`🔧 [TOOL] get_project_info called`);

    try {
      // Get info from the library instance
      const projectInfo = this.library.getProjectInfo();
      const libraryPath = this.library.getLibraryPath();
      const isProjectLibrary = this.library.isProjectLibrary();

      // Also detect what project would be detected from cwd
      const { NotebookLibrary: NL } = await import("../library/notebook-library.js");
      const detectedProject = NL.detectCurrentProject();

      log.success(`✅ [TOOL] get_project_info completed`);
      return {
        success: true,
        data: {
          project: projectInfo,
          library_path: libraryPath,
          is_project_library: isProjectLibrary,
          detected_project: detectedProject,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_project_info failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_quota tool
   *
   * Returns current quota status including license tier, usage, and limits.
   * If sync=true, navigates to NotebookLM to fetch actual quota from Google.
   */
  async handleGetQuota(args: { sync?: boolean } = {}): Promise<ToolResult<{
    tier: string;
    notebooks: { used: number; limit: number; remaining: number; percent: number };
    sources: { limit: number };
    queries: { used: number; limit: number; remaining: number; percent: number; should_stop: boolean; reset_time: string };
    warnings: string[];
    auto_detected: boolean;
    last_updated: string;
    synced_from_google: boolean;
    google_quota?: { used: number; limit: number } | null;
    rate_limit_detected?: boolean;
  }>> {
    const { sync = false } = args;
    log.info(`🔧 [TOOL] get_quota called (sync=${sync})`);

    try {
      const quotaManager = getQuotaManager();

      let syncedFromGoogle = false;
      let googleQuota: { used: number; limit: number } | null = null;
      let rateLimitDetected = false;

      // If sync requested, navigate to NotebookLM and scrape quota
      if (sync) {
        log.info("📊 Syncing quota from Google NotebookLM...");
        try {
          // Get the shared context manager from session manager
          const contextManager = this.sessionManager.getContextManager();
          const context = await contextManager.getOrCreateContext();

          // Create a new page to check quota
          const page = await context.newPage();
          try {
            // Navigate to NotebookLM homepage
            await page.goto("https://notebooklm.google.com/", {
              waitUntil: "networkidle",
              timeout: 30000,
            });

            // Wait for page to load
            await page.waitForTimeout(2000);

            // Update quota from UI
            const syncResult = await quotaManager.updateFromUI(page);
            syncedFromGoogle = true;
            googleQuota = syncResult.queryUsageFromGoogle;
            rateLimitDetected = syncResult.rateLimitDetected;

            log.success(`✅ Synced quota from Google: ${googleQuota ? `${googleQuota.used}/${googleQuota.limit}` : "usage not displayed in UI"}`);
          } finally {
            await page.close();
          }
        } catch (syncError) {
          const syncErrorMsg = syncError instanceof Error ? syncError.message : String(syncError);
          log.warning(`⚠️ Could not sync from Google: ${syncErrorMsg}. Using local tracking.`);
        }
      }

      const detailedStatus = quotaManager.getDetailedStatus();
      const settings = quotaManager.getSettings();

      log.success(`✅ [TOOL] get_quota completed (tier: ${detailedStatus.tier}, ${detailedStatus.queries.remaining} queries remaining, synced=${syncedFromGoogle})`);
      return {
        success: true,
        data: {
          tier: detailedStatus.tier,
          notebooks: {
            used: detailedStatus.notebooks.used,
            limit: detailedStatus.notebooks.limit,
            remaining: detailedStatus.notebooks.remaining,
            percent: detailedStatus.notebooks.percentUsed,
          },
          sources: detailedStatus.sources,
          queries: {
            used: detailedStatus.queries.used,
            limit: detailedStatus.queries.limit,
            remaining: detailedStatus.queries.remaining,
            percent: detailedStatus.queries.percentUsed,
            should_stop: detailedStatus.queries.shouldStop,
            reset_time: detailedStatus.queries.resetTime,
          },
          warnings: detailedStatus.warnings,
          auto_detected: settings.autoDetected,
          last_updated: settings.usage.lastUpdated,
          synced_from_google: syncedFromGoogle,
          google_quota: googleQuota,
          rate_limit_detected: rateLimitDetected,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_quota failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle set_quota_tier tool
   *
   * Manually set the license tier to override auto-detection.
   */
  async handleSetQuotaTier(args: {
    tier: "free" | "pro" | "ultra";
  }): Promise<ToolResult<{
    tier: string;
    limits: { notebooks: number; sourcesPerNotebook: number; queriesPerDay: number };
    message: string;
  }>> {
    log.info(`🔧 [TOOL] set_quota_tier called`);
    log.info(`  Tier: ${args.tier}`);

    try {
      const quotaManager = getQuotaManager();
      quotaManager.setTier(args.tier);
      const settings = quotaManager.getSettings();

      log.success(`✅ [TOOL] set_quota_tier completed (tier: ${args.tier})`);
      return {
        success: true,
        data: {
          tier: settings.tier,
          limits: {
            notebooks: settings.limits.notebooks,
            sourcesPerNotebook: settings.limits.sourcesPerNotebook,
            queriesPerDay: settings.limits.queriesPerDay,
          },
          message: `License tier set to ${args.tier}. Limits updated accordingly.`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] set_quota_tier failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle create_notebook tool
   *
   * Creates a new NotebookLM notebook with sources programmatically.
   */
  async handleCreateNotebook(
    args: CreateNotebookInput,
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<CreatedNotebook>> {
    log.info(`🔧 [TOOL] create_notebook called`);
    log.info(`  Name: ${args.name}`);
    log.info(`  Sources: ${args.sources?.length || 0}`);

    try {
      // Validate inputs
      if (!args.name || typeof args.name !== "string") {
        throw new Error("Notebook name is required");
      }

      if (!args.sources || !Array.isArray(args.sources) || args.sources.length === 0) {
        throw new Error("At least one source is required");
      }

      // Validate each source
      for (const source of args.sources) {
        if (!source.type || !["url", "text", "file"].includes(source.type)) {
          throw new Error(`Invalid source type: ${source.type}. Must be url, text, or file.`);
        }
        if (!source.value || typeof source.value !== "string") {
          throw new Error("Source value is required");
        }
        if (source.type === "url") {
          try {
            new URL(source.value);
          } catch {
            throw new Error(`Invalid URL: ${source.value}`);
          }
        }
      }

      // === QUOTA CHECK ===
      const quotaManager = getQuotaManager();
      const canCreate = quotaManager.canCreateNotebook();
      if (!canCreate.allowed) {
        log.warning(`⚠️ Quota limit: ${canCreate.reason}`);
        return {
          success: false,
          error: canCreate.reason || "Notebook quota limit reached",
        };
      }

      // Check source limit
      const sourceLimits = quotaManager.getLimits();
      if (args.sources.length > sourceLimits.sourcesPerNotebook) {
        const reason = `Too many sources (${args.sources.length}). Limit is ${sourceLimits.sourcesPerNotebook} per notebook.`;
        log.warning(`⚠️ Quota limit: ${reason}`);
        return {
          success: false,
          error: reason,
        };
      }

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Create notebook
      const creator = new NotebookCreator(this.authManager, contextManager);
      const result = await creator.createNotebook({
        name: args.name,
        sources: args.sources,
        sendProgress,
        browserOptions: args.browser_options || (args.show_browser ? { show: true } : undefined),
      });

      // Auto-add to library if requested (default: true)
      if (args.auto_add_to_library !== false) {
        try {
          this.library.addNotebook({
            url: result.url,
            name: args.name,
            description: args.description || `Created ${new Date().toLocaleDateString()}`,
            topics: args.topics || [],
          });
          log.success(`✅ Added notebook to library: ${args.name}`);
        } catch (libError) {
          log.warning(`⚠️ Failed to add to library: ${libError}`);
          // Don't fail the whole operation
        }
      }

      // Update quota tracking
      quotaManager.incrementNotebookCount();

      // Audit log
      await audit.tool("create_notebook", {
        name: args.name,
        sourceCount: args.sources.length,
        url: result.url,
      }, true, 0);

      log.success(`✅ [TOOL] create_notebook completed: ${result.url}`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] create_notebook failed: ${errorMessage}`);

      await audit.tool("create_notebook", {
        name: args.name,
        error: errorMessage,
      }, false, 0, errorMessage);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle batch_create_notebooks tool
   *
   * Creates multiple notebooks in a single batch operation.
   */
  async handleBatchCreateNotebooks(
    args: {
      notebooks: Array<{
        name: string;
        sources: Array<{ type: "url" | "text" | "file"; value: string; title?: string }>;
        description?: string;
        topics?: string[];
      }>;
      stop_on_error?: boolean;
      show_browser?: boolean;
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<{
    total: number;
    succeeded: number;
    failed: number;
    results: Array<{
      name: string;
      success: boolean;
      url?: string;
      error?: string;
    }>;
  }>> {
    log.info(`🔧 [TOOL] batch_create_notebooks called`);
    log.info(`  Notebooks: ${args.notebooks.length}`);
    log.info(`  Stop on error: ${args.stop_on_error || false}`);

    try {
      // Validate input
      if (!args.notebooks || !Array.isArray(args.notebooks)) {
        throw new Error("notebooks array is required");
      }

      if (args.notebooks.length === 0) {
        throw new Error("At least one notebook is required");
      }

      if (args.notebooks.length > 10) {
        throw new Error("Maximum 10 notebooks per batch");
      }

      const results: Array<{
        name: string;
        success: boolean;
        url?: string;
        error?: string;
      }> = [];

      const total = args.notebooks.length;
      let succeeded = 0;
      let failed = 0;

      for (let i = 0; i < args.notebooks.length; i++) {
        const notebook = args.notebooks[i];

        await sendProgress?.(
          `Creating notebook ${i + 1}/${total}: ${notebook.name}`,
          i,
          total
        );

        log.info(`  📓 Creating notebook ${i + 1}/${total}: ${notebook.name}`);

        try {
          const result = await this.handleCreateNotebook({
            name: notebook.name,
            sources: notebook.sources,
            description: notebook.description,
            topics: notebook.topics,
            auto_add_to_library: true,
            show_browser: args.show_browser,
          });

          if (result.success && result.data) {
            results.push({
              name: notebook.name,
              success: true,
              url: result.data.url,
            });
            succeeded++;
            log.success(`    ✅ Created: ${result.data.url}`);
          } else {
            results.push({
              name: notebook.name,
              success: false,
              error: result.error || "Unknown error",
            });
            failed++;
            log.error(`    ❌ Failed: ${result.error}`);

            if (args.stop_on_error) {
              log.warning(`  ⚠️ Stopping batch due to error (stop_on_error=true)`);
              break;
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          results.push({
            name: notebook.name,
            success: false,
            error: errorMessage,
          });
          failed++;
          log.error(`    ❌ Exception: ${errorMessage}`);

          if (args.stop_on_error) {
            log.warning(`  ⚠️ Stopping batch due to exception (stop_on_error=true)`);
            break;
          }
        }

        // Delay between notebooks to avoid rate limiting
        if (i < args.notebooks.length - 1) {
          const delay = 2000 + Math.random() * 2000; // 2-4 seconds
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      await sendProgress?.(`Batch complete: ${succeeded}/${total} succeeded`, total, total);

      log.success(`✅ [TOOL] batch_create_notebooks completed: ${succeeded}/${total} succeeded`);

      return {
        success: failed === 0,
        data: {
          total,
          succeeded,
          failed,
          results,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] batch_create_notebooks failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle sync_library tool
   *
   * Syncs local library with actual NotebookLM notebooks.
   */
  async handleSyncLibrary(
    args: { auto_fix?: boolean; show_browser?: boolean }
  ): Promise<ToolResult<SyncResult>> {
    log.info(`🔧 [TOOL] sync_library called`);
    log.info(`  Auto-fix: ${args.auto_fix || false}`);
    log.info(`  Show browser: ${args.show_browser || false}`);

    try {
      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Sync library
      const sync = new NotebookSync(this.authManager, contextManager, this.library);
      const result = await sync.syncLibrary({
        autoFix: args.auto_fix,
        showBrowser: args.show_browser,
      });

      // Audit log
      await audit.tool("sync_library", {
        matched: result.matched.length,
        stale: result.staleEntries.length,
        missing: result.missingNotebooks.length,
        autoFix: args.auto_fix,
      }, true, 0);

      log.success(`✅ [TOOL] sync_library completed`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] sync_library failed: ${errorMessage}`);

      await audit.tool("sync_library", {
        error: errorMessage,
      }, false, 0, errorMessage);

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
   * Handle list_sources tool
   *
   * List all sources in a NotebookLM notebook.
   */
  async handleListSources(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<ListSourcesResult>> {
    log.info(`🔧 [TOOL] list_sources called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // List sources
      const sourceManager = new SourceManager(this.authManager, contextManager);
      const result = await sourceManager.listSources(safeUrl);

      log.success(`✅ [TOOL] list_sources completed (${result.count} sources)`);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_sources failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle add_source tool
   *
   * Add a source to an existing NotebookLM notebook.
   */
  async handleAddSource(args: {
    notebook_id?: string;
    notebook_url?: string;
    source: NotebookSource;
  }): Promise<ToolResult<AddSourceResult>> {
    log.info(`🔧 [TOOL] add_source called`);
    log.info(`  Source type: ${args.source?.type}`);

    try {
      // Validate source
      if (!args.source || !args.source.type || !args.source.value) {
        throw new Error("Source with type and value is required");
      }

      if (!["url", "text", "file"].includes(args.source.type)) {
        throw new Error(`Invalid source type: ${args.source.type}. Must be url, text, or file.`);
      }

      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Add source
      const sourceManager = new SourceManager(this.authManager, contextManager);
      const result = await sourceManager.addSource(safeUrl, args.source);

      if (result.success) {
        log.success(`✅ [TOOL] add_source completed`);
      } else {
        log.warning(`⚠️ [TOOL] add_source failed: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] add_source failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle remove_source tool
   *
   * Remove a source from a NotebookLM notebook.
   */
  async handleRemoveSource(args: {
    notebook_id?: string;
    notebook_url?: string;
    source_id: string;
  }): Promise<ToolResult<RemoveSourceResult>> {
    log.info(`🔧 [TOOL] remove_source called`);
    log.info(`  Source ID: ${args.source_id}`);

    try {
      // Validate source_id
      if (!args.source_id) {
        throw new Error("source_id is required");
      }

      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Remove source
      const sourceManager = new SourceManager(this.authManager, contextManager);
      const result = await sourceManager.removeSource(safeUrl, args.source_id);

      if (result.success) {
        log.success(`✅ [TOOL] remove_source completed`);
      } else {
        log.warning(`⚠️ [TOOL] remove_source failed: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_source failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle generate_audio_overview tool
   *
   * Triggers audio overview generation for a notebook.
   */
  async handleGenerateAudioOverview(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<GenerateAudioResult>> {
    log.info(`🔧 [TOOL] generate_audio_overview called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Generate audio
      const audioManager = new AudioManager(this.authManager, contextManager);
      const result = await audioManager.generateAudioOverview(safeUrl);

      if (result.success) {
        log.success(`✅ [TOOL] generate_audio_overview completed (status: ${result.status.status})`);
      } else {
        log.warning(`⚠️ [TOOL] generate_audio_overview: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_audio_overview failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_audio_status tool
   *
   * Checks the audio generation status for a notebook.
   */
  async handleGetAudioStatus(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<AudioStatus>> {
    log.info(`🔧 [TOOL] get_audio_status called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Get status
      const audioManager = new AudioManager(this.authManager, contextManager);
      const status = await audioManager.getAudioStatus(safeUrl);

      log.success(`✅ [TOOL] get_audio_status completed (status: ${status.status})`);

      return {
        success: true,
        data: status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_audio_status failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle download_audio tool
   *
   * Downloads the generated audio file.
   */
  async handleDownloadAudio(args: {
    notebook_id?: string;
    notebook_url?: string;
    output_path?: string;
  }): Promise<ToolResult<DownloadAudioResult>> {
    log.info(`🔧 [TOOL] download_audio called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Download audio
      const audioManager = new AudioManager(this.authManager, contextManager);
      const result = await audioManager.downloadAudio(safeUrl, args.output_path);

      if (result.success) {
        log.success(`✅ [TOOL] download_audio completed: ${result.filePath}`);
      } else {
        log.warning(`⚠️ [TOOL] download_audio: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] download_audio failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle configure_webhook tool
   *
   * Add or update a webhook endpoint.
   */
  async handleConfigureWebhook(args: {
    id?: string;
    name: string;
    url: string;
    enabled?: boolean;
    events?: string[];
    format?: "generic" | "slack" | "discord" | "teams";
    secret?: string;
  }): Promise<ToolResult<WebhookConfig>> {
    log.info(`🔧 [TOOL] configure_webhook called`);
    log.info(`  Name: ${args.name}`);

    try {
      const dispatcher = getWebhookDispatcher();

      if (args.id) {
        // Update existing
        const updated = dispatcher.updateWebhook({
          id: args.id,
          name: args.name,
          url: args.url,
          enabled: args.enabled,
          events: args.events as EventType[] | ["*"],
          format: args.format,
          secret: args.secret,
        });

        if (!updated) {
          throw new Error(`Webhook not found: ${args.id}`);
        }

        log.success(`✅ [TOOL] configure_webhook updated: ${updated.name}`);
        return { success: true, data: updated };
      } else {
        // Create new
        const webhook = dispatcher.addWebhook({
          name: args.name,
          url: args.url,
          events: args.events as EventType[] | ["*"],
          format: args.format,
          secret: args.secret,
        });

        log.success(`✅ [TOOL] configure_webhook created: ${webhook.name}`);
        return { success: true, data: webhook };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] configure_webhook failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle list_webhooks tool
   *
   * List all configured webhooks.
   */
  async handleListWebhooks(): Promise<ToolResult<{
    webhooks: WebhookConfig[];
    stats: WebhookStats;
  }>> {
    log.info(`🔧 [TOOL] list_webhooks called`);

    try {
      const dispatcher = getWebhookDispatcher();
      const webhooks = dispatcher.listWebhooks();
      const stats = dispatcher.getStats();

      log.success(`✅ [TOOL] list_webhooks completed (${webhooks.length} webhooks)`);
      return {
        success: true,
        data: { webhooks, stats },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_webhooks failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle test_webhook tool
   *
   * Send a test event to a webhook.
   */
  async handleTestWebhook(args: { id: string }): Promise<ToolResult<{
    success: boolean;
    message: string;
  }>> {
    log.info(`🔧 [TOOL] test_webhook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const dispatcher = getWebhookDispatcher();
      const result = await dispatcher.testWebhook(args.id);

      if (result.success) {
        log.success(`✅ [TOOL] test_webhook succeeded`);
        return {
          success: true,
          data: { success: true, message: "Test event delivered successfully" },
        };
      } else {
        log.warning(`⚠️ [TOOL] test_webhook failed: ${result.error}`);
        return {
          success: false,
          data: { success: false, message: result.error || "Test failed" },
          error: result.error,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] test_webhook failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle remove_webhook tool
   *
   * Remove a configured webhook.
   */
  async handleRemoveWebhook(args: { id: string }): Promise<ToolResult<{
    removed: boolean;
    id: string;
  }>> {
    log.info(`🔧 [TOOL] remove_webhook called`);
    log.info(`  ID: ${args.id}`);

    try {
      const dispatcher = getWebhookDispatcher();
      const removed = dispatcher.removeWebhook(args.id);

      if (removed) {
        log.success(`✅ [TOOL] remove_webhook completed`);
        return {
          success: true,
          data: { removed: true, id: args.id },
        };
      } else {
        log.warning(`⚠️ [TOOL] Webhook not found: ${args.id}`);
        return {
          success: false,
          error: `Webhook not found: ${args.id}`,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] remove_webhook failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // ==================== GEMINI API HANDLERS ====================

  /**
   * Handle deep_research tool
   *
   * Performs comprehensive research using Gemini's Deep Research agent.
   */
  async handleDeepResearch(
    args: {
      query: string;
      wait_for_completion?: boolean;
      max_wait_seconds?: number;
    },
    sendProgress?: ProgressCallback
  ): Promise<ToolResult<DeepResearchResult>> {
    const startTime = Date.now();
    log.info(`🔧 [TOOL] deep_research called`);
    log.info(`  Query: "${sanitizeForLogging(args.query.substring(0, 100))}"...`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] deep_research failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate query
      if (!args.query || args.query.trim().length === 0) {
        throw new Error("Query cannot be empty");
      }
      if (args.query.length > 10000) {
        throw new Error("Query too long (max 10000 characters)");
      }

      // Validate max_wait_seconds
      const maxWaitSeconds = Math.min(args.max_wait_seconds || 300, 600); // Max 10 minutes
      const maxWaitMs = maxWaitSeconds * 1000;

      if (sendProgress) {
        await sendProgress("Starting deep research...", 0, 100);
      }

      // Start the research
      const interaction = await this.geminiClient.deepResearch({
        query: args.query,
        background: true,
        waitForCompletion: args.wait_for_completion !== false,
        maxWaitMs,
        progressCallback: sendProgress,
      });

      const durationMs = Date.now() - startTime;

      // Extract the answer
      const answer = interaction.outputs.find(o => o.type === "text")?.text || "";

      // Audit log
      await audit.tool("deep_research", { query: sanitizeForLogging(args.query) }, true, durationMs);

      log.success(`✅ [TOOL] deep_research completed in ${durationMs}ms`);

      return {
        success: true,
        data: {
          interactionId: interaction.id,
          status: interaction.status,
          answer,
          tokensUsed: interaction.usage?.totalTokens,
          durationMs,
          ...(interaction.deprecationWarning && { deprecationWarning: interaction.deprecationWarning }),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;
      log.error(`❌ [TOOL] deep_research failed: ${errorMessage}`);
      await audit.tool("deep_research", { query: sanitizeForLogging(args.query) }, false, durationMs, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle gemini_query tool
   *
   * Quick query to Gemini model with optional grounding tools.
   */
  async handleGeminiQuery(args: {
    query: string;
    model?: GeminiModel;
    tools?: GeminiTool[];
    urls?: string[];
    previous_interaction_id?: string;
    thinking_level?: "minimal" | "low" | "medium" | "high";
    response_schema?: Record<string, unknown>;
  }): Promise<ToolResult<GeminiQueryResult>> {
    const startTime = Date.now();
    log.info(`🔧 [TOOL] gemini_query called`);
    log.info(`  Query: "${sanitizeForLogging(args.query.substring(0, 100))}"...`);
    log.info(`  Model: ${args.model || "default"}`);
    if (args.tools) log.info(`  Tools: ${args.tools.join(", ")}`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] gemini_query failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate query
      if (!args.query || args.query.trim().length === 0) {
        throw new Error("Query cannot be empty");
      }
      if (args.query.length > 30000) {
        throw new Error("Query too long (max 30000 characters)");
      }

      // If URLs provided, auto-enable url_context
      let tools = args.tools || [];
      if (args.urls && args.urls.length > 0 && !tools.includes("url_context")) {
        tools = [...tools, "url_context"];
      }

      // Validate URLs if provided
      if (args.urls) {
        for (const url of args.urls) {
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new Error(`Invalid URL: ${url} (must start with http:// or https://)`);
          }
        }
      }

      // Build generationConfig from thinking_level and response_schema
      const hasGenConfig = args.thinking_level || args.response_schema;
      const generationConfig = hasGenConfig ? {
        ...(args.thinking_level && { thinkingLevel: args.thinking_level }),
        ...(args.response_schema && {
          responseMimeType: "application/json" as const,
          responseSchema: args.response_schema,
        }),
      } : undefined;

      const interaction = await this.geminiClient.query({
        query: args.query,
        model: args.model,
        tools,
        urls: args.urls,
        previousInteractionId: args.previous_interaction_id,
        generationConfig,
      });

      const durationMs = Date.now() - startTime;

      // Extract the answer
      const answer = interaction.outputs.find(o => o.type === "text")?.text || "";

      // Identify which tools were used
      const toolsUsed = interaction.outputs
        .filter(o => o.type === "function_call")
        .map(o => o.name)
        .filter((name): name is string => !!name);

      // Audit log
      await audit.tool("gemini_query", {
        query: sanitizeForLogging(args.query),
        model: args.model,
        tools: args.tools,
      }, true, durationMs);

      log.success(`✅ [TOOL] gemini_query completed in ${durationMs}ms`);

      return {
        success: true,
        data: {
          interactionId: interaction.id,
          answer,
          model: interaction.model || args.model || CONFIG.geminiDefaultModel,
          tokensUsed: interaction.usage?.totalTokens,
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
          ...(interaction.deprecationWarning && { deprecationWarning: interaction.deprecationWarning }),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;
      log.error(`❌ [TOOL] gemini_query failed: ${errorMessage}`);
      await audit.tool("gemini_query", { query: sanitizeForLogging(args.query) }, false, durationMs, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Handle get_research_status tool
   *
   * Check the status of a background deep research task.
   */
  async handleGetResearchStatus(args: {
    interaction_id: string;
  }): Promise<ToolResult<GeminiInteraction>> {
    log.info(`🔧 [TOOL] get_research_status called`);
    log.info(`  Interaction ID: ${args.interaction_id}`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] get_research_status failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate interaction_id
      if (!args.interaction_id || args.interaction_id.trim().length === 0) {
        throw new Error("Interaction ID cannot be empty");
      }

      const interaction = await this.geminiClient.getInteraction(args.interaction_id);

      log.success(`✅ [TOOL] get_research_status: ${interaction.status}`);

      return {
        success: true,
        data: interaction,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_research_status failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // ==================== DOCUMENT TOOLS (v1.9.0) ====================

  /**
   * Upload a document to Gemini Files API
   */
  async handleUploadDocument(args: {
    file_path: string;
    display_name?: string;
  }): Promise<ToolResult<import("../gemini/types.js").UploadDocumentResult>> {
    const startTime = Date.now();
    log.info(`🔧 [TOOL] upload_document called`);
    log.info(`  File: ${args.file_path}`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] upload_document failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate file path
      if (!args.file_path || args.file_path.trim().length === 0) {
        throw new Error("File path cannot be empty");
      }

      const result = await this.geminiClient.uploadDocument({
        filePath: args.file_path,
        displayName: args.display_name,
      });

      const durationMs = Date.now() - startTime;
      await audit.tool("upload_document", { file: sanitizeForLogging(args.file_path) }, true, durationMs);

      log.success(`✅ [TOOL] upload_document completed in ${durationMs}ms`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;
      await audit.tool("upload_document", { file: sanitizeForLogging(args.file_path) }, false, durationMs, errorMessage);
      log.error(`❌ [TOOL] upload_document failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Query an uploaded document
   */
  async handleQueryDocument(args: {
    file_name: string;
    query: string;
    model?: string;
    additional_files?: string[];
  }): Promise<ToolResult<import("../gemini/types.js").QueryDocumentResult>> {
    const startTime = Date.now();
    log.info(`🔧 [TOOL] query_document called`);
    log.info(`  File: ${args.file_name}`);
    log.info(`  Query: ${args.query.substring(0, 50)}...`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] query_document failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate inputs
      if (!args.file_name || args.file_name.trim().length === 0) {
        throw new Error("File name cannot be empty");
      }
      if (!args.query || args.query.trim().length === 0) {
        throw new Error("Query cannot be empty");
      }

      const result = await this.geminiClient.queryDocument({
        fileName: args.file_name,
        query: args.query,
        model: args.model as import("../gemini/types.js").GeminiModel | undefined,
        additionalFiles: args.additional_files,
      });

      const durationMs = Date.now() - startTime;
      await audit.tool("query_document", { file: args.file_name, query: sanitizeForLogging(args.query) }, true, durationMs);

      log.success(`✅ [TOOL] query_document completed in ${durationMs}ms`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;
      await audit.tool("query_document", { file: args.file_name }, false, durationMs, errorMessage);
      log.error(`❌ [TOOL] query_document failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * List all uploaded documents
   */
  async handleListDocuments(args: {
    page_size?: number;
  }): Promise<ToolResult<import("../gemini/types.js").ListDocumentsResult>> {
    log.info(`🔧 [TOOL] list_documents called`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] list_documents failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      const result = await this.geminiClient.listFiles(args.page_size || 100);

      log.success(`✅ [TOOL] list_documents: ${result.totalCount} files`);

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] list_documents failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Delete an uploaded document
   */
  async handleDeleteDocument(args: {
    file_name: string;
  }): Promise<ToolResult<{ deleted: boolean; fileName: string }>> {
    log.info(`🔧 [TOOL] delete_document called`);
    log.info(`  File: ${args.file_name}`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] delete_document failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate file name
      if (!args.file_name || args.file_name.trim().length === 0) {
        throw new Error("File name cannot be empty");
      }

      await this.geminiClient.deleteFile(args.file_name);

      log.success(`✅ [TOOL] delete_document: ${args.file_name} deleted`);

      return {
        success: true,
        data: { deleted: true, fileName: args.file_name },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] delete_document failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Query a chunked document (v1.10.0)
   * Queries multiple chunks and aggregates results
   */
  async handleQueryChunkedDocument(args: {
    file_names: string[];
    query: string;
    model?: string;
  }): Promise<ToolResult<{
    answer: string;
    model: string;
    tokensUsed?: number;
    chunksQueried: number;
    filesUsed: string[];
  }>> {
    log.info(`🔧 [TOOL] query_chunked_document called`);
    log.info(`  Chunks: ${args.file_names.length}`);
    log.info(`  Query: ${args.query.substring(0, 50)}...`);

    // Check if Gemini is available
    if (!this.geminiClient.isAvailable()) {
      log.error(`❌ [TOOL] query_chunked_document failed: Gemini API key not configured`);
      return {
        success: false,
        error: "Gemini API key not configured. Set GEMINI_API_KEY environment variable.",
      };
    }

    try {
      // Validate inputs
      if (!args.file_names || args.file_names.length === 0) {
        throw new Error("At least one file name is required");
      }
      if (!args.query || args.query.trim().length === 0) {
        throw new Error("Query cannot be empty");
      }

      const result = await this.geminiClient.queryChunkedDocument(
        args.file_names,
        args.query,
        { model: args.model }
      );

      log.success(`✅ [TOOL] query_chunked_document completed`);

      return {
        success: true,
        data: {
          answer: result.answer,
          model: result.model,
          tokensUsed: result.tokensUsed,
          chunksQueried: args.file_names.length,
          filesUsed: result.filesUsed,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] query_chunked_document failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // ==================== QUERY HISTORY ====================

  /**
   * Handle get_query_history tool
   *
   * Retrieves past NotebookLM queries for reviewing research sessions.
   */
  async handleGetQueryHistory(args: {
    session_id?: string;
    notebook_id?: string;
    date?: string;
    search?: string;
    limit?: number;
  }): Promise<ToolResult<{
    count: number;
    queries: Array<{
      timestamp: string;
      queryId: string;
      sessionId: string;
      notebookId?: string;
      notebookUrl: string;
      notebookName?: string;
      question: string;
      answer: string;
      answerLength: number;
      durationMs: number;
      quotaInfo: { used: number; limit: number; remaining: number; tier: string };
    }>;
  }>> {
    log.info(`🔧 [TOOL] get_query_history called`);

    try {
      const queryLogger = getQueryLogger();
      const limit = Math.min(args.limit ?? 50, 500); // Cap at 500

      let queries;

      if (args.search) {
        // Search across all queries
        queries = await queryLogger.searchQueries(args.search, { limit });
        log.info(`  Searching for: "${args.search}"`);
      } else if (args.session_id) {
        // Filter by session
        queries = await queryLogger.getQueriesForSession(args.session_id);
        log.info(`  Filtering by session: ${args.session_id}`);
      } else if (args.notebook_id) {
        // Filter by notebook
        queries = await queryLogger.getQueriesForNotebookId(args.notebook_id);
        log.info(`  Filtering by notebook: ${args.notebook_id}`);
      } else if (args.date) {
        // Filter by date
        queries = await queryLogger.getQueriesForDate(args.date);
        log.info(`  Filtering by date: ${args.date}`);
      } else {
        // Get recent queries
        queries = await queryLogger.getRecentQueries(limit);
        log.info(`  Getting recent queries (limit: ${limit})`);
      }

      // Apply limit
      const limitedQueries = queries.slice(0, limit);

      log.success(`✅ [TOOL] get_query_history completed (${limitedQueries.length} queries)`);

      return {
        success: true,
        data: {
          count: limitedQueries.length,
          queries: limitedQueries,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_query_history failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== CHAT HISTORY ====================

  /**
   * Handle get_notebook_chat_history tool
   *
   * Extracts conversation history from a NotebookLM notebook's chat UI
   * using browser automation.
   */
  async handleGetNotebookChatHistory(args: {
    notebook_id?: string;
    notebook_url?: string;
    preview_only?: boolean;
    limit?: number;
    offset?: number;
    output_file?: string;
    show_browser?: boolean;
  }): Promise<ToolResult<{
    notebook_url: string;
    notebook_name?: string;
    total_messages: number;
    returned_messages: number;
    user_messages: number;
    assistant_messages: number;
    offset?: number;
    has_more?: boolean;
    output_file?: string;
    messages?: Array<{
      role: "user" | "assistant";
      content: string;
      index: number;
    }>;
  }>> {
    log.info(`🔧 [TOOL] get_notebook_chat_history called${args.preview_only ? ' (preview mode)' : ''}`);

    try {
      // Resolve notebook URL
      let notebookUrl: string;
      let notebookName: string | undefined;

      if (args.notebook_url) {
        notebookUrl = validateNotebookUrl(args.notebook_url);
      } else if (args.notebook_id) {
        validateNotebookId(args.notebook_id);
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          return {
            success: false,
            error: `Notebook not found: ${args.notebook_id}. Use list_notebooks to see available notebooks.`,
          };
        }
        notebookUrl = notebook.url;
        notebookName = notebook.name;
      } else {
        // Try to use active notebook
        const activeNotebook = this.library.getActiveNotebook();
        if (!activeNotebook) {
          return {
            success: false,
            error: "No notebook specified. Provide notebook_id or notebook_url, or set an active notebook.",
          };
        }
        notebookUrl = activeNotebook.url;
        notebookName = activeNotebook.name;
      }

      log.info(`  📓 Extracting chat history from: ${notebookUrl}`);

      // Apply browser options if show_browser is set
      if (args.show_browser !== undefined) {
        applyBrowserOptions({ show: args.show_browser });
      }

      // Create a temporary session to navigate to the notebook
      const sessionId = `chat-history-${Date.now()}`;
      const session = await this.sessionManager.getOrCreateSession(sessionId, notebookUrl);

      try {
        // Get the page from the session
        const page = session.getPage();
        if (!page) {
          throw new Error("Failed to get page from session");
        }

        // Wait a bit for the chat history to fully load
        await page.waitForTimeout(2000);

        // Extract all chat messages from the DOM
        type ChatMessage = { role: "user" | "assistant"; content: string; index: number };
        const messages = await page.evaluate((): Array<{ role: string; content: string; index: number }> => {
          const result: Array<{ role: string; content: string; index: number }> = [];

          // Get all message containers (both user and assistant)
          // User messages: .from-user-container  /  Assistant messages: .to-user-container
          // @ts-expect-error - DOM types available in browser context
          const allContainers = document.querySelectorAll(".from-user-container, .to-user-container");

          let idx = 0;
          allContainers.forEach((container: any) => {
            const isUser = container.classList?.contains("from-user-container");
            const isAssistant = container.classList?.contains("to-user-container");

            if (isUser) {
              // User message - look for query text
              const queryText = container.querySelector(".query-text, .message-text-content, .user-message");
              if (queryText) {
                const content = queryText.innerText?.trim();
                if (content) {
                  result.push({ role: "user", content, index: idx++ });
                }
              } else {
                // Fallback: get container text directly
                const content = container.innerText?.trim();
                if (content) {
                  result.push({ role: "user", content, index: idx++ });
                }
              }
            } else if (isAssistant) {
              // Assistant message
              const textContent = container.querySelector(".message-text-content");
              if (textContent) {
                const content = textContent.innerText?.trim();
                if (content) {
                  result.push({ role: "assistant", content, index: idx++ });
                }
              }
            }
          });

          return result;
        }) as ChatMessage[];

        // Calculate stats
        const totalMessages = messages.length;
        const userMessages = messages.filter(m => m.role === "user").length;
        const assistantMessages = messages.filter(m => m.role === "assistant").length;

        // Preview mode - just return stats without content
        if (args.preview_only) {
          log.success(`✅ [TOOL] get_notebook_chat_history preview completed (${totalMessages} messages found)`);
          return {
            success: true,
            data: {
              notebook_url: notebookUrl,
              notebook_name: notebookName,
              total_messages: totalMessages,
              returned_messages: 0,
              user_messages: userMessages,
              assistant_messages: assistantMessages,
            },
          };
        }

        // Apply pagination (offset and limit)
        const offset = args.offset ?? 0;
        const limit = Math.min(args.limit ?? 50, 200);
        const startIdx = offset * 2; // offset is in pairs, convert to message count
        const endIdx = startIdx + (limit * 2);
        const paginatedMessages = messages.slice(startIdx, endIdx);
        const hasMore = endIdx < totalMessages;

        // Re-index the paginated messages
        const reindexedMessages = paginatedMessages.map((m, idx) => ({
          ...m,
          index: startIdx + idx,
        }));

        // Export to file if requested
        if (args.output_file) {
          const fs = await import("fs/promises");
          const exportData = {
            notebook_url: notebookUrl,
            notebook_name: notebookName,
            exported_at: new Date().toISOString(),
            total_messages: totalMessages,
            user_messages: userMessages,
            assistant_messages: assistantMessages,
            messages: reindexedMessages,
          };
          await fs.writeFile(args.output_file, JSON.stringify(exportData, null, 2));
          log.success(`✅ [TOOL] get_notebook_chat_history exported to ${args.output_file}`);

          return {
            success: true,
            data: {
              notebook_url: notebookUrl,
              notebook_name: notebookName,
              total_messages: totalMessages,
              returned_messages: reindexedMessages.length,
              user_messages: userMessages,
              assistant_messages: assistantMessages,
              output_file: args.output_file,
            },
          };
        }

        log.success(`✅ [TOOL] get_notebook_chat_history completed (${reindexedMessages.length}/${totalMessages} messages)`);

        return {
          success: true,
          data: {
            notebook_url: notebookUrl,
            notebook_name: notebookName,
            total_messages: totalMessages,
            returned_messages: reindexedMessages.length,
            user_messages: userMessages,
            assistant_messages: assistantMessages,
            offset: offset,
            has_more: hasMore,
            messages: reindexedMessages,
          },
        };
      } finally {
        // Close the temporary session
        await this.sessionManager.closeSession(sessionId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_notebook_chat_history failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== VIDEO OVERVIEW ====================

  /**
   * Handle generate_video_overview tool
   *
   * Generates a Video Overview via the Studio panel in NotebookLM.
   */
  async handleGenerateVideoOverview(args: {
    notebook_id?: string;
    notebook_url?: string;
    style?: VideoStyle;
    format?: VideoFormat;
  }): Promise<ToolResult<GenerateVideoResult>> {
    log.info(`🔧 [TOOL] generate_video_overview called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Generate video
      const videoManager = new VideoManager(this.authManager, contextManager);
      const result = await videoManager.generateVideoOverview(
        safeUrl,
        args.style || "auto-select",
        args.format || "explainer"
      );

      if (result.success) {
        log.success(`✅ [TOOL] generate_video_overview completed (status: ${result.status.status})`);
      } else {
        log.warning(`⚠️ [TOOL] generate_video_overview: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_video_overview failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_video_status tool
   *
   * Checks the video generation status for a notebook.
   */
  async handleGetVideoStatus(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<VideoStatus>> {
    log.info(`🔧 [TOOL] get_video_status called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Get status
      const videoManager = new VideoManager(this.authManager, contextManager);
      const status = await videoManager.getVideoStatus(safeUrl);

      log.success(`✅ [TOOL] get_video_status completed (status: ${status.status})`);

      return {
        success: true,
        data: status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_video_status failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== DATA TABLES ====================

  /**
   * Handle generate_data_table tool
   *
   * Generates a structured Data Table via the Studio panel in NotebookLM.
   */
  async handleGenerateDataTable(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<GenerateDataTableResult>> {
    log.info(`🔧 [TOOL] generate_data_table called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Generate data table
      const dataTableManager = new DataTableManager(this.authManager, contextManager);
      const result = await dataTableManager.generateDataTable(safeUrl);

      if (result.success) {
        log.success(`✅ [TOOL] generate_data_table completed (status: ${result.status.status})`);
      } else {
        log.warning(`⚠️ [TOOL] generate_data_table: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] generate_data_table failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle get_data_table tool
   *
   * Extracts the generated Data Table content from a notebook.
   */
  async handleGetDataTable(args: {
    notebook_id?: string;
    notebook_url?: string;
  }): Promise<ToolResult<GetDataTableResult>> {
    log.info(`🔧 [TOOL] get_data_table called`);

    try {
      // Resolve notebook URL
      let notebookUrl = args.notebook_url;

      if (!notebookUrl && args.notebook_id) {
        const notebook = this.library.getNotebook(args.notebook_id);
        if (!notebook) {
          throw new Error(`Notebook not found in library: ${args.notebook_id}`);
        }
        notebookUrl = notebook.url;
        log.info(`  Resolved notebook: ${notebook.name}`);
      } else if (!notebookUrl) {
        const active = this.library.getActiveNotebook();
        if (active) {
          notebookUrl = active.url;
          log.info(`  Using active notebook: ${active.name}`);
        } else {
          throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
        }
      }

      // Validate URL
      const safeUrl = validateNotebookUrl(notebookUrl);

      // Get the shared context manager from session manager
      const contextManager = this.sessionManager.getContextManager();

      // Get data table
      const dataTableManager = new DataTableManager(this.authManager, contextManager);
      const result = await dataTableManager.getDataTable(safeUrl);

      if (result.success) {
        log.success(`✅ [TOOL] get_data_table completed (${result.table?.totalRows} rows x ${result.table?.totalColumns} cols)`);
      } else {
        log.warning(`⚠️ [TOOL] get_data_table: ${result.error}`);
      }

      return {
        success: result.success,
        data: result,
        ...(result.error && { error: result.error }),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`❌ [TOOL] get_data_table failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== CLEANUP ====================

  /**
   * Cleanup all resources (called on server shutdown)
   */
  async cleanup(): Promise<void> {
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.sessionManager.closeAllSessions();
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
