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
   * Ensure the Studio panel is visible (expand if collapsed)
   */
  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const toggleBtn = document.querySelector(".toggle-studio-panel-button") as any;
      if (!toggleBtn) return false;

      const aria = toggleBtn.getAttribute("aria-label")?.toLowerCase() || "";
      // If it says "Expand", the panel is collapsed — click to open
      if (aria.includes("expand")) {
        toggleBtn.click();
        return true;
      }
      // If it says "Collapse", the panel is already open
      if (aria.includes("collapse")) {
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

        // Match video artifacts by icon or title
        const isVideoByIcon = iconText === "subscriptions";
        const isVideoByTitle = titleText.includes("video overview");
        const isGeneratingSync = iconText === "sync" && titleText.includes("video");

        if (!isVideoByIcon && !isVideoByTitle && !isGeneratingSync) continue;

        // Found a video artifact — check if still generating
        if (
          titleText.includes("generating") ||
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
      // Primary: aria-label selector
      // @ts-expect-error - DOM types
      const tile = document.querySelector('[aria-label="Video Overview"][role="button"]') as any;
      if (tile) {
        tile.click();
        return true;
      }
      // Fallback: find by text in create-artifact tiles
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

      // Normalize style name for matching (e.g., "retro-print" → "retro print")
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
      // Last resort: find Generate text in visible dialog buttons
      // @ts-expect-error - DOM types
      const dialog = document.querySelector("mat-dialog-container");
      if (dialog) {
        const buttons = dialog.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn as any).textContent?.trim().toLowerCase() || "";
          if (text === "generate") {
            (btn as any).click();
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

      await randomDelay(3000, 4000);

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
