/**
 * Data Table Tool Definitions
 *
 * Tools for generating and extracting Data Tables in NotebookLM Studio.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Generate Data Table tool
 */
const generateDataTableTool: Tool = {
  name: "generate_data_table",
  description: `Generate a structured Data Table from notebook sources.

## What This Tool Does
- Opens the Studio panel in NotebookLM
- Generates a structured tabular extraction from notebook content
- Tables organize key information from sources into rows and columns
- Generation typically takes 1-3 minutes
- Returns immediately with status (check with get_data_table)

## Requirements
- Notebook must have at least one source
- Authentication required (run setup_auth first)

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

/**
 * Get Data Table tool
 */
const getDataTableTool: Tool = {
  name: "get_data_table",
  description: `Extract the generated Data Table content from a notebook.

## What This Tool Does
- Navigates to the notebook's Studio panel
- Extracts the table data (headers and rows) as structured JSON
- Returns the full table content for analysis

## Returns
- table.headers: Column headers
- table.rows: Array of row arrays
- table.totalRows: Number of rows
- table.totalColumns: Number of columns

## Requirements
- Data table must be generated first (use generate_data_table)
- Returns error if table is not yet ready

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

/**
 * All data table tools
 */
export const dataTableTools: Tool[] = [
  generateDataTableTool,
  getDataTableTool,
];
