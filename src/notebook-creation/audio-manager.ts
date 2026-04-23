/**
 * Audio Manager
 *
 * Manages Audio Overview generation in NotebookLM notebooks.
 * Audio overviews are AI-generated podcast-style summaries, available
 * through the Studio panel in NotebookLM (April 2026 redesign).
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026):
 * - Studio panel toggle: .toggle-studio-panel-button (locale-independent)
 * - Tiles container: .create-artifact-button-container (only when panel is open)
 * - Audio tile: aria-label="音声解説" (ja), class includes "blue", jslog^="261212"
 * - Icon inside tile: mat-icon text = "audio_magic_eraser"  (Material icon, never translated)
 * - Clicking the tile either starts generation directly or opens a customise
 *   dialog (language/voice) depending on account settings; we handle both.
 * - Artifacts appear in .artifact-library-container with .artifact-item-button
 * - Generating state: .shimmer-blue class + .rotate "sync" icon
 * - Ready state: .artifact-item-button without shimmer, with play/download
 *   controls, or a native <audio> element.
 *
 * Previous implementation was stuck on the old "button[aria-label*='audio' i]"
 * selector — it never opened the Studio panel and failed silently in the ja UI.
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
    await randomDelay(2000, 3000);

    return this.page;
  }

  /**
   * Ensure the Studio panel is visible.
   *
   * Same strategy as VideoManager.ensureStudioPanelOpen — kept in sync
   * intentionally so both managers share the same panel-opening logic.
   */
  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(
        ".create-artifact-button-container, [class*='create-artifact'][role='button'], .toggle-studio-panel-button",
        { timeout: 30000 }
      );
    } catch {
      // Fall through; evaluate() below decides.
    }

    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      if (document.querySelector(".create-artifact-button-container, [class*='create-artifact'][role='button']")) return true;

      const candidateSelectors = [
        ".toggle-studio-panel-button",
        '[aria-label*="studio" i]',
        'button[class*="studio"]',
      ];
      for (const selector of candidateSelectors) {
        // @ts-expect-error - DOM types
        const toggleBtn = document.querySelector(selector) as any;
        if (!toggleBtn) continue;
        toggleBtn.click();
        return true;
      }
      return false;
    });
  }

  /**
   * Click the Audio Overview tile in the Studio panel.
   * Uses a 4-layer fallback — locale-independent signals first.
   */
  private async clickAudioTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // Primary: blue accent class (locale-independent, stable April 2026)
      // @ts-expect-error - DOM types
      const tileByClass = document.querySelector('.create-artifact-button-container.blue[role="button"]') as any;
      if (tileByClass) { tileByClass.click(); return true; }

      // Secondary: Material icon "audio_magic_eraser" (icon names never translate)
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll('.create-artifact-button-container[role="button"]');
      for (const tile of tiles) {
        const iconText = (tile as any).querySelector("mat-icon")?.textContent?.trim() || "";
        if (iconText === "audio_magic_eraser" || iconText === "podcasts") {
          (tile as any).click();
          return true;
        }
      }

      // Tertiary: jslog numeric ID 261212 (locale-independent, confirmed April 2026)
      // @ts-expect-error - DOM types
      const tileByJslog = document.querySelector('[jslog^="261212"][role="button"]') as any;
      if (tileByJslog) { tileByJslog.click(); return true; }

      // Fallback: aria/text multi-locale match
      // @ts-expect-error - DOM types
      const tilesByAria = document.querySelectorAll('[role="button"]');
      for (const t of tilesByAria) {
        const aria = (t as any).getAttribute('aria-label') || '';
        const text = (t as any).textContent || '';
        if (/audio overview|音声解説|résumé audio|podcast/i.test(aria + ' ' + text)) {
          (t as any).click();
          return true;
        }
      }

      return false;
    });
  }

  /**
   * Wait (up to ~8s) for an optional customise dialog that might appear
   * after clicking the audio tile (some accounts get language/voice picker).
   * If it appears, accept defaults via the primary "Generate/生成" button.
   */
  private async acceptCustomiseDialogIfAny(page: Page): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const handled = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const dialog = document.querySelector('mat-dialog-container');
        if (!dialog) return false;
        // Look for primary (unelevated) generate button inside the dialog
        const submit = (dialog as any).querySelector(
          'mat-dialog-actions button.button-color--primary:not([disabled]), ' +
          'mat-dialog-actions button.mdc-button--unelevated:not([disabled])'
        );
        if (submit) { submit.click(); return true; }
        return null; // dialog present but submit not ready — wait
      });
      if (handled === true) return;
      if (handled === false) return; // no dialog — nothing to do
      await randomDelay(300, 500);
    }
  }

  /**
   * Generate an audio overview for a notebook
   */
  async generateAudioOverview(notebookUrl: string): Promise<GenerateAudioResult> {
    log.info(`🎙️ Generating audio overview for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // If an artifact already exists, return its state
      const currentStatus = await this.checkAudioStatusInternal(page);
      if (currentStatus.status === "generating") {
        log.info("  ⏳ Audio generation already in progress");
        return { success: true, status: currentStatus };
      }
      if (currentStatus.status === "ready") {
        log.info("  ✅ Audio already generated");
        return { success: true, status: currentStatus };
      }

      // Open the Studio panel
      const panelOpened = await this.ensureStudioPanelOpen(page);
      if (!panelOpened) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not open Studio panel (toggle button not found).",
        };
      }
      await randomDelay(800, 1400);

      // Click the audio tile
      const tileClicked = await this.clickAudioTile(page);
      if (!tileClicked) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Audio Overview tile in Studio panel.",
        };
      }
      await randomDelay(1500, 2500);

      // Accept customise dialog if it appears (some accounts get a voice/language picker)
      await this.acceptCustomiseDialogIfAny(page);
      await randomDelay(1500, 2500);

      // Check if generation started
      const newStatus = await this.checkAudioStatusInternal(page);
      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  ✅ Audio generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return { success: true, status: newStatus };
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
   * Internal: Check audio artifact state.
   *
   * Mirrors VideoManager.checkVideoStatusInternal structure:
   *   - Generating: shimmer-blue + sync icon OR "Generating audio/音声" title
   *   - Ready: artifact item whose icon is "audio_magic_eraser" or "podcasts"
   *     (no shimmer), OR a native <audio> element or download button present.
   */
  private async checkAudioStatusInternal(page: Page): Promise<AudioStatus> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        const title = (item as any).querySelector(".artifact-title");
        const titleText = (title?.textContent?.trim() || "").toLowerCase();

        const isAudioByIcon =
          iconText === "audio_magic_eraser" || iconText === "podcasts" || iconText === "headphones";
        const isAudioGenerating =
          iconText === "sync" &&
          ((item as any).classList.contains("shimmer-blue") ||
            (item as any).classList.contains("shimmer-green"));
        const isAudioByTitle = /audio overview|音声解説|podcast/i.test(titleText);

        if (!isAudioByIcon && !isAudioGenerating && !isAudioByTitle) continue;

        if (isAudioGenerating || iconText === "sync" ||
            (item as any).classList.contains("shimmer-blue") ||
            (item as any).classList.contains("shimmer-green")) {
          return { status: "generating" as const, progress: 0 };
        }
        // Ready — attempt to extract duration from any audio element on the page
        let duration = 0;
        // @ts-expect-error - DOM types
        const audioEl = document.querySelector("audio");
        if (audioEl) duration = (audioEl as any).duration || 0;
        return { status: "ready" as const, duration };
      }

      // No artifact row yet — check for legacy indicators
      // @ts-expect-error - DOM types
      const progressBar = document.querySelector('[role="progressbar"]');
      if (progressBar) {
        const value = (progressBar as any).getAttribute("aria-valuenow");
        const progress = value ? parseInt(value, 10) : 0;
        return { status: "generating" as const, progress };
      }

      // @ts-expect-error - DOM types
      const audioElement = document.querySelector("audio");
      // @ts-expect-error - DOM types
      const playButton = document.querySelector('button[aria-label*="play" i], button[aria-label*="再生"]');
      // @ts-expect-error - DOM types
      const downloadButton = document.querySelector('button[aria-label*="download" i], a[download]');
      if (audioElement || playButton || downloadButton) {
        return { status: "ready" as const, duration: (audioElement as any)?.duration || 0 };
      }

      // @ts-expect-error - DOM types
      const failed = document.querySelector('[class*="audio-failed"], [class*="audio-error"]');
      if (failed) return { status: "failed" as const };

      return { status: "not_started" as const };
    });
  }

  /**
   * Download the generated audio overview
   */
  async downloadAudio(notebookUrl: string, outputPath?: string): Promise<DownloadAudioResult> {
    log.info(`📥 Downloading audio from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const status = await this.checkAudioStatusInternal(page);
      if (status.status !== "ready") {
        return {
          success: false,
          error: `Audio is not ready (status: ${status.status}). Generate it first.`,
        };
      }

      // Set up download path
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const defaultPath = path.join(
        process.env.HOME || "/tmp",
        `notebooklm-audio-${timestamp}.mp3`
      );
      const finalPath = outputPath || defaultPath;

      // Ensure directory exists
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Prefer Playwright's download event by clicking the download button
      let filePath: string | null = null;
      try {
        const [ download ] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          page.evaluate(() => {
            // @ts-expect-error - DOM types
            const btn = document.querySelector(
              'button[aria-label*="download" i], a[download], button[aria-label*="ダウンロード"]'
            ) as any;
            if (btn) btn.click();
          }),
        ]);
        await download.saveAs(finalPath);
        filePath = finalPath;
      } catch (e) {
        log.warning(`  Download event timed out or failed: ${e}`);
      }

      if (!filePath) {
        // Fallback: try fetching the audio element's src directly
        const audioSrc = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const audio = document.querySelector("audio");
          return audio ? (audio as any).src || (audio as any).currentSrc : null;
        });
        if (!audioSrc) {
          return { success: false, error: "Could not locate audio source to download." };
        }
        // Use page.request.get to reuse cookies
        const res = await page.request.get(audioSrc);
        if (!res.ok()) {
          return { success: false, error: `HTTP ${res.status()} while fetching audio.` };
        }
        const buffer = await res.body();
        fs.writeFileSync(finalPath, buffer);
        filePath = finalPath;
      }

      const stat = fs.statSync(filePath);
      log.success(`  ✅ Audio saved to: ${filePath} (${stat.size} bytes)`);
      return { success: true, filePath, size: stat.size };
    } finally {
      await this.closePage();
    }
  }

  private async closePage(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
  }
}
