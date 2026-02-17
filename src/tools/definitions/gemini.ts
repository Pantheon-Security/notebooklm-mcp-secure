/**
 * Gemini API Tool Definitions
 *
 * Tools for accessing Gemini models and the Deep Research agent
 * via the Interactions API.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Deep Research tool - comprehensive research using Gemini's Deep Research agent
 */
const deepResearchTool: Tool = {
  name: "deep_research",
  description: `Perform deep research using Gemini's Deep Research agent.

> **⚠️ REQUIRES GEMINI_API_KEY** - Do NOT use this tool unless GEMINI_API_KEY is configured. For notebook queries, use ask_question instead (no API key needed).

This runs in the background and can take 1-5 minutes to complete.

## When to Use
- ONLY when GEMINI_API_KEY is configured
- You need comprehensive research on a topic NOT in your notebooks
- No specific NotebookLM notebook is relevant

## When NOT to Use
- **Use ask_question instead** for queries about your NotebookLM notebooks (no API key needed)
- If GEMINI_API_KEY is not set, this tool will fail

## Requirements
- GEMINI_API_KEY environment variable MUST be set

## Notes
- Deep Research is a premium feature that may incur costs
- Results are grounded in web sources with citations`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The research question or topic to investigate",
      },
      wait_for_completion: {
        type: "boolean",
        default: true,
        description: "Wait for research to complete (polls every 10s). Set to false to run in background.",
      },
      max_wait_seconds: {
        type: "number",
        default: 300,
        description: "Maximum wait time in seconds (default 5 min, max 10 min)",
      },
      thinking_level: {
        type: "string",
        enum: ["minimal", "low", "medium", "high"],
        description: "Controls thinking depth for research. Higher levels produce more thorough results.",
      },
    },
    required: ["query"],
  },
};

/**
 * Gemini Query tool - quick queries with optional grounding tools
 */
const geminiQueryTool: Tool = {
  name: "gemini_query",
  description: `Quick query to Gemini model with optional grounding tools.

> **⚠️ REQUIRES GEMINI_API_KEY** - Do NOT use this tool unless GEMINI_API_KEY is configured. For notebook queries, use ask_question instead (no API key needed).

Supports:
- Google Search grounding for current information
- Code execution for calculations
- URL analysis for web content

## Requirements
- GEMINI_API_KEY environment variable MUST be set

## When to Use (ONLY if API key is configured)
- Quick factual questions NOT in your notebooks
- Current events (with google_search tool)
- Code calculations (with code_execution tool)
- Web page analysis (with url_context tool)

## When NOT to Use
- **Use ask_question instead** for queries about your NotebookLM notebooks (no API key needed)`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or prompt",
      },
      model: {
        type: "string",
        enum: ["gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro"],
        default: "gemini-3-flash-preview",
        description: "Model to use. Gemini 3 recommended. Note: gemini-2.5-* models retire March 31, 2026.",
      },
      tools: {
        type: "array",
        items: {
          type: "string",
          enum: ["google_search", "code_execution", "url_context"],
        },
        description: "Built-in tools to enable for grounding",
      },
      urls: {
        type: "array",
        items: { type: "string" },
        description: "URLs to analyze (automatically enables url_context)",
      },
      previous_interaction_id: {
        type: "string",
        description: "Continue a previous conversation (for multi-turn)",
      },
      thinking_level: {
        type: "string",
        enum: ["minimal", "low", "medium", "high"],
        description: "Controls thinking depth. Higher levels produce more thorough but slower responses.",
      },
      response_schema: {
        type: "object",
        description: "JSON schema for structured output. When provided, Gemini returns valid JSON matching this schema. Example: { type: 'object', properties: { name: { type: 'string' }, score: { type: 'number' } }, required: ['name'] }",
      },
    },
    required: ["query"],
  },
};

/**
 * Get Research Status tool - check background task progress
 */
const getResearchStatusTool: Tool = {
  name: "get_research_status",
  description: `Check the status of a background deep research task.

Use this when you started deep_research with wait_for_completion=false.

## Returns
- status: pending | running | completed | failed
- answer: The research result (if completed)
- error: Error message (if failed)`,
  inputSchema: {
    type: "object",
    properties: {
      interaction_id: {
        type: "string",
        description: "The interaction ID returned from deep_research",
      },
    },
    required: ["interaction_id"],
  },
};

// =============================================================================
// Document Tools (Files API) - v1.9.0
// =============================================================================

/**
 * Upload Document tool - upload a document to Gemini for querying
 */
const uploadDocumentTool: Tool = {
  name: "upload_document",
  description: `Upload a document (PDF, text, etc.) to Gemini for querying.

> **⚠️ REQUIRES GEMINI_API_KEY** - For adding documents to NotebookLM notebooks (no API key), use create_notebook or add_source instead.

## What This Does
- Uploads a local file to Gemini's Files API
- File is retained for 48 hours
- Returns a file ID for use with query_document

## Auto-Chunking for Large PDFs (v1.10.0)
- PDFs over 50MB or 1000 pages are automatically split into chunks
- Each chunk is uploaded separately and tracked
- Use query_chunked_document or pass all chunk IDs to query_document
- Returns wasChunked=true and allFileNames array when chunked

## Supported File Types
- PDF (any size - auto-chunked if needed)
- TXT, MD, HTML, CSV, JSON, XML
- DOCX, DOC
- Images (PNG, JPG, GIF, WebP)
- Audio (MP3, WAV)
- Video (MP4)

## When to Use
- You have a local document to analyze
- You want fast, API-based document queries (no browser needed)
- For temporary analysis (48h retention)

## For Permanent Storage
Use create_notebook instead for permanent document storage with NotebookLM.

## Requirements
- GEMINI_API_KEY environment variable must be set`,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to upload",
      },
      display_name: {
        type: "string",
        description: "Optional friendly name for the file",
      },
    },
    required: ["file_path"],
  },
};

