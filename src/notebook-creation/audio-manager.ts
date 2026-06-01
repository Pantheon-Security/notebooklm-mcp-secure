/**
 * Audio Manager
 *
 * Manages audio overview generation in NotebookLM notebooks.
 * Audio overviews are AI-generated podcast-style summaries of notebook content.
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Maximum size for a downloaded audio file. Caps unbounded in-memory buffering
 * (response.body() reads the whole response) and arbitrary disk writes (H14).
 */
const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MiB

/**
 * Allowed origins for audio download URLs scraped from the page DOM.
 * Prevents SSRF: the download URL (downloadBtn.href / data-url / audio.src) is
 * attacker-influenceable content, so it must be confined to Google/NotebookLM
 * hosts before page.goto() (C3). Mirrors the host-matching used by
 * validateNotebookUrl in utils/security.ts.
 */
const ALLOWED_AUDIO_DOWNLOAD_DOMAINS = [
  "google.com",
  "googleusercontent.com",
];

/**
 * Resolve and validate the audio output path, confining it to an allowed base
 * directory (C2). Mirrors resolveExportPath in tools/handlers/system.ts:
 *   1. NLMCP_EXPORT_DIR env override
 *   2. user home directory
 * Rejects absolute paths and '..' traversal that escape the base dir.
 */
function resolveAudioOutputPath(userPath: string | undefined, defaultName: string): string {
  const envDir = process.env.NLMCP_EXPORT_DIR?.trim();
  const baseDirRaw = envDir && envDir.length > 0 ? envDir : os.homedir();
  const baseDir = path.resolve(baseDirRaw);

  const candidate = userPath && userPath.trim().length > 0
    ? path.resolve(baseDir, userPath)
    : path.resolve(baseDir, defaultName);

  // Defence in depth: ensure resolved path is still inside the base dir.
  const rel = path.relative(baseDir, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `output_path must resolve inside ${baseDir} (got '${candidate}'). ` +
      `Set NLMCP_EXPORT_DIR to allow another base directory.`
    );
  }
  return candidate;
}

/**
 * Validate a DOM-sourced audio download URL before navigating to it (C3, SSRF).
 * Enforces https and an allowed Google/NotebookLM host. Returns the normalized
 * URL or throws.
 */
function validateAudioDownloadUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Audio download URL is not a valid absolute URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Audio download URL must be https (got '${parsed.protocol}')`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_AUDIO_DOWNLOAD_DOMAINS.some(
    (d) => hostname === d || hostname.endsWith("." + d)
  );
  if (!allowed) {
    throw new Error(`Audio download host not allowed: ${hostname}`);
  }

  return parsed.href;
}

export interface AudioStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number; // 0-100
  duration?: number; // seconds
  estimatedTimeRemaining?: number; // seconds
}

export interface GenerateAudioResult {
  success: boolean;
  status: AudioStatus;
  error?: string;
}

export interface DownloadAudioResult {
  success: boolean;
  filePath?: string;
  size?: number;
  error?: string;
}

// Selectors for audio controls (may need refinement based on actual UI)
const AUDIO_SELECTORS = {
  // Generate button
  generateButton: {
    primary: 'button[aria-label*="audio" i], button[aria-label*="podcast" i]',
    fallbacks: [
      'button:has-text("Audio Overview")',
      'button:has-text("Generate")',
      '[class*="audio-generate"]',
      '[data-testid*="audio"]',
    ],
  },
  // Status indicators
  status: {
    generating: '[class*="generating"], [class*="processing"], [role="progressbar"]',
    ready: '[class*="audio-ready"], [class*="play-button"], audio',
    failed: '[class*="error"], [class*="failed"]',
  },
  // Audio player
  player: {
    container: '[class*="audio-player"], audio, [role="audio"]',
    playButton: 'button[aria-label*="play" i]',
    downloadButton: 'button[aria-label*="download" i], a[download]',
  },
  // Progress
  progress: {
    bar: '[role="progressbar"]',
    text: '[class*="progress-text"], [class*="eta"]',
  },
};

type BrowserDomElement = unknown;

interface BrowserClickableElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  click(): void;
}

interface BrowserAudioElement {
  duration?: number;
  src?: string;
  currentSrc?: string;
}

interface BrowserProgressElement {
  getAttribute(name: string): string | null;
}

interface BrowserLinkElement {
  href?: string;
  getAttribute(name: string): string | null;
}

interface BrowserDocumentContext {
  document: {
    querySelector(selector: string): BrowserDomElement | null;
    querySelectorAll(selector: string): Iterable<BrowserDomElement>;
  };
}

export class AudioManager {
  private page: Page | null = null;

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager
  ) {}

  /**
   * Navigate to a notebook and ensure we're on the right page
   */
  private async navigateToNotebook(notebookUrl: string): Promise<Page> {
    const context = await this.contextManager.getOrCreateContext();
    const isAuth = await this.authManager.validateWithRetry(context);

    if (!isAuth) {
      throw new Error("Not authenticated. Run setup_auth first.");
    }

    this.page = await context.newPage();
    await this.page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => {});
    await randomDelay(1500, 2500);

    return this.page;
  }

  /**
   * Generate an audio overview for a notebook
   */
  async generateAudioOverview(notebookUrl: string): Promise<GenerateAudioResult> {
    log.info(`Generating audio overview for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // First, check current status
      const currentStatus = await this.checkAudioStatusInternal(page);

      if (currentStatus.status === "generating") {
        log.info("  Audio generation already in progress");
        return {
          success: true,
          status: currentStatus,
        };
      }

      if (currentStatus.status === "ready") {
        log.info("  Audio already generated");
        return {
          success: true,
          status: currentStatus,
        };
      }

      // Try to find and click the generate button
      let generateClicked = false;

      // Try primary selector first — check visibility to avoid timeout on hidden elements
      const primaryBtn = await page.$(AUDIO_SELECTORS.generateButton.primary);
      if (primaryBtn && (await primaryBtn.isVisible())) {
        await primaryBtn.click();
        generateClicked = true;
      } else {
        // Try fallbacks
        for (const selector of AUDIO_SELECTORS.generateButton.fallbacks) {
          try {
            const btn = await page.$(selector);
            if (btn && (await btn.isVisible())) {
              await btn.click();
              generateClicked = true;
              break;
            }
          } catch (err) {
            log.debug(`audio-manager: clicking generate button selector: ${err instanceof Error ? err.message : String(err)}`);
            // Continue trying
          }
        }
      }

      // Also try finding by text content
      if (!generateClicked) {
        generateClicked = await page.evaluate(() => {
          const browser = globalThis as unknown as BrowserDocumentContext;
          const buttons = Array.from(browser.document.querySelectorAll("button")) as BrowserClickableElement[];
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || "";
            if (text.includes("audio") || text.includes("podcast") || text.includes("generate")) {
              if (!text.includes("stop") && !text.includes("cancel")) {
                btn.click();
                return true;
              }
            }
          }
          return false;
        });
      }

      if (!generateClicked) {
        log.warning("  Could not find audio generation button");
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find audio generation button. The feature may not be available for this notebook.",
        };
      }

      await randomDelay(2000, 3000);

      // Check if generation started
      const newStatus = await this.checkAudioStatusInternal(page);

      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  Audio generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return {
          success: true,
          status: newStatus,
        };
      }

      return {
        success: false,
        status: newStatus,
        error: "Audio generation may have failed to start. Try again or check the notebook.",
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Check the current audio status for a notebook
   */
  async getAudioStatus(notebookUrl: string): Promise<AudioStatus> {
    log.info(`Checking audio status for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const status = await this.checkAudioStatusInternal(page);
      log.info(`  Status: ${status.status}`);
      return status;
    } finally {
      await this.closePage();
    }
  }

  /**
   * Internal: Check audio status on current page
   */
  private async checkAudioStatusInternal(page: Page): Promise<AudioStatus> {
    return await page.evaluate(() => {
      const browser = globalThis as unknown as BrowserDocumentContext;

      // Check for generating state
      const generating = browser.document.querySelector('[class*="generating"], [class*="processing"]');
      const progressBar = browser.document.querySelector('[role="progressbar"]') as BrowserProgressElement | null;

      if (generating || progressBar) {
        let progress = 0;
        if (progressBar) {
          const value = progressBar.getAttribute("aria-valuenow");
          if (value) {
            progress = parseInt(value, 10);
          }
        }
        return {
          status: "generating" as const,
          progress,
        };
      }

      // Check for ready state (audio player or download button)
      const audioElement = browser.document.querySelector("audio") as BrowserAudioElement | null;
      const playButton = browser.document.querySelector('button[aria-label*="play" i]');
      const downloadButton = browser.document.querySelector('button[aria-label*="download" i], a[download]');

      if (audioElement || playButton || downloadButton) {
        let duration = 0;
        if (audioElement) {
          duration = audioElement.duration || 0;
        }
        return {
          status: "ready" as const,
          duration,
        };
      }

      // Check for failed state
      const errorElement = browser.document.querySelector('[class*="error"], [class*="failed"]');
      if (errorElement) {
        return { status: "failed" as const };
      }

      // Check if audio section exists but not started
      const audioSection = browser.document.querySelector('[class*="audio"], [aria-label*="audio" i]');
      if (audioSection) {
        return { status: "not_started" as const };
      }

      return { status: "unknown" as const };
    });
  }

  /**
   * Download the generated audio file
   */
  async downloadAudio(
    notebookUrl: string,
    outputPath?: string
  ): Promise<DownloadAudioResult> {
    log.info(`Downloading audio from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // First check if audio is ready
      const status = await this.checkAudioStatusInternal(page);

      if (status.status !== "ready") {
        return {
          success: false,
          error: `Audio not ready. Current status: ${status.status}`,
        };
      }

      // Look for download button or audio element
      const downloadInfo = await page.evaluate(() => {
        const browser = globalThis as unknown as BrowserDocumentContext;

        // Look for download button
        const downloadBtn = browser.document.querySelector('button[aria-label*="download" i], a[download]') as BrowserLinkElement | null;
        if (downloadBtn) {
          const href = downloadBtn.href || downloadBtn.getAttribute("data-url");
          return { type: "button", url: href };
        }

        // Look for audio element source
        const audio = browser.document.querySelector("audio") as BrowserAudioElement | null;
        if (audio) {
          const src = audio.src || audio.currentSrc;
          return { type: "audio", url: src };
        }

        return null;
      });

      if (!downloadInfo || !downloadInfo.url) {
        // Try clicking download button directly
        const clicked = await page.evaluate(() => {
          const browser = globalThis as unknown as BrowserDocumentContext;
          const buttons = Array.from(browser.document.querySelectorAll("button, a")) as BrowserClickableElement[];
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || "";
            const aria = btn.getAttribute("aria-label")?.toLowerCase() || "";
            if (text.includes("download") || aria.includes("download")) {
              btn.click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          // The button was clicked but we cannot capture the file via this code
          // path, so no file is written. Do not report success (M27).
          await randomDelay(2000, 3000);
          return {
            success: false,
            error: "Download could not be completed automatically; no file was saved. Try downloading the audio manually from the notebook.",
          };
        }

        return {
          success: false,
          error: "Could not find download button or audio source",
        };
      }

      // Confine output to an allowed base directory (C2). When no output_path
      // is supplied, the generated default also lands inside the base dir.
      const defaultName = `notebooklm-audio-${Date.now()}.mp3`;
      const finalPath = resolveAudioOutputPath(outputPath, defaultName);

      // Validate the DOM-sourced download URL before navigating (C3, SSRF).
      const safeDownloadUrl = validateAudioDownloadUrl(downloadInfo.url);

      // Download the file using the page context
      const response = await page.goto(safeDownloadUrl);
      if (!response) {
        return {
          success: false,
          error: "Failed to fetch audio file",
        };
      }

      // Enforce size cap early via Content-Length if present (H14).
      const contentLengthHeader = response.headers()["content-length"];
      if (contentLengthHeader) {
        const declared = parseInt(contentLengthHeader, 10);
        if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
          return {
            success: false,
            error: `Audio file too large: ${declared} bytes exceeds limit of ${MAX_AUDIO_BYTES} bytes`,
          };
        }
      }

      // Warn (do not hard-fail) if content-type is not audio/* — NotebookLM may
      // serve application/octet-stream.
      const contentType = response.headers()["content-type"];
      if (contentType && !contentType.startsWith("audio/") && !contentType.startsWith("application/octet-stream")) {
        log.warning(`  Unexpected audio content-type: ${contentType}`);
      }

      // patchright's response.body() has no streaming cap, so buffer then
      // enforce the cap before writing (H14). Content-Length can be absent or
      // inaccurate, so this check is authoritative.
      const buffer = await response.body();
      if (buffer.length > MAX_AUDIO_BYTES) {
        return {
          success: false,
          error: `Audio file too large: ${buffer.length} bytes exceeds limit of ${MAX_AUDIO_BYTES} bytes`,
        };
      }

      // Async write to avoid blocking the event loop (H14).
      await fs.promises.writeFile(finalPath, buffer);

      log.success(`  Audio downloaded: ${finalPath} (${buffer.length} bytes)`);

      return {
        success: true,
        filePath: finalPath,
        size: buffer.length,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`  Failed to download audio: ${msg}`);
      return {
        success: false,
        error: msg,
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Close the page if open
   */
  private async closePage(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        log.debug(`audio-manager: closing page: ${err instanceof Error ? err.message : String(err)}`);
        // Ignore close errors
      }
      this.page = null;
    }
  }
}
