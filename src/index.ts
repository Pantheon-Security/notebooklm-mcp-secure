#!/usr/bin/env node

/**
 * NotebookLM MCP Server
 *
 * MCP Server for Google NotebookLM - Chat with Gemini 3 through NotebookLM
 * with session support and human-like behavior!
 *
 * Features:
 * - Session-based contextual conversations
 * - Auto re-login on session expiry
 * - Human-like typing and mouse movements
 * - Persistent browser fingerprint
 * - Stealth mode with Patchright
 * - Claude Code integration via npx
 *
 * Usage:
 *   npx notebooklm-mcp
 *   node dist/index.js
 *
 * Environment Variables:
 *   NOTEBOOK_URL - Default NotebookLM notebook URL
 *   AUTO_LOGIN_ENABLED - Enable automatic login (true/false)
 *   LOGIN_EMAIL - Google email for auto-login
 *   LOGIN_PASSWORD - Google password for auto-login
 *   HEADLESS - Run browser in headless mode (true/false)
 *   MAX_SESSIONS - Maximum concurrent sessions (default: 10)
 *   SESSION_TIMEOUT - Session timeout in seconds (default: 900)
 *
 * Based on the Python NotebookLM API implementation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { createRequire } from "module";
import { AuthManager } from "./auth/auth-manager.js";
import { SessionManager } from "./session/session-manager.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const VERSION = packageJson.version;
import { NotebookLibrary } from "./library/notebook-library.js";
import { ToolHandlers, buildToolDefinitions } from "./tools/index.js";
import { ResourceHandlers } from "./resources/resource-handlers.js";
import { SettingsManager } from "./utils/settings-manager.js";
import { CliHandler } from "./utils/cli-handler.js";
import { CONFIG, ensureDirectories } from "./config.js";
import { log } from "./utils/logger.js";
import { audit, getAuditLogger } from "./utils/audit-logger.js";
import { checkSecurityContext } from "./utils/security.js";
import { getMCPAuthenticator, authenticateMCPRequest } from "./auth/mcp-auth.js";
import {
  getComplianceTools,
  handleComplianceToolCall,
} from "./compliance/compliance-tools.js";
import { getPrivacyNoticeManager, getPrivacyNoticeCLIText } from "./compliance/privacy-notice.js";
import { runRetentionPolicies } from "./compliance/retention-engine.js";
import { getBreachDetector } from "./compliance/breach-detection.js";
import type { ToolResult } from "./types.js";

type ProgressReporter = (message: string, progress?: number, total?: number) => Promise<void>;
type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs, progress?: ProgressReporter) => Promise<ToolResult>;
type ToolErrorType = "transport" | "domain";

const LIST_TOOLS_PAGE_SIZE = 25;

const TOOL_NAMES = [
  "ask_question", "add_notebook", "list_notebooks", "get_notebook", "select_notebook",
  "update_notebook", "remove_notebook", "search_notebooks", "get_library_stats",
  "export_library", "get_quota", "set_quota_tier", "get_project_info", "create_notebook",
  "batch_create_notebooks", "sync_library", "list_sessions", "close_session", "reset_session",
  "get_health", "setup_auth", "re_auth", "cleanup_data", "list_sources", "add_source",
  "add_folder", "remove_source", "generate_audio_overview", "get_audio_status", "download_audio",
  "generate_video_overview", "get_video_status", "generate_data_table", "get_data_table",
  "configure_webhook", "list_webhooks", "test_webhook", "remove_webhook", "deep_research",
  "gemini_query", "get_research_status", "upload_document", "query_document", "list_documents",
  "delete_document", "query_chunked_document", "get_query_history", "get_notebook_chat_history",
  "submit_dsar", "export_user_data", "request_data_erasure", "get_data_inventory",
  "get_privacy_notice", "get_compliance_report", "check_breach_risk", "manage_consent",
  "grant_consent", "revoke_consent", "report_security_incident", "collect_audit_evidence",
  "generate_compliance_report",
] as const;

type ToolName = typeof TOOL_NAMES[number];

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function toToolArgs(value: unknown): ToolArgs {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  return {};
}

function asToolInput<T>(args: ToolArgs): T {
  return args as T;
}

function parseListToolsCursor(cursor: string | undefined, totalTools: number): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isInteger(offset) || offset < 0 || offset >= totalTools) return 0;
  return offset;
}

function classifyToolError(error: unknown): ToolErrorType {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(transport|protocol|json-?rpc|connection|stdio|notification)\b/i.test(message)
    ? "transport"
    : "domain";
}

const TOOLS_EXEMPT_FROM_AUTH = new Set<ToolName>([
  "ask_question", "add_notebook", "list_notebooks", "get_notebook", "select_notebook",
  "update_notebook", "remove_notebook", "search_notebooks", "get_library_stats",
  "get_quota", "set_quota_tier", "get_project_info", "create_notebook",
  "batch_create_notebooks", "sync_library", "list_sessions", "close_session", "reset_session",
  "get_health", "list_sources", "add_source", "remove_source",
  "generate_audio_overview", "get_audio_status", "generate_video_overview", "get_video_status",
  "generate_data_table", "get_data_table", "list_webhooks",
  "deep_research", "gemini_query", "get_research_status",
  "query_document", "list_documents", "query_chunked_document",
  "get_query_history", "get_notebook_chat_history",
]);

const TOOLS_REQUIRING_AUTH = new Set<ToolName>([
  "add_folder",
  "cleanup_data",
  "export_library",
  "setup_auth",
  "re_auth",
  "configure_webhook",
  "remove_webhook",
  "test_webhook",
  "delete_document",
  "upload_document",
  "download_audio",
  // Compliance — destructive or privileged operations.
  "submit_dsar",
  "export_user_data",
  "request_data_erasure",
  "grant_consent",
  "revoke_consent",
  "report_security_incident",
  "collect_audit_evidence",
  "generate_compliance_report",
]);

const ADVANCED_TOOLS = new Set<ToolName>([
  "export_library",
  "list_sessions",
  "close_session",
  "reset_session",
  "cleanup_data",
  "configure_webhook",
  "list_webhooks",
  "test_webhook",
  "remove_webhook",
  "deep_research",
  "gemini_query",
  "get_research_status",
  "upload_document",
  "query_document",
  "list_documents",
  "delete_document",
  "query_chunked_document",
  "get_query_history",
  "get_notebook_chat_history",
  "submit_dsar",
  "export_user_data",
  "request_data_erasure",
  "get_data_inventory",
  "get_privacy_notice",
  "get_compliance_report",
  "check_breach_risk",
  "manage_consent",
  "grant_consent",
  "revoke_consent",
  "report_security_incident",
  "collect_audit_evidence",
  "generate_compliance_report",
]);

/**
 * Main MCP Server Class
 */
