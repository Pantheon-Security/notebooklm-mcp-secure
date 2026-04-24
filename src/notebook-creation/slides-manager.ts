/**
 * Slides Manager
 *
 * Manages Slides (スライド資料 / Slide deck) generation, revision, and download
 * in NotebookLM notebooks. Slides are AI-generated presentation decks produced
 * from notebook sources, available through the Studio panel (beta as of April 2026).
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026, ja locale):
 *
 * ── Tile (main click surface) ──
 * - Studio panel toggle: .toggle-studio-panel-button
 * - Slide tile: jslog="279187", Material icon "tablet", class includes "yellow"
 * - Clicking the tile surface starts generation IMMEDIATELY with defaults.
 *
 * ── Customize chevron (right side of tile) ──
 * - Inside .option-icon > button.edit-button (jslog="270546")
 * - Clicking opens a "スライド資料をカスタマイズ" mat-dialog with:
 *     * 形式 (Format) radio — value="1" 詳細なスライド (default), value="2" プレゼンターのスライド
 *     * 言語を選択 (Language) mat-select — default 日本語
 *     * 長さ (Length) mat-button-toggle-group — "短め" (short) | "デフォルト" (default, checked)
 *     * 説明テキスト textarea (aria="作成するスライドについて説明してください")
 *     * 生成 (Generate) button — class includes "mdc-button--unelevated"
 *
 * ── Artifact (completed slides deck) ──
 * - .artifact-item-button with Material icon "tablet"
 * - Generating state: .shimmer-yellow + icon "sync" + title "スライド資料を生成しています..."
 * - ⋮ More button inside artifact: jslog="265186" — opens context menu:
 *     * PDF ダウンロード (jslog="302103")
 *     * PPTX ダウンロード (jslog="302084")
 *     * 共有 (jslog="296546")
 *     * スライドショー開始 (jslog="296107")
 *     * 変更 (jslog="304805") — opens inline revision mode
 *     * 削除 (jslog="261221")
 *
 * ── Revision mode ──
 * - Opens an inline artifact viewer with textarea.revision-input-textarea
 *   (aria="リビジョンの手順")
 * - Submit: button[jslog^="305586"] (text "改訂版のスライドを生成")
 * - Cancel: button[jslog^="305585"]
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType } from "../utils/stealth-utils.js";
import fs from "fs";
import path from "path";

export type SlidesFormat = "detailed" | "presenter";
export type SlidesLength = "short" | "default";
export type SlidesDownloadFormat = "pdf" | "pptx";

export interface SlidesStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number;
  title?: string;
}

export interface GenerateSlidesOptions {
  /** Detailed ("詳細なスライド", default) or presenter ("プレゼンターのスライド") */
  format?: SlidesFormat;
  /** UI label text to pick in the language mat-select, e.g. "日本語", "English", "Français".
   * If omitted, the default remains whatever NotebookLM pre-selects for the account. */
  language?: string;
  /** Short ("短め") or default ("デフォルト") */
  length?: SlidesLength;
  /** Custom free-form instructions describing the target audience / style / key points */
  description?: string;
}

export interface GenerateSlidesResult {
  success: boolean;
  status: SlidesStatus;
  /** True if the customize dialog was used (i.e. any option was passed).
   *  False if the direct tile click fast path ran (no customization). */
  customized?: boolean;
  error?: string;
}

export interface ReviseSlidesResult {
  success: boolean;
  /** State after submitting the revision — usually `generating`. */
  status: SlidesStatus;
  error?: string;
}

export interface DownloadSlidesResult {
  success: boolean;
  filePath?: string;
  size?: number;
  format?: SlidesDownloadFormat;
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

