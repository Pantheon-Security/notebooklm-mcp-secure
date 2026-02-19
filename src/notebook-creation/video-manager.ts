/**
 * Video Manager
 *
 * Manages Video Overview generation in NotebookLM notebooks.
 * Video overviews are AI-generated visual summaries of notebook content,
 * available through the Studio panel in NotebookLM.
 *
 * Selectors derived from live NotebookLM DOM inspection (Feb 2026):
 * - Studio panel is visible by default (toggle: .toggle-studio-panel-button)
 * - Tiles are DIVs with role="button" and class="create-artifact-button-container"
 * - Video tile: aria-label="Video Overview", class includes "green"
 * - Clicking tile opens a mat-dialog-container with format/style radio groups
 * - Generate button: mat-dialog-actions button.button-color--primary
 * - Artifacts appear in .artifact-library-container with .artifact-item-button
 * - Generating state: .shimmer-blue class + .rotate icon + "Generating" title
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

/**
 * Visual styles for video overviews (matches actual NotebookLM UI)
 */
export type VideoStyle =
  | "auto-select"
  | "custom"
  | "classic"
  | "whiteboard"
  | "kawaii"
  | "anime"
  | "watercolour"
  | "retro-print"
  | "heritage"
  | "paper-craft";

/**
 * Video format/length options
 */
export type VideoFormat = "explainer" | "brief";

export interface VideoStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number; // 0-100
  duration?: number; // seconds
}

export interface GenerateVideoResult {
  success: boolean;
  status: VideoStatus;
  error?: string;
}

export class VideoManager {
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
    await randomDelay(2000, 3000);

