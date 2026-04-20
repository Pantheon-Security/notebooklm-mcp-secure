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
import type { ToolResult } from "./types.js";

type ProgressReporter = (message: string, progress?: number, total?: number) => Promise<void>;
type ToolArgs = Record<string, unknown>;
type ToolHandler = (args: ToolArgs, progress?: ProgressReporter) => Promise<ToolResult>;

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
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ToolArgs;
  return {};
}

function asToolInput<T>(args: ToolArgs): T {
  return args as unknown as T;
}

const TOOLS_REQUIRING_AUTH: Array<ToolName> = [
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
];

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
          logging: {},
        },
      }
    );

    // Initialize managers
    this.authManager = new AuthManager();
    this.sessionManager = new SessionManager(this.authManager);
    this.library = new NotebookLibrary();
    this.settingsManager = new SettingsManager();
    
    // Initialize handlers
    this.toolHandlers = new ToolHandlers(
      this.sessionManager,
      this.authManager,
      this.library
    );
    this.resourceHandlers = new ResourceHandlers(this.library);

    // Build and Filter tool definitions
    const allTools = buildToolDefinitions(this.library) as Tool[];
    this.toolDefinitions = this.settingsManager.filterTools(allTools);

    // Track compliance tool names for the short-circuit dispatch path.
    this.complianceToolNames = new Set(getComplianceTools().map((t) => t.name));

    // Setup handlers
    this.setupHandlers();
    this.setupShutdownHandlers();

    const activeSettings = this.settingsManager.getEffectiveSettings();
    log.info("🚀 NotebookLM MCP Server initialized");
    log.info(`  Version: ${VERSION}`);
    log.info(`  Node: ${process.version}`);
    log.info(`  Platform: ${process.platform}`);
    log.info(`  Profile: ${activeSettings.profile} (${this.toolDefinitions.length} tools active)`);
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // Register Resource Handlers (Resources, Templates, Completions)
    this.resourceHandlers.registerHandlers(this.server);

    // Build tool registry once (not per-request)
    this.toolRegistry = new Map<string, ToolHandler>([
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
    ]);

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      log.info("📋 [MCP] list_tools request received");
      return {
        tools: this.toolDefinitions,
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
      const requiresAuth = isToolName(name) && TOOLS_REQUIRING_AUTH.includes(name);

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
          const content = await handleComplianceToolCall(name, (args ?? {}) as Record<string, unknown>);
          return { content };
        }

        const handler = this.toolRegistry.get(name);
        if (!handler) {
          log.error(`❌ [MCP] Unknown tool: ${name}`);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2),
              },
            ],
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
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        log.error(`❌ [MCP] Tool execution error: ${errorMessage}`);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    });
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    let shuttingDown = false;

    const shutdown = async (signal: string) => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      log.info(`\n🛑 Received ${signal}, shutting down gracefully...`);

      try {
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

    const requestShutdown = (signal: string) => {
      void shutdown(signal);
    };

    process.on("SIGINT", () => requestShutdown("SIGINT"));
    process.on("SIGTERM", () => requestShutdown("SIGTERM"));

    process.on("uncaughtException", (error) => {
      log.error(`💥 Uncaught exception: ${error}`);
      log.error(error.stack || "");
      requestShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      log.error(`💥 Unhandled rejection at: ${promise}`);
      log.error(`Reason: ${reason}`);
      requestShutdown("unhandledRejection");
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

    log.info("🛡️  Breach detector ready");
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
    log.info("📖 For MCP details, see: MCP_INFOS.md");
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
