/**
 * Infographic Tool Definitions
 *
 * Tools for generating infographics in NotebookLM Studio (beta, April 2026).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const generateInfographicTool: Tool = {
  name: "generate_infographic",
  description: `Generate an AI-powered infographic (インフォグラフィック) for a notebook.

## What This Tool Does
- Opens the Studio panel in NotebookLM
- Generates a visual one-pager summary (poster) from notebook sources
- Beta feature — tile labelled "ベータ版 インフォグラフィック" (ja) in NotebookLM UI
- Generation typically takes 2-5 minutes
- Returns immediately with status (check with get_infographic_status)

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

const getInfographicStatusTool: Tool = {
  name: "get_infographic_status",
  description: `Check the infographic generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: Generation progress (0-100) if generating (currently always 0; NotebookLM does not expose %)
- title: Current artifact title (e.g. "インフォグラフィックを生成しています..." while generating)

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

export const infographicTools: Tool[] = [generateInfographicTool, getInfographicStatusTool];
