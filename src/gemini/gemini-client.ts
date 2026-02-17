/**
 * Gemini Interactions API Client
 *
 * Provides access to Gemini models and the Deep Research agent
 * via the Interactions API for stable, API-based research capabilities.
 */

import { GoogleGenAI } from "@google/genai";
import { log } from "../utils/logger.js";
import { CONFIG } from "../config.js";
import type { ProgressCallback } from "../types.js";
import type {
  GeminiQueryOptions,
  GeminiInteraction,
  DeepResearchOptions,
  GeminiOutput,
  InteractionStatus,
  UploadDocumentOptions,
  QueryDocumentOptions,
  GeminiFile,
  FileState,
  UploadDocumentResult,
  QueryDocumentResult,
  ListDocumentsResult,
  UploadedChunk,
} from "./types.js";
import { analyzePdf, chunkPdf, cleanupChunks } from "./pdf-chunker.js";
import fs from "fs";
import path from "path";

// Re-export the agent constant
export { DEEP_RESEARCH_AGENT } from "./types.js";

/**
 * Client for Gemini Interactions API
 */
export class GeminiClient {
  private client: GoogleGenAI | null = null;

  constructor(apiKey?: string) {
    const key = apiKey || CONFIG.geminiApiKey;
    if (key) {
      this.client = new GoogleGenAI({ apiKey: key });
      log.info("Gemini client initialized");
    } else {
      log.info("Gemini client not initialized (no API key)");
    }
  }