/**
 * Query Document tool - ask questions about an uploaded document
 */
const queryDocumentTool: Tool = {
  name: "query_document",
  description: `Ask questions about an uploaded document.

## What This Does
- Queries a document previously uploaded with upload_document
- Uses Gemini's document understanding (text, images, charts, tables)
- Returns answers grounded in the document content

## Features
- Full document understanding (not just text extraction)
- Can analyze charts, diagrams, and tables in PDFs
- Multi-document queries (pass additional file IDs)
- Fast API-based (no browser automation)

## When to Use
- Quick document analysis without browser
- Comparing multiple documents
- Extracting specific information

## Requirements
- GEMINI_API_KEY environment variable must be set
- Document must be uploaded first with upload_document`,
  inputSchema: {
    type: "object",
    properties: {
      file_name: {
        type: "string",
        description: "File name/ID returned from upload_document",
      },
      query: {
        type: "string",
        description: "Question to ask about the document",
      },
      model: {
        type: "string",
        enum: ["gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro"],
        default: "gemini-3-flash-preview",
        description: "Model to use. Gemini 3 recommended. Note: gemini-2.5-* models retire March 31, 2026.",
      },
      additional_files: {
        type: "array",
        items: { type: "string" },
        description: "Additional file IDs to include in the query (for multi-document analysis)",
      },
    },
    required: ["file_name", "query"],
  },
};

/**
 * List Documents tool - list all uploaded documents
 */
const listDocumentsTool: Tool = {
  name: "list_documents",
  description: `List all documents uploaded to Gemini.

## What This Does
- Shows all files currently stored in Gemini Files API
- Files expire 48 hours after upload
- Returns file names, sizes, and expiration times

## Use Cases
- Check what documents are available for querying
- Find file IDs for query_document
- Monitor storage usage

## Requirements
- GEMINI_API_KEY environment variable must be set`,
  inputSchema: {
    type: "object",
    properties: {
      page_size: {
        type: "number",
        default: 100,
        description: "Maximum number of files to return",
      },
    },
  },
};

/**
 * Delete Document tool - delete an uploaded document
 */
const deleteDocumentTool: Tool = {
  name: "delete_document",
  description: `Delete an uploaded document from Gemini.

## What This Does
- Removes a file from Gemini Files API
- File will no longer be available for queries
- Frees up storage space

## Notes
- Files auto-delete after 48 hours anyway
- Use this to immediately remove sensitive documents

## Requirements
- GEMINI_API_KEY environment variable must be set`,
  inputSchema: {
    type: "object",
    properties: {
      file_name: {
        type: "string",
        description: "File name/ID to delete (from upload_document or list_documents)",
      },
    },
    required: ["file_name"],
  },
};

/**
 * Query Chunked Document tool - query a large document that was split into chunks
 */
const queryChunkedDocumentTool: Tool = {
  name: "query_chunked_document",
  description: `Query a large document that was automatically chunked during upload.

## What This Does
- Queries each chunk of a large document
- Aggregates results into a single coherent answer
- Handles documents of any size (1000+ pages)

## When to Use
- After upload_document returns wasChunked=true
- When you have multiple chunk file IDs to query together
- For comprehensive analysis of large PDFs

## How It Works
1. Queries each chunk with your question
2. Collects answers from all chunks
3. Uses Gemini to synthesize a unified response
4. Returns aggregated answer with all sources

## Example
If upload_document returned:
  { wasChunked: true, allFileNames: ["files/a", "files/b", "files/c"] }

Call this tool with:
  { file_names: ["files/a", "files/b", "files/c"], query: "What are the main findings?" }

## Requirements
- GEMINI_API_KEY environment variable must be set
- Document chunks must be uploaded first`,
  inputSchema: {
    type: "object",
    properties: {
      file_names: {
        type: "array",
        items: { type: "string" },
        description: "Array of chunk file IDs (from upload_document's allFileNames)",
      },
      query: {
        type: "string",
        description: "Question to ask about the document",
      },
      model: {
        type: "string",
        enum: ["gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-2.5-flash", "gemini-2.5-pro"],
        default: "gemini-3-flash-preview",
        description: "Model to use for querying and aggregation. Note: gemini-2.5-* models retire March 31, 2026.",
      },
    },
    required: ["file_names", "query"],
  },
};

/**
 * All Gemini tools
 */
export const geminiTools: Tool[] = [
  // Research tools
  deepResearchTool,
  geminiQueryTool,
  getResearchStatusTool,
  // Document tools (v1.9.0)
  uploadDocumentTool,
  queryDocumentTool,
  listDocumentsTool,
  deleteDocumentTool,
  // Chunked document tools (v1.10.0)
  queryChunkedDocumentTool,
];
