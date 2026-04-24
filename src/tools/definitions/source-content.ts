/**
 * Source content / download tool definitions.
 *
 * Reads the rendered body of a source (as shown in NotebookLM's source viewer)
 * and returns it as markdown / html / text, or saves it to a local file.
 * NotebookLM's own UI has no such download feature — this tool scrapes the
 * labs-tailwind-doc-viewer HTML and converts it locally.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const getSourceContentTool: Tool = {
  name: "get_source_content",
  description: `Read the rendered content of a single source in a NotebookLM notebook.

## What This Tool Does
- Opens the source viewer (equivalent to clicking a source card in the UI)
- Extracts the rendered HTML from NotebookLM's \`labs-tailwind-doc-viewer\`
- Optionally converts to markdown (default) or plain text
- Also returns the source guide (AI-generated summary + topic chips) when available

## Source ID
Use \`list_sources\` first to obtain a valid source_id like "source-0". The IDs
are index-based and reflect the current row order in the source panel.

## Formats
- **markdown** (default) — GitHub-flavored markdown via turndown, preserves
  headings, lists, code fences, tables, links
- **html** — raw HTML from the doc viewer (no conversion)
- **text** — tags stripped, entities decoded

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "source_id": "source-0",
  "format": "markdown"
}
\`\`\`

Returns \`{ content, contentLength, sourceTitle, sourceGuide }\`.`,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      source_id: { type: "string", description: "Source ID from list_sources, e.g. 'source-0'" },
      format: {
        type: "string",
        enum: ["markdown", "html", "text"],
        description: "Output format. Default: markdown.",
      },
    },
    required: ["source_id"],
  },
};

const downloadSourceTool: Tool = {
  name: "download_source",
  description: `Download the rendered content of a source to a local file.

## What This Tool Does
- Same extraction as \`get_source_content\`
- Writes the content to disk in the chosen format

## Default file path
If \`output_path\` is omitted, the file is saved to
\`~/notebooklm-source-{title-slug}-{timestamp}.{md|html|txt}\`. Title-slug is
derived from the source title with filesystem-unsafe characters replaced.

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "source_id": "source-0",
  "format": "markdown",
  "output_path": "/Users/me/Desktop/notebook-source.md"
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      source_id: { type: "string", description: "Source ID from list_sources, e.g. 'source-0'" },
      format: {
        type: "string",
        enum: ["markdown", "html", "text"],
        description: "Output format. Default: markdown.",
      },
      output_path: {
        type: "string",
        description: "Absolute path to save the file. Directory will be created if missing.",
      },
    },
    required: ["source_id"],
  },
};

export const sourceContentTools: Tool[] = [getSourceContentTool, downloadSourceTool];
