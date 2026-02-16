import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Icon, Resource } from "@modelcontextprotocol/sdk/types.js";
import { NotebookLibrary } from "../library/notebook-library.js";
import { log } from "../utils/logger.js";

/**
 * Create an SVG icon data URI
 */
function svgIcon(svg: string): Icon {
  const encoded = Buffer.from(svg).toString("base64");
  return {
    src: `data:image/svg+xml;base64,${encoded}`,
    mimeType: "image/svg+xml",
  };
}

// Resource icons
const ICONS = {
  library: svgIcon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`),
  notebook: svgIcon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`),
  metadata: svgIcon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`),
};

/**
 * Handlers for MCP Resource-related requests
 */
export class ResourceHandlers {
  private library: NotebookLibrary;

  constructor(library: NotebookLibrary) {
    this.library = library;
  }

  /**
   * Register all resource handlers to the server
   */
  public registerHandlers(server: Server): void {
    // List available resources (enhanced with icons and annotations)
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      log.info("📚 [MCP] list_resources request received");

      const notebooks = this.library.listNotebooks();
      const resources: Resource[] = [
        {
          uri: "notebooklm://library",
          name: "Notebook Library",
          title: "NotebookLM Library",
          description:
            "Complete notebook library with all available knowledge sources. " +
            "Read this to discover what notebooks are available. " +
            "⚠️ If you think a notebook might help with the user's task, " +
            "ASK THE USER FOR PERMISSION before consulting it: " +
            "'Should I consult the [notebook] for this task?'",
          mimeType: "application/json",
          icons: [ICONS.library],
          annotations: {
            audience: ["assistant"],
            priority: 1.0, // High priority - main entry point
          },
        },
      ];

      // Add individual notebook resources
      for (const notebook of notebooks) {
        resources.push({
          uri: `notebooklm://library/${notebook.id}`,
          name: notebook.name,
          title: notebook.name,
          description:
            `${notebook.description} | Topics: ${notebook.topics.join(", ")} | ` +
            `💡 Use ask_question to query this notebook (ask user permission first if task isn't explicitly about these topics)`,
          mimeType: "application/json",
          icons: [ICONS.notebook],
          annotations: {
            audience: ["assistant"],
            priority: 0.8,
            ...(notebook.last_used && { lastModified: notebook.last_used }),
          },
        });
      }

      // Add legacy metadata resource for backwards compatibility
      const active = this.library.getActiveNotebook();
      if (active) {
        resources.push({
          uri: "notebooklm://metadata",
          name: "Active Notebook Metadata (Legacy)",
          title: "Active Notebook (Legacy)",
          description:
            "Information about the currently active notebook. " +
            "DEPRECATED: Use notebooklm://library instead for multi-notebook support. " +
            "⚠️ Always ask user permission before using notebooks for tasks they didn't explicitly mention.",
          mimeType: "application/json",
          icons: [ICONS.metadata],
          annotations: {
            audience: ["assistant"],
            priority: 0.3, // Low priority - deprecated
          },
        });
      }

      return { resources };
    });

    // List resource templates
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      log.info("📑 [MCP] list_resource_templates request received");

      return {
        resourceTemplates: [
          {
            uriTemplate: "notebooklm://library/{id}",
            name: "Notebook by ID",
            description:
              "Access a specific notebook from your library by ID. " +
              "Provides detailed metadata about the notebook including topics, use cases, and usage statistics. " +
              "💡 Use the 'id' parameter from list_notebooks to access specific notebooks.",
            mimeType: "application/json",
          },
        ],
      };
    });

    // Read resource content
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      log.info(`📖 [MCP] read_resource request: ${uri}`);

      // Handle library resource
      if (uri === "notebooklm://library") {
        const notebooks = this.library.listNotebooks();
        const stats = this.library.getStats();
        const active = this.library.getActiveNotebook();

        const libraryData = {
          active_notebook: active
            ? {
                id: active.id,
                name: active.name,
                description: active.description,
                topics: active.topics,
              }
            : null,
          notebooks: notebooks.map((nb) => ({
            id: nb.id,
            name: nb.name,
            description: nb.description,
            topics: nb.topics,
            content_types: nb.content_types,
            use_cases: nb.use_cases,
            url: nb.url,
            use_count: nb.use_count,
            last_used: nb.last_used,
            tags: nb.tags,
          })),
          stats,
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(libraryData, null, 2),
            },
          ],
        };
      }

      // Handle individual notebook resource
      if (uri.startsWith("notebooklm://library/")) {
        const prefix = "notebooklm://library/";
        const encodedId = uri.slice(prefix.length);
        if (!encodedId) {
          throw new Error(
            "Notebook resource requires an ID (e.g. notebooklm://library/{id})"
          );
        }

        let id: string;
        try {
          id = decodeURIComponent(encodedId);
        } catch {
          throw new Error(`Invalid notebook identifier encoding: ${encodedId}`);
        }

        if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(id)) {
          throw new Error(
            `Invalid notebook identifier: ${encodedId}. Notebook IDs may only contain letters, numbers, and hyphens.`
          );
        }

        const notebook = this.library.getNotebook(id);

        if (!notebook) {
          throw new Error(`Notebook not found: ${id}`);
        }

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(notebook, null, 2),
            },
          ],
        };
      }

      // Legacy metadata resource (backwards compatibility)
      if (uri === "notebooklm://metadata") {
        const active = this.library.getActiveNotebook();

        if (!active) {
          throw new Error(
            "No active notebook. Use notebooklm://library to see all notebooks."
          );
        }

        const metadata = {
          description: active.description,
          topics: active.topics,
          content_types: active.content_types,
          use_cases: active.use_cases,
          notebook_url: active.url,
          notebook_id: active.id,
          last_used: active.last_used,
          use_count: active.use_count,
          note: "DEPRECATED: Use notebooklm://library or notebooklm://library/{id} instead",
        };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(metadata, null, 2),
            },
          ],
        };
      }

      throw new Error(`Unknown resource: ${uri}`);
    });

    // Argument completions (for prompt arguments and resource templates)
    server.setRequestHandler(CompleteRequestSchema, async (request) => {
      const { ref, argument } = request.params as any;
      try {
        if (ref?.type === "ref/resource") {
          // Complete variables for resource templates
          const uri = String(ref.uri || "");
          // Notebook by ID template
          if (uri === "notebooklm://library/{id}" && argument?.name === "id") {
            const values = this.completeNotebookIds(argument?.value);
            return this.buildCompletion(values) as any;
          }
        }
      } catch (e) {
        log.warning(`⚠️  [MCP] completion error: ${e}`);
      }
      return { completion: { values: [], total: 0 } } as any;
    });

    // List available prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      log.info("📝 [MCP] list_prompts request received");

      return {
        prompts: [
          {
            name: "notebooklm.auth-setup",
            description:
              "Guide for initial Google authentication setup for NotebookLM access. " +
              "Use this when the user needs to authenticate for the first time.",
            arguments: [],
          },
          {
            name: "notebooklm.auth-repair",
            description:
              "Troubleshooting guide for authentication issues. " +
              "Use this when authentication fails or cookies have expired.",
            arguments: [],
          },
          {
            name: "notebooklm.quick-start",
            description:
              "Quick start guide for NotebookLM MCP. " +
              "Explains how to add notebooks, query them, and manage sessions.",
            arguments: [],
          },
          {
            name: "notebooklm.security-overview",
            description:
              "Overview of security features in this hardened MCP server. " +
              "Includes GDPR compliance, audit logging, and post-quantum encryption details.",
            arguments: [],
          },
        ],
      };
    });

    // Get prompt content
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name } = request.params;
      log.info(`📝 [MCP] get_prompt request: ${name}`);

      switch (name) {
        case "notebooklm.auth-setup":
          return {
            description: "Initial authentication setup guide",
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: `# NotebookLM Authentication Setup

To authenticate with NotebookLM:

1. **Run the setup_auth tool** - This opens a browser window for Google login
2. **Complete Google login** - You have up to 10 minutes to log in
3. **Verify with get_health** - Check that authentication was saved successfully

\`\`\`
// Step 1: Start auth
setup_auth({ show_browser: true })

// Step 2: Complete login in browser...

// Step 3: Verify
get_health({ deep_check: true })
\`\`\`

**Tips:**
- Close all Chrome/Chromium instances before starting
- Use re_auth if you need to switch accounts
- Use cleanup_data if you have persistent issues`,
                },
              },
            ],
          };

        case "notebooklm.auth-repair":
          return {
            description: "Authentication troubleshooting guide",
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: `# NotebookLM Authentication Repair

If authentication is failing:

## Quick Fix
\`\`\`
// Check current status
get_health({ deep_check: true })

// If cookies expired, re-authenticate
re_auth({ show_browser: true })
\`\`\`

## Full Reset (if quick fix fails)
\`\`\`
// 1. Close ALL Chrome/Chromium instances first!

// 2. Preview cleanup
cleanup_data({ confirm: false, preserve_library: true })

// 3. Execute cleanup
cleanup_data({ confirm: true, preserve_library: true })

// 4. Fresh authentication
setup_auth({ show_browser: true })

// 5. Verify
get_health({ deep_check: true })
\`\`\`

**Common Issues:**
- Rate limit hit (50 queries/day free) → re_auth to switch accounts
- Stale browser session → cleanup_data + setup_auth
- Cookies expired → re_auth`,
                },
              },
            ],
          };

        case "notebooklm.quick-start":
          return {
            description: "Quick start guide for NotebookLM MCP",
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: `# NotebookLM MCP Quick Start

## 1. Add a Notebook
\`\`\`
add_notebook({
  url: "https://notebooklm.google.com/notebook/...",
  name: "My Documentation",
  description: "API docs and examples",
  topics: ["api", "documentation"]
})
\`\`\`

## 2. Query Your Notebook
\`\`\`
// Start a new session
ask_question({ question: "How do I use the API?" })
// Returns session_id

// Continue conversation
ask_question({
  question: "Show me an example",
  session_id: "..."
})
\`\`\`

## 3. Manage Library
\`\`\`
list_notebooks()      // See all notebooks
select_notebook(...)  // Set active notebook
search_notebooks(...) // Find notebooks by topic
\`\`\`

## 4. Direct Gemini Queries
\`\`\`
// Quick query with web grounding
gemini_query({
  query: "Latest news about...",
  tools: ["google_search"]
})

// Deep research (1-5 min)
deep_research({ query: "Comprehensive analysis of..." })
\`\`\``,
                },
              },
            ],
          };

        case "notebooklm.security-overview":
          return {
            description: "Security features overview",
            messages: [
              {
                role: "user" as const,
                content: {
                  type: "text" as const,
                  text: `# NotebookLM MCP Security Features

This is a security-hardened fork with 14 security layers:

## Core Security
- **Input Validation** - Zod schemas for all inputs
- **URL Whitelisting** - Only approved domains
- **Rate Limiting** - Abuse prevention
- **Session Timeout** - Auto-expire idle sessions

## Data Protection
- **Post-Quantum Encryption** - ML-KEM-768 + ChaCha20-Poly1305
- **Secrets Scanning** - Detect leaked credentials
- **Memory Scrubbing** - Secure data cleanup
- **Credential Masking** - Hide sensitive data in logs

## Enterprise Compliance
- **GDPR** - Consent management, data portability, right to erasure
- **SOC2** - Hash-chained audit logs, change management
- **CSSF** - 7-year retention, SIEM integration

## Monitoring
- **Audit Logging** - Tamper-evident hash chains
- **Certificate Pinning** - Prevent MITM attacks
- **Response Validation** - Detect injection attempts

Use \`get_health()\` to check security status.`,
                },
              },
            ],
          };

        default:
          throw new Error("Unknown prompt requested");
      }
    });
  }

  /**
   * Return notebook IDs matching the provided input (case-insensitive contains)
   */
  private completeNotebookIds(input: unknown): string[] {
    const query = String(input ?? "").toLowerCase();
    return this.library
      .listNotebooks()
      .map((nb) => nb.id)
      .filter((id) => id.toLowerCase().includes(query))
      .slice(0, 50);
  }

  /**
   * Build a completion payload for MCP responses
   */
  private buildCompletion(values: string[]) {
    return {
      completion: {
        values,
        total: values.length,
      },
    };
  }
}