class NotebookLMMCPServer {
  private server: Server;
  private authManager: AuthManager;
  private sessionManager: SessionManager;
  private library: NotebookLibrary;
  private toolHandlers: ToolHandlers;
  private resourceHandlers: ResourceHandlers;
  private settingsManager: SettingsManager;
  private toolDefinitions: Tool[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toolRegistry!: Map<string, ToolHandler>;
  private complianceToolNames: Set<string>;
  private retentionTimer?: NodeJS.Timeout;
  private readonly advancedToolsEnabled: boolean;

  constructor() {
    // Initialize MCP Server
    this.server = new Server(
      {
        name: "notebooklm-mcp",
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
          completions: {}, // Required for completion/complete handler
        },
      }
    );

    // Initialize managers
    this.authManager = new AuthManager();
    this.sessionManager = new SessionManager(this.authManager);
    this.library = new NotebookLibrary();
    this.settingsManager = new SettingsManager();
    this.advancedToolsEnabled = process.env.NLMCP_ADVANCED_TOOLS === "1";
    
    // Initialize handlers
    this.toolHandlers = new ToolHandlers(
      this.sessionManager,
      this.authManager,
      this.library
    );
    this.resourceHandlers = new ResourceHandlers(this.library);

    // Build and Filter tool definitions
    const allTools = buildToolDefinitions(this.library);
    this.toolDefinitions = this.filterAdvancedTools(this.settingsManager.filterTools(allTools));

    // Track compliance tool names for the short-circuit dispatch path.
    this.complianceToolNames = new Set(
      this.filterAdvancedTools(getComplianceTools()).map((t) => t.name)
    );

    // Setup handlers
    this.setupHandlers();
    this.setupShutdownHandlers();

    const activeSettings = this.settingsManager.getEffectiveSettings();
    log.info("🚀 NotebookLM MCP Server initialized");
    log.info(`  Version: ${VERSION}`);
    log.info(`  Node: ${process.version}`);
    log.info(`  Platform: ${process.platform}`);
    log.info(`  Profile: ${activeSettings.profile} (${this.toolDefinitions.length} tools active)`);
    log.info(`  Advanced tools: ${this.advancedToolsEnabled ? "enabled" : "disabled"}`);
  }

