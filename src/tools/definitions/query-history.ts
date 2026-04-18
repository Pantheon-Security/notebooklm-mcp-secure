/**
 * Query History Tool Definition
 *
 * Allows users to retrieve and search past NotebookLM Q&A interactions.
 */

import type { Tool } from "../../types.js";

export const queryHistoryTool: Tool = {
  name: "get_query_history",
  description: `Retrieve past NotebookLM queries and answers for reviewing research sessions.

Use this tool to:
- Review past research conversations
- Find specific information from previous queries
- Track which notebooks and sessions you've used
- Search through question and answer content

Returns query entries with question, answer, notebook, session, and timing info.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: {
        type: "string",
        maxLength: 128,
        description: "Filter queries by session ID",
      },
      notebook_id: {
        type: "string",
        maxLength: 128,
        description: "Filter queries by notebook ID (from your library)",
      },
      date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Filter queries by date (format: YYYY-MM-DD)",
      },
      search: {
        type: "string",
        maxLength: 500,
        description: "Search pattern to find in questions or answers",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 500,
        description: "Maximum number of entries to return (default: 50, max: 500)",
      },
    },
  },
};

export const queryHistoryTools = [queryHistoryTool];