    return this.page;
  }

  /**
   * Ensure the Studio panel is visible (expand if collapsed).
   *
   * Live DOM inspection (Feb 2026) confirms:
   *   - Toggle button: .toggle-studio-panel-button
   *   - Tiles container: .create-artifact-button-container (present only when panel is open)
   *
   * Locale-agnostic strategy — no aria-label text matching:
   * 1. Wait for either tiles or toggle button to appear in the DOM (guards timing issues)
   * 2. If tiles are visible the panel is open — return true immediately
   * 3. If tiles absent but toggle button found, click it to open — no aria-label check needed
   */
  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    // Wait for either the tiles (panel open) or the toggle button (panel closed) to appear.
    // This guards against the panel not having rendered yet, especially on slower machines.
    try {
      await page.waitForSelector(
        ".create-artifact-button-container, .toggle-studio-panel-button",
        { timeout: 10000 }
      );
    } catch {
      // Neither element appeared — fall through to the evaluate below which will return false
    }

    return await page.evaluate(() => {
      // 1. Tiles present — panel is open, nothing to do
      // @ts-expect-error - DOM types
      if (document.querySelector(".create-artifact-button-container")) return true;

      // 2. Tiles absent — panel is collapsed. Find toggle and click to open.
      // No aria-label text matching: labels are locale-dependent (e.g. "Réduire" in French).
      const candidateSelectors = [
        ".toggle-studio-panel-button",   // Confirmed present as of Feb 2026
        '[aria-label*="studio" i]',      // Class-name fallback (still locale-safe for "studio")
        'button[class*="studio"]',       // Class-name fallback
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
   * Check video artifact status in the artifact library.
   *
   * Video artifacts can appear with different icons depending on state:
   * - Generating: "sync" icon (rotating), title contains "Generating Video Overview"
   * - Ready: "subscriptions" icon, title is the generated video name
   * We match by title text containing "video" to be robust across states.
   */
  private async checkVideoStatusInternal(page: Page): Promise<VideoStatus> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        const title = (item as any).querySelector(".artifact-title");
        const titleText = title?.textContent?.trim().toLowerCase() || "";

        // Detect video artifacts using locale-independent signals first:
        // - Ready: Material icon "subscriptions" (icon name, never translated)
        // - Generating: Material icon "sync" + shimmer animation class (CSS, never translated)
        // - English title fallback: won't match French "résumé vidéo" but kept for extra confidence
        const isVideoByIcon = iconText === "subscriptions";
        const isVideoGenerating = iconText === "sync" && (
          (item as any).classList.contains("shimmer-green") ||
          (item as any).classList.contains("shimmer-blue")
        );
        const isVideoByTitle = titleText.includes("video overview"); // English fallback only

        if (!isVideoByIcon && !isVideoGenerating && !isVideoByTitle) continue;

        // Determine generating vs ready state — class checks are locale-independent
        if (
          isVideoGenerating ||
          iconText === "sync" ||
          (item as any).classList.contains("shimmer-blue") ||
          (item as any).classList.contains("shimmer-green")
        ) {
          return { status: "generating" as const, progress: 0 };
        }

        // Otherwise it's ready
        return { status: "ready" as const };
      }

      // No video artifact found
      return { status: "not_started" as const };
    });
  }

  /**
   * Click the Video Overview tile in the Studio panel
   */
  private async clickVideoTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // Primary: color class (locale-independent — video tile uses "green" accent class)
      // Confirmed via DOM inspection Feb 2026; no data-create-button-type on video tile
      // @ts-expect-error - DOM types
      const tileByClass = document.querySelector('.create-artifact-button-container.green[role="button"]') as any;
      if (tileByClass) {
        tileByClass.click();
        return true;
      }
      // Fallback: English aria-label
      // @ts-expect-error - DOM types
      const tileByAria = document.querySelector('[aria-label="Video Overview"][role="button"]') as any;
      if (tileByAria) {
        tileByAria.click();
        return true;
      }
      // Last resort: text search (English only)
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll(".create-artifact-button-container");
      for (const t of tiles) {
        const text = t.textContent?.toLowerCase() || "";
        if (text.includes("video overview")) {
          (t as any).click();
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Wait for the customise dialog to appear
   */
  private async waitForDialog(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector('mat-dialog-container[role="dialog"]', { timeout: 5000 });
      await randomDelay(500, 800);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Select a video format in the dialog (Explainer or Brief)
   */
  private async selectFormat(page: Page, format: VideoFormat): Promise<boolean> {
    return await page.evaluate((fmt: string) => {
      // Format is in mat-radio-group.tile-group
      // @ts-expect-error - DOM types
      const radioGroup = document.querySelector("mat-radio-group.tile-group");
      if (!radioGroup) return false;

      // Primary: value attribute (locale-independent if Angular Material uses stable values)
      const byValue = radioGroup.querySelector(`[value="${fmt}"]`) as any;
      if (byValue) {
        byValue.click();
        return true;
      }

      // Fallback: text match (English only — may not work in non-English locales,
      // but selectFormat is best-effort; generation will use default format if this fails)
      const labels = radioGroup.querySelectorAll("mat-radio-button, label, [role='radio']");
      for (const label of labels) {
        const text = label.textContent?.toLowerCase() || "";
        if (text.includes(fmt.toLowerCase())) {
          (label as any).click();
          return true;
        }
      }
      return false;
    }, format);
  }

  /**
   * Select a video style in the dialog carousel
   */
  private async selectStyle(page: Page, style: VideoStyle): Promise<boolean> {
    return await page.evaluate((styleName: string) => {
      // Style is in mat-radio-group.carousel-group
      // @ts-expect-error - DOM types
      const radioGroup = document.querySelector("mat-radio-group.carousel-group");
      if (!radioGroup) return false;

      // Primary: value attribute (locale-independent)
      const byValue = radioGroup.querySelector(`[value="${styleName}"]`) as any;
      if (byValue) {
        byValue.click();
        return true;
      }

      // Fallback: text match (English only — style labels are translated in non-English UIs,
      // but selectStyle is best-effort; generation will use default style if this fails)
      // Normalize: "retro-print" → "retro print"
      const normalized = styleName.replace(/-/g, " ").toLowerCase();

      const labels = radioGroup.querySelectorAll("mat-radio-button, label, [role='radio']");
      for (const label of labels) {
        const text = label.textContent?.toLowerCase() || "";
        if (text.includes(normalized)) {
          (label as any).click();
          return true;
        }
      }
      return false;
    }, style);
  }

  /**
   * Click the Generate button in the dialog
   */
  private async clickDialogGenerate(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // Primary: button in mat-dialog-actions
      // @ts-expect-error - DOM types
      const dialogActions = document.querySelector("mat-dialog-actions");
      if (dialogActions) {
        const btn = dialogActions.querySelector("button") as any;
        if (btn) {
          btn.click();
          return true;
        }
      }
      // Fallback: button with primary color in any dialog
      // @ts-expect-error - DOM types
      const primaryBtn = document.querySelector('.dialog-actions button, button.button-color--primary') as any;
      if (primaryBtn) {
        primaryBtn.click();
        return true;
      }
      // Last resort: click the last enabled button in the dialog (locale-independent —
      // Material Design places the primary action button last in the DOM)
      // @ts-expect-error - DOM types
      const dialog = document.querySelector("mat-dialog-container");
      if (dialog) {
        const buttons = Array.from(dialog.querySelectorAll("button")) as any[];
        for (let i = buttons.length - 1; i >= 0; i--) {
          if (!buttons[i].disabled) {
            buttons[i].click();
            return true;
          }
        }
      }
      return false;
    });
  }

  /**
   * Generate a video overview for a notebook
   */
  async generateVideoOverview(
    notebookUrl: string,
    style: VideoStyle = "auto-select",
    format: VideoFormat = "explainer"
  ): Promise<GenerateVideoResult> {
    log.info(`Generating video overview for: ${notebookUrl}`);
    log.info(`  Style: ${style}, Format: ${format}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Ensure Studio panel is visible
      const panelOpen = await this.ensureStudioPanelOpen(page);
      if (!panelOpen) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Studio panel toggle button.",
        };
      }
      await randomDelay(500, 800);

      // Check current status first
      const currentStatus = await this.checkVideoStatusInternal(page);

      if (currentStatus.status === "generating") {
        log.info("  Video generation already in progress");
        return { success: true, status: currentStatus };
      }

      if (currentStatus.status === "ready") {
        log.info("  Video already generated");
        return { success: true, status: currentStatus };
      }

      // Click Video Overview tile
      const tileClicked = await this.clickVideoTile(page);
      if (!tileClicked) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Video Overview tile in Studio panel.",
        };
      }

      // Wait for customise dialog
      const dialogOpened = await this.waitForDialog(page);
      if (!dialogOpened) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Video Overview customise dialog did not appear.",
        };
      }

      // Select format (best-effort)
      await this.selectFormat(page, format);
      await randomDelay(300, 500);

      // Select style (best-effort)
      await this.selectStyle(page, style);
      await randomDelay(300, 500);

      // Click Generate in dialog
      const generated = await this.clickDialogGenerate(page);
      if (!generated) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Generate button in dialog.",
        };
      }

      // Wait for the generating artifact to appear in the sidebar (shimmer-blue = in progress).
      // Falls back gracefully if it doesn't appear within 15s (slow machines, large notebooks).
      await page.waitForSelector(".artifact-item-button.shimmer-blue", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      // Check if generation started
      const newStatus = await this.checkVideoStatusInternal(page);

      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  Video generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return { success: true, status: newStatus };
      }

      return {
        success: false,
        status: newStatus,
        error: "Video generation may have failed to start. Try again or check the notebook.",
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Check the current video status for a notebook
   */
  async getVideoStatus(notebookUrl: string): Promise<VideoStatus> {
    log.info(`Checking video status for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Ensure Studio panel is visible
      await this.ensureStudioPanelOpen(page);
      await randomDelay(500, 800);

      const status = await this.checkVideoStatusInternal(page);
      log.info(`  Status: ${status.status}`);
      return status;
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
