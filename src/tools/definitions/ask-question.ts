import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NotebookLibrary } from "../../library/notebook-library.js";

/**
 * Build dynamic tool description for ask_question based on active notebook or library
 */
export function buildAskQuestionDescription(library: NotebookLibrary): string {
  const active = library.getActiveNotebook();

  if (active) {
    return `NotebookLM notebook Q&A via browser automation.

Active notebook is set; use get_notebook for details.
No Gemini API key is required, but browser authentication must be valid.
Prefer this tool for questions grounded in the user's NotebookLM sources.
Use the returned session_id for follow-up questions on the same task.
Use notebook_id or notebook_url only when overriding the active notebook.
If the right notebook is ambiguous, ask the user which one to use.
If authentication fails, use notebooklm.auth-repair or notebooklm.auth-setup.`;
  } else {
    return `NotebookLM notebook Q&A via browser automation.

No active notebook is selected.
Use list_notebooks and select_notebook to choose one, or pass notebook_url.
No Gemini API key is required, but browser authentication must be valid.
If login is required, use notebooklm.auth-setup and verify with get_health.`;
  }
}

export const askQuestionTool: Tool = {
  name: "ask_question",
  // Description will be set dynamically using buildAskQuestionDescription
  description: "Dynamic description placeholder", 
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        minLength: 1,
        maxLength: 10000,
        description: "The question to ask NotebookLM",
      },
      session_id: {
        type: "string",
        maxLength: 128,
        description:
          "Optional session ID for contextual conversations. If omitted, a new session is created.",
      },
      notebook_id: {
        type: "string",
        maxLength: 128,
        description:
          "Optional notebook ID from your library. If omitted, uses the active notebook. " +
          "Use list_notebooks to see available notebooks.",
      },
      notebook_url: {
        type: "string",
        pattern: "^https://notebooklm\\.google\\.com/",
        maxLength: 512,
        description:
          "Optional notebook URL (overrides notebook_id). Use this for ad-hoc queries to notebooks not in your library.",
      },
      show_browser: {
        type: "boolean",
        description:
          "Show browser window for debugging (simple version). " +
          "For advanced control (typing speed, stealth, etc.), use browser_options instead.",
      },
      browser_options: {
        type: "object",
        description:
          "Optional browser behavior settings. Claude can control everything: " +
          "visibility, typing speed, stealth mode, timeouts. Useful for debugging or fine-tuning.",
        properties: {
          show: {
            type: "boolean",
            description: "Show browser window (default: from ENV or false)",
          },
          headless: {
            type: "boolean",
            description: "Run browser in headless mode (default: true)",
          },
          timeout_ms: {
            type: "number",
            minimum: 1000,
            maximum: 300000,
            description: "Browser operation timeout in milliseconds (default: 30000)",
          },
          stealth: {
            type: "object",
            description: "Human-like behavior settings to avoid detection",
            properties: {
              enabled: {
                type: "boolean",
                description: "Master switch for all stealth features (default: true)",
              },
              random_delays: {
                type: "boolean",
                description: "Random delays between actions (default: true)",
              },
              human_typing: {
                type: "boolean",
                description: "Human-like typing patterns (default: true)",
              },
              mouse_movements: {
                type: "boolean",
                description: "Realistic mouse movements (default: true)",
              },
              typing_wpm_min: {
                type: "number",
                minimum: 10,
                maximum: 600,
                description: "Minimum typing speed in WPM (default: 160)",
              },
              typing_wpm_max: {
                type: "number",
                minimum: 10,
                maximum: 600,
                description: "Maximum typing speed in WPM (default: 240)",
              },
              delay_min_ms: {
                type: "number",
                minimum: 0,
                maximum: 10000,
                description: "Minimum delay between actions in ms (default: 100)",
              },
              delay_max_ms: {
                type: "number",
                minimum: 0,
                maximum: 10000,
                description: "Maximum delay between actions in ms (default: 400)",
              },
            },
          },
          viewport: {
            type: "object",
            description: "Browser viewport size",
            properties: {
              width: {
                type: "number",
                minimum: 320,
                maximum: 7680,
                description: "Viewport width in pixels (default: 1920)",
              },
              height: {
                type: "number",
                minimum: 240,
                maximum: 4320,
                description: "Viewport height in pixels (default: 1080)",
              },
            },
          },
        },
      },
    },
    required: ["question"],
  },
};
