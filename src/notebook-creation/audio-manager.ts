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
    const context = await this.contextManager.getOrCreateContext(true);
    const isAuth = await this.authManager.validateCookiesExpiry(context);

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
    log.info(`🎙️ Generating audio overview for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // First, check current status
      const currentStatus = await this.checkAudioStatusInternal(page);

      if (currentStatus.status === "generating") {
        log.info("  ⏳ Audio generation already in progress");
        return {
          success: true,
          status: currentStatus,
        };
      }

      if (currentStatus.status === "ready") {
        log.info("  ✅ Audio already generated");
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
          } catch {
            // Continue trying
          }
        }
      }

      // Also try finding by text content
      if (!generateClicked) {
        generateClicked = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const buttons = document.querySelectorAll("button");
          for (const btn of buttons) {
            const text = (btn as any).textContent?.toLowerCase() || "";
            if (text.includes("audio") || text.includes("podcast") || text.includes("generate")) {
              if (!text.includes("stop") && !text.includes("cancel")) {
                (btn as any).click();
                return true;
              }
            }
          }
          return false;
        });
      }

      if (!generateClicked) {
        log.warning("  ⚠️ Could not find audio generation button");
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
        log.success(`  ✅ Audio generation ${newStatus.status === "ready" ? "completed" : "started"}`);
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
    log.info(`🔍 Checking audio status for: ${notebookUrl}`);

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
      // Check for generating state
      // @ts-expect-error - DOM types
      const generating = document.querySelector('[class*="generating"], [class*="processing"]');
      // @ts-expect-error - DOM types
      const progressBar = document.querySelector('[role="progressbar"]');

      if (generating || progressBar) {
        let progress = 0;
        if (progressBar) {
          const value = (progressBar as any).getAttribute("aria-valuenow");
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
      // @ts-expect-error - DOM types
      const audioElement = document.querySelector("audio");
      // @ts-expect-error - DOM types
      const playButton = document.querySelector('button[aria-label*="play" i]');
      // @ts-expect-error - DOM types
      const downloadButton = document.querySelector('button[aria-label*="download" i], a[download]');

      if (audioElement || playButton || downloadButton) {
        let duration = 0;
        if (audioElement) {
          duration = (audioElement as any).duration || 0;
        }
        return {
          status: "ready" as const,
          duration,
        };
      }

      // Check for failed state
      // @ts-expect-error - DOM types
      const errorElement = document.querySelector('[class*="error"], [class*="failed"]');
      if (errorElement) {
        return { status: "failed" as const };
      }

      // Check if audio section exists but not started
      // @ts-expect-error - DOM types
      const audioSection = document.querySelector('[class*="audio"], [aria-label*="audio" i]');
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
    log.info(`⬇️ Downloading audio from: ${notebookUrl}`);

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
        // Look for download button
        // @ts-expect-error - DOM types
        const downloadBtn = document.querySelector('button[aria-label*="download" i], a[download]');
        if (downloadBtn) {
          const href = (downloadBtn as any).href || (downloadBtn as any).getAttribute("data-url");
          return { type: "button", url: href };
        }

        // Look for audio element source
        // @ts-expect-error - DOM types
        const audio = document.querySelector("audio");
        if (audio) {
          const src = (audio as any).src || (audio as any).currentSrc;
          return { type: "audio", url: src };
        }

        return null;
      });

      if (!downloadInfo || !downloadInfo.url) {
        // Try clicking download button directly
        const clicked = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const buttons = document.querySelectorAll("button, a");
          for (const btn of buttons) {
            const text = (btn as any).textContent?.toLowerCase() || "";
            const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
            if (text.includes("download") || aria.includes("download")) {
              (btn as any).click();
              return true;
            }
          }
          return false;
        });

        if (clicked) {
          // Wait for download to start
          await randomDelay(2000, 3000);
          // Note: Actual file download handling would require more complex logic
          return {
            success: true,
            error: "Download initiated. Check your downloads folder.",
          };
        }

        return {
          success: false,
          error: "Could not find download button or audio source",
        };
      }

      // Generate output path if not provided
      const finalPath = outputPath || path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        `notebooklm-audio-${Date.now()}.mp3`
      );

      // Download the file using the page context
      const response = await page.goto(downloadInfo.url);
      if (!response) {
        return {
          success: false,
          error: "Failed to fetch audio file",
        };
      }

      const buffer = await response.body();
      fs.writeFileSync(finalPath, buffer);

      const stats = fs.statSync(finalPath);

      log.success(`  ✅ Audio downloaded: ${finalPath} (${stats.size} bytes)`);

      return {
        success: true,
        filePath: finalPath,
        size: stats.size,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`  ❌ Failed to download audio: ${msg}`);
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
      } catch {
        // Ignore close errors
      }
      this.page = null;
    }
  }
}
