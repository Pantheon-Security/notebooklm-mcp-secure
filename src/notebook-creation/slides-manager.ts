/**
 * Slides Manager
 *
 * Manages Slides (スライド資料 / Slide deck) generation in NotebookLM notebooks.
 * Slides are AI-generated presentation decks produced from notebook sources,
 * available through the Studio panel (beta as of April 2026).
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026, ja locale):
 * - Studio panel toggle: .toggle-studio-panel-button
 * - Slide tile: Material icon "tablet" inside .create-artifact-button-container[role="button"]
 *   jslog="279187" (locale-independent), class includes "yellow"
 * - Clicking tile immediately starts generation (no customise dialog)
 * - Generating state: .artifact-item-button.shimmer-yellow + icon "sync"
 *   title: "スライド資料を生成しています..." (ja) / "Generating slide deck..." (en)
 * - Ready state: icon is "tablet" and no shimmer class
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

export interface SlidesStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number;
  title?: string;
}

export interface GenerateSlidesResult {
  success: boolean;
  status: SlidesStatus;
  error?: string;
}

export class SlidesManager {
  private page: Page | null = null;

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager
  ) {}

  private async navigateToNotebook(notebookUrl: string): Promise<Page> {
    const context = await this.contextManager.getOrCreateContext();
    const isAuth = await this.authManager.validateWithRetry(context);
    if (!isAuth) throw new Error("Not authenticated. Run setup_auth first.");

    this.page = await context.newPage();
    await this.page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => {});
    await randomDelay(2000, 3000);
    return this.page;
  }

  /**
   * Ensure the Studio panel is visible — same pattern as VideoManager/DataTableManager
   */
  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(
        ".create-artifact-button-container, [class*='create-artifact'][role='button'], .toggle-studio-panel-button",
        { timeout: 30000 }
      );
    } catch {
      // Fall through — evaluate() decides
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
   * Click the Slides (スライド資料) tile.
   *
   * Layer order (most → least locale-independent):
   *   1. jslog^="279187" (Google click-tracking ID)
   *   2. Material icon "tablet" (icon names are never translated)
   *   3. CSS class `.yellow` on the tile (stable color accent)
   *   4. Multi-locale aria-label match ("スライド資料" / "Slide deck" / "Diapositives")
   */
  private async clickSlidesTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // 1. jslog
      // @ts-expect-error - DOM types
      const byJslog = document.querySelector('[jslog^="279187"][role="button"]') as any;
      if (byJslog) { byJslog.click(); return true; }

      // 2. Material icon "tablet"
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll('.create-artifact-button-container[role="button"]');
      for (const tile of tiles) {
        const iconText = (tile as any).querySelector("mat-icon")?.textContent?.trim() || "";
        if (iconText === "tablet") {
          (tile as any).click();
          return true;
        }
      }

      // 3. Yellow accent class (slides is the only tile with this accent in April 2026,
      //    but report→yellow exists too — use this as secondary only)
      // Skipped intentionally: ambiguous with レポート (Report)

      // 4. aria-label multi-locale
      for (const tile of tiles) {
        const aria = (tile as any).getAttribute('aria-label') || '';
        if (/スライド資料|slide deck|slides|diapositives/i.test(aria)) {
          (tile as any).click();
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Status detection from the artifact library.
   *
   * Slides artifact signals:
   *   - icon "tablet" (ready) / icon "sync" + .shimmer-yellow (generating)
   *   - title text contains "スライド" / "slide" for identification
   */
  private async checkSlidesStatusInternal(page: Page): Promise<SlidesStatus> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        const title = (item as any).querySelector(".artifact-title");
        const titleText = (title?.textContent?.trim() || "");

        const isSlidesByIcon = iconText === "tablet";
        const isGenerating =
          (item as any).classList.contains("shimmer-yellow") &&
          /スライド|slide|diapos/i.test(titleText);
        const isSlidesByTitle = /スライド資料|slide deck|slides|diapositives/i.test(titleText);

        if (!isSlidesByIcon && !isGenerating && !isSlidesByTitle) continue;

        if (isGenerating || iconText === "sync") {
          return { status: "generating" as const, progress: 0, title: titleText };
        }
        return { status: "ready" as const, title: titleText };
      }
      return { status: "not_started" as const };
    });
  }

  async generateSlides(notebookUrl: string): Promise<GenerateSlidesResult> {
    log.info(`🎞️  Generating slides for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const panelOpen = await this.ensureStudioPanelOpen(page);
      if (!panelOpen) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Studio panel toggle button.",
        };
      }
      await randomDelay(500, 800);

      const currentStatus = await this.checkSlidesStatusInternal(page);
      if (currentStatus.status === "generating") {
        log.info("  Slides generation already in progress");
        return { success: true, status: currentStatus };
      }
      if (currentStatus.status === "ready") {
        log.info("  Slides already generated");
        return { success: true, status: currentStatus };
      }

      const tileClicked = await this.clickSlidesTile(page);
      if (!tileClicked) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Slides tile in Studio panel (feature may not be available for this account).",
        };
      }

      // Wait for the generating artifact to appear (shimmer-yellow = in progress)
      await page.waitForSelector(".artifact-item-button.shimmer-yellow", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      const newStatus = await this.checkSlidesStatusInternal(page);
      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  ✅ Slides generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return { success: true, status: newStatus };
      }

      log.warning("  Tile clicked but shimmer not detected — reporting generating (poll with get_slides_status)");
      return { success: true, status: { status: "generating" } };
    } finally {
      await this.closePage();
    }
  }

  async getSlidesStatus(notebookUrl: string): Promise<SlidesStatus> {
    log.info(`🔍 Checking slides status for: ${notebookUrl}`);
    const page = await this.navigateToNotebook(notebookUrl);
    try {
      const status = await this.checkSlidesStatusInternal(page);
      log.info(`  Status: ${status.status}${status.title ? ` (${status.title})` : ''}`);
      return status;
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
