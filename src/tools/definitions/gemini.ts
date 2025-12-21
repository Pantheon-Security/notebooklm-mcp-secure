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

This runs in the background and can take 1-5 minutes to complete.

## When to Use
- You need comprehensive research on a topic
- No specific NotebookLM notebook is relevant
- You want web-grounded answers with citations

## Requirements
- GEMINI_API_KEY environment variable must be set

## Notes
- Deep Research is a premium feature that may incur costs
- Results are grounded in web sources with citations
- For notebook-specific queries, use ask_question instead`,
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

Faster than deep_research for simpler questions. Supports:
- Google Search grounding for current information
- Code execution for calculations
- URL analysis for web content

## Requirements
- GEMINI_API_KEY environment variable must be set

## When to Use
- Quick factual questions
- Current events (with google_search tool)
- Code calculations (with code_execution tool)
- Web page analysis (with url_context tool)`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question or prompt",
      },
      model: {
        type: "string",
        enum: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview"],
        default: "gemini-2.5-flash",
        description: "Model to use (flash is faster, pro is more capable)",
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

## What This Does
- Uploads a local file to Gemini's Files API
- File is retained for 48 hours
- Returns a file ID for use with query_document

## Supported File Types
- PDF (up to 50MB, 1000 pages)
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
        enum: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview"],
        default: "gemini-2.5-flash",
        description: "Model to use (flash is faster, pro is more capable)",
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
];
