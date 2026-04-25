/**
 * Audio, Video, and Data Table handler functions
 *
 * Extracted from the monolithic ToolHandlers class.
 */

import type { HandlerContext } from "./types.js";
import { log } from "../../utils/logger.js";
import { validateNotebookUrl } from "../../utils/security.js";
import type { ToolResult } from "../../types.js";
import {
  AudioManager,
  type AudioStatus,
  type GenerateAudioResult,
  type DownloadAudioResult,
} from "../../notebook-creation/audio-manager.js";
import {
  VideoManager,
  type VideoStatus,
  type GenerateVideoResult,
  type VideoStyle,
  type VideoFormat,
} from "../../notebook-creation/video-manager.js";
import {
  DataTableManager,
  type GenerateDataTableResult,
  type GetDataTableResult,
} from "../../notebook-creation/data-table-manager.js";
import { getSanitizedErrorMessage, resolveNotebookUrl } from "./error-utils.js";

export async function handleGenerateAudioOverview(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<GenerateAudioResult>> {
  log.info(`🔧 [TOOL] generate_audio_overview called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Generate audio
    const audioManager = new AudioManager(ctx.authManager, contextManager);
    const result = await audioManager.generateAudioOverview(safeUrl);

    if (result.success) {
      log.success(`✅ [TOOL] generate_audio_overview completed (status: ${result.status.status})`);
    } else {
      log.warning(`⚠️ [TOOL] generate_audio_overview: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] generate_audio_overview failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleGetAudioStatus(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<AudioStatus>> {
  log.info(`🔧 [TOOL] get_audio_status called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Get status
    const audioManager = new AudioManager(ctx.authManager, contextManager);
    const status = await audioManager.getAudioStatus(safeUrl);

    log.success(`✅ [TOOL] get_audio_status completed (status: ${status.status})`);

    return {
      success: true,
      data: status,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_audio_status failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleDownloadAudio(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    output_path?: string;
  }
): Promise<ToolResult<DownloadAudioResult>> {
  log.info(`🔧 [TOOL] download_audio called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Download audio
    const audioManager = new AudioManager(ctx.authManager, contextManager);
    const result = await audioManager.downloadAudio(safeUrl, args.output_path);

    if (result.success) {
      log.success(`✅ [TOOL] download_audio completed: ${result.filePath}`);
    } else {
      log.warning(`⚠️ [TOOL] download_audio: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] download_audio failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleGenerateVideoOverview(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
    style?: VideoStyle;
    format?: VideoFormat;
  }
): Promise<ToolResult<GenerateVideoResult>> {
  log.info(`🔧 [TOOL] generate_video_overview called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Generate video
    const videoManager = new VideoManager(ctx.authManager, contextManager);
    const result = await videoManager.generateVideoOverview(
      safeUrl,
      args.style || "auto-select",
      args.format || "explainer"
    );

    if (result.success) {
      log.success(`✅ [TOOL] generate_video_overview completed (status: ${result.status.status})`);
    } else {
      log.warning(`⚠️ [TOOL] generate_video_overview: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] generate_video_overview failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleGetVideoStatus(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<VideoStatus>> {
  log.info(`🔧 [TOOL] get_video_status called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Get status
    const videoManager = new VideoManager(ctx.authManager, contextManager);
    const status = await videoManager.getVideoStatus(safeUrl);

    log.success(`✅ [TOOL] get_video_status completed (status: ${status.status})`);

    return {
      success: true,
      data: status,
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_video_status failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleGenerateDataTable(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<GenerateDataTableResult>> {
  log.info(`🔧 [TOOL] generate_data_table called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Generate data table
    const dataTableManager = new DataTableManager(ctx.authManager, contextManager);
    const result = await dataTableManager.generateDataTable(safeUrl);

    if (result.success) {
      log.success(`✅ [TOOL] generate_data_table completed (status: ${result.status.status})`);
    } else {
      log.warning(`⚠️ [TOOL] generate_data_table: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] generate_data_table failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}

export async function handleGetDataTable(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<GetDataTableResult>> {
  log.info(`🔧 [TOOL] get_data_table called`);

  try {
    const safeUrl = validateNotebookUrl(resolveNotebookUrl(ctx, args));

    // Get the shared context manager from session manager
    const contextManager = ctx.sessionManager.getContextManager();

    // Get data table
    const dataTableManager = new DataTableManager(ctx.authManager, contextManager);
    const result = await dataTableManager.getDataTable(safeUrl);

    if (result.success) {
      log.success(`✅ [TOOL] get_data_table completed (${result.table?.totalRows} rows x ${result.table?.totalColumns} cols)`);
    } else {
      log.warning(`⚠️ [TOOL] get_data_table: ${result.error}`);
    }

    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = getSanitizedErrorMessage(error);
    log.error(`❌ [TOOL] get_data_table failed: ${errorMessage}`);
    return {
      success: false,
      data: null,
      error: errorMessage,
    };
  }
}
