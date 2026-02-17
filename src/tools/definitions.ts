/**
 * MCP Tool Definitions
 *
 * Aggregates tool definitions from sub-modules and applies
 * enhanced metadata (icons, annotations, titles) for better UX.
 *
 * @see https://modelcontextprotocol.io/specification/draft/2025-03-26/server/tools
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { NotebookLibrary } from "../library/notebook-library.js";
import {
  askQuestionTool,
  buildAskQuestionDescription,
} from "./definitions/ask-question.js";
import { notebookManagementTools } from "./definitions/notebook-management.js";
import { sessionManagementTools } from "./definitions/session-management.js";
import { systemTools } from "./definitions/system.js";
import { geminiTools } from "./definitions/gemini.js";
import { videoTools } from "./definitions/video.js";
import { dataTableTools } from "./definitions/data-tables.js";
import { queryHistoryTools } from "./definitions/query-history.js";
import { chatHistoryTools } from "./definitions/chat-history.js";
import { getToolIcons } from "./icons.js";
import { getToolMetadata } from "./annotations.js";

/**
 * Apply enhanced metadata (icons, annotations, title, execution) to a tool
 */
function enhanceTool(tool: Tool): Tool {
  const icons = getToolIcons(tool.name);
  const metadata = getToolMetadata(tool.name);

  return {
    ...tool,
    // Add icons if available
    ...(icons && { icons }),
    // Add title if available (human-friendly name)
    ...(metadata?.title && { title: metadata.title }),
    // Add annotations if available (behavior hints)
    ...(metadata?.annotations && { annotations: metadata.annotations }),
    // Add execution hints if available (e.g., task support)
    ...(metadata?.execution && { execution: metadata.execution }),
  };
}

/**
 * Build Tool Definitions with NotebookLibrary context
 * Includes enhanced metadata (icons, annotations, titles) for better UX
 */
export function buildToolDefinitions(library: NotebookLibrary): Tool[] {
  // Update the description for ask_question based on the library state
  const dynamicAskQuestionTool = {
    ...askQuestionTool,
    description: buildAskQuestionDescription(library),
  };

  // Aggregate all tools
  const allTools: Tool[] = [
    dynamicAskQuestionTool,
    ...notebookManagementTools,
    ...sessionManagementTools,
    ...systemTools,
    ...geminiTools,
    ...videoTools,
    ...dataTableTools,
    ...queryHistoryTools,
    ...chatHistoryTools,
  ];

  // Apply enhanced metadata to all tools
  return allTools.map(enhanceTool);
}