import { Tool } from "@modelcontextprotocol/sdk/types.js";

function buildAuthTool(
  name: "setup_auth" | "re_auth",
  description: string
): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        show_browser: {
          type: "boolean",
          description:
            `Show browser window (simple version). Default: true for ${name === "setup_auth" ? "setup" : "re-auth"}. ` +
            "For advanced control, use browser_options instead.",
        },
        browser_options: {
          type: "object",
          description:
            "Optional browser settings. Control visibility, timeouts, and stealth behavior.",
          additionalProperties: false,
          properties: {
            show: {
              type: "boolean",
              description: `Show browser window (default: true for ${name === "setup_auth" ? "setup" : "re-auth"})`,
            },
            headless: {
              type: "boolean",
              description: `Run browser in headless mode (default: false for ${name === "setup_auth" ? "setup" : "re-auth"})`,
            },
            timeout_ms: {
              type: "number",
              description: "Browser operation timeout in milliseconds (default: 30000)",
            },
          },
        },
      },
    },
  };
}

export const systemTools: Tool[] = [
  {
    name: "get_health",
    description:
      "Get server health status including authentication state, active sessions, and configuration. " +
      "Use this to verify the server is ready before starting research workflows.\n\n" +
      "**Deep Check Mode (v2026.1.1)**\n" +
      "Set `deep_check: true` to actually verify the NotebookLM chat UI loads. " +
      "This catches stale sessions where cookies exist but the UI won't load. " +
      "Returns `chat_ui_accessible: true/false`.\n\n" +
      "If authenticated=false and having persistent issues:\n" +
      "Consider running cleanup_data(preserve_library=true) + setup_auth for fresh start with clean browser session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        deep_check: {
          type: "boolean",
          description: "If true, actually navigates to NotebookLM and verifies the chat UI loads. More reliable but slower (~5s). Use this before important query sessions.",
        },
        notebook_id: {
          type: "string",
          description: "Notebook to check (for deep_check). Defaults to active notebook or first available.",
        },
      },
    },
  },
  buildAuthTool(
    "setup_auth",
      "Google authentication for NotebookLM access - opens a browser window for manual login to your Google account. " +
      "Returns immediately after opening the browser. You have up to 10 minutes to complete the login. " +
      "Use 'get_health' tool afterwards to verify authentication was saved successfully. " +
      "Use this for first-time authentication or when auto-login credentials are not available. " +
      "For switching accounts or rate-limit workarounds, use 're_auth' tool instead.\n\n" +
      "TROUBLESHOOTING for persistent auth issues:\n" +
      "If setup_auth fails or you encounter browser/session issues:\n" +
      "1. Ask user to close ALL Chrome/Chromium instances\n" +
      "2. Run cleanup_data(confirm=true, preserve_library=true) to clean old data\n" +
      "3. Run setup_auth again for fresh start\n" +
      "This helps resolve conflicts from old browser sessions and installation data."
  ),
  buildAuthTool(
    "re_auth",
      "Switch to a different Google account or re-authenticate. " +
      "Use this when:\n" +
      "- NotebookLM rate limit is reached (50 queries/day for free accounts)\n" +
      "- You want to switch to a different Google account\n" +
      "- Authentication is broken and needs a fresh start\n\n" +
      "This will:\n" +
      "1. Close all active browser sessions\n" +
      "2. Delete all saved authentication data (cookies, Chrome profile)\n" +
      "3. Open browser for fresh Google login\n\n" +
      "After completion, use 'get_health' to verify authentication.\n\n" +
      "TROUBLESHOOTING for persistent auth issues:\n" +
      "If re_auth fails repeatedly:\n" +
      "1. Ask user to close ALL Chrome/Chromium instances\n" +
      "2. Run cleanup_data(confirm=false, preserve_library=true) to preview old files\n" +
      "3. Run cleanup_data(confirm=true, preserve_library=true) to clean everything except library\n" +
      "4. Run re_auth again for completely fresh start\n" +
      "This removes old installation data and browser sessions that can cause conflicts."
  ),
  {
    name: "cleanup_data",
    description:
      "Preview or delete NotebookLM MCP data across known install, browser, cache, log, backup, and trash locations. " +
      "Run first with confirm=false, then rerun with confirm=true after review. " +
      "Close all Chrome/Chromium instances before deleting browser data. " +
      "Set preserve_library=true to keep the local notebook library.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        confirm: {
          type: "boolean",
          description:
            "Confirmation flag. Tool shows preview first, then user confirms deletion. " +
            "Set to true only after user has reviewed the preview and explicitly confirmed.",
        },
        preserve_library: {
          type: "boolean",
          description:
            "Preserve library.json file during cleanup. Default: false. " +
            "Set to true to keep your notebook library while deleting everything else (browser data, caches, logs).",
          default: false,
        },
      },
      required: ["confirm"],
    },
  },
  {
    name: "get_quota",
    description:
      "Get current quota status including license tier, usage, and limits.\n\n" +
      "Returns:\n" +
      "- tier: 'free', 'pro', 'ultra', or 'unknown'\n" +
      "- notebooks: used/limit/remaining/percent\n" +
      "- sources: limit per notebook\n" +
      "- queries: used/limit/remaining/percent/should_stop/reset_time\n" +
      "- warnings: array of warning messages\n\n" +
      "Quota Limits by Tier:\n" +
      "- Free: 100 notebooks, 50 sources/notebook, 50 queries/day\n" +
      "- Pro: 500 notebooks, 300 sources/notebook, 500 queries/day\n" +
      "- Ultra: 500 notebooks, 600 sources/notebook, 5000 queries/day\n\n" +
      "Use sync=true to fetch actual quota from Google's NotebookLM UI (requires browser). " +
      "Without sync, returns locally tracked counts which may differ if you used NotebookLM directly in browser. " +
      "Query counts reset daily at midnight.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sync: {
          type: "boolean",
          description:
            "If true, navigate to NotebookLM and fetch actual quota from Google's UI. " +
            "More accurate but requires browser automation. Default: false (use local tracking).",
        },
      },
    },
  },
  {
    name: "set_quota_tier",
    description:
      "Manually set your NotebookLM license tier.\n\n" +
      "Use this if:\n" +
      "- Auto-detection failed (shows 'unknown')\n" +
      "- You want to override the detected tier\n" +
      "- You upgraded/downgraded your plan\n\n" +
      "Tiers:\n" +
      "- free: 100 notebooks, 50 sources, 50 queries/day\n" +
      "- pro: 500 notebooks, 300 sources, 500 queries/day\n" +
      "- ultra: 500 notebooks, 600 sources, 5000 queries/day",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tier: {
          type: "string",
          enum: ["free", "pro", "ultra"],
          description: "License tier to set",
        },
      },
      required: ["tier"],
    },
  },
  {
    name: "get_project_info",
    description:
      "Get current project context and library location.\n\n" +
      "Detects the project from the current working directory using:\n" +
      "1. Git repository root (looks for .git directory)\n" +
      "2. package.json location (for npm projects)\n" +
      "3. Current directory as fallback\n\n" +
      "Returns:\n" +
      "- project: { id, name, path, type } or null if using global library\n" +
      "- library_path: Path to the active library.json file\n" +
      "- is_project_library: Whether using per-project or global library\n\n" +
      "Use this to understand which library context is active.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "configure_webhook",
    description:
      "Add or update a webhook endpoint for event notifications.\n\n" +
      "## Supported Formats\n" +
      "- generic: Standard JSON payload\n" +
      "- slack: Slack webhook format\n" +
      "- discord: Discord webhook format\n" +
      "- teams: Microsoft Teams format\n\n" +
      "## Events\n" +
      "Subscribe to specific events or use '*' for all events:\n" +
      "- question_answered, notebook_created, notebook_deleted\n" +
      "- source_added, source_removed\n" +
      "- session_created, session_expired\n" +
      "- auth_required, rate_limit_hit, security_incident\n" +
      "- quota_warning, audio_generated, batch_complete\n\n" +
      "## Example\n" +
      "```json\n" +
      "{\n" +
      '  \"name\": \"Slack Notifications\",\n' +
      '  \"url\": \"https://hooks.slack.com/...\",\n' +
      '  \"format\": \"slack\",\n' +
      '  \"events\": [\"notebook_created\", \"security_incident\"]\n' +
      "}\n" +
      "```",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "Webhook ID (for updates). Omit to create new.",
        },
        name: {
          type: "string",
          description: "Display name for the webhook",
        },
        url: {
          type: "string",
          // HTTPS-only; blocks localhost, 127.x, RFC1918 ranges (I046)
          pattern: "^https://(?!localhost|127\\.|10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.).+",
          maxLength: 2048,
          description: "Webhook endpoint URL (must be HTTPS, no localhost or private IPs)",
        },
        enabled: {
          type: "boolean",
          description: "Enable/disable the webhook (default: true)",
        },
        events: {
          type: "array",
          items: { type: "string" },
          description: 'Events to subscribe to. Use ["*"] for all events.',
        },
        format: {
          type: "string",
          enum: ["generic", "slack", "discord", "teams"],
          description: "Payload format (default: generic)",
        },
        secret: {
          type: "string",
          description: "Secret for HMAC signature (X-Webhook-Signature header)",
        },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "list_webhooks",
    description:
      "List all configured webhooks with their status and statistics.\n\n" +
      "Returns array of webhooks with: id, name, url, enabled, events, format.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "test_webhook",
    description:
      "Send a test event to a webhook to verify it's working.\n\n" +
      "Sends a sample 'question_answered' event and returns success/failure.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "Webhook ID to test",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "remove_webhook",
    description: "Remove a configured webhook by ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "Webhook ID to remove",
        },
      },
      required: ["id"],
    },
  },
];
