/**
 * Handler for the ask_question tool
 */

import crypto from "node:crypto";
import type { HandlerContext } from "./types.js";
import { CONFIG } from "../../config.js";
import type { BrowserOptions } from "../../notebook-creation/browser-options.js";
import { log } from "../../utils/logger.js";
import type {
  AskQuestionResult,
  ToolResult,
  ProgressCallback,
} from "../../types.js";
import { RateLimitError } from "../../errors.js";
import {
  validateNotebookUrl,
  validateNotebookId,
  validateSessionId,
  validateQuestion,
  sanitizeForLogging,
  SecurityError,
} from "../../utils/security.js";
import { audit } from "../../utils/audit-logger.js";
import { validateResponse } from "../../utils/response-validator.js";
import { getQuotaManager } from "../../quota/index.js";
import { getQueryLogger } from "../../logging/index.js";
import {
  getErrorAuditArgs,
  getSanitizedErrorMessage,
} from "./error-utils.js";

function validateBrowserOptionRanges(browserOptions?: BrowserOptions): string | null {
  const stealth = browserOptions?.stealth;
  if (!stealth) return null;

  if (
    stealth.typing_wpm_min !== undefined &&
    stealth.typing_wpm_max !== undefined &&
    stealth.typing_wpm_min > stealth.typing_wpm_max
  ) {
    return "browser_options.stealth.typing_wpm_min must be less than or equal to typing_wpm_max";
  }

  if (
    stealth.delay_min_ms !== undefined &&
    stealth.delay_max_ms !== undefined &&
    stealth.delay_min_ms > stealth.delay_max_ms
  ) {
    return "browser_options.stealth.delay_min_ms must be less than or equal to delay_max_ms";
  }

  return null;
}

function getRateLimitKey(
  sessionId?: string,
  notebookId?: string,
  notebookUrl?: string
): string {
  if (sessionId) return `session:${sessionId}`;
  if (notebookId) return `notebook:${notebookId}`;
  if (notebookUrl) {
    return `notebook_url:${crypto.createHash("sha256").update(notebookUrl).digest("hex").slice(0, 16)}`;
  }
  return "anonymous";
}

/**
 * Handle ask_question tool
 */
export async function handleAskQuestion(
  ctx: HandlerContext,
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
    const rateLimitKey = getRateLimitKey(safeSessionId, safeNotebookId, safeNotebookUrl);
    if (!ctx.rateLimiter.isAllowed(rateLimitKey)) {
      log.warning(`🚫 Rate limit exceeded for ${rateLimitKey}`);
      await audit.security("rate_limit_exceeded", "warning", {
        session_id: rateLimitKey,
        remaining: ctx.rateLimiter.getRemaining(rateLimitKey),
      });
      await audit.tool(
        "ask_question",
        getErrorAuditArgs("ask_question", "Rate limit exceeded"),
        false,
        Date.now() - startTime,
        "Rate limit exceeded"
      );
      return {
        success: false,
        data: null,
        error: `Rate limit exceeded. Please wait before making more requests. Remaining: ${ctx.rateLimiter.getRemaining(rateLimitKey)}`,
      };
    }

    // === QUOTA CHECK ===
    const quotaManager = getQuotaManager();
    const canQuery = quotaManager.canMakeQuery();
    if (!canQuery.allowed) {
      log.warning(`⚠️ Quota limit: ${canQuery.reason}`);
      const quotaError = canQuery.reason || "Query quota exceeded";
      await audit.tool(
        "ask_question",
        getErrorAuditArgs("ask_question", quotaError),
        false,
        Date.now() - startTime,
        quotaError
      );
      return {
        success: false,
        data: null,
        error: quotaError || "Daily query limit reached. Try again tomorrow or upgrade your plan.",
      };
    }

    const browserOptionError = validateBrowserOptionRanges(browser_options);
    if (browserOptionError) {
      await audit.tool(
        "ask_question",
        getErrorAuditArgs("ask_question", browserOptionError),
        false,
        Date.now() - startTime,
        browserOptionError
      );
      return {
        success: false,
        data: null,
        error: browserOptionError,
      };
    }
  } catch (error) {
    if (error instanceof SecurityError) {
      const errorMessage = getSanitizedErrorMessage(error);
      log.error(`🛡️ [SECURITY] Validation failed: ${errorMessage}`);
      await audit.security("validation_failed", "error", {
        tool: "ask_question",
        error: errorMessage,
      });
      await audit.tool(
        "ask_question",
        getErrorAuditArgs("ask_question", errorMessage),
        false,
        Date.now() - startTime,
        errorMessage
      );
      return {
        success: false,
        data: null,
        error: `Security validation failed: ${errorMessage}`,
      };
    }
    throw error;
  }

  try {
    // Resolve notebook URL (using validated values)
    let resolvedNotebookUrl = safeNotebookUrl;

    if (!resolvedNotebookUrl && safeNotebookId) {
      const notebook = ctx.library.incrementUseCount(safeNotebookId);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${safeNotebookId}`);
      }

      resolvedNotebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!resolvedNotebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        const notebook = ctx.library.incrementUseCount(active.id);
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
    const session = await ctx.sessionManager.getOrCreateSession(
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

    const followUpReminder = CONFIG.followUpEnabled ? CONFIG.followUpReminder : "";
    const answer = `${finalAnswer.trimEnd()}${followUpReminder}`;

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
      const resolvedNotebook = safeNotebookId ? ctx.library.getNotebook(safeNotebookId) : null;
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
    const errorMessage = getSanitizedErrorMessage(error);

    // Special handling for rate limit errors
    if (error instanceof RateLimitError) {
      log.error(`🚫 [TOOL] Rate limit detected`);
      await audit.security("notebooklm_rate_limit", "warning", {
        session_id: safeSessionId,
      });
      await audit.tool(
        "ask_question",
        getErrorAuditArgs("ask_question", "NotebookLM rate limit"),
        false,
        Date.now() - startTime,
        "NotebookLM rate limit"
      );
      return {
        success: false,
        data: null,
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
    await audit.tool(
      "ask_question",
      getErrorAuditArgs("ask_question", errorMessage),
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
