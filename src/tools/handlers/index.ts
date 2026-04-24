/**
 * Handler Facade — ToolHandlers class that delegates to domain modules
 *
 * This file re-exports the ToolHandlers class which is the public API
 * used by index.ts. Internally it delegates to domain-specific handler functions.
 */

import { SessionManager } from "../../session/session-manager.js";
import { AuthManager } from "../../auth/auth-manager.js";
import { NotebookLibrary } from "../../library/notebook-library.js";
import { RateLimiter } from "../../utils/security.js";
import { GeminiClient } from "../../gemini/index.js";
import type { HandlerContext } from "./types.js";
import type { ProgressCallback } from "../../types.js";

// Import domain handlers
import { handleAskQuestion } from "./ask-question.js";
import {
  handleListSessions,
  handleCloseSession,
  handleResetSession,
  handleGetHealth,
} from "./session-management.js";
import { handleSetupAuth, handleReAuth } from "./auth.js";
import {
  handleAddNotebook,
  handleListNotebooks,
  handleGetNotebook,
  handleSelectNotebook,
  handleUpdateNotebook,
  handleRemoveNotebook,
  handleSearchNotebooks,
  handleGetLibraryStats,
} from "./notebook-management.js";
import {
  handleCreateNotebook,
  handleBatchCreateNotebooks,
  handleSyncLibrary,
  handleListSources,
  handleAddSource,
  handleAddFolder,
  handleRemoveSource,
} from "./notebook-creation.js";
import {
  handleExportLibrary,
  handleGetProjectInfo,
  handleGetQuota,
  handleSetQuotaTier,
  handleCleanupData,
} from "./system.js";
import { handleResearchSources } from "./research.js";
import {
  handleGenerateAudioOverview,
  handleGetAudioStatus,
  handleDownloadAudio,
  handleGenerateVideoOverview,
  handleGetVideoStatus,
  handleGenerateDataTable,
  handleGetDataTable,
  handleGenerateSlides,
  handleGetSlidesStatus,
  handleReviseSlides,
  handleDownloadSlides,
  handleGenerateInfographic,
  handleGetInfographicStatus,
  handleDownloadInfographic,
} from "./audio-video.js";
import {
  handleConfigureWebhook,
  handleListWebhooks,
  handleTestWebhook,
  handleRemoveWebhook,
} from "./webhooks.js";
import {
  handleDeepResearch,
  handleGeminiQuery,
  handleGetResearchStatus,
  handleUploadDocument,
  handleQueryDocument,
  handleListDocuments,
  handleDeleteDocument,
  handleQueryChunkedDocument,
  handleGetQueryHistory,
  handleGetNotebookChatHistory,
} from "./gemini.js";

export type { HandlerContext } from "./types.js";

/**
 * ToolHandlers — facade class that delegates to domain handler functions.
 *
 * Each method delegates to a standalone function in its domain module,
 * passing a shared HandlerContext.
 */
export class ToolHandlers {
  private ctx: HandlerContext;

  constructor(
    sessionManager: SessionManager,
    authManager: AuthManager,
    library: NotebookLibrary
  ) {
    this.ctx = {
      sessionManager,
      authManager,
      library,
      rateLimiter: new RateLimiter(100, 60000),
      geminiClient: new GeminiClient(),
    };
  }

  // === Ask Question ===
  handleAskQuestion(
    args: Parameters<typeof handleAskQuestion>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleAskQuestion(this.ctx, args, sendProgress);
  }

  // === Session Management ===
  handleListSessions() {
    return handleListSessions(this.ctx);
  }
  handleCloseSession(args: Parameters<typeof handleCloseSession>[1]) {
    return handleCloseSession(this.ctx, args);
  }
  handleResetSession(args: Parameters<typeof handleResetSession>[1]) {
    return handleResetSession(this.ctx, args);
  }
  handleGetHealth(args?: Parameters<typeof handleGetHealth>[1]) {
    return handleGetHealth(this.ctx, args);
  }

