import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const notebookManagementTools: Tool[] = [
  {
    name: "add_notebook",
    description:
      "Add a NotebookLM notebook to the local library after explicit user confirmation. " +
      "Provide the NotebookLM URL plus concise metadata: name, description, topics, and optional use cases/tags. " +
      "Do not infer missing metadata; ask the user first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "The NotebookLM notebook URL (must start with https://notebooklm.google.com/)",
        },
        name: {
          type: "string",
          maxLength: 200,
          description: "Display name for the notebook (e.g., 'n8n Documentation')",
        },
        description: {
          type: "string",
          maxLength: 1000,
          description: "What knowledge/content is in this notebook",
        },
        topics: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description: "Topics covered in this notebook",
        },
        content_types: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description:
            "Types of content (e.g., ['documentation', 'examples', 'best practices'])",
        },
        use_cases: {
          type: "array",
          items: { type: "string", maxLength: 200 },
          maxItems: 20,
          description: "When should Claude use this notebook (e.g., ['Implementing n8n workflows'])",
        },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description: "Optional tags for organization",
        },
      },
      required: ["url", "name", "description", "topics"],
    },
  },
  {
    name: "list_notebooks",
    description:
      "List all library notebooks with metadata (name, topics, use cases, URL). " +
      "Use this to present options, then ask which notebook to use for the task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_notebook",
    description: "Get detailed information about a specific notebook by ID",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          maxLength: 128,
          description: "The notebook ID",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "select_notebook",
    description:
      `Set a notebook as the active default (used when ask_question has no notebook_id).

## When To Use
- User switches context: "Let's work on React now"
- User asks explicitly to activate a notebook
- Obvious task change requires another notebook

## Auto-Switching
- Safe to auto-switch if the context is clear and you announce it:
  "Switching to React notebook for this task..."
- If ambiguous, ask: "Switch to [notebook] for this task?"

## Example
User: "Now let's build the React frontend"
You: "Switching to React notebook..." (call select_notebook)`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "The notebook ID to activate",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "update_notebook",
    description:
      `Update notebook metadata based on user intent.

## Pattern
1) Identify target notebook and fields (topics, description, use_cases, tags, url)
2) Propose the exact change back to the user
3) After explicit confirmation, call this tool

## Examples
- User: "React notebook also covers Next.js 14"
  You: "Add 'Next.js 14' to topics for React?"
  User: "Yes" → call update_notebook

- User: "Include error handling in n8n description"
  You: "Update the n8n description to mention error handling?"
  User: "Yes" → call update_notebook

Tip: You may update multiple fields at once if requested.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          maxLength: 128,
          description: "The notebook ID to update",
        },
        name: {
          type: "string",
          maxLength: 200,
          description: "New display name",
        },
        description: {
          type: "string",
          maxLength: 1000,
          description: "New description",
        },
        topics: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description: "New topics list",
        },
        content_types: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 20,
          description: "New content types",
        },
        use_cases: {
          type: "array",
          items: { type: "string", maxLength: 200 },
          maxItems: 20,
          description: "New use cases",
        },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description: "New tags",
        },
        url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "New notebook URL (must start with https://notebooklm.google.com/)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "remove_notebook",
    description:
      `Dangerous — requires explicit user confirmation.

## Confirmation Workflow
1) User requests removal ("Remove the React notebook")
2) Look up full name to confirm
3) Ask: "Remove '[notebook_name]' from your library? (Does not delete the actual NotebookLM notebook)"
4) Only on explicit "Yes" → call remove_notebook

Never remove without permission or based on assumptions.

Example:
User: "Delete the old React notebook"
You: "Remove 'React Best Practices' from your library?"
User: "Yes" → call remove_notebook`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          description: "The notebook ID to remove",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "search_notebooks",
    description:
      "Search library by query (name, description, topics, tags). " +
      "Use to propose relevant notebooks for the task and then ask which to use.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Search query",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_library_stats",
    description: "Get statistics about your notebook library (total notebooks, usage, etc.)",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "create_notebook",
    description: `Create a new NotebookLM notebook with sources programmatically.

## What This Tool Does
- Creates a NEW notebook in your NotebookLM account
- Uploads sources (URLs, text, files) to the notebook
- Returns the notebook URL for immediate use
- Optionally adds to your local library

