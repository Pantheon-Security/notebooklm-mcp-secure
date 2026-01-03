#!/usr/bin/env node

/**
 * NotebookLM MCP Server
 *
 * MCP Server for Google NotebookLM - Chat with Gemini 2.5 through NotebookLM
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

  constructor() {
    // Initialize MCP Server
    this.server = new Server(
      {
        name: "notebooklm-mcp",
        version: "1.1.0",
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
      const authResult = await authenticateMCPRequest(authToken, name);
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
        let result;

        switch (name) {
          case "ask_question":
            result = await this.toolHandlers.handleAskQuestion(
              args as {
                question: string;
                session_id?: string;
                notebook_id?: string;
                notebook_url?: string;
                show_browser?: boolean;
              },
              sendProgress
            );
            break;

          case "add_notebook":
            result = await this.toolHandlers.handleAddNotebook(
              args as {
                url: string;
                name: string;
                description: string;
                topics: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
              }
            );
            break;

          case "list_notebooks":
            result = await this.toolHandlers.handleListNotebooks();
            break;

          case "get_notebook":
            result = await this.toolHandlers.handleGetNotebook(
              args as { id: string }
            );
            break;

          case "select_notebook":
            result = await this.toolHandlers.handleSelectNotebook(
              args as { id: string }
            );
            break;

          case "update_notebook":
            result = await this.toolHandlers.handleUpdateNotebook(
              args as {
                id: string;
                name?: string;
                description?: string;
                topics?: string[];
                content_types?: string[];
                use_cases?: string[];
                tags?: string[];
                url?: string;
              }
            );
            break;

          case "remove_notebook":
            result = await this.toolHandlers.handleRemoveNotebook(
              args as { id: string }
            );
            break;

          case "search_notebooks":
            result = await this.toolHandlers.handleSearchNotebooks(
              args as { query: string }
            );
            break;

          case "get_library_stats":
            result = await this.toolHandlers.handleGetLibraryStats();
            break;

          case "export_library":
            result = await this.toolHandlers.handleExportLibrary(
              args as { format?: "json" | "csv"; output_path?: string }
            );
            break;

          case "get_quota":
            result = await this.toolHandlers.handleGetQuota(
              args as { sync?: boolean }
            );
            break;

          case "set_quota_tier":
            result = await this.toolHandlers.handleSetQuotaTier(
              args as { tier: "free" | "pro" | "ultra" }
            );
            break;

          case "get_project_info":
            result = await this.toolHandlers.handleGetProjectInfo();
            break;

          case "create_notebook":
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            result = await this.toolHandlers.handleCreateNotebook(
              args as any,
              sendProgress
            );
            break;

          case "list_sessions":
            result = await this.toolHandlers.handleListSessions();
            break;

          case "close_session":
            result = await this.toolHandlers.handleCloseSession(
              args as { session_id: string }
            );
            break;

          case "reset_session":
            result = await this.toolHandlers.handleResetSession(
              args as { session_id: string }
            );
            break;

          case "get_health":
            result = await this.toolHandlers.handleGetHealth();
            break;

          case "setup_auth":
            result = await this.toolHandlers.handleSetupAuth(
              args as { show_browser?: boolean },
              sendProgress
            );
            break;

          case "re_auth":
            result = await this.toolHandlers.handleReAuth(
              args as { show_browser?: boolean },
              sendProgress
            );
            break;

          case "cleanup_data":
            result = await this.toolHandlers.handleCleanupData(
              args as { confirm: boolean }
            );
            break;

          case "sync_library":
            result = await this.toolHandlers.handleSyncLibrary(
              args as { auto_fix?: boolean; show_browser?: boolean }
            );
            break;

          case "batch_create_notebooks":
            result = await this.toolHandlers.handleBatchCreateNotebooks(
              args as {
                notebooks: Array<{
                  name: string;
                  sources: Array<{ type: "url" | "text" | "file"; value: string; title?: string }>;
                  description?: string;
                  topics?: string[];
                }>;
                stop_on_error?: boolean;
                show_browser?: boolean;
              },
              sendProgress
            );
            break;

          case "list_sources":
            result = await this.toolHandlers.handleListSources(
              args as { notebook_id?: string; notebook_url?: string }
            );
            break;

          case "add_source":
            result = await this.toolHandlers.handleAddSource(
              args as {
                notebook_id?: string;
                notebook_url?: string;
                source: { type: "url" | "text" | "file"; value: string; title?: string };
              }
            );
            break;

          case "remove_source":
            result = await this.toolHandlers.handleRemoveSource(
              args as {
                notebook_id?: string;
                notebook_url?: string;
                source_id: string;
              }
            );
            break;

          case "generate_audio_overview":
            result = await this.toolHandlers.handleGenerateAudioOverview(
              args as { notebook_id?: string; notebook_url?: string }
            );
            break;

          case "get_audio_status":
            result = await this.toolHandlers.handleGetAudioStatus(
              args as { notebook_id?: string; notebook_url?: string }
            );
            break;

          case "download_audio":
            result = await this.toolHandlers.handleDownloadAudio(
              args as {
                notebook_id?: string;
                notebook_url?: string;
                output_path?: string;
              }
            );
            break;

          case "configure_webhook":
            result = await this.toolHandlers.handleConfigureWebhook(
              args as {
                id?: string;
                name: string;
                url: string;
                enabled?: boolean;
                events?: string[];
                format?: "generic" | "slack" | "discord" | "teams";
                secret?: string;
              }
            );
            break;

          case "list_webhooks":
            result = await this.toolHandlers.handleListWebhooks();
            break;

          case "test_webhook":
            result = await this.toolHandlers.handleTestWebhook(
              args as { id: string }
            );
            break;

          case "remove_webhook":
            result = await this.toolHandlers.handleRemoveWebhook(
              args as { id: string }
            );
            break;

          // Gemini API tools
          case "deep_research":
            result = await this.toolHandlers.handleDeepResearch(
              args as {
                query: string;
                wait_for_completion?: boolean;
                max_wait_seconds?: number;
              },
              sendProgress
            );
            break;

          case "gemini_query":
            // Type assertion for Gemini-specific types
            result = await this.toolHandlers.handleGeminiQuery({
              query: (args as { query: string }).query,
              model: (args as { model?: string }).model as import("./gemini/types.js").GeminiModel | undefined,
              tools: (args as { tools?: string[] }).tools as import("./gemini/types.js").GeminiTool[] | undefined,
              urls: (args as { urls?: string[] }).urls,
              previous_interaction_id: (args as { previous_interaction_id?: string }).previous_interaction_id,
            });
            break;

          case "get_research_status":
            result = await this.toolHandlers.handleGetResearchStatus(
              args as { interaction_id: string }
            );
            break;

          // Gemini Files API tools (v1.9.0)
          case "upload_document":
            result = await this.toolHandlers.handleUploadDocument(
              args as { file_path: string; display_name?: string }
            );
            break;

          case "query_document":
            result = await this.toolHandlers.handleQueryDocument({
              file_name: (args as { file_name: string }).file_name,
              query: (args as { query: string }).query,
              model: (args as { model?: string }).model as
                | import("./gemini/types.js").GeminiModel
                | undefined,
              additional_files: (args as { additional_files?: string[] })
                .additional_files,
            });
            break;

          case "list_documents":
            result = await this.toolHandlers.handleListDocuments(
              args as { page_size?: number }
            );
            break;

          case "delete_document":
            result = await this.toolHandlers.handleDeleteDocument(
              args as { file_name: string }
            );
            break;

          // Chunked document tools (v1.10.0)
          case "query_chunked_document":
            result = await this.toolHandlers.handleQueryChunkedDocument(
              args as { file_names: string[]; query: string; model?: string }
            );
            break;

          // Query history tool
          case "get_query_history":
            result = await this.toolHandlers.handleGetQueryHistory(
              args as {
                session_id?: string;
                notebook_id?: string;
                date?: string;
                search?: string;
                limit?: number;
              }
            );
            break;

          default:
            log.error(`❌ [MCP] Unknown tool: ${name}`);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      success: false,
                      error: `Unknown tool: ${name}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
        }

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
      version: "1.2.0-secure.1",
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

  // Print banner
  console.error("╔══════════════════════════════════════════════════════════╗");
  console.error("║                                                          ║");
  console.error(`║           NotebookLM MCP Server v${VERSION.padEnd(23)}║`);
  console.error("║                                                          ║");
  console.error("║   Chat with Gemini 2.5 through NotebookLM via MCP       ║");
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