  /**
   * Check if the client is available (API key configured)
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Perform a quick query to Gemini
   */
  async query(options: GeminiQueryOptions): Promise<GeminiInteraction> {
    if (!this.client) {
      throw new Error("Gemini API key not configured. Set GEMINI_API_KEY environment variable.");
    }

    const model = options.model || CONFIG.geminiDefaultModel || "gemini-3-flash-preview";
    log.info(`Gemini query to ${model}: ${options.query.substring(0, 50)}...`);

    // Check for deprecated model
    const deprecationWarning = this.getDeprecationWarning(model);
    if (deprecationWarning) {
      log.warning(`[DEPRECATION] ${deprecationWarning}`);
    }

    try {
      // Build tools array - use 'as any' to bypass strict SDK typing
      const tools: unknown[] = [];
      if (options.tools) {
        for (const tool of options.tools) {
          tools.push({ type: tool });
        }
      }

      // Build input - just use string for simplicity
      let input: string = options.query;

      // If URLs are provided, append them to the query
      if (options.urls && options.urls.length > 0) {
        input = `${options.query}\n\nPlease analyze these URLs:\n${options.urls.join("\n")}`;
      }

      // Create interaction - use 'as any' to handle SDK type strictness
      const response = await (this.client.interactions as any).create({
        model,
        input,
        tools: tools.length > 0 ? tools : undefined,
        previousInteractionId: options.previousInteractionId,
        store: true,
        generationConfig: options.generationConfig ? {
          temperature: options.generationConfig.temperature,
          maxOutputTokens: options.generationConfig.maxOutputTokens,
          thinkingLevel: options.generationConfig.thinkingLevel,
          ...(options.generationConfig.responseMimeType && {
            responseMimeType: options.generationConfig.responseMimeType,
          }),
          ...(options.generationConfig.responseSchema && {
            responseSchema: options.generationConfig.responseSchema,
          }),
        } : undefined,
      });

      const interaction = this.mapInteraction(response);
      if (deprecationWarning) {
        interaction.deprecationWarning = deprecationWarning;
      }
      return interaction;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Gemini query failed: ${msg}`);
      throw error;
    }
  }

  /**
   * Check if a model is deprecated and return a warning message
   */
  private getDeprecationWarning(model: string): string | null {
    const DEPRECATED_MODELS: Record<string, string> = {
      "gemini-2.5-flash": "gemini-2.5-flash is retiring March 31, 2026. Migrate to gemini-3-flash-preview.",
      "gemini-2.5-pro": "gemini-2.5-pro is retiring March 31, 2026. Migrate to gemini-3-pro-preview.",
    };
    return DEPRECATED_MODELS[model] || null;
  }

  /**
   * Start deep research using the Deep Research agent
   */
  async deepResearch(options: DeepResearchOptions): Promise<GeminiInteraction> {
    if (!this.client) {
      throw new Error("Gemini API key not configured. Set GEMINI_API_KEY environment variable.");
    }

    if (!CONFIG.geminiDeepResearchEnabled) {
      throw new Error("Deep Research is disabled. Set GEMINI_DEEP_RESEARCH_ENABLED=true to enable.");
    }

    log.info(`Starting deep research: ${options.query.substring(0, 50)}...`);

    try {
      // Start research in background - use 'as any' to handle SDK type strictness
      const response = await (this.client.interactions as any).create({
        input: options.query,
        agent: "deep-research-pro-preview-12-2025",
        background: options.background !== false,
        store: true,
      });

      const interaction = this.mapInteraction(response);
      log.info(`Deep research started: ${interaction.id}`);

      // If waiting for completion, poll
      if (options.waitForCompletion !== false) {
        return this.pollForCompletion(
          interaction.id,
          options.maxWaitMs || 300000, // 5 minutes default
          options.progressCallback
        );
      }

      return interaction;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Deep research failed: ${msg}`);
      throw error;
    }
  }

  /**
   * Get an existing interaction by ID
   */
  async getInteraction(interactionId: string): Promise<GeminiInteraction> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    try {
      const response = await (this.client.interactions as any).get(interactionId);
      return this.mapInteraction(response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to get interaction ${interactionId}: ${msg}`);
      throw error;
    }
  }

  /**
   * Poll for interaction completion
   */
  async pollForCompletion(
    interactionId: string,
    maxWaitMs: number,
    progressCallback?: ProgressCallback
  ): Promise<GeminiInteraction> {
    const startTime = Date.now();
    const pollInterval = 10000; // 10 seconds
    let lastStatus: InteractionStatus | null = null;

    log.info(`Polling for completion: ${interactionId} (max ${maxWaitMs / 1000}s)`);

    while (Date.now() - startTime < maxWaitMs) {
      const interaction = await this.getInteraction(interactionId);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // Report progress - ProgressCallback signature is (message, progress?, total?)
      if (progressCallback && interaction.status !== lastStatus) {
        const progress = Math.min(90, Math.round((elapsed / (maxWaitMs / 1000)) * 100));
        await progressCallback(
          `Research ${interaction.status}... (${elapsed}s elapsed)`,
          progress,
          100
        );
        lastStatus = interaction.status;
      }

      // Check if done
      if (interaction.status === "completed") {
        if (progressCallback) {
          await progressCallback("Research complete", 100, 100);
        }
        log.success(`Research completed in ${elapsed}s`);
        return interaction;
      }

      if (interaction.status === "incomplete") {
        if (progressCallback) {
          await progressCallback("Research completed with partial results", 100, 100);
        }
        log.warning(`Research incomplete after ${elapsed}s (partial results)`);
        return interaction;
      }

      if (interaction.status === "failed") {
        if (progressCallback) {
          await progressCallback("Research failed", 100, 100);
        }
        log.error(`Research failed: ${interaction.error || "Unknown error"}`);
        return interaction;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    throw new Error(`Research timed out after ${elapsed} seconds`);
  }

  /**
   * Delete a stored interaction
   */
  async deleteInteraction(interactionId: string): Promise<void> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    try {
      await (this.client.interactions as any).delete(interactionId);
      log.info(`Deleted interaction: ${interactionId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to delete interaction: ${msg}`);
      throw error;
    }
  }

  /**
   * Map SDK response to our interface
   */
  private mapInteraction(response: unknown): GeminiInteraction {
    // The SDK returns an object with id, model, status, outputs, usage
    const r = response as {
      id?: string;
      model?: string;
      status?: string;
      outputs?: Array<{
        type?: string;
        text?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        id?: string;
      }>;
      usage?: {
        totalTokens?: number;
        total_tokens?: number;
        promptTokens?: number;
        prompt_tokens?: number;
        completionTokens?: number;
        completion_tokens?: number;
      };
      error?: string;
    };

    const outputs: GeminiOutput[] = (r.outputs || []).map(o => ({
      type: (o.type as "text" | "function_call" | "image") || "text",
      text: o.text,
      name: o.name,
      arguments: o.arguments,
      id: o.id,
    }));

    return {
      id: r.id || "",
      model: r.model,
      status: (r.status as InteractionStatus) || "pending",
      outputs,
      usage: r.usage ? {
        totalTokens: r.usage.totalTokens || r.usage.total_tokens || 0,
        promptTokens: r.usage.promptTokens || r.usage.prompt_tokens,
        completionTokens: r.usage.completionTokens || r.usage.completion_tokens,
      } : undefined,
      error: r.error,
    };
  }

  // ===========================================================================
  // Files API Methods (v1.9.0)
  // ===========================================================================

  /**
   * Upload a document to Gemini Files API
   * Files are retained for 48 hours and can be used in multiple queries
   * Large PDFs (>50MB or >1000 pages) are automatically chunked
   */
  async uploadDocument(options: UploadDocumentOptions): Promise<UploadDocumentResult> {
    if (!this.client) {
      throw new Error("Gemini API key not configured. Set GEMINI_API_KEY environment variable.");
    }

    const { filePath, displayName, mimeType } = options;

    // Verify file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get file stats
    const stats = fs.statSync(filePath);
    const fileName = displayName || path.basename(filePath);

    // Auto-detect MIME type if not provided
    const detectedMimeType = mimeType || this.detectMimeType(filePath);

    // Check if this is a PDF that might need chunking
    const isPdf = detectedMimeType === "application/pdf" ||
                  filePath.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      const analysis = await analyzePdf(filePath);

      if (analysis.needsChunking) {
        log.info(`Large PDF detected: ${analysis.reason}`);
        log.info(`Splitting into ~${analysis.estimatedChunks} chunks...`);

        return await this.uploadChunkedPdf(filePath, fileName, analysis.pageCount);
      }
    }

    // Standard upload for non-PDF or small PDF files
    log.info(`Uploading document: ${fileName} (${this.formatBytes(stats.size)})`);

    try {
      // Upload file using SDK
      const uploadResult = await (this.client.files as any).upload({
        file: filePath,
        config: {
          displayName: fileName,
          mimeType: detectedMimeType,
        },
      });

      // Poll for processing completion
      let file = await this.waitForFileProcessing(uploadResult.name);

      log.success(`Document uploaded: ${file.name}`);

      return {
        fileName: file.name,
        displayName: file.displayName || fileName,
        uri: file.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        expiresAt: file.expirationTime || this.calculateExpiration(),
        state: file.state as FileState,
        wasChunked: false,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to upload document: ${msg}`);
      throw error;
    }
  }

  /**
   * Upload a large PDF by splitting it into chunks
   */
  private async uploadChunkedPdf(
    filePath: string,
    displayName: string,
    _totalPages: number
  ): Promise<UploadDocumentResult> {
    // Chunk the PDF
    const chunkResult = await chunkPdf(filePath);

    if (!chunkResult.success) {
      throw new Error(`Failed to chunk PDF: ${chunkResult.error}`);
    }

    log.info(`Uploading ${chunkResult.chunks.length} chunks...`);

    const uploadedChunks: UploadedChunk[] = [];
    const allFileNames: string[] = [];

    try {
      // Upload each chunk
      for (const chunk of chunkResult.chunks) {
        log.info(`  Uploading chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks} (pages ${chunk.pageStart}-${chunk.pageEnd})...`);

        const uploadResult = await (this.client!.files as any).upload({
          file: chunk.filePath,
          config: {
            displayName: `${displayName} (Part ${chunk.chunkIndex + 1}/${chunk.totalChunks})`,
            mimeType: "application/pdf",
          },
        });

        // Wait for processing
        const file = await this.waitForFileProcessing(uploadResult.name);

        uploadedChunks.push({
          fileName: file.name,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          uri: file.uri,
        });

        allFileNames.push(file.name);

        log.success(`  Chunk ${chunk.chunkIndex + 1} uploaded: ${file.name}`);
      }

      // Clean up temp chunk files
      await cleanupChunks(chunkResult.chunks);

      // Return result with first chunk as primary
      const firstChunk = uploadedChunks[0];

      log.success(`All ${uploadedChunks.length} chunks uploaded successfully`);

      return {
        fileName: firstChunk.fileName,
        displayName: displayName,
        uri: firstChunk.uri,
        mimeType: "application/pdf",
        sizeBytes: fs.statSync(filePath).size,
        expiresAt: this.calculateExpiration(),
        state: "ACTIVE",
        wasChunked: true,
        totalPages: chunkResult.totalPages,
        chunks: uploadedChunks,
        allFileNames: allFileNames,
      };
    } catch (error) {
      // Clean up temp files on error
      await cleanupChunks(chunkResult.chunks);
      throw error;
    }
  }

  /**
   * Wait for file processing to complete
   */
  private async waitForFileProcessing(fileName: string, maxWaitMs = 60000): Promise<GeminiFile> {
    const startTime = Date.now();
    const pollInterval = 2000; // 2 seconds

    while (Date.now() - startTime < maxWaitMs) {
      const file = await this.getFile(fileName);

      if (file.state === "ACTIVE") {
        return file;
      }

      if (file.state === "FAILED") {
        throw new Error(`File processing failed: ${file.error || "Unknown error"}`);
      }

      // Still processing, wait and retry
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`File processing timed out after ${maxWaitMs / 1000} seconds`);
  }

  /**
   * Get file metadata
   */
  async getFile(fileName: string): Promise<GeminiFile> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    try {
      const response = await (this.client.files as any).get({ name: fileName });
      return this.mapFile(response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to get file ${fileName}: ${msg}`);
      throw error;
    }
  }

  /**
   * List all uploaded files
   */
  async listFiles(pageSize = 100, pageToken?: string): Promise<ListDocumentsResult> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    try {
      const response = await (this.client.files as any).list({
        pageSize,
        pageToken,
      });

      const files: GeminiFile[] = (response.files || []).map((f: unknown) => this.mapFile(f));

      return {
        files,
        totalCount: files.length,
        nextPageToken: response.nextPageToken,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to list files: ${msg}`);
      throw error;
    }
  }

  /**
   * Delete an uploaded file
   */
  async deleteFile(fileName: string): Promise<void> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    try {
      await (this.client.files as any).delete({ name: fileName });
      log.info(`Deleted file: ${fileName}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Failed to delete file ${fileName}: ${msg}`);
      throw error;
    }
  }

  /**
   * Query an uploaded document
   */
  async queryDocument(options: QueryDocumentOptions): Promise<QueryDocumentResult> {
    if (!this.client) {
      throw new Error("Gemini API key not configured. Set GEMINI_API_KEY environment variable.");
    }

    const { fileName, query, model, additionalFiles, generationConfig } = options;
    const modelId = model || CONFIG.geminiDefaultModel || "gemini-2.5-flash";

    log.info(`Querying document ${fileName}: ${query.substring(0, 50)}...`);

    try {
      // Get file metadata for URI
      const file = await this.getFile(fileName);
      if (file.state !== "ACTIVE") {
        throw new Error(`File is not ready for querying. State: ${file.state}`);
      }

      // Build content parts with file references
      const fileParts: unknown[] = [
        { fileData: { fileUri: file.uri, mimeType: file.mimeType } },
      ];

      // Add additional files if specified
      const filesUsed = [fileName];
      if (additionalFiles) {
        for (const additionalFileName of additionalFiles) {
          const additionalFile = await this.getFile(additionalFileName);
          if (additionalFile.state === "ACTIVE") {
            fileParts.push({
              fileData: { fileUri: additionalFile.uri, mimeType: additionalFile.mimeType },
            });
            filesUsed.push(additionalFileName);
          }
        }
      }

      // Generate content with the document
      const response = await (this.client.models as any).generateContent({
        model: modelId,
        contents: [
          {
            role: "user",
            parts: [
              ...fileParts,
              { text: query },
            ],
          },
        ],
        generationConfig: generationConfig ? {
          temperature: generationConfig.temperature,
          maxOutputTokens: generationConfig.maxOutputTokens,
        } : undefined,
      });

      // Extract response text
      const answer = response.response?.text?.() ||
                     response.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
                     "";

      // Extract usage
      const usage = response.response?.usageMetadata;

      log.success(`Document query completed`);

      return {
        answer,
        model: modelId,
        tokensUsed: usage?.totalTokenCount,
        filesUsed,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Document query failed: ${msg}`);
      throw error;
    }
  }

  /**
   * Query multiple document chunks and aggregate results
   * This is useful for querying large documents that were split into chunks
   */
  async queryChunkedDocument(
    fileNames: string[],
    query: string,
    options?: {
      model?: string;
      aggregatePrompt?: string;
    }
  ): Promise<QueryDocumentResult> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    if (fileNames.length === 0) {
      throw new Error("No file names provided");
    }

    // Single file - just query normally
    if (fileNames.length === 1) {
      return this.queryDocument({
        fileName: fileNames[0],
        query,
        model: options?.model as any,
      });
    }

    const modelId = options?.model || CONFIG.geminiDefaultModel || "gemini-2.5-flash";
    log.info(`Querying ${fileNames.length} document chunks...`);

    // Query each chunk
    const chunkResults: { chunkIndex: number; answer: string }[] = [];
    let totalTokens = 0;

    for (let i = 0; i < fileNames.length; i++) {
      log.info(`  Querying chunk ${i + 1}/${fileNames.length}...`);

      const result = await this.queryDocument({
        fileName: fileNames[i],
        query,
        model: options?.model as any,
      });

      chunkResults.push({
        chunkIndex: i,
        answer: result.answer,
      });

      totalTokens += result.tokensUsed || 0;
    }

    // Aggregate results using Gemini
    const aggregatePrompt = options?.aggregatePrompt ||
      `You received the following answers from different parts of a large document.
Please synthesize these into a single, coherent response that addresses the original query.
Remove any redundancy and present the information in a clear, organized manner.

Original query: ${query}

Answers from document parts:
${chunkResults.map((r, i) => `--- Part ${i + 1} ---\n${r.answer}`).join("\n\n")}

Synthesized answer:`;

    log.info(`  Aggregating ${chunkResults.length} chunk results...`);

    const aggregateResult = await this.query({
      query: aggregatePrompt,
      model: modelId as any,
    });

    const answer = aggregateResult.outputs.find(o => o.type === "text")?.text || "";
    totalTokens += aggregateResult.usage?.totalTokens || 0;

    log.success(`Chunked document query completed`);

    return {
      answer,
      model: modelId,
      tokensUsed: totalTokens,
      filesUsed: fileNames,
    };
  }

  /**
   * Map SDK file response to our interface
   */
  private mapFile(response: unknown): GeminiFile {
    const r = response as {
      name?: string;
      displayName?: string;
      mimeType?: string;
      sizeBytes?: string | number;
      createTime?: string;
      expirationTime?: string;
      state?: string;
      uri?: string;
      error?: { message?: string };
    };

    return {
      name: r.name || "",
      displayName: r.displayName,
      mimeType: r.mimeType || "application/octet-stream",
      sizeBytes: typeof r.sizeBytes === "string" ? parseInt(r.sizeBytes, 10) : r.sizeBytes,
      createTime: r.createTime,
      expirationTime: r.expirationTime,
      state: (r.state as FileState) || "PROCESSING",
      uri: r.uri || "",
      error: r.error?.message,
    };
  }

  /**
   * Detect MIME type from file extension
   */
  private detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".html": "text/html",
      ".htm": "text/html",
      ".csv": "text/csv",
      ".json": "application/json",
      ".xml": "application/xml",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".mp4": "video/mp4",
    };
    return mimeTypes[ext] || "application/octet-stream";
  }

  /**
   * Format bytes to human-readable string
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Calculate expiration time (48 hours from now)
   */
  private calculateExpiration(): string {
    const expiration = new Date();
    expiration.setHours(expiration.getHours() + 48);
    return expiration.toISOString();
  }
}