  // === Auth ===
  handleSetupAuth(
    args: Parameters<typeof handleSetupAuth>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleSetupAuth(this.ctx, args, sendProgress);
  }
  handleReAuth(
    args: Parameters<typeof handleReAuth>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleReAuth(this.ctx, args, sendProgress);
  }

  // === Notebook Management ===
  handleAddNotebook(args: Parameters<typeof handleAddNotebook>[1]) {
    return handleAddNotebook(this.ctx, args);
  }
  handleListNotebooks() {
    return handleListNotebooks(this.ctx);
  }
  handleGetNotebook(args: Parameters<typeof handleGetNotebook>[1]) {
    return handleGetNotebook(this.ctx, args);
  }
  handleSelectNotebook(args: Parameters<typeof handleSelectNotebook>[1]) {
    return handleSelectNotebook(this.ctx, args);
  }
  handleUpdateNotebook(args: Parameters<typeof handleUpdateNotebook>[1]) {
    return handleUpdateNotebook(this.ctx, args);
  }
  handleRemoveNotebook(args: Parameters<typeof handleRemoveNotebook>[1]) {
    return handleRemoveNotebook(this.ctx, args);
  }
  handleSearchNotebooks(args: Parameters<typeof handleSearchNotebooks>[1]) {
    return handleSearchNotebooks(this.ctx, args);
  }
  handleGetLibraryStats() {
    return handleGetLibraryStats(this.ctx);
  }

  // === Notebook Creation ===
  handleCreateNotebook(
    args: Parameters<typeof handleCreateNotebook>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleCreateNotebook(this.ctx, args, sendProgress);
  }
  handleBatchCreateNotebooks(
    args: Parameters<typeof handleBatchCreateNotebooks>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleBatchCreateNotebooks(this.ctx, args, sendProgress);
  }
  handleSyncLibrary(args: Parameters<typeof handleSyncLibrary>[1]) {
    return handleSyncLibrary(this.ctx, args);
  }
  handleListSources(args: Parameters<typeof handleListSources>[1]) {
    return handleListSources(this.ctx, args);
  }
  handleAddSource(args: Parameters<typeof handleAddSource>[1]) {
    return handleAddSource(this.ctx, args);
  }
  handleAddFolder(
    args: Parameters<typeof handleAddFolder>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleAddFolder(this.ctx, args, sendProgress);
  }
  handleRemoveSource(args: Parameters<typeof handleRemoveSource>[1]) {
    return handleRemoveSource(this.ctx, args);
  }

  // === System ===
  handleExportLibrary(args: Parameters<typeof handleExportLibrary>[1]) {
    return handleExportLibrary(this.ctx, args);
  }
  handleGetProjectInfo() {
    return handleGetProjectInfo(this.ctx);
  }
  handleGetQuota(args?: Parameters<typeof handleGetQuota>[1]) {
    return handleGetQuota(this.ctx, args);
  }
  handleSetQuotaTier(args: Parameters<typeof handleSetQuotaTier>[1]) {
    return handleSetQuotaTier(this.ctx, args);
  }
  handleCleanupData(args: Parameters<typeof handleCleanupData>[1]) {
    return handleCleanupData(this.ctx, args);
  }

