/**
 * Research Sources Tool Definition
 *
 * Wraps the NotebookLM "Search for new sources" feature (the query box at
 * the top of the source panel, with Fast Research / Deep Research toggle).
 *
 * Unlike `add_source` (which accepts a single URL or file the user already
 * has), `research_sources` takes a natural-language query, lets NotebookLM
 * discover candidate sources automatically, and optionally imports them
 * all as real sources.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const researchSourcesTool: Tool = {
  name: "research_sources",
  description: `Run Fast Research or Deep Research on a query — NotebookLM discovers related sources from the web (or Google Drive) and optionally adds them to the notebook.

## What This Tool Does
- Opens the source panel if collapsed
- Types the query into the search box at the top of the panel
- Selects the research mode (Fast / Deep) and corpus (Web / Drive)
- Submits and waits for completion
- If \`auto_import: true\`, clicks the "インポート" button so the discovered sources become real sources on the notebook. Otherwise returns after completion so the user can review candidates in NotebookLM's UI themselves.

## Requirements
- Authentication required (run setup_auth first)
- Fast Research typically completes in 15-30 seconds; Deep Research takes several minutes
- Deep Research consumes significantly more generation quota

## Modes
- **fast** (default): 結果をすばやく取得したい場合に最適 — quick candidate list, ~7-10 sources
- **deep**: 詳細なレポートと結果 — slower, more thorough discovery with deeper analysis

## Corpus
- **web** (default): Web 上の最適なソース
- **drive**: Google ドライブのコンテンツ (requires Drive access on the signed-in Google account)

## Example — Fast Research + auto import
\`\`\`json
{
  "notebook_url": "https://notebooklm.google.com/notebook/xxx",
  "query": "NotebookLM MCP サーバの実装例",
  "mode": "fast",
  "auto_import": true
}
\`\`\`

## Example — Deep Research, manual review
\`\`\`json
{
  "notebook_id": "my-research",
  "query": "2026 年の MCP プロトコル拡張仕様",
  "mode": "deep",
  "timeout_ms": 900000
}
\`\`\``,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL (overrides notebook_id)" },
      query: { type: "string", description: "Natural-language query to search for related sources." },
      mode: {
        type: "string",
        enum: ["fast", "deep"],
        description: "Research mode. fast=quick list (~30s), deep=thorough (several min). Default: fast.",
      },
      corpus: {
        type: "string",
        enum: ["web", "drive"],
        description: "Search corpus. Default: web.",
      },
      auto_import: {
        type: "boolean",
        description: "If true, click the 'インポート' button after research completes so discovered sources are added. Default: false.",
      },
      timeout_ms: {
        type: "number",
        description: "Max time to wait for research completion. Default: 60000 (fast) or 600000 (deep).",
      },
    },
    required: ["query"],
  },
};

export const researchTools: Tool[] = [researchSourcesTool];
