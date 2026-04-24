/**
 * Slides Tool Definitions
 *
 * Tools for generating, revising, and downloading slide decks in NotebookLM
 * Studio (beta, April 2026).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const generateSlidesTool: Tool = {
  name: "generate_slides",
  description: `Generate an AI-powered slide deck (スライド資料 / Slide deck) for a notebook.

## What This Tool Does
- Opens the Studio panel in NotebookLM and starts generation
- Beta feature — tile labelled "ベータ版 スライド資料" (ja) in NotebookLM UI
- Generation typically takes 2-5 minutes
- Returns immediately with status (check with get_slides_status)

## Customization (all optional)
Supply any of these to open NotebookLM's customize dialog before generation:
- **format**: "detailed" (default, 詳細なスライド — full-text slides ideal for email)
  or "presenter" (プレゼンターのスライド — visual slides to support speaking)
- **length**: "default" or "short" (短め)
- **language**: UI label of the target language mat-select option, e.g. "日本語", "English", "Français". If omitted, account default is kept.
- **description**: Free-form instructions — audience, style, emphasis points.
  Example: "初心者向けに、一つひとつの手順に焦点を当て、大胆で遊び心のあるスタイルで"

If no options are supplied, a fast direct-tile click runs (same as before).

## Requirements
- Notebook must have at least one source
- Authentication required (run setup_auth first)
- Feature must be enabled on the signed-in Google account

## Examples
\`\`\`json
{ "notebook_id": "my-research" }
\`\`\`

\`\`\`json
{
  "notebook_url": "https://notebooklm.google.com/notebook/xxx",
  "format": "presenter",
  "length": "short",
  "description": "エンジニア向けに技術的な深掘りを重視し、コード例を多く含める"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL (overrides notebook_id)" },
      format: {
        type: "string",
        enum: ["detailed", "presenter"],
        description: 'Slide format. "detailed" = full-text slides, "presenter" = visual slides. Default: detailed.',
      },
      length: {
        type: "string",
        enum: ["default", "short"],
        description: 'Deck length. Default: default (slightly longer).',
      },
      language: {
        type: "string",
        description: "Language mat-select label, e.g. '日本語', 'English', 'Français'. Omit to keep account default.",
      },
      description: {
        type: "string",
        description: "Free-form customization instructions (audience, style, emphasis points).",
      },
      source_titles: {
        type: "array",
        items: { type: "string" },
        description: "Optional. Case-insensitive substring patterns — each must match exactly one source title. When provided, only those sources are used as input. Omit to use all sources.",
      },
    },
  },
};

const getSlidesStatusTool: Tool = {
  name: "get_slides_status",
  description: `Check the slide deck generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: 0-100 (NotebookLM does not expose a % — always 0 when generating)
- title: Current artifact title (e.g. "スライド資料を生成しています..." while generating)

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

const reviseSlidesTool: Tool = {
  name: "revise_slides",
  description: `Revise an existing slide deck with custom instructions.

## What This Tool Does
- Opens the ready slide deck's artifact viewer
- Enters revision mode (equivalent to the "変更" context menu item)
- Types the provided instructions into the revision textarea
- Clicks "改訂版のスライドを生成" — a new revised deck is generated

## Requirements
- Slides must be in "ready" state (use get_slides_status to confirm)
- Consumes 1 generation quota
- Infographic does NOT have a revision mode in NotebookLM; use generate_infographic with description instead

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "instructions": "タイトルを短くして、最後のスライドに要点をまとめたページを追加"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      instructions: {
        type: "string",
        description: "Revision instructions — what to change about the existing deck.",
      },
      source_titles: {
        type: "array",
        items: { type: "string" },
        description: "Optional. Case-insensitive substring patterns — each must match exactly one source title. When provided, only those sources are used as input for the revision. Omit to use all sources.",
      },
    },
    required: ["instructions"],
  },
};

const downloadSlidesTool: Tool = {
  name: "download_slides",
  description: `Download the generated slide deck as a .pdf or .pptx file.

## What This Tool Does
- Opens the slide artifact's ⋮ menu
- Clicks the PDF (jslog 302103) or PPTX (jslog 302084) download item
- Waits for the download event and saves the file locally

## Requirements
- Slides must be in "ready" state

## Output
Saved to \`output_path\` if provided, otherwise \`~/notebooklm-slides-{timestamp}.{pdf|pptx}\`.

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "format": "pptx",
  "output_path": "/Users/me/Desktop/my-deck.pptx"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      format: {
        type: "string",
        enum: ["pdf", "pptx"],
        description: 'Download format. Default: pdf.',
      },
      output_path: {
        type: "string",
        description: "Absolute path to save the file. Directory will be created if missing.",
      },
    },
  },
};

export const slidesTools: Tool[] = [
  generateSlidesTool,
  getSlidesStatusTool,
  reviseSlidesTool,
  downloadSlidesTool,
];