  // === Audio / Video / Data Table ===
  handleGenerateAudioOverview(args: Parameters<typeof handleGenerateAudioOverview>[1]) {
    return handleGenerateAudioOverview(this.ctx, args);
  }
  handleGetAudioStatus(args: Parameters<typeof handleGetAudioStatus>[1]) {
    return handleGetAudioStatus(this.ctx, args);
  }
  handleDownloadAudio(args: Parameters<typeof handleDownloadAudio>[1]) {
    return handleDownloadAudio(this.ctx, args);
  }
  handleGenerateVideoOverview(args: Parameters<typeof handleGenerateVideoOverview>[1]) {
    return handleGenerateVideoOverview(this.ctx, args);
  }
  handleGetVideoStatus(args: Parameters<typeof handleGetVideoStatus>[1]) {
    return handleGetVideoStatus(this.ctx, args);
  }
  handleGenerateDataTable(args: Parameters<typeof handleGenerateDataTable>[1]) {
    return handleGenerateDataTable(this.ctx, args);
  }
  handleGetDataTable(args: Parameters<typeof handleGetDataTable>[1]) {
    return handleGetDataTable(this.ctx, args);
  }
  handleGenerateSlides(args: Parameters<typeof handleGenerateSlides>[1]) {
    return handleGenerateSlides(this.ctx, args);
  }
  handleGetSlidesStatus(args: Parameters<typeof handleGetSlidesStatus>[1]) {
    return handleGetSlidesStatus(this.ctx, args);
  }
  handleReviseSlides(args: Parameters<typeof handleReviseSlides>[1]) {
    return handleReviseSlides(this.ctx, args);
  }
  handleDownloadSlides(args: Parameters<typeof handleDownloadSlides>[1]) {
    return handleDownloadSlides(this.ctx, args);
  }
  handleGenerateInfographic(args: Parameters<typeof handleGenerateInfographic>[1]) {
    return handleGenerateInfographic(this.ctx, args);
  }
  handleGetInfographicStatus(args: Parameters<typeof handleGetInfographicStatus>[1]) {
    return handleGetInfographicStatus(this.ctx, args);
  }
  handleDownloadInfographic(args: Parameters<typeof handleDownloadInfographic>[1]) {
    return handleDownloadInfographic(this.ctx, args);
  }
  handleResearchSources(args: Parameters<typeof handleResearchSources>[1]) {
    return handleResearchSources(this.ctx, args);
  }

  // === Webhooks ===
  handleConfigureWebhook(args: Parameters<typeof handleConfigureWebhook>[1]) {
    return handleConfigureWebhook(this.ctx, args);
  }
  handleListWebhooks() {
    return handleListWebhooks(this.ctx);
  }
  handleTestWebhook(args: Parameters<typeof handleTestWebhook>[1]) {
    return handleTestWebhook(this.ctx, args);
  }
  handleRemoveWebhook(args: Parameters<typeof handleRemoveWebhook>[1]) {
    return handleRemoveWebhook(this.ctx, args);
  }

  // === Gemini ===
  handleDeepResearch(
    args: Parameters<typeof handleDeepResearch>[1],
    sendProgress?: ProgressCallback
  ) {
    return handleDeepResearch(this.ctx, args, sendProgress);
  }
  handleGeminiQuery(args: Parameters<typeof handleGeminiQuery>[1]) {
    return handleGeminiQuery(this.ctx, args);
  }
  handleGetResearchStatus(args: Parameters<typeof handleGetResearchStatus>[1]) {
    return handleGetResearchStatus(this.ctx, args);
  }
  handleUploadDocument(args: Parameters<typeof handleUploadDocument>[1]) {
    return handleUploadDocument(this.ctx, args);
  }
  handleQueryDocument(args: Parameters<typeof handleQueryDocument>[1]) {
    return handleQueryDocument(this.ctx, args);
  }
  handleListDocuments(args: Parameters<typeof handleListDocuments>[1]) {
    return handleListDocuments(this.ctx, args);
  }
  handleDeleteDocument(args: Parameters<typeof handleDeleteDocument>[1]) {
    return handleDeleteDocument(this.ctx, args);
  }
  handleQueryChunkedDocument(args: Parameters<typeof handleQueryChunkedDocument>[1]) {
    return handleQueryChunkedDocument(this.ctx, args);
  }
  handleGetQueryHistory(args: Parameters<typeof handleGetQueryHistory>[1]) {
    return handleGetQueryHistory(this.ctx, args);
  }
  handleGetNotebookChatHistory(args: Parameters<typeof handleGetNotebookChatHistory>[1]) {
    return handleGetNotebookChatHistory(this.ctx, args);
  }

  // === Cleanup ===
  async cleanup(): Promise<void> {
    const { log } = await import("../../utils/logger.js");
    log.info(`🧹 Cleaning up tool handlers...`);
    await this.ctx.sessionManager.closeAllSessions();
    log.success(`✅ Tool handlers cleanup complete`);
  }
}
