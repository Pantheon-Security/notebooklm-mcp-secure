/**
 * Slides (Slide Deck) Tool Definitions
 *
 * Tools for generating slide decks in NotebookLM Studio (beta, April 2026).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const generateSlidesTool: Tool = {
  name: "generate_slides",
  description: `Generate an AI-powered slide deck (スライド資料 / Slide deck) for a notebook.

## What This Tool Does
- Opens the Studio panel in NotebookLM
- Generates a presentation-style slide deck from notebook sources
- Beta feature — tile labelled "ベータ版 スライド資料" (ja) in NotebookLM UI
- Generation typically takes 2-5 minutes
- Returns immediately with status (check with get_slides_status)

## Requirements
- Notebook must have at least one source
- Authentication required (run setup_auth first)
- Feature must be enabled on the signed-in Google account

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

const getSlidesStatusTool: Tool = {
  name: "get_slides_status",
  description: `Check the slide deck generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: Generation progress (0-100) if generating (currently always 0; NotebookLM does not expose %)
- title: Current artifact title (e.g. "スライド資料を生成しています..." while generating)

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

export const slidesTools: Tool[] = [generateSlidesTool, getSlidesStatusTool];
