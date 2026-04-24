/**
 * Infographic Tool Definitions
 *
 * Tools for generating and downloading infographics in NotebookLM Studio
 * (beta, April 2026). Note: infographic does NOT support post-generation
 * revision (no UI for it); use the `description` option on generate to steer
 * the content up-front instead.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const INFOGRAPHIC_STYLES = [
  "auto",
  "sketch",
  "kawaii",
  "professional",
  "science",
  "anime",
  "clay",
  "editorial",
  "explanatory",
  "bento",
  "block",
] as const;

const generateInfographicTool: Tool = {
  name: "generate_infographic",
  description: `Generate an AI-powered infographic (インフォグラフィック) for a notebook.

## What This Tool Does
- Opens the Studio panel and starts generation
- Beta feature — tile labelled "ベータ版 インフォグラフィック" (ja)
- Generation typically takes 2-5 minutes
- Returns immediately with status (poll get_infographic_status)

## Customization (all optional)
- **style**: One of ${INFOGRAPHIC_STYLES.join(", ")}
  Japanese UI labels: auto=自動選択, sketch=スケッチ, kawaii=カワイイ, professional=プロフェッショナル,
  science=科学, anime=アニメ, clay=クレイ, editorial=エディトリアル, explanatory=説明的,
  bento=弁当箱, block=ブロック
- **orientation**: "landscape" (横向き), "portrait" (縦向き), "square" (正方形)
- **language**: UI label, e.g. "日本語", "English". Omit to keep account default.
- **description**: Free-form instructions — style, color, emphasis points.
  Example: "青のカラーテーマを使用し、3 つの主要統計項目を強調"

If no options are supplied, a fast direct-tile click runs.

## Requirements
- Notebook must have at least one source
- Authentication required (run setup_auth first)
- Feature must be enabled on the signed-in Google account

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "style": "kawaii",
  "orientation": "portrait",
  "description": "ピンクとパープルの配色で、キャラクターを交えて楽しい雰囲気に"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL (overrides notebook_id)" },
      style: {
        type: "string",
        enum: [...INFOGRAPHIC_STYLES],
        description: "Visual style preset (11 options).",
      },
      orientation: {
        type: "string",
        enum: ["landscape", "portrait", "square"],
        description: "Canvas orientation.",
      },
      language: {
        type: "string",
        description: "Language mat-select label, e.g. '日本語', 'English'. Omit to keep account default.",
      },
      description: {
        type: "string",
        description: "Free-form customization instructions (style, color, emphasis points).",
      },
    },
  },
};

const getInfographicStatusTool: Tool = {
  name: "get_infographic_status",
  description: `Check the infographic generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: 0-100 (always 0 while generating — NotebookLM does not expose %)
- title: Current artifact title (e.g. "インフォグラフィックを生成しています...")

## Example
\`\`\`json
{ "notebook_id": "my-research" }
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
    },
  },
};

const downloadInfographicTool: Tool = {
  name: "download_infographic",
  description: `Download the generated infographic as an image file.

## What This Tool Does
- Opens the infographic artifact's ⋮ menu
- Clicks the "ダウンロード" item (jslog 296552)
- Waits for the download event and saves the file locally
- File extension is inferred from the server's suggested filename (typically .png)

## Requirements
- Infographic must be in "ready" state

## Output
Saved to \`output_path\` if provided, otherwise \`~/notebooklm-infographic-{timestamp}.{ext}\`.

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "output_path": "/Users/me/Desktop/my-infographic.png"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      output_path: {
        type: "string",
        description: "Absolute path to save the file. Directory will be created if missing.",
      },
    },
  },
};

export const infographicTools: Tool[] = [
  generateInfographicTool,
  getInfographicStatusTool,
  downloadInfographicTool,
];
