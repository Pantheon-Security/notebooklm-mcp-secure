import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const sessionManagementTools: Tool[] = [
  {
    name: "list_sessions",
    description:
      "List all active sessions with stats (age, message count, last activity). " +
      "Use to continue the most relevant session instead of starting from scratch.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "close_session",
    description: "Close a specific session by session ID. Ask before closing if the user might still need it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "The session ID to close",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "reset_session",
    description:
      "Reset a session's chat history (keep same session ID). " +
      "Use for a clean slate when the task changes; ask the user before resetting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "The session ID to reset",
        },
      },
      required: ["session_id"],
    },
  },
];
