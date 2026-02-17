/**
 * Video Overview Tool Definitions
 *
 * Tools for generating and managing Video Overviews in NotebookLM Studio.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Generate Video Overview tool
 */
const generateVideoOverviewTool: Tool = {
  name: "generate_video_overview",
  description: `Generate an AI-powered Video Overview for a notebook.

## What This Tool Does
- Opens the Studio panel in NotebookLM
- Generates a visual video summary of notebook content
- Supports multiple visual styles and formats
- Generation takes 3-10 minutes typically
- Returns immediately with status (check with get_video_status)

## Visual Styles
- **auto-select** — Let NotebookLM choose the best style (default)
- **custom** — Custom visual style
- **classic** — Classic presentation style
- **whiteboard** — Hand-drawn whiteboard style
- **kawaii** — Cute kawaii style
- **anime** — Anime-inspired visuals
- **watercolour** — Watercolour painting style
- **retro-print** — Retro print aesthetic
- **heritage** — Heritage/traditional style
- **paper-craft** — Paper-craft visual style

## Formats
- **explainer** — Full explanation (5-15 min, default)
- **brief** — Quick summary (1-3 min)

## Requirements
- Notebook must have at least one source
- Authentication required (run setup_auth first)

## Example
\`\`\`json
{ "notebook_id": "my-research", "style": "documentary", "format": "brief" }
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: {
        type: "string",
        description: "Library notebook ID",
      },
      notebook_url: {
        type: "string",
        description: "Or direct notebook URL (overrides notebook_id)",
      },
      style: {
        type: "string",
        enum: ["auto-select", "custom", "classic", "whiteboard", "kawaii", "anime", "watercolour", "retro-print", "heritage", "paper-craft"],
        default: "auto-select",
        description: "Visual style for the video overview",
      },
      format: {
        type: "string",
        enum: ["explainer", "brief"],
        default: "explainer",
        description: "Video format (explainer = full, brief = short summary)",
      },
    },
  },
};

/**
 * Get Video Status tool
 */
const getVideoStatusTool: Tool = {
  name: "get_video_status",
  description: `Check the Video Overview generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: Generation progress (0-100) if generating
- duration: Video duration in seconds if ready

## Example
\`\`\`json
{ "notebook_id": "my-research" }
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: {
        type: "string",
        description: "Library notebook ID",
      },
      notebook_url: {
        type: "string",
        description: "Or direct notebook URL (overrides notebook_id)",
      },
    },
  },
};

/**
 * All video tools
 */
export const videoTools: Tool[] = [
  generateVideoOverviewTool,
  getVideoStatusTool,
];
