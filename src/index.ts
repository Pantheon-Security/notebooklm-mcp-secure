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
import { CONFIG } from "./config.js";
import { log } from "./utils/logger.js";
import { audit, getAuditLogger } from "./utils/audit-logger.js";
import { checkSecurityContext } from "./utils/security.js";
import { getMCPAuthenticator, authenticateMCPRequest } from "./auth/mcp-auth.js";

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
  private toolRegistry!: Map<string, (a: any, p?: (message: string, progress?: number, total?: number) => Promise<void>) => Promise<any>>;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.toolRegistry = new Map<string, (a: any, p?: any) => Promise<any>>([
      // Ask Question
      ["ask_question", (a: any, p?: any) => this.toolHandlers.handleAskQuestion(a, p)],
      // Notebook Management
      ["add_notebook", (a: any) => this.toolHandlers.handleAddNotebook(a)],
      ["list_notebooks", () => this.toolHandlers.handleListNotebooks()],
      ["get_notebook", (a: any) => this.toolHandlers.handleGetNotebook(a)],
      ["select_notebook", (a: any) => this.toolHandlers.handleSelectNotebook(a)],
      ["update_notebook", (a: any) => this.toolHandlers.handleUpdateNotebook(a)],
      ["remove_notebook", (a: any) => this.toolHandlers.handleRemoveNotebook(a)],
      ["search_notebooks", (a: any) => this.toolHandlers.handleSearchNotebooks(a)],
      ["get_library_stats", () => this.toolHandlers.handleGetLibraryStats()],
      ["export_library", (a: any) => this.toolHandlers.handleExportLibrary(a)],
      // Quota & System
      ["get_quota", (a: any) => this.toolHandlers.handleGetQuota(a)],
      ["set_quota_tier", (a: any) => this.toolHandlers.handleSetQuotaTier(a)],
      ["get_project_info", () => this.toolHandlers.handleGetProjectInfo()],
      // Notebook Creation
      ["create_notebook", (a: any, p?: any) => this.toolHandlers.handleCreateNotebook(a, p)],
      ["batch_create_notebooks", (a: any, p?: any) => this.toolHandlers.handleBatchCreateNotebooks(a, p)],
      ["sync_library", (a: any) => this.toolHandlers.handleSyncLibrary(a)],
      // Session Management
      ["list_sessions", () => this.toolHandlers.handleListSessions()],
      ["close_session", (a: any) => this.toolHandlers.handleCloseSession(a)],
      ["reset_session", (a: any) => this.toolHandlers.handleResetSession(a)],
      ["get_health", (a: any) => this.toolHandlers.handleGetHealth(a)],
      // Auth
      ["setup_auth", (a: any, p?: any) => this.toolHandlers.handleSetupAuth(a, p)],
      ["re_auth", (a: any, p?: any) => this.toolHandlers.handleReAuth(a, p)],
      ["cleanup_data", (a: any) => this.toolHandlers.handleCleanupData(a)],
      // Sources
      ["list_sources", (a: any) => this.toolHandlers.handleListSources(a)],
      ["add_source", (a: any) => this.toolHandlers.handleAddSource(a)],
      ["add_folder", (a: any, p?: any) => this.toolHandlers.handleAddFolder(a, p)],
      ["remove_source", (a: any) => this.toolHandlers.handleRemoveSource(a)],
      // Audio / Video / Data Table
      ["generate_audio_overview", (a: any) => this.toolHandlers.handleGenerateAudioOverview(a)],
      ["get_audio_status", (a: any) => this.toolHandlers.handleGetAudioStatus(a)],
      ["download_audio", (a: any) => this.toolHandlers.handleDownloadAudio(a)],
      ["generate_video_overview", (a: any) => this.toolHandlers.handleGenerateVideoOverview(a)],
      ["get_video_status", (a: any) => this.toolHandlers.handleGetVideoStatus(a)],
      ["generate_data_table", (a: any) => this.toolHandlers.handleGenerateDataTable(a)],
      ["get_data_table", (a: any) => this.toolHandlers.handleGetDataTable(a)],
      ["generate_slides", (a: any) => this.toolHandlers.handleGenerateSlides(a)],
      ["get_slides_status", (a: any) => this.toolHandlers.handleGetSlidesStatus(a)],
      ["revise_slides", (a: any) => this.toolHandlers.handleReviseSlides(a)],
      ["download_slides", (a: any) => this.toolHandlers.handleDownloadSlides(a)],
      ["generate_infographic", (a: any) => this.toolHandlers.handleGenerateInfographic(a)],
      ["get_infographic_status", (a: any) => this.toolHandlers.handleGetInfographicStatus(a)],
      ["download_infographic", (a: any) => this.toolHandlers.handleDownloadInfographic(a)],
      ["research_sources", (a: any) => this.toolHandlers.handleResearchSources(a)],
      ["get_source_discovery_status", (a: any) => this.toolHandlers.handleGetSourceDiscoveryStatus(a)],
      ["import_research_results", (a: any) => this.toolHandlers.handleImportResearchResults(a)],
      // Webhooks
      ["configure_webhook", (a: any) => this.toolHandlers.handleConfigureWebhook(a)],
      ["list_webhooks", () => this.toolHandlers.handleListWebhooks()],
      ["test_webhook", (a: any) => this.toolHandlers.handleTestWebhook(a)],
      ["remove_webhook", (a: any) => this.toolHandlers.handleRemoveWebhook(a)],
      // Gemini API
      ["deep_research", (a: any, p?: any) => this.toolHandlers.handleDeepResearch(a, p)],
      ["gemini_query", (a: any) => this.toolHandlers.handleGeminiQuery(a)],
      ["get_research_status", (a: any) => this.toolHandlers.handleGetResearchStatus(a)],
      ["upload_document", (a: any) => this.toolHandlers.handleUploadDocument(a)],
      ["query_document", (a: any) => this.toolHandlers.handleQueryDocument(a)],
      ["list_documents", (a: any) => this.toolHandlers.handleListDocuments(a)],
      ["delete_document", (a: any) => this.toolHandlers.handleDeleteDocument(a)],
      ["query_chunked_document", (a: any) => this.toolHandlers.handleQueryChunkedDocument(a)],
      ["get_query_history", (a: any) => this.toolHandlers.handleGetQueryHistory(a)],
      ["get_notebook_chat_history", (a: any) => this.toolHandlers.handleGetNotebookChatHistory(a)],
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
      const progressToken = (args as any)?._meta?.progressToken;
      const authToken = (args as any)?._meta?.authToken || process.env.NLMCP_AUTH_TOKEN;

      log.info(`🔧 [MCP] Tool call: ${name}`);
      if (progressToken) {
        log.info(`  📊 Progress token: ${progressToken}`);
      }

      // === SECURITY: MCP Authentication ===
      // Tools that access the filesystem always require auth, even if globally disabled
      const TOOLS_REQUIRING_AUTH = ["add_folder", "cleanup_data", "export_library"];
      const requiresAuth = TOOLS_REQUIRING_AUTH.includes(name);

      const authResult = requiresAuth
        ? await authenticateMCPRequest(authToken, name, true)
        : await authenticateMCPRequest(authToken, name);
      if (!authResult.authenticated) {
        log.warning(`🔒 [MCP] Authentication failed for tool: ${name}`);
        return {
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
        const handler = this.toolRegistry.get(name);
        if (!handler) {
          log.error(`❌ [MCP] Unknown tool: ${name}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }, null, 2),
              },
            ],
          };
        }

        const result = await handler(args, sendProgress);

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
   * Start the MCP server
   */
  async start(): Promise<void> {
    log.info("🎯 Starting NotebookLM MCP Server (Security Hardened)...");
    log.info("");

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
