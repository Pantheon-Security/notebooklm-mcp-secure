/**
 * Gemini Handlers
 *
 * Handles deep_research, gemini_query, get_research_status,
 * upload_document, query_document, list_documents, delete_document,
 * query_chunked_document, get_query_history, and get_notebook_chat_history tools.
 */

import type { HandlerContext } from "./types.js";
import type { ToolResult, ProgressCallback } from "../../types.js";
import { CONFIG } from "../../config.js";
import { applyBrowserOptions } from "../../notebook-creation/browser-options.js";
import { log } from "../../utils/logger.js";
import { audit } from "../../utils/audit-logger.js";
import {
  validateNotebookUrl,
  validateNotebookId,
  sanitizeForLogging,
} from "../../utils/security.js";
import { getQueryLogger } from "../../logging/index.js";
import type {
  GeminiInteraction,
  DeepResearchResult,
  GeminiQueryResult,
  GeminiTool,
  GeminiModel,
  UploadDocumentResult,
  QueryDocumentResult,
  ListDocumentsResult,
} from "../../gemini/index.js";
import {
  getErrorAuditArgs,
  getSanitizedErrorMessage,
} from "./error-utils.js";

function getConfiguredGeminiClient(ctx: HandlerContext) {
  const geminiClient = ctx.getGeminiClient();
  if (!geminiClient) {
    return null;
  }
  return geminiClient;
}

/**
 * Handle deep_research tool
 */