## Supported Source Types
- **url**: Web page URL (documentation, articles, etc.)
- **text**: Raw text content (code, notes, etc.)
- **file**: Local file path (PDF, DOCX, TXT)

## Example Usage

Create a notebook from API documentation:
\`\`\`json
{
  "name": "React Docs",
  "sources": [
    { "type": "url", "value": "https://react.dev/reference/react" }
  ]
}
\`\`\`

Create a notebook with multiple sources:
\`\`\`json
{
  "name": "Security Research",
  "sources": [
    { "type": "url", "value": "https://owasp.org/Top10" },
    { "type": "file", "value": "/path/to/security-report.pdf" },
    { "type": "text", "value": "Custom notes...", "title": "My Notes" }
  ],
  "description": "Security best practices and research",
  "topics": ["security", "owasp", "best-practices"]
}
\`\`\`

## NotebookLM Limits (Free Tier)
- 100 notebooks maximum
- 50 sources per notebook
- 500k words per source
- 50 queries per day

## Notes
- Requires authentication (run setup_auth first)
- Creates notebook with sharing set to private by default
- Large files may take longer to process`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          maxLength: 200,
          description: "Display name for the new notebook",
        },
        sources: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["url", "text", "file"],
                description: "Source type: url, text, or file",
              },
              value: {
                type: "string",
                maxLength: 5000,
                description: "URL, text content, or file path depending on type",
              },
              title: {
                type: "string",
                maxLength: 200,
                description: "Optional title for text sources",
              },
            },
            required: ["type", "value"],
          },
          description: "Array of sources to add to the notebook",
        },
        description: {
          type: "string",
          maxLength: 1000,
          description: "Optional description for the notebook in your library",
        },
        topics: {
          type: "array",
          items: { type: "string", maxLength: 100 },
          maxItems: 50,
          description: "Optional topics for categorization in your library",
        },
        auto_add_to_library: {
          type: "boolean",
          description: "Whether to automatically add the created notebook to your library (default: true)",
        },
        browser_options: {
          type: "object",
          properties: {
            headless: {
              type: "boolean",
              description: "Run browser in headless mode (default: true)",
            },
            show: {
              type: "boolean",
              description: "Show browser window for debugging",
            },
            timeout_ms: {
              type: "number",
              description: "Timeout in milliseconds (default: 30000)",
            },
          },
          description: "Optional browser settings for debugging",
        },
        show_browser: {
          type: "boolean",
          description: "Show browser window (shorthand for browser_options.show)",
        },
      },
      required: ["name", "sources"],
    },
  },
  {
    name: "sync_library",
    description: `Sync your local library with actual NotebookLM notebooks.

## What This Tool Does
- Navigates to NotebookLM and extracts all your notebooks
- Compares with local library entries
- Detects stale entries (notebooks deleted or URLs changed)
- Identifies notebooks not in your library
- Optionally auto-removes stale entries

## When To Use
- Library seems out of sync with NotebookLM
- After deleting notebooks in NotebookLM
- To discover new notebooks to add
- Before setting up automation workflows

## Output
Returns a sync report with:
- **matched**: Library entries that match actual notebooks
- **staleEntries**: Library entries with no matching notebook (candidates for removal)
- **missingNotebooks**: NotebookLM notebooks not in library (candidates for adding)
- **suggestions**: Recommended actions

## Example Usage
\`\`\`json
{ "auto_fix": false }
\`\`\`

With auto-fix to remove stale entries:
\`\`\`json
{ "auto_fix": true }
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        auto_fix: {
          type: "boolean",
          description: "Automatically remove stale library entries (default: false)",
        },
        show_browser: {
          type: "boolean",
          description: "Show browser window for debugging",
        },
      },
    },
  },
  {
    name: "list_sources",
    description:
      "List sources in a notebook. Provide notebook_id or notebook_url; if neither is provided, " +
      "the active notebook from the local library is used. Returns source id, title, type, and status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebook_id: {
          type: "string",
          maxLength: 128,
          description: "Library notebook ID",
        },
        notebook_url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "Direct notebook URL (overrides notebook_id)",
        },
      },
    },
  },
  {
    name: "add_source",
    description: `Add a source to an existing NotebookLM notebook.

If neither \`notebook_id\` nor \`notebook_url\` is provided, this tool uses the currently active notebook from the local library.

## Source Types
- **url**: Web page URL
- **text**: Text content (paste)
- **file**: Local file path (PDF, DOCX, TXT)

## Example
\`\`\`json
{
  "notebook_id": "my-notebook",
  "source": {
    "type": "url",
    "value": "https://docs.example.com/api"
  }
}
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebook_id: {
          type: "string",
          maxLength: 128,
          description: "Library notebook ID",
        },
        notebook_url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "Direct notebook URL (overrides notebook_id)",
        },
        source: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["url", "text", "file"],
              description: "Source type",
            },
            value: {
              type: "string",
              maxLength: 5000,
              description: "URL, text content, or file path",
            },
            title: {
              type: "string",
              maxLength: 200,
              description: "Optional title for text sources",
            },
          },
          required: ["type", "value"],
        },
      },
      required: ["source"],
    },
  },
  {
    name: "add_folder",
    description: `Add all files from a local folder as sources to a NotebookLM notebook.

## Use this when
- User wants to add a folder of PDFs, docs, or text files to a notebook
- Adding 5+ files at once (faster than calling add_source repeatedly)

## Behaviour
- Scans the folder for supported file types (default: .pdf, .txt, .md, .docx)
- Adds each file one-by-one with progress updates
- Skips files that fail and reports them in the summary
- If file count exceeds your tier's source limit, auto-splits into multiple notebooks

## Dry Run First (recommended for large folders)
\`\`\`json
{ "folder_path": "/path/to/docs", "notebook_id": "my-notebook", "dry_run": true }
\`\`\`

## Full Add
\`\`\`json
{ "folder_path": "/path/to/docs", "notebook_id": "my-notebook" }
\`\`\`

## With Subdirectories
\`\`\`json
{ "folder_path": "/path/to/project", "notebook_id": "my-notebook", "recursive": true }
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder_path: {
          type: "string",
          // Reject path traversal sequences and home-dir expansion (I048)
          pattern: "^(?!.*\\.\\.)(?!~)/.+",
          maxLength: 500,
          description: "Absolute path to the folder to scan (no .. or ~ allowed)",
        },
        notebook_id: {
          type: "string",
          maxLength: 128,
          description: "Library notebook ID to add sources to",
        },
        notebook_url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "Direct notebook URL (overrides notebook_id)",
        },
        recursive: {
          type: "boolean",
          description: "Scan subdirectories too (default: false)",
        },
        file_types: {
          type: "array",
          items: { type: "string", maxLength: 10 },
          maxItems: 20,
          description: "File extensions to include (default: [\".pdf\", \".txt\", \".md\", \".docx\"])",
        },
        dry_run: {
          type: "boolean",
          description: "Preview files that would be added without actually adding them (default: false)",
        },
        notebook_name_prefix: {
          type: "string",
          maxLength: 100,
          description: "Prefix for auto-split notebooks when file count exceeds tier limit (default: folder name)",
        },
      },
      required: ["folder_path"],
    },
  },
  {
    name: "remove_source",
    description: `Remove a source from a NotebookLM notebook.

If neither \`notebook_id\` nor \`notebook_url\` is provided, this tool uses the currently active notebook from the local library.

## Usage
1. First call list_sources to get source IDs
2. Then call remove_source with the source ID

## Example
\`\`\`json
{
  "notebook_id": "my-notebook",
  "source_id": "source-0"
}
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebook_id: {
          type: "string",
          maxLength: 128,
          description: "Library notebook ID",
        },
        notebook_url: {
          type: "string",
          pattern: "^https://notebooklm\\.google\\.com/",
          maxLength: 512,
          description: "Direct notebook URL (overrides notebook_id)",
        },
        source_id: {
          type: "string",
          maxLength: 128,
          description: "Source ID from list_sources (e.g., 'source-0')",
        },
      },
      required: ["source_id"],
    },
  },
  {
    name: "export_library",
    description: `Export your notebook library to a backup file.

## Formats
- **json**: Full backup with all metadata (recommended for restore)
- **csv**: Simple list for spreadsheets (name, url, topics, last_used)

## Default Location
If no output_path specified, saves to:
~/notebooklm-library-backup-{date}.{format}

## Example Usage
\`\`\`json
{ "format": "json" }
\`\`\`

Export to specific location:
\`\`\`json
{ "format": "csv", "output_path": "/path/to/backup.csv" }
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        format: {
          type: "string",
          enum: ["json", "csv"],
          description: "Export format (default: json)",
        },
        output_path: {
          type: "string",
          pattern: "^(?!.*\\.\\.)(?!~)/.+",
          maxLength: 500,
          description: "Output file path (optional, defaults to home directory; no .. or ~ allowed)",
        },
      },
    },
  },
  {
    name: "batch_create_notebooks",
    description: `Create multiple NotebookLM notebooks in one operation.

## What This Tool Does
- Creates up to 10 notebooks in a single batch operation
- Reports progress for each notebook
- Optionally continues on error or stops on first failure
- Auto-adds created notebooks to your library

## Example Usage
\`\`\`json
{
  "notebooks": [
    {
      "name": "React Documentation",
      "sources": [
        { "type": "url", "value": "https://react.dev/reference" }
      ],
      "topics": ["react", "frontend"]
    },
    {
      "name": "Node.js API",
      "sources": [
        { "type": "url", "value": "https://nodejs.org/api/" }
      ],
      "topics": ["nodejs", "backend"]
    }
  ],
  "stop_on_error": false
}
\`\`\`

## Limits
- Maximum 10 notebooks per batch
- Each notebook follows individual source limits (50-600 based on tier)
- Delays between notebooks to avoid rate limiting

## Returns
Summary with:
- total: Number of notebooks attempted
- succeeded: Successfully created count
- failed: Failed count
- results: Array of individual results`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebooks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                maxLength: 200,
                description: "Display name for the notebook",
              },
              sources: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["url", "text", "file"],
                      description: "Source type",
                    },
                    value: {
                      type: "string",
                      maxLength: 5000,
                      description: "URL, text content, or file path",
                    },
                    title: {
                      type: "string",
                      maxLength: 200,
                      description: "Optional title for text sources",
                    },
                  },
                  required: ["type", "value"],
                },
                description: "Sources to add to this notebook",
              },
              description: {
                type: "string",
                maxLength: 1000,
                description: "Optional description for the notebook",
              },
              topics: {
                type: "array",
                maxItems: 50,
                items: { type: "string", maxLength: 100 },
                description: "Optional topics for categorization",
              },
            },
            required: ["name", "sources"],
          },
          maxItems: 10,
          description: "Array of notebooks to create (max 10)",
        },
        stop_on_error: {
          type: "boolean",
          description: "Stop batch if any notebook fails (default: false)",
        },
        show_browser: {
          type: "boolean",
          description: "Show browser window for debugging",
        },
      },
      required: ["notebooks"],
    },
  },
  {
    name: "generate_audio_overview",
    description: `Generate an AI-powered audio overview (podcast-style) for a notebook.

## What This Tool Does
- Triggers NotebookLM's audio overview generation
- Audio overviews are ~5-15 minute podcast-style summaries
- Generation takes 2-5 minutes typically
- Returns immediately with status (check with get_audio_status)

## Requirements
- Notebook must have at least one source
- Audio generation may not be available on all notebooks

## Example
\`\`\`json
{ "notebook_id": "my-research" }
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
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
  },
  {
    name: "get_audio_status",
    description: `Check the audio overview generation status for a notebook.

## Returns
- status: "not_started" | "generating" | "ready" | "failed" | "unknown"
- progress: Generation progress (0-100) if generating
- duration: Audio duration in seconds if ready

## Example
\`\`\`json
{ "notebook_id": "my-research" }
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
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
  },
  {
    name: "download_audio",
    description: `Download the generated audio overview file.

## Requirements
- Audio must be in "ready" status
- Use get_audio_status to check before downloading

## Output
Downloads to specified path or ~/notebooklm-audio-{timestamp}.mp3

## Example
\`\`\`json
{
  "notebook_id": "my-research",
  "output_path": "/path/to/save/podcast.mp3"
}
\`\`\``,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebook_id: {
          type: "string",
          description: "Library notebook ID",
        },
        notebook_url: {
          type: "string",
          description: "Or direct notebook URL (overrides notebook_id)",
        },
        output_path: {
          type: "string",
          pattern: "^(?!.*\\.\\.)(?!~)/.+",
          maxLength: 500,
          description: "Optional output file path (absolute, no .. or ~ allowed)",
        },
      },
    },
  },
];
