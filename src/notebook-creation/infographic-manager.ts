/**
 * Infographic Manager
 *
 * Manages Infographic (インフォグラフィック) generation in NotebookLM notebooks.
 * Infographics are AI-generated visual summaries (one-pager posters) produced
 * from notebook sources, available through the Studio panel (beta as of April 2026).
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026, ja locale):
 * - Studio panel toggle: .toggle-studio-panel-button
 * - Infographic tile: Material icon "stacked_bar_chart" inside .create-artifact-button-container[role="button"]
 *   jslog="279184" (locale-independent), class includes "pink"
 * - Clicking tile immediately starts generation (no customise dialog)
 * - Generating state: .artifact-item-button.shimmer-pink + icon "sync"
 *   title: "インフォグラフィックを生成しています..." (ja)
 * - Note: The "マインドマップ" tile also uses .pink — use jslog or icon to disambiguate.
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

export interface InfographicStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number;
  title?: string;
}

export interface GenerateInfographicResult {
  success: boolean;
  status: InfographicStatus;
  error?: string;
}

export class InfographicManager {
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

  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(
        ".create-artifact-button-container, [class*='create-artifact'][role='button'], .toggle-studio-panel-button",
        { timeout: 30000 }
      );
    } catch {
      // Fall through
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
   * Click the Infographic (インフォグラフィック) tile.
   *
   * Layer order:
   *   1. jslog^="279184" (Google click-tracking ID, locale-independent)
   *   2. Material icon "stacked_bar_chart" (icon names never translated)
   *   3. Multi-locale aria-label match
   *
   * Note: Several tiles share `.pink` (mindmap + infographic) so CSS class
   * cannot safely be used as a primary signal for this tile.
   */
  private async clickInfographicTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // 1. jslog
      // @ts-expect-error - DOM types
      const byJslog = document.querySelector('[jslog^="279184"][role="button"]') as any;
      if (byJslog) { byJslog.click(); return true; }

      // 2. Material icon "stacked_bar_chart"
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll('.create-artifact-button-container[role="button"]');
      for (const tile of tiles) {
        const iconText = (tile as any).querySelector("mat-icon")?.textContent?.trim() || "";
        if (iconText === "stacked_bar_chart") {
          (tile as any).click();
          return true;
        }
      }

      // 3. aria-label multi-locale
      for (const tile of tiles) {
        const aria = (tile as any).getAttribute('aria-label') || '';
        if (/インフォグラフィック|infographic|infographie/i.test(aria)) {
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
   * Infographic artifact signals:
   *   - icon "stacked_bar_chart" (ready) / icon "sync" + .shimmer-pink (generating)
   *   - title text contains "インフォグラフィック" / "infographic" for identification
   */
  private async checkInfographicStatusInternal(page: Page): Promise<InfographicStatus> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        const title = (item as any).querySelector(".artifact-title");
        const titleText = (title?.textContent?.trim() || "");

        const isInfoByIcon = iconText === "stacked_bar_chart";
        // shimmer-pink is ambiguous with mindmap; require title match to disambiguate
        const isGenerating =
          (item as any).classList.contains("shimmer-pink") &&
          /インフォグラフィック|infographic|infographie/i.test(titleText);
        const isInfoByTitle = /インフォグラフィック|infographic|infographie/i.test(titleText);

        if (!isInfoByIcon && !isGenerating && !isInfoByTitle) continue;

        if (isGenerating || iconText === "sync") {
          return { status: "generating" as const, progress: 0, title: titleText };
        }
        return { status: "ready" as const, title: titleText };
      }
      return { status: "not_started" as const };
    });
  }

  async generateInfographic(notebookUrl: string): Promise<GenerateInfographicResult> {
    log.info(`📊 Generating infographic for: ${notebookUrl}`);

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

      const currentStatus = await this.checkInfographicStatusInternal(page);
      if (currentStatus.status === "generating") {
        log.info("  Infographic generation already in progress");
        return { success: true, status: currentStatus };
      }
      if (currentStatus.status === "ready") {
        log.info("  Infographic already generated");
        return { success: true, status: currentStatus };
      }

      const tileClicked = await this.clickInfographicTile(page);
      if (!tileClicked) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Infographic tile in Studio panel (feature may not be available for this account).",
        };
      }

      // Wait for the generating artifact to appear (shimmer-pink = in progress).
      // mindmap also uses shimmer-pink, so we match any shimmer and rely on status re-check.
      await page.waitForSelector(".artifact-item-button.shimmer-pink", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      const newStatus = await this.checkInfographicStatusInternal(page);
      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  ✅ Infographic generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return { success: true, status: newStatus };
      }

      log.warning("  Tile clicked but shimmer not detected — reporting generating (poll with get_infographic_status)");
      return { success: true, status: { status: "generating" } };
    } finally {
      await this.closePage();
    }
  }

  async getInfographicStatus(notebookUrl: string): Promise<InfographicStatus> {
    log.info(`🔍 Checking infographic status for: ${notebookUrl}`);
    const page = await this.navigateToNotebook(notebookUrl);
    try {
      const status = await this.checkInfographicStatusInternal(page);
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
