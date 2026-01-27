/**
 * Tool Annotations for MCP UX Enhancement
 *
 * Annotations provide hints about tool behavior to help clients make better decisions.
 *
 * @see https://modelcontextprotocol.io/specification/draft/2025-03-26/server/tools#annotations
 */

import type { ToolAnnotations, ToolExecution } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool metadata including title, annotations, and execution hints
 */
export interface ToolMetadata {
  /** Human-friendly title for the tool */
  title: string;
  /** Behavior hints for the client */
  annotations?: ToolAnnotations;
  /** Execution configuration (e.g., task support) */
  execution?: ToolExecution;
}

/**
 * Tool metadata mapped to tool names
 */
export const toolMetadata: Record<string, ToolMetadata> = {
  // ==========================================================================
  // Core Research Tool
  // ==========================================================================
  ask_question: {
    title: "Ask NotebookLM",
    annotations: {
      title: "Research Question",
      readOnlyHint: true, // Doesn't modify data, just queries
      destructiveHint: false,
      idempotentHint: false, // Same question may get different answers
      openWorldHint: true, // Interacts with external NotebookLM
    },
  },

  // ==========================================================================
  // Notebook Management
  // ==========================================================================
  add_notebook: {
    title: "Add Notebook",
    annotations: {
      title: "Add Notebook to Library",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true, // Adding same notebook twice is safe
      openWorldHint: false, // Local library operation
    },
  },
  list_notebooks: {
    title: "List Notebooks",
    annotations: {
      title: "List Library Notebooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_notebook: {
    title: "Get Notebook",
    annotations: {
      title: "Get Notebook Details",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  select_notebook: {
    title: "Select Notebook",
    annotations: {
      title: "Set Active Notebook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  update_notebook: {
    title: "Update Notebook",
    annotations: {
      title: "Update Notebook Metadata",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  remove_notebook: {
    title: "Remove Notebook",
    annotations: {
      title: "Remove from Library",
      readOnlyHint: false,
      destructiveHint: true, // Removes from library
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  search_notebooks: {
    title: "Search Notebooks",
    annotations: {
      title: "Search Library",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_library_stats: {
    title: "Library Stats",
    annotations: {
      title: "Get Library Statistics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  export_library: {
    title: "Export Library",
    annotations: {
      title: "Export Library Backup",
      readOnlyHint: true, // Just exports, doesn't modify
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  create_notebook: {
    title: "Create Notebook",
    annotations: {
      title: "Create NotebookLM Notebook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false, // Creates new notebook each time
      openWorldHint: true, // Creates in NotebookLM
    },
  },
  sync_library: {
    title: "Sync Library",
    annotations: {
      title: "Sync with NotebookLM",
      readOnlyHint: false, // Can modify library
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, // Accesses NotebookLM
    },
  },
  batch_create_notebooks: {
    title: "Batch Create",
    annotations: {
      title: "Batch Create Notebooks",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  // ==========================================================================
  // Source Management
  // ==========================================================================
  list_sources: {
    title: "List Sources",
    annotations: {
      title: "List Notebook Sources",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, // Reads from NotebookLM
    },
  },
  add_source: {
    title: "Add Source",
    annotations: {
      title: "Add Source to Notebook",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  remove_source: {
    title: "Remove Source",
    annotations: {
      title: "Remove Source from Notebook",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // ==========================================================================
  // Audio
  // ==========================================================================
  generate_audio_overview: {
    title: "Generate Audio",
    annotations: {
      title: "Generate Audio Overview",
      readOnlyHint: false, // Creates audio
      destructiveHint: false,
      idempotentHint: false, // Regenerates each time
      openWorldHint: true,
    },
  },
  get_audio_status: {
    title: "Audio Status",
    annotations: {
      title: "Check Audio Generation Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  download_audio: {
    title: "Download Audio",
    annotations: {
      title: "Download Audio File",
      readOnlyHint: true, // Just downloads, doesn't modify source
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // ==========================================================================
  // Session Management
  // ==========================================================================
  list_sessions: {
    title: "List Sessions",
    annotations: {
      title: "List Active Sessions",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  close_session: {
    title: "Close Session",
    annotations: {
      title: "Close Browser Session",
      readOnlyHint: false,
      destructiveHint: true, // Closes session
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  reset_session: {
    title: "Reset Session",
    annotations: {
      title: "Reset Session History",
      readOnlyHint: false,
      destructiveHint: true, // Clears history
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // ==========================================================================
  // System Tools
  // ==========================================================================
  get_health: {
    title: "Health Check",
    annotations: {
      title: "Server Health Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  setup_auth: {
    title: "Setup Auth",
    annotations: {
      title: "Setup Google Authentication",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false, // Opens browser each time
      openWorldHint: true, // Interacts with Google
    },
  },
  re_auth: {
    title: "Re-authenticate",
    annotations: {
      title: "Re-authenticate with Google",
      readOnlyHint: false,
      destructiveHint: true, // Deletes existing auth
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  cleanup_data: {
    title: "Cleanup Data",
    annotations: {
      title: "Clean MCP Data Files",
      readOnlyHint: false,
      destructiveHint: true, // Deletes files
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_quota: {
    title: "Get Quota",
    annotations: {
      title: "Check Quota Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false, // Local unless sync=true
    },
  },
  set_quota_tier: {
    title: "Set Tier",
    annotations: {
      title: "Set License Tier",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_project_info: {
    title: "Project Info",
    annotations: {
      title: "Get Project Context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // ==========================================================================
  // Webhooks
  // ==========================================================================
  configure_webhook: {
    title: "Configure Webhook",
    annotations: {
      title: "Configure Webhook Endpoint",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_webhooks: {
    title: "List Webhooks",
    annotations: {
      title: "List Configured Webhooks",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  test_webhook: {
    title: "Test Webhook",
    annotations: {
      title: "Send Test Event",
      readOnlyHint: true, // Doesn't modify webhook config
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, // Sends HTTP request
    },
  },
  remove_webhook: {
    title: "Remove Webhook",
    annotations: {
      title: "Remove Webhook Configuration",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // ==========================================================================
  // Gemini Tools
  // ==========================================================================
  deep_research: {
    title: "Deep Research",
    annotations: {
      title: "Gemini Deep Research",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false, // Results may vary
      openWorldHint: true, // Uses Gemini API
    },
    execution: {
      // Deep research can take 1-5 minutes, ideal for task-based execution
      taskSupport: "optional",
    },
  },
  gemini_query: {
    title: "Gemini Query",
    annotations: {
      title: "Quick Gemini Query",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  get_research_status: {
    title: "Research Status",
    annotations: {
      title: "Check Research Progress",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  upload_document: {
    title: "Upload Document",
    annotations: {
      title: "Upload to Gemini",
      readOnlyHint: false, // Uploads file
      destructiveHint: false,
      idempotentHint: true, // Same file = same result
      openWorldHint: true,
    },
  },
  query_document: {
    title: "Query Document",
    annotations: {
      title: "Ask About Document",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  list_documents: {
    title: "List Documents",
    annotations: {
      title: "List Uploaded Documents",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  delete_document: {
    title: "Delete Document",
    annotations: {
      title: "Delete from Gemini",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  query_chunked_document: {
    title: "Query Chunked Doc",
    annotations: {
      title: "Query Large Document",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },

  // ==========================================================================
  // History
  // ==========================================================================
  get_query_history: {
    title: "Query History",
    annotations: {
      title: "Get Query History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_notebook_chat_history: {
    title: "Chat History",
    annotations: {
      title: "Get Notebook Chat History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true, // Reads from NotebookLM
    },
  },
};

/**
 * Get metadata for a tool by name
 */
export function getToolMetadata(toolName: string): ToolMetadata | undefined {
  return toolMetadata[toolName];
}
