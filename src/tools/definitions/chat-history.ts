/**
 * Chat History Tool Definition
 *
 * Allows users to extract conversation history from NotebookLM notebooks
 * using browser automation to scrape the chat UI.
 */

import type { Tool } from "../../types.js";

export const getNotebookChatHistoryTool: Tool = {
  name: "get_notebook_chat_history",
  description: `Extract conversation history from a NotebookLM notebook's chat interface.

This tool uses browser automation to navigate to a notebook and extract all Q&A pairs
from the chat UI. This is useful for:
- Recovering previous research conversations
- Auditing what queries were made in a notebook
- Understanding quota usage from direct NotebookLM browser usage
- Resuming context from previous sessions

## Context Management
Use \`preview_only: true\` to get a quick count before extracting full content.
Use \`output_file\` to export to JSON instead of returning to context.
Use \`offset\` with \`limit\` for pagination through large histories.

## Examples

Quick audit (preview only):
\`\`\`json
{ "notebook_id": "my-research", "preview_only": true }
\`\`\`

Export to file (avoids context overflow):
\`\`\`json
{ "notebook_id": "my-research", "output_file": "/tmp/chat-history.json" }
\`\`\`

Paginate through history:
\`\`\`json
{ "notebook_id": "my-research", "limit": 20, "offset": 0 }
{ "notebook_id": "my-research", "limit": 20, "offset": 20 }
\`\`\``,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      notebook_id: {
        type: "string",
        maxLength: 128,
        description: "Library notebook ID. Use list_notebooks to see available notebooks.",
      },
      notebook_url: {
        type: "string",
        pattern: "^https://notebooklm\\.google\\.com/",
        maxLength: 512,
        description: "Direct notebook URL (overrides notebook_id). Use for notebooks not in your library.",
      },
      preview_only: {
        type: "boolean",
        description: "If true, only returns message count and summary without content. Use this to audit before extracting full history. (default: false)",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 200,
        description: "Maximum number of message pairs to return (default: 50, max: 200).",
      },
      offset: {
        type: "number",
        minimum: 0,
        maximum: 10000,
        description: "Number of message pairs to skip from the start. Use with limit for pagination. (default: 0)",
      },
      output_file: {
        type: "string",
        maxLength: 500,
        description: "If provided, exports chat history to this JSON file instead of returning to context. Useful for large histories.",
      },
      show_browser: {
        type: "boolean",
        description: "Show browser window for debugging (default: false)",
      },
    },
  },
};

export const chatHistoryTools = [getNotebookChatHistoryTool];
