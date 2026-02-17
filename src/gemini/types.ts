/**
 * Gemini Interactions API Types
 *
 * Type definitions for the Gemini Interactions API integration.
 */

import type { ProgressCallback } from "../types.js";

/**
 * Gemini built-in tools
 */
export type GeminiTool = "google_search" | "code_execution" | "url_context";

/**
 * Supported Gemini models
 */
export type GeminiModel =
  | "gemini-2.5-flash"
  | "gemini-2.5-pro"
  | "gemini-3-flash-preview"
  | "gemini-3-pro-preview";

/**
 * Deep Research agent ID
 */
export const DEEP_RESEARCH_AGENT = "deep-research-pro-preview-12-2025";

/**
 * Options for Gemini query
 */
export interface GeminiQueryOptions {
  /** The query/prompt to send */
  query: string;
  /** Model to use (default: gemini-3-flash-preview) */
  model?: GeminiModel;
  /** Built-in tools to enable */
  tools?: GeminiTool[];
  /** URLs to analyze (requires url_context tool) */
  urls?: string[];
  /** Continue a previous conversation */
  previousInteractionId?: string;
  /** Enable streaming (default: false) */
  stream?: boolean;
  /** Generation config */
  generationConfig?: GeminiGenerationConfig;
}

/**
 * Generation configuration
 */
export interface GeminiGenerationConfig {
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Thinking level: minimal, low, medium, high */
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  /** Response MIME type for structured output */
  responseMimeType?: string;
  /** JSON schema for structured output (requires responseMimeType: "application/json") */
  responseSchema?: Record<string, unknown>;
}

/**
 * Options for deep research
 */
export interface DeepResearchOptions {
  /** The research query */
  query: string;
  /** Run in background (default: true) */
  background?: boolean;
  /** Wait for completion (default: true) */
  waitForCompletion?: boolean;
  /** Maximum wait time in milliseconds */
  maxWaitMs?: number;
  /** Progress callback */
  progressCallback?: ProgressCallback;
}

/**
 * Interaction status
 */
export type InteractionStatus = "pending" | "running" | "completed" | "failed" | "incomplete";

/**
 * Output types from Gemini
 */
export interface GeminiOutput {
  /** Output type */
  type: "text" | "function_call" | "image";
  /** Text content (if type is text) */
  text?: string;
  /** Function name (if type is function_call) */
  name?: string;
  /** Function arguments (if type is function_call) */
  arguments?: Record<string, unknown>;
  /** Output ID */
  id?: string;
}

/**
 * Gemini interaction result
 */
export interface GeminiInteraction {
  /** Unique interaction ID */
  id: string;
  /** Model used */
  model?: string;
  /** Current status */
  status: InteractionStatus;
  /** Output content */
  outputs: GeminiOutput[];
  /** Token usage */
  usage?: {
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  /** Error message (if failed) */
  error?: string;
  /** Deprecation warning if using a retiring model */
  deprecationWarning?: string;
}

/**
 * Result from deep research
 */
export interface DeepResearchResult {
  /** Interaction ID for tracking */
  interactionId: string;
  /** Current status */
  status: InteractionStatus;
  /** Research answer (if completed) */
  answer?: string;
  /** Tokens used */
  tokensUsed?: number;
  /** Error message (if failed) */
  error?: string;
  /** Time taken in milliseconds */
  durationMs?: number;
}

/**
 * Result from quick Gemini query
 */
export interface GeminiQueryResult {
  /** Interaction ID */
  interactionId: string;
  /** Response text */
  answer: string;
  /** Model used */
  model: string;
  /** Tokens used */
  tokensUsed?: number;
  /** Tools that were used */
  toolsUsed?: string[];
  /** Deprecation warning if model is retiring */
  deprecationWarning?: string;
}

// =============================================================================
// Files API Types (v1.9.0)
// =============================================================================

/**
 * File processing state
 */
export type FileState = "PROCESSING" | "ACTIVE" | "FAILED";

/**
 * Uploaded file metadata
 */
export interface GeminiFile {
  /** File name (resource ID) */
  name: string;
  /** Display name */
  displayName?: string;
  /** MIME type */
  mimeType: string;
  /** File size in bytes */
  sizeBytes?: number;
  /** Creation timestamp */
  createTime?: string;
  /** Expiration timestamp (48h after upload) */
  expirationTime?: string;
  /** Processing state */
  state: FileState;
  /** URI for use in prompts */
  uri: string;
  /** Error details if state is FAILED */
  error?: string;
}

/**
 * Options for uploading a document
 */
export interface UploadDocumentOptions {
  /** Path to the file */
  filePath: string;
  /** Optional display name */
  displayName?: string;
  /** MIME type (auto-detected if not provided) */
  mimeType?: string;
}

/**
 * Options for querying a document
 */
export interface QueryDocumentOptions {
  /** File name/ID returned from upload */
  fileName: string;
  /** The question to ask about the document */
  query: string;
  /** Model to use (default: gemini-3-flash-preview) */
  model?: GeminiModel;
  /** Additional files to include in query */
  additionalFiles?: string[];
  /** Generation config */
  generationConfig?: GeminiGenerationConfig;
}

/**
 * Information about a single uploaded chunk
 */
export interface UploadedChunk {
  /** File name for this chunk */
  fileName: string;
  /** Chunk index (0-based) */
  chunkIndex: number;
  /** Total number of chunks */
  totalChunks: number;
  /** Page range start (1-indexed) */
  pageStart: number;
  /** Page range end (1-indexed) */
  pageEnd: number;
  /** URI for reference */
  uri: string;
}

/**
 * Result from document upload
 */
export interface UploadDocumentResult {
  /** File name (use this for queries) - primary file or first chunk */
  fileName: string;
  /** Display name */
  displayName: string;
  /** URI for reference */
  uri: string;
  /** MIME type */
  mimeType: string;
  /** File size (original file) */
  sizeBytes?: number;
  /** Expiration time (48h from now) */
  expiresAt: string;
  /** Processing state */
  state: FileState;
  /** Whether file was chunked */
  wasChunked?: boolean;
  /** Total pages in original document */
  totalPages?: number;
  /** Chunk details (if file was split) */
  chunks?: UploadedChunk[];
  /** All file names for querying (includes all chunks) */
  allFileNames?: string[];
}

/**
 * Result from document query
 */
export interface QueryDocumentResult {
  /** The answer from Gemini */
  answer: string;
  /** Model used */
  model: string;
  /** Tokens used */
  tokensUsed?: number;
  /** Files referenced in the query */
  filesUsed: string[];
}

/**
 * Result from listing documents
 */
export interface ListDocumentsResult {
  /** List of uploaded files */
  files: GeminiFile[];
  /** Total count */
  totalCount: number;
  /** Next page token (if more results) */
  nextPageToken?: string;
}