  private filterAdvancedTools<T extends { name: string }>(tools: T[]): T[] {
    if (this.advancedToolsEnabled) return tools;
    return tools.filter((tool) => !isToolName(tool.name) || !ADVANCED_TOOLS.has(tool.name));
  }

  private filterAdvancedToolRegistry(registry: Map<string, ToolHandler>): Map<string, ToolHandler> {
    if (this.advancedToolsEnabled) return registry;
    return new Map(
      Array.from(registry.entries()).filter(
        ([name]) => !isToolName(name) || !ADVANCED_TOOLS.has(name)
      )
    );
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // Register Resource Handlers (Resources, Templates, Completions)
    this.resourceHandlers.registerHandlers(this.server);

    // Build tool registry once (not per-request)
    this.toolRegistry = this.filterAdvancedToolRegistry(new Map<string, ToolHandler>([
      // Ask Question
      ["ask_question", (args, progress) => this.toolHandlers.handleAskQuestion(asToolInput<Parameters<ToolHandlers["handleAskQuestion"]>[0]>(args), progress)],
      // Notebook Management
      ["add_notebook", (args) => this.toolHandlers.handleAddNotebook(asToolInput<Parameters<ToolHandlers["handleAddNotebook"]>[0]>(args))],
      ["list_notebooks", () => this.toolHandlers.handleListNotebooks()],
      ["get_notebook", (args) => this.toolHandlers.handleGetNotebook(asToolInput<Parameters<ToolHandlers["handleGetNotebook"]>[0]>(args))],
      ["select_notebook", (args) => this.toolHandlers.handleSelectNotebook(asToolInput<Parameters<ToolHandlers["handleSelectNotebook"]>[0]>(args))],
      ["update_notebook", (args) => this.toolHandlers.handleUpdateNotebook(asToolInput<Parameters<ToolHandlers["handleUpdateNotebook"]>[0]>(args))],
      ["remove_notebook", (args) => this.toolHandlers.handleRemoveNotebook(asToolInput<Parameters<ToolHandlers["handleRemoveNotebook"]>[0]>(args))],
      ["search_notebooks", (args) => this.toolHandlers.handleSearchNotebooks(asToolInput<Parameters<ToolHandlers["handleSearchNotebooks"]>[0]>(args))],
      ["get_library_stats", () => this.toolHandlers.handleGetLibraryStats()],
      ["export_library", (args) => this.toolHandlers.handleExportLibrary(asToolInput<Parameters<ToolHandlers["handleExportLibrary"]>[0]>(args))],
      // Quota & System
      ["get_quota", (args) => this.toolHandlers.handleGetQuota(asToolInput<Parameters<ToolHandlers["handleGetQuota"]>[0]>(args))],
      ["set_quota_tier", (args) => this.toolHandlers.handleSetQuotaTier(asToolInput<Parameters<ToolHandlers["handleSetQuotaTier"]>[0]>(args))],
      ["get_project_info", () => this.toolHandlers.handleGetProjectInfo()],
      // Notebook Creation
      ["create_notebook", (args, progress) => this.toolHandlers.handleCreateNotebook(asToolInput<Parameters<ToolHandlers["handleCreateNotebook"]>[0]>(args), progress)],
      ["batch_create_notebooks", (args, progress) => this.toolHandlers.handleBatchCreateNotebooks(asToolInput<Parameters<ToolHandlers["handleBatchCreateNotebooks"]>[0]>(args), progress)],
      ["sync_library", (args) => this.toolHandlers.handleSyncLibrary(asToolInput<Parameters<ToolHandlers["handleSyncLibrary"]>[0]>(args))],
      // Session Management
      ["list_sessions", () => this.toolHandlers.handleListSessions()],
      ["close_session", (args) => this.toolHandlers.handleCloseSession(asToolInput<Parameters<ToolHandlers["handleCloseSession"]>[0]>(args))],
      ["reset_session", (args) => this.toolHandlers.handleResetSession(asToolInput<Parameters<ToolHandlers["handleResetSession"]>[0]>(args))],
      ["get_health", (args) => this.toolHandlers.handleGetHealth(asToolInput<Parameters<ToolHandlers["handleGetHealth"]>[0]>(args))],
      // Auth
      ["setup_auth", (args, progress) => this.toolHandlers.handleSetupAuth(asToolInput<Parameters<ToolHandlers["handleSetupAuth"]>[0]>(args), progress)],
      ["re_auth", (args, progress) => this.toolHandlers.handleReAuth(asToolInput<Parameters<ToolHandlers["handleReAuth"]>[0]>(args), progress)],
      ["cleanup_data", (args) => this.toolHandlers.handleCleanupData(asToolInput<Parameters<ToolHandlers["handleCleanupData"]>[0]>(args))],
      // Sources
      ["list_sources", (args) => this.toolHandlers.handleListSources(asToolInput<Parameters<ToolHandlers["handleListSources"]>[0]>(args))],
      ["add_source", (args) => this.toolHandlers.handleAddSource(asToolInput<Parameters<ToolHandlers["handleAddSource"]>[0]>(args))],
      ["add_folder", (args, progress) => this.toolHandlers.handleAddFolder(asToolInput<Parameters<ToolHandlers["handleAddFolder"]>[0]>(args), progress)],
      ["remove_source", (args) => this.toolHandlers.handleRemoveSource(asToolInput<Parameters<ToolHandlers["handleRemoveSource"]>[0]>(args))],
      // Audio / Video / Data Table
      ["generate_audio_overview", (args) => this.toolHandlers.handleGenerateAudioOverview(asToolInput<Parameters<ToolHandlers["handleGenerateAudioOverview"]>[0]>(args))],
      ["get_audio_status", (args) => this.toolHandlers.handleGetAudioStatus(asToolInput<Parameters<ToolHandlers["handleGetAudioStatus"]>[0]>(args))],
      ["download_audio", (args) => this.toolHandlers.handleDownloadAudio(asToolInput<Parameters<ToolHandlers["handleDownloadAudio"]>[0]>(args))],
      ["generate_video_overview", (args) => this.toolHandlers.handleGenerateVideoOverview(asToolInput<Parameters<ToolHandlers["handleGenerateVideoOverview"]>[0]>(args))],
      ["get_video_status", (args) => this.toolHandlers.handleGetVideoStatus(asToolInput<Parameters<ToolHandlers["handleGetVideoStatus"]>[0]>(args))],
      ["generate_data_table", (args) => this.toolHandlers.handleGenerateDataTable(asToolInput<Parameters<ToolHandlers["handleGenerateDataTable"]>[0]>(args))],
      ["get_data_table", (args) => this.toolHandlers.handleGetDataTable(asToolInput<Parameters<ToolHandlers["handleGetDataTable"]>[0]>(args))],
      // Webhooks
      ["configure_webhook", (args) => this.toolHandlers.handleConfigureWebhook(asToolInput<Parameters<ToolHandlers["handleConfigureWebhook"]>[0]>(args))],
      ["list_webhooks", () => this.toolHandlers.handleListWebhooks()],
      ["test_webhook", (args) => this.toolHandlers.handleTestWebhook(asToolInput<Parameters<ToolHandlers["handleTestWebhook"]>[0]>(args))],
      ["remove_webhook", (args) => this.toolHandlers.handleRemoveWebhook(asToolInput<Parameters<ToolHandlers["handleRemoveWebhook"]>[0]>(args))],
      // Gemini API
      ["deep_research", (args, progress) => this.toolHandlers.handleDeepResearch(asToolInput<Parameters<ToolHandlers["handleDeepResearch"]>[0]>(args), progress)],
      ["gemini_query", (args) => this.toolHandlers.handleGeminiQuery(asToolInput<Parameters<ToolHandlers["handleGeminiQuery"]>[0]>(args))],
      ["get_research_status", (args) => this.toolHandlers.handleGetResearchStatus(asToolInput<Parameters<ToolHandlers["handleGetResearchStatus"]>[0]>(args))],
      ["upload_document", (args) => this.toolHandlers.handleUploadDocument(asToolInput<Parameters<ToolHandlers["handleUploadDocument"]>[0]>(args))],
      ["query_document", (args) => this.toolHandlers.handleQueryDocument(asToolInput<Parameters<ToolHandlers["handleQueryDocument"]>[0]>(args))],
      ["list_documents", (args) => this.toolHandlers.handleListDocuments(asToolInput<Parameters<ToolHandlers["handleListDocuments"]>[0]>(args))],
      ["delete_document", (args) => this.toolHandlers.handleDeleteDocument(asToolInput<Parameters<ToolHandlers["handleDeleteDocument"]>[0]>(args))],
      ["query_chunked_document", (args) => this.toolHandlers.handleQueryChunkedDocument(asToolInput<Parameters<ToolHandlers["handleQueryChunkedDocument"]>[0]>(args))],
      ["get_query_history", (args) => this.toolHandlers.handleGetQueryHistory(asToolInput<Parameters<ToolHandlers["handleGetQueryHistory"]>[0]>(args))],
      ["get_notebook_chat_history", (args) => this.toolHandlers.handleGetNotebookChatHistory(asToolInput<Parameters<ToolHandlers["handleGetNotebookChatHistory"]>[0]>(args))],
    ]));

    // Startup assertion: every registered tool must be explicitly auth-classified (I313)
    for (const toolName of this.toolRegistry.keys()) {
      if (isToolName(toolName) && !TOOLS_REQUIRING_AUTH.has(toolName) && !TOOLS_EXEMPT_FROM_AUTH.has(toolName)) {
        log.warning(`⚠️ Tool '${toolName}' not in auth lists — defaulting to unauthenticated`);
      }
    }

    // List available tools — rebuild each call so ask_question description reflects current notebook (I022)
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      log.info("📋 [MCP] list_tools request received");
      const allTools = buildToolDefinitions(this.library);
      const tools = this.filterAdvancedTools(this.settingsManager.filterTools(allTools));
      const offset = parseListToolsCursor(request.params?.cursor, tools.length);
      const page = tools.slice(offset, offset + LIST_TOOLS_PAGE_SIZE);
      const nextOffset = offset + page.length;

      return {
        tools: page,
        ...(nextOffset < tools.length && { nextCursor: String(nextOffset) }),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      // Per MCP spec, _meta lives on request.params, not inside arguments
      const meta = (request.params as { _meta?: { progressToken?: string | number; authToken?: string } })._meta;
      const progressToken = meta?.progressToken;
      const authToken = meta?.authToken || process.env.NLMCP_AUTH_TOKEN;

      log.info(`🔧 [MCP] Tool call: ${name}`);
      if (progressToken) {
        log.info(`  📊 Progress token: ${progressToken}`);
      }

      // === SECURITY: MCP Authentication ===
      // Tools that touch the filesystem, wipe credentials, dispatch outbound
      // HTTP, delete remote resources, or exercise GDPR data-subject rights
      // always require auth, even if globally disabled via NLMCP_AUTH_DISABLED.
      const requiresAuth = isToolName(name) && TOOLS_REQUIRING_AUTH.has(name);

      const authResult = requiresAuth
        ? await authenticateMCPRequest(authToken, name, true)
        : await authenticateMCPRequest(authToken, name);
      if (!authResult.authenticated) {
        log.warning(`🔒 [MCP] Authentication failed for tool: ${name}`);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: authResult.error || "Authentication required",
                _errorType: "domain",
              }),
            },
          ],
        };
      }

      // Create progress callback function
      const sendProgress = async (message: string, progress?: number, total?: number) => {
        if (progressToken) {
          await this.server.notification({
            method: "notifications/progress",
            params: {
              progressToken,
              message,
              ...(progress !== undefined && { progress }),
              ...(total !== undefined && { total }),
            },
          });
          log.dim(`  📊 Progress: ${message}`);
        }
      };

      try {
        // Compliance tools have their own dispatcher that returns MCP-shaped
        // TextContent[] directly. Short-circuit before the generic wrapper
        // so dashboard/report text isn't double-encoded as JSON.
        if (this.complianceToolNames.has(name)) {
          const content = await handleComplianceToolCall(name, toToolArgs(args));
          return { content };
        }

        const handler = this.toolRegistry.get(name);
        if (!handler) {
          log.error(`❌ [MCP] Unknown tool: ${name}`);
          const errorBody = {
            success: false,
            error: `Unknown tool: ${name}`,
            _errorType: "domain" as const,
          };
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(errorBody, null, 2),
              },
            ],
            structuredContent: errorBody,
          };
        }

        const result = await handler(toToolArgs(args), sendProgress);

        // Return result
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const errorType = classifyToolError(error);
        log.error(`❌ [MCP] Tool execution error for '${name}': ${rawMessage}`);

        // Sanitize before returning to client: strip absolute paths and stack fragments (I328)
        const sanitized = rawMessage
          .replace(/(?:\/[^\s/:,'"]+)+/g, "[path]")
          .replace(/\bat\s+\S+\s+\(\S+:\d+:\d+\)/g, "")
          .trim();

        const errorBody = {
          success: false,
          error: sanitized,
          _errorType: errorType,
        };

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(errorBody, null, 2),
            },
          ],
          structuredContent: errorBody,
        };
      }
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    let shuttingDown = false;

    const flushFatalError = async (signal: string, error?: unknown) => {
      if (signal !== "uncaughtException" && signal !== "unhandledRejection") return;

      const message = error instanceof Error ? error.message : String(error ?? signal);
      try {
        await this.server.notification({
          method: "notifications/message",
          params: {
            level: "error",
            logger: "notebooklm-mcp",
            data: {
              success: false,
              error: message,
              _errorType: "transport",
              signal,
            },
          },
        });
      } catch (notifyError) {
        log.warning(
          `⚠️ Failed to flush fatal MCP error notification: ${
            notifyError instanceof Error ? notifyError.message : String(notifyError)
          }`
        );
      }
    };

    const shutdown = async (signal: string, error?: unknown) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      log.info(`\n🛑 Received ${signal}, shutting down gracefully...`);

      try {
        await flushFatalError(signal, error);

        if (this.retentionTimer) {
          clearInterval(this.retentionTimer);
          this.retentionTimer = undefined;
        }

        // Cleanup tool handlers (closes all sessions)
        await this.toolHandlers.cleanup();

        // Close server
        await this.server.close();

        log.success("✅ Shutdown complete");
        process.exit(0);
      } catch (error) {
        log.error(`❌ Error during shutdown: ${error}`);
        process.exit(1);
      }
    };

    const requestShutdown = (signal: string, error?: unknown) => {
      void shutdown(signal, error);
    };

    process.on("SIGINT", () => requestShutdown("SIGINT"));
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));

    process.on("uncaughtException", (error) => {
      log.error(`💥 Uncaught exception: ${error}`);
      log.error(error.stack || "");
      requestShutdown("uncaughtException", error);
    });

    process.on("unhandledRejection", (reason, promise) => {
      log.error(`💥 Unhandled rejection at: ${promise}`);
      log.error(`Reason: ${reason}`);
      requestShutdown("unhandledRejection", reason);
    });
  }

  /**
   * Bootstrap the compliance module at startup:
   *   1. Display the privacy notice to stderr on first run and auto-record
   *      acknowledgment (stdio MCP cannot prompt interactively, so the
   *      notice is informational — operators wishing for explicit consent
   *      should call the `grant_consent` MCP tool).
   *   2. Run the retention engine immediately and schedule it every 6 hours
   *      so archive/delete policies actually fire. Timer is unref()'d so it
   *      does not keep the process alive on shutdown.
   */
  private async bootstrapCompliance(): Promise<void> {
    try {
      const privacy = getPrivacyNoticeManager();
      if (await privacy.needsDisplay()) {
        log.info("");
        log.info("━━━ Privacy notice (first run) ━━━");
        // Multi-line notice — write via stderr directly so formatting survives.
        process.stderr.write(getPrivacyNoticeCLIText() + "\n");
        log.info("━━━ End privacy notice ━━━");
        log.info("");
        await privacy.acknowledge("auto");
        log.info("📜 Privacy notice recorded (method=auto). Use grant_consent to record explicit consent.");
      }
    } catch (err) {
      log.warning(`⚠️ Privacy notice bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const runOnce = async () => {
        const results = await runRetentionPolicies();
        if (results.length > 0) {
          log.info(`🗂️  Retention engine ran ${results.length} policy(ies)`);
        }
      };
      await runOnce();
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      this.retentionTimer = setInterval(() => {
        void runOnce().catch((err) => log.warning(`⚠️ retention policy run failed: ${err}`));
      }, SIX_HOURS_MS);
      this.retentionTimer.unref();
    } catch (err) {
      log.warning(`⚠️ Retention engine bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Subscribe breach detector to audit event stream (I244)
    try {
      const breachDetector = getBreachDetector();
      getAuditLogger().onEvent(async (event) => {
        if (event.eventType !== "auth" && event.eventType !== "security") return;
        try {
          await breachDetector.checkEvent(event.eventName, event.details);
        } catch (err) {
          log.warning(`breach detector checkEvent failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      log.info("🛡️  Breach detector subscribed to audit events");
    } catch (err) {
      log.warning(`⚠️ Breach detector bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    log.info("🎯 Starting NotebookLM MCP Server (Security Hardened)...");
    log.info("");

    if (process.env.NODE_ENV !== "test") {
      ensureDirectories();
    }

    // Security: Check security context and warn about issues
    const securityCheck = checkSecurityContext();
    if (!securityCheck.secure) {
      log.warning("⚠️  Security warnings detected:");
      for (const warning of securityCheck.warnings) {
        log.warning(`    - ${warning}`);
      }
      log.info("");
    }

    // Security: Initialize MCP authentication
    const mcpAuth = getMCPAuthenticator();
    await mcpAuth.initialize();
    const authStatus = mcpAuth.getStatus();

    // Audit: verify hash-chain integrity from previous run (I218)
    try {
      const integrity = await getAuditLogger().verifyIntegrity();
      if (!integrity.valid) {
        log.warning(`⚠️ Audit log integrity check failed: ${integrity.errors.join(", ")}`);
      } else {
        log.info("🔒 Audit log integrity verified");
      }
    } catch (err) {
      log.warning(`⚠️ Audit integrity check error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Compliance: surface privacy notice on first run and schedule retention.
    await this.bootstrapCompliance();

    // Audit: Log server startup
    await audit.system("server_start", {
      version: VERSION,
      security_warnings: securityCheck.warnings,
      mcp_auth_enabled: authStatus.enabled,
      config: {
        headless: CONFIG.headless,
        max_sessions: CONFIG.maxSessions,
        session_timeout: CONFIG.sessionTimeout,
        stealth_enabled: CONFIG.stealthEnabled,
      },
    });

    log.info("📝 Configuration:");
    log.info(`  Config Dir: ${CONFIG.configDir}`);
    log.info(`  Data Dir: ${CONFIG.dataDir}`);
    log.info(`  Headless: ${CONFIG.headless}`);
    log.info(`  Max Sessions: ${CONFIG.maxSessions}`);
    log.info(`  Session Timeout: ${CONFIG.sessionTimeout}s`);
    log.info(`  Stealth: ${CONFIG.stealthEnabled}`);
    log.info(`  Audit Logging: ${getAuditLogger().getStats().totalEvents >= 0 ? 'enabled' : 'disabled'}`);
    log.info(`  MCP Authentication: ${authStatus.enabled ? 'enabled' : 'disabled'}`);
    log.info("");

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await this.server.connect(transport);

    log.success("✅ MCP Server connected via stdio");
    log.success("🎉 Ready to receive requests from Claude Code!");
    log.info("");
    log.info("💡 Available tools:");
    for (const tool of this.toolDefinitions) {
      const desc = tool.description ? tool.description.split('\n')[0] : 'No description'; // First line only
      log.info(`  - ${tool.name}: ${desc.substring(0, 80)}...`);
    }
    log.info("");
    log.info("📖 For documentation, see: README.md");
    log.info("");
  }
}

/**
 * Main entry point
 */
async function main() {
  // Handle CLI commands
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] === "config") {
    const cli = new CliHandler();
    await cli.handleCommand(args);
    process.exit(0);
  }

  if (args.length > 0 && args[0] === "token") {
    const { handleTokenCommand } = await import("./auth/mcp-auth.js");
    await handleTokenCommand(args.slice(1));
    process.exit(0);
  }

  // Print banner
  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║                                                          ║");
  console.error(`║           NotebookLM MCP Server v${VERSION.padEnd(23)}║`);
  console.error("║                                                          ║");
  console.error("║   Chat with Gemini 3 through NotebookLM via MCP         ║");
  console.error("║                                                          ║");
  console.error("╚══════════════════════════════════════════════════════════╝");
  console.error("");

  try {
    const server = new NotebookLMMCPServer();
    await server.start();
  } catch (error) {
    log.error(`💥 Fatal error starting server: ${error}`);
    if (error instanceof Error) {
      log.error(error.stack || "");
    }
    process.exit(1);
  }
}

// Run the server
main();