export async function handleDeepResearch(
  ctx: HandlerContext,
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
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] deep_research failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
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
    const interaction = await geminiClient.deepResearch({
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
    const errorMessage = getSanitizedErrorMessage(error);
    const durationMs = Date.now() - startTime;
    log.error(`❌ [TOOL] deep_research failed: ${errorMessage}`);
    await audit.tool(
      "deep_research",
      getErrorAuditArgs("deep_research", errorMessage),
      false,
      durationMs,
      errorMessage
    );
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Handle gemini_query tool
 */
export async function handleGeminiQuery(
  ctx: HandlerContext,
  args: {
    query: string;
    model?: GeminiModel;
    tools?: GeminiTool[];
    urls?: string[];
    previous_interaction_id?: string;
    thinking_level?: "minimal" | "low" | "medium" | "high";
    response_schema?: Record<string, unknown>;
  }
): Promise<ToolResult<GeminiQueryResult>> {
  const startTime = Date.now();
  log.info(`🔧 [TOOL] gemini_query called`);
  log.info(`  Query: "${sanitizeForLogging(args.query.substring(0, 100))}"...`);
  log.info(`  Model: ${args.model || "default"}`);
  if (args.tools) log.info(`  Tools: ${args.tools.join(", ")}`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] gemini_query failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
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

    const interaction = await geminiClient.query({
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
    const errorMessage = getSanitizedErrorMessage(error);
    const durationMs = Date.now() - startTime;
    log.error(`❌ [TOOL] gemini_query failed: ${errorMessage}`);
    await audit.tool(
      "gemini_query",
      getErrorAuditArgs("gemini_query", errorMessage),
      false,
      durationMs,
      errorMessage
    );
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Handle get_research_status tool
 */
export async function handleGetResearchStatus(
  ctx: HandlerContext,
  args: {
    interaction_id: string;
  }
): Promise<ToolResult<GeminiInteraction>> {
  log.info(`🔧 [TOOL] get_research_status called`);
  log.info(`  Interaction ID: ${args.interaction_id}`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] get_research_status failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
    };
  }

  try {
    // Validate interaction_id
    if (!args.interaction_id || args.interaction_id.trim().length === 0) {
      throw new Error("Interaction ID cannot be empty");
    }

    const interaction = await geminiClient.getInteraction(args.interaction_id);

    log.success(`✅ [TOOL] get_research_status: ${interaction.status}`);

    return {
      success: true,
      data: interaction,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_research_status failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

// ==================== DOCUMENT TOOLS (v1.9.0) ====================

/**
 * Upload a document to Gemini Files API
 */
export async function handleUploadDocument(
  ctx: HandlerContext,
  args: {
    file_path: string;
    display_name?: string;
  }
): Promise<ToolResult<UploadDocumentResult>> {
  const startTime = Date.now();
  log.info(`🔧 [TOOL] upload_document called`);
  log.info(`  File: ${args.file_path}`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] upload_document failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
    };
  }

  try {
    // Validate file path
    if (!args.file_path || args.file_path.trim().length === 0) {
      throw new Error("File path cannot be empty");
    }

    const result = await geminiClient.uploadDocument({
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
    const errorMessage = getSanitizedErrorMessage(error);
    const durationMs = Date.now() - startTime;
    await audit.tool(
      "upload_document",
      getErrorAuditArgs("upload_document", errorMessage),
      false,
      durationMs,
      errorMessage
    );
    log.error(`❌ [TOOL] upload_document failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Query an uploaded document
 */
export async function handleQueryDocument(
  ctx: HandlerContext,
  args: {
    file_name: string;
    query: string;
    model?: string;
    additional_files?: string[];
  }
): Promise<ToolResult<QueryDocumentResult>> {
  const startTime = Date.now();
  log.info(`🔧 [TOOL] query_document called`);
  log.info(`  File: ${args.file_name}`);
  log.info(`  Query: ${args.query.substring(0, 50)}...`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] query_document failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
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

    const result = await geminiClient.queryDocument({
      fileName: args.file_name,
      query: args.query,
      model: args.model as GeminiModel | undefined,
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
    const errorMessage = getSanitizedErrorMessage(error);
    const durationMs = Date.now() - startTime;
    await audit.tool(
      "query_document",
      getErrorAuditArgs("query_document", errorMessage),
      false,
      durationMs,
      errorMessage
    );
    log.error(`❌ [TOOL] query_document failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * List all uploaded documents
 */
export async function handleListDocuments(
  ctx: HandlerContext,
  args: {
    page_size?: number;
  }
): Promise<ToolResult<ListDocumentsResult>> {
  log.info(`🔧 [TOOL] list_documents called`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] list_documents failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
    };
  }

  try {
    const result = await geminiClient.listFiles(args.page_size || 100);

    log.success(`✅ [TOOL] list_documents: ${result.totalCount} files`);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] list_documents failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Delete an uploaded document
 */
export async function handleDeleteDocument(
  ctx: HandlerContext,
  args: {
    file_name: string;
  }
): Promise<ToolResult<{ deleted: boolean; fileName: string }>> {
  log.info(`🔧 [TOOL] delete_document called`);
  log.info(`  File: ${args.file_name}`);

  // Check if Gemini is available
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] delete_document failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
    };
  }

  try {
    // Validate file name
    if (!args.file_name || args.file_name.trim().length === 0) {
      throw new Error("File name cannot be empty");
    }

    await geminiClient.deleteFile(args.file_name);

    log.success(`✅ [TOOL] delete_document: ${args.file_name} deleted`);

    return {
      success: true,
      data: { deleted: true, fileName: args.file_name },
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] delete_document failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

/**
 * Query a chunked document (v1.10.0)
 * Queries multiple chunks and aggregates results
 */
export async function handleQueryChunkedDocument(
  ctx: HandlerContext,
  args: {
    file_names: string[];
    query: string;
    model?: string;
  }
): Promise<ToolResult<{
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
  const geminiClient = getConfiguredGeminiClient(ctx);
  if (!geminiClient) {
    log.error(`❌ [TOOL] query_chunked_document failed: Gemini API key not configured`);
    return {
      success: false,
      data: null,
      error: "GEMINI_API_KEY is not configured.",
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

    const result = await geminiClient.queryChunkedDocument(
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
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] query_chunked_document failed: ${errorMessage}`);
    return { success: false, data: null, error: errorMessage };
  }
}

// ==================== QUERY HISTORY ====================

/**
 * Handle get_query_history tool
 */
export async function handleGetQueryHistory(
  _ctx: HandlerContext,
  args: {
    session_id?: string;
    notebook_id?: string;
    date?: string;
    search?: string;
    limit?: number;
  }
): Promise<ToolResult<{
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
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_query_history failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

// ==================== CHAT HISTORY ====================

/**
 * Handle get_notebook_chat_history tool
 *
 * Extracts conversation history from a NotebookLM notebook's chat UI
 */
export async function handleGetNotebookChatHistory(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    preview_only?: boolean;
    limit?: number;
    offset?: number;
    output_file?: string;
    show_browser?: boolean;
  }
): Promise<ToolResult<{
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
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        return {
          success: false,
          data: null,
          error: `Notebook not found: ${args.notebook_id}. Use list_notebooks to see available notebooks.`,
        };
      }
      notebookUrl = notebook.url;
      notebookName = notebook.name;
    } else {
      // Try to use active notebook
      const activeNotebook = ctx.library.getActiveNotebook();
      if (!activeNotebook) {
        return {
          success: false,
          data: null,
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
    const session = await ctx.sessionManager.getOrCreateSession(sessionId, notebookUrl);

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
      await ctx.sessionManager.closeSession(sessionId);
    }
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_notebook_chat_history failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}
