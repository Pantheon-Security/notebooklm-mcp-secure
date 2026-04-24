/**
 * Research (Source Discovery) Tool Definitions — async 3-step flow
 *
 * 1. `research_sources` — triggers the search and returns immediately
 * 2. `get_research_status` — polls the discovery container state
 * 3. `import_research_results` — imports (or dismisses) the candidates
 *
 * Deep Research can take 2-10 minutes which exceeds the MCP client's ~60s
 * request timeout, so the previous auto-import-in-one-call design was
 * unusable for it. This async split works for both Fast and Deep modes.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const researchSourcesTool: Tool = {
  name: "research_sources",
  description: `Trigger Fast Research or Deep Research on a query. Returns immediately after submitting — does NOT wait for completion (Deep Research takes 2-10 minutes, which exceeds the MCP protocol's ~60s timeout).

## Flow (3-step async)
1. \`research_sources\` — submit the query (this tool)
2. \`get_source_discovery_status\` — poll until status = "completed"
3. \`import_research_results\` — click Import (or Dismiss) to finalize

## Modes
- **fast** (default): Quick candidate list (~15-30s)
- **deep**: Thorough report + broader candidate pool (2-10 min)

## Corpus
- **web** (default): Web 上の最適なソース
- **drive**: Google ドライブのコンテンツ (requires Drive access)

## Example
\`\`\`json
{
  "notebook_url": "https://notebooklm.google.com/notebook/xxx",
  "query": "NotebookLM MCP サーバの実装例",
  "mode": "deep"
}
\`\`\`
After this returns, call \`get_source_discovery_status\` every ~20-30s until status="completed", then call \`import_research_results\`.`,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL (overrides notebook_id)" },
      query: { type: "string", description: "Natural-language query used to search for related sources." },
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
    },
    required: ["query"],
  },
};

const getSourceDiscoveryStatusTool: Tool = {
  name: "get_source_discovery_status",
  description: `Check the state of a pending source-discovery (research_sources) request. Lightweight — no long-running browser work.

Note: this is distinct from the Gemini \`get_research_status\` tool, which queries the separate Gemini API deep-research jobs.

## Returns
- **status**: "idle" (no research in progress) | "running" (candidates not ready) | "completed" (candidates ready for import)
- **candidatesCount**: Number of discovered candidates (present when status="completed")
- **candidatePreview**: Up to 5 candidate titles for preview (present when status="completed")
- **headerText**: Raw header text from the discovery container (e.g. "高速リサーチが完了しました！")

## When to call
- Immediately after \`research_sources\` to confirm the trigger registered (expect "running")
- Polling every ~20-30s until status = "completed"

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

const importResearchResultsTool: Tool = {
  name: "import_research_results",
  description: `Import (or dismiss) the candidate sources that were discovered by a completed Research.

## Prerequisites
- \`research_sources\` must have been triggered
- \`get_source_discovery_status\` must return status="completed"

## Action parameter
- **import** (default): Click the "インポート" button. Candidates become real sources on the notebook. Returns \`addedTitles\` listing the new sources (title extraction takes a few seconds, so the returned titles are the final extracted titles not raw URLs).
- **dismiss**: Click the "削除" button to discard the candidates without importing.

## Typical use
\`\`\`json
{
  "notebook_id": "my-research",
  "action": "import"
}
\`\`\`

Returns the before/after source counts and \`addedTitles\` when action=import.`,
  inputSchema: {
    type: "object",
    properties: {
      notebook_id: { type: "string", description: "Library notebook ID" },
      notebook_url: { type: "string", description: "Or direct notebook URL" },
      action: {
        type: "string",
        enum: ["import", "dismiss"],
        description: "import (default) — adds candidates as real sources. dismiss — discards them without importing.",
      },
    },
  },
};

export const researchTools: Tool[] = [
  researchSourcesTool,
  getSourceDiscoveryStatusTool,
  importResearchResultsTool,
];