  /** Ensure the Studio panel is visible — identical to VideoManager. */
  private async ensureStudioPanelOpen(page: Page): Promise<boolean> {
    try {
      await page.waitForSelector(
        ".create-artifact-button-container, [class*='create-artifact'][role='button'], .toggle-studio-panel-button",
        { timeout: 30000 }
      );
    } catch { /* fall through */ }
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      if (document.querySelector(".create-artifact-button-container, [class*='create-artifact'][role='button']")) return true;
      const candidateSelectors = [".toggle-studio-panel-button", '[aria-label*="studio" i]', 'button[class*="studio"]'];
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

  /** Click the tile's main surface — fast path, no customization. */
  private async clickSlidesTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const tile = document.querySelector('[jslog^="279187"][role="button"]') as any;
      if (tile) { tile.click(); return true; }
      // Fallback: icon "tablet"
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll('.create-artifact-button-container[role="button"]');
      for (const t of tiles) {
        if ((t as any).querySelector("mat-icon")?.textContent?.trim() === "tablet") {
          (t as any).click();
          return true;
        }
      }
      return false;
    });
  }

  /** Click the chevron inside the tile to open the customize dialog. */
  private async openSlidesCustomizeDialog(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const tile = document.querySelector('[jslog^="279187"][role="button"]') as any;
      if (!tile) return false;
      // Primary: chevron button inside the tile — jslog 270546
      const editBtn =
        tile.querySelector('button.edit-button, button[jslog^="270546"]') ||
        tile.querySelector('.option-icon button, .option-icon [role="button"]');
      if (editBtn) {
        // CRITICAL: stop propagation risk — the tile itself is role="button". We click the child.
        (editBtn as any).click();
        return true;
      }
      return false;
    });
  }

  /** Fill the Slides customize dialog according to options and click Generate. */
  private async fillSlidesCustomizeDialogAndSubmit(
    page: Page,
    options: GenerateSlidesOptions
  ): Promise<void> {
    // Wait for dialog to render
    await page.waitForSelector('mat-dialog-container textarea[aria-label*="スライド" i], mat-dialog-container textarea[aria-label*="slide" i], mat-dialog-container mat-radio-group', { timeout: 10000 });
    await randomDelay(600, 1000);

    // 1. Format radio
    if (options.format) {
      const value = options.format === "presenter" ? "2" : "1";
      await page.evaluate((val: string) => {
        // @ts-expect-error - DOM types
        const radios = document.querySelectorAll('mat-dialog-container mat-radio-button input[type="radio"]');
        for (const r of radios) {
          if ((r as any).value === val) {
            // Click the surrounding mat-radio-button to respect Angular
            const container = (r as any).closest('mat-radio-button');
            (container || r as any).click();
            return;
          }
        }
      }, value);
      await randomDelay(300, 500);
    }

    // 2. Length toggle ("短め" / "デフォルト")
    if (options.length) {
      const label = options.length === "short" ? "短め" : "デフォルト";
      const enLabel = options.length === "short" ? "short" : "default";
      await page.evaluate((labels: string[]) => {
        // @ts-expect-error - DOM types
        const toggles = document.querySelectorAll('mat-dialog-container mat-button-toggle');
        for (const t of toggles) {
          const txt = ((t as any).textContent || '').trim().toLowerCase();
          if (labels.some(l => txt.includes(l.toLowerCase()))) {
            const btn = (t as any).querySelector('button, [role="button"]') || t;
            btn.click();
            return;
          }
        }
      }, [label, enLabel]);
      await randomDelay(300, 500);
    }

    // 3. Language mat-select
    if (options.language) {
      await this.selectMatSelectOption(page, options.language);
    }

    // 4. Description textarea
    if (options.description && options.description.trim()) {
      const descSelector = 'mat-dialog-container textarea';
      await page.evaluate((text: string) => {
        // @ts-expect-error - DOM types
        const tas = document.querySelectorAll('mat-dialog-container textarea');
        for (const ta of tas) {
          const aria = (ta as any).getAttribute('aria-label') || '';
          // Use the slides description textarea (fallback to first visible textarea)
          if (/スライド|slide|説明|describe/i.test(aria)) {
            (ta as any).focus();
            // @ts-expect-error - HTMLTextAreaElement is a browser-context type
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(ta, text);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }, options.description);
      await randomDelay(300, 500);
      void descSelector; // reserved for future humanType use
    }

    // 5. Click Generate (生成) — primary unelevated button in dialog-actions
    const clicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll('mat-dialog-container button');
      for (const b of buttons) {
        if ((b as any).disabled) continue;
        const text = ((b as any).textContent || '').trim();
        const cls = ((b as any).className || '').toString();
        if (cls.includes('mdc-button--unelevated') || cls.includes('button-color--primary')) {
          // Skip close/cancel
          if (/close|cancel|キャンセル|閉じる/i.test(text)) continue;
          (b as any).click();
          return text;
        }
      }
      // Fallback: text match "生成" / "Generate"
      for (const b of buttons) {
        const text = ((b as any).textContent || '').trim();
        if (/^(生成|create|generate)$/i.test(text)) {
          (b as any).click();
          return text;
        }
      }
      return '';
    });
    if (!clicked) throw new Error("Could not find the Generate button in customize dialog");
    log.dim(`    Submitted customize dialog via: ${clicked}`);
  }

  /** Shared helper to pick a mat-select option by its visible text (locale-agnostic). */
  private async selectMatSelectOption(page: Page, targetText: string): Promise<void> {
    // Open first mat-select in the dialog
    const opened = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const sel = document.querySelector('mat-dialog-container mat-select');
      if (!sel) return false;
      (sel as any).click();
      return true;
    });
    if (!opened) return;
    // Wait for overlay panel
    try {
      await page.waitForSelector('.cdk-overlay-pane mat-option, .cdk-overlay-pane [role="option"]', { timeout: 5000 });
    } catch {
      return;
    }
    await page.evaluate((target: string) => {
      // @ts-expect-error - DOM types
      const opts = document.querySelectorAll('.cdk-overlay-pane mat-option, .cdk-overlay-pane [role="option"]');
      for (const o of opts) {
        const txt = ((o as any).textContent || '').trim();
        if (txt === target || txt.includes(target)) {
          (o as any).click();
          return;
        }
      }
    }, targetText);
    await randomDelay(400, 700);
  }

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
        const isGenerating = (item as any).classList.contains("shimmer-yellow") && /スライド|slide|diapos/i.test(titleText);
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

  /**
   * Generate slides.
   *
   * - If no `options` (or all fields undefined) are supplied, the tile is clicked
   *   directly — this is the fast path that matches the previous behavior.
   * - If any option is provided, the chevron is clicked to open the customize
   *   dialog and the fields are filled before pressing Generate.
   */
  async generateSlides(
    notebookUrl: string,
    options?: GenerateSlidesOptions
  ): Promise<GenerateSlidesResult> {
    log.info(`🎞️  Generating slides for: ${notebookUrl}`);

    const customized = !!(options && (options.format || options.language || options.length || options.description));
    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const panelOpen = await this.ensureStudioPanelOpen(page);
      if (!panelOpen) {
        return { success: false, status: { status: "unknown" }, error: "Could not find Studio panel toggle button." };
      }
      await randomDelay(500, 800);

      const currentStatus = await this.checkSlidesStatusInternal(page);
      if (currentStatus.status === "generating") {
        log.info("  Slides generation already in progress");
        return { success: true, status: currentStatus, customized };
      }
      // NOTE: We do NOT early-return on "ready" here because the user may want to
      // generate a NEW deck with different options (NotebookLM allows multiple decks).

      let triggered = false;
      if (customized) {
        log.info(`  Opening customize dialog (format=${options?.format||'-'}, length=${options?.length||'-'}, lang=${options?.language||'-'}, desc=${options?.description ? 'yes' : 'no'})`);
        triggered = await this.openSlidesCustomizeDialog(page);
        if (!triggered) {
          return { success: false, status: { status: "unknown" }, error: "Could not open Slides customize dialog (chevron button not found)." };
        }
        try {
          await this.fillSlidesCustomizeDialogAndSubmit(page, options!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, status: { status: "unknown" }, error: `Customize dialog error: ${msg}` };
        }
      } else {
        triggered = await this.clickSlidesTile(page);
        if (!triggered) {
          return { success: false, status: { status: "unknown" }, error: "Could not find Slides tile in Studio panel." };
        }
      }

      // Wait for the generating artifact to appear
      await page.waitForSelector(".artifact-item-button.shimmer-yellow", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      const newStatus = await this.checkSlidesStatusInternal(page);
      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  ✅ Slides generation ${newStatus.status === "ready" ? "completed" : "started"}${customized ? ' (customized)' : ''}`);
        return { success: true, status: newStatus, customized };
      }
      log.warning("  Tile/dialog accepted but shimmer not detected — reporting generating (poll with get_slides_status)");
      return { success: true, status: { status: "generating" }, customized };
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

  /**
   * Open the ⋮ context menu on the first slides artifact and click a menuitem
   * identified by its jslog prefix.
   *
   * Returns the Page with the menu item clicked. Caller is responsible for
   * whatever comes next (download handler, revision dialog, etc.).
   */
  private async clickSlidesArtifactMenuItem(page: Page, menuItemJslogPrefix: string): Promise<boolean> {
    const opened = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const arts = document.querySelectorAll('.artifact-item-button');
      for (const a of arts) {
        const iconText = (a as any).querySelector('.artifact-icon')?.textContent?.trim() || '';
        if (iconText !== 'tablet') continue;
        // Skip generating
        if ((a as any).classList.contains('shimmer-yellow')) continue;
        const moreBtn = (a as any).querySelector('button[jslog^="265186"], button[aria-label="その他"]');
        if (moreBtn) { moreBtn.click(); return true; }
      }
      return false;
    });
    if (!opened) return false;
    await randomDelay(600, 900);
    const clicked = await page.evaluate((prefix: string) => {
      // @ts-expect-error - DOM types
      const items = document.querySelectorAll('[role="menuitem"], button.mat-mdc-menu-item');
      for (const mi of items) {
        const jslog = (mi as any).getAttribute('jslog') || '';
        if (jslog.startsWith(prefix)) {
          (mi as any).click();
          return true;
        }
      }
      return false;
    }, menuItemJslogPrefix);
    return clicked;
  }

  /**
   * Download the generated slides in PDF or PPTX format.
   * Requires the artifact to be in "ready" state.
   */
  async downloadSlides(
    notebookUrl: string,
    format: SlidesDownloadFormat = "pdf",
    outputPath?: string
  ): Promise<DownloadSlidesResult> {
    log.info(`📥 Downloading slides (${format}) from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      await this.ensureStudioPanelOpen(page);
      const status = await this.checkSlidesStatusInternal(page);
      if (status.status !== "ready") {
        return { success: false, error: `Slides are not ready (status: ${status.status}). Generate and wait for completion first.` };
      }

      // Select default output path
      const ext = format === "pptx" ? "pptx" : "pdf";
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const defaultPath = path.join(process.env.HOME || "/tmp", `notebooklm-slides-${timestamp}.${ext}`);
      const finalPath = outputPath || defaultPath;
      const dir = path.dirname(finalPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const jslogPrefix = format === "pptx" ? "302084" : "302103";

      // Click the download menu item & wait for download event
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          this.clickSlidesArtifactMenuItem(page, jslogPrefix),
        ]);
        await download.saveAs(finalPath);
        const stat = fs.statSync(finalPath);
        log.success(`  ✅ Saved ${format.toUpperCase()} (${stat.size} bytes) to: ${finalPath}`);
        return { success: true, filePath: finalPath, size: stat.size, format };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: `Download failed: ${msg}` };
      }
    } finally {
      await this.closePage();
    }
  }

  /**
   * Revise an existing slides deck with custom instructions.
   *
   * Flow: open ⋮ menu → click 変更 (jslog 304805) → wait for artifact viewer
   * with textarea.revision-input-textarea → fill → click submit (jslog 305586).
   */
  async reviseSlides(notebookUrl: string, instructions: string): Promise<ReviseSlidesResult> {
    log.info(`✏️ Revising slides with custom instructions: "${instructions.slice(0, 60)}..."`);
    if (!instructions || !instructions.trim()) {
      return { success: false, status: { status: "unknown" }, error: "Instructions required." };
    }

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      await this.ensureStudioPanelOpen(page);
      const status = await this.checkSlidesStatusInternal(page);
      if (status.status !== "ready") {
        return { success: false, status, error: `Slides are not ready (status: ${status.status}). Generate first.` };
      }

      const clickedRevise = await this.clickSlidesArtifactMenuItem(page, "304805");
      if (!clickedRevise) {
        return { success: false, status: { status: "unknown" }, error: "Could not open revision mode (menu item 'Change/変更' not found)." };
      }

      // Wait for the revision textarea to appear
      try {
        await page.waitForSelector("textarea.revision-input-textarea", { timeout: 10000 });
      } catch {
        return { success: false, status: { status: "unknown" }, error: "Revision textarea did not appear." };
      }
      await randomDelay(600, 1000);

      // Fill instructions
      await humanType(page, "textarea.revision-input-textarea", instructions, { withTypos: false });
      await randomDelay(400, 700);

      // Click submit (改訂版のスライドを生成, jslog 305586)
      const submitted = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const btn = document.querySelector('button[jslog^="305586"]:not([disabled])') as any;
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!submitted) {
        return { success: false, status: { status: "unknown" }, error: "Could not click the revision submit button." };
      }

      // Wait for shimmer to indicate revision is generating
      await page.waitForSelector(".artifact-item-button.shimmer-yellow", { timeout: 15000 }).catch(() => {});
      await randomDelay(600, 1000);
      const newStatus = await this.checkSlidesStatusInternal(page);
      log.success(`  ✅ Revision submitted (status: ${newStatus.status})`);
      return { success: true, status: newStatus };
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
