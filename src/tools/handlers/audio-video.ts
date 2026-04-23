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
import {
  SlidesManager,
  type SlidesStatus,
  type GenerateSlidesResult,
} from "../../notebook-creation/slides-manager.js";
import {
  InfographicManager,
  type InfographicStatus,
  type GenerateInfographicResult,
} from "../../notebook-creation/infographic-manager.js";

/**
 * Shared notebook URL resolution — matches the inline pattern used across this file
 * (kept inline originally; extracted here for reuse by the new slides/infographic handlers).
 */
function resolveNotebookUrl(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string },
  logPrefix: string
): string {
  let notebookUrl = args.notebook_url;
  if (!notebookUrl && args.notebook_id) {
    const notebook = ctx.library.getNotebook(args.notebook_id);
    if (!notebook) throw new Error(`Notebook not found in library: ${args.notebook_id}`);
    notebookUrl = notebook.url;
    log.info(`  [${logPrefix}] Resolved notebook: ${notebook.name}`);
  } else if (!notebookUrl) {
    const active = ctx.library.getActiveNotebook();
    if (active) {
      notebookUrl = active.url;
      log.info(`  [${logPrefix}] Using active notebook: ${active.name}`);
    } else {
      throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
    }
  }
  return validateNotebookUrl(notebookUrl);
}

export async function handleGenerateAudioOverview(
  ctx: HandlerContext,
  args: {
    notebook_id?: string;
    notebook_url?: string;
  }
): Promise<ToolResult<GenerateAudioResult>> {
  log.info(`🔧 [TOOL] generate_audio_overview called`);

  try {
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] generate_audio_overview failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_audio_status failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] download_audio failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] generate_video_overview failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_video_status failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] generate_data_table failed: ${errorMessage}`);
    return {
      success: false,
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
    // Resolve notebook URL
    let notebookUrl = args.notebook_url;

    if (!notebookUrl && args.notebook_id) {
      const notebook = ctx.library.getNotebook(args.notebook_id);
      if (!notebook) {
        throw new Error(`Notebook not found in library: ${args.notebook_id}`);
      }
      notebookUrl = notebook.url;
      log.info(`  Resolved notebook: ${notebook.name}`);
    } else if (!notebookUrl) {
      const active = ctx.library.getActiveNotebook();
      if (active) {
        notebookUrl = active.url;
        log.info(`  Using active notebook: ${active.name}`);
      } else {
        throw new Error("No notebook specified. Provide notebook_id or notebook_url.");
      }
    }

    // Validate URL
    const safeUrl = validateNotebookUrl(notebookUrl);

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
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_data_table failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// === Slides (スライド資料) ===

export async function handleGenerateSlides(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): Promise<ToolResult<GenerateSlidesResult>> {
  log.info(`🔧 [TOOL] generate_slides called`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "generate_slides");
    const contextManager = ctx.sessionManager.getContextManager();
    const slidesManager = new SlidesManager(ctx.authManager, contextManager);
    const result = await slidesManager.generateSlides(safeUrl);
    if (result.success) {
      log.success(`✅ [TOOL] generate_slides completed (status: ${result.status.status})`);
    } else {
      log.warning(`⚠️ [TOOL] generate_slides: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] generate_slides failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleGetSlidesStatus(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): Promise<ToolResult<SlidesStatus>> {
  log.info(`🔧 [TOOL] get_slides_status called`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "get_slides_status");
    const contextManager = ctx.sessionManager.getContextManager();
    const slidesManager = new SlidesManager(ctx.authManager, contextManager);
    const status = await slidesManager.getSlidesStatus(safeUrl);
    log.success(`✅ [TOOL] get_slides_status completed (status: ${status.status})`);
    return { success: true, data: status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_slides_status failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

// === Infographic (インフォグラフィック) ===

export async function handleGenerateInfographic(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): Promise<ToolResult<GenerateInfographicResult>> {
  log.info(`🔧 [TOOL] generate_infographic called`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "generate_infographic");
    const contextManager = ctx.sessionManager.getContextManager();
    const infoManager = new InfographicManager(ctx.authManager, contextManager);
    const result = await infoManager.generateInfographic(safeUrl);
    if (result.success) {
      log.success(`✅ [TOOL] generate_infographic completed (status: ${result.status.status})`);
    } else {
      log.warning(`⚠️ [TOOL] generate_infographic: ${result.error}`);
    }
    return {
      success: result.success,
      data: result,
      ...(result.error && { error: result.error }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] generate_infographic failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleGetInfographicStatus(
  ctx: HandlerContext,
  args: { notebook_id?: string; notebook_url?: string }
): Promise<ToolResult<InfographicStatus>> {
  log.info(`🔧 [TOOL] get_infographic_status called`);
  try {
    const safeUrl = resolveNotebookUrl(ctx, args, "get_infographic_status");
    const contextManager = ctx.sessionManager.getContextManager();
    const infoManager = new InfographicManager(ctx.authManager, contextManager);
    const status = await infoManager.getInfographicStatus(safeUrl);
    log.success(`✅ [TOOL] get_infographic_status completed (status: ${status.status})`);
    return { success: true, data: status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] get_infographic_status failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
