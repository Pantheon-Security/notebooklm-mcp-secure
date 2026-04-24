/**
 * Infographic Manager
 *
 * Manages Infographic (インフォグラフィック) generation and download in
 * NotebookLM notebooks. Infographics are AI-generated visual summaries
 * (posters / one-pagers), available through the Studio panel (beta as of
 * April 2026).
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026, ja locale):
 *
 * ── Tile ──
 * - Infographic tile: jslog="279184", Material icon "stacked_bar_chart", class "pink"
 * - Clicking the tile surface starts generation IMMEDIATELY with defaults.
 *
 * ── Customize chevron (right edge of tile) ──
 * - Inside .option-icon > button.edit-button (jslog="270546", same class name as slides)
 * - Opens "インフォグラフィックのカスタマイズ" mat-dialog with:
 *     * Style radio (11 options, mapped below)
 *     * 向き (Orientation) mat-button-toggle: 横向き | 縦向き | 正方形
 *     * 言語を選択 (Language) mat-select — default 日本語
 *     * 説明テキスト textarea (aria="作成するインフォグラフィックについて説明してください")
 *     * 生成 (Generate) button
 *
 * ── Style radio value mapping ──
 *   1  自動選択 (auto, default)       5  エディトリアル (editorial)   9  アニメ (anime)
 *   2  スケッチ (sketch)              6  説明的 (explanatory)        10 カワイイ (kawaii)
 *   3  プロフェッショナル (professional) 7  ブロック (block)            11 科学 (science)
 *   4  弁当箱 (bento)                 8  クレイ (clay)
 *
 * ── Artifact ──
 * - .artifact-item-button with Material icon "stacked_bar_chart"
 * - Generating state: .shimmer-pink + icon "sync" + title "インフォグラフィックを生成しています..."
 * - ⋮ More button jslog="265186" — menu items:
 *     * 名前を変更
 *     * save_alt ダウンロード (jslog="296552")
 *     * 共有 (jslog="296548")
 *     * 削除 (jslog="261221")
 *   Note: Infographic does NOT have a "revise" option like slides do.
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";
import fs from "fs";
import path from "path";

export type InfographicStyle =
  | "auto"
  | "sketch"
  | "kawaii"
  | "professional"
  | "science"
  | "anime"
  | "clay"
  | "editorial"
  | "explanatory"
  | "bento"
  | "block";

export type InfographicOrientation = "landscape" | "portrait" | "square";

const STYLE_VALUE_MAP: Record<InfographicStyle, string> = {
  auto: "1",
  sketch: "2",
  professional: "3",
  bento: "4",
  editorial: "5",
  explanatory: "6",
  block: "7",
  clay: "8",
  anime: "9",
  kawaii: "10",
  science: "11",
};

const ORIENTATION_LABEL_MAP: Record<InfographicOrientation, string[]> = {
  landscape: ["横向き", "landscape", "horizontal"],
  portrait: ["縦向き", "portrait", "vertical"],
  square: ["正方形", "square"],
};

export interface InfographicStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number;
  title?: string;
}

export interface GenerateInfographicOptions {
  /** Visual style preset (11 options). If omitted, NotebookLM's auto-select is used. */
  style?: InfographicStyle;
  /** Canvas orientation. */
  orientation?: InfographicOrientation;
  /** UI label text to pick in the language mat-select, e.g. "日本語", "English". */
  language?: string;
  /** Custom free-form instructions (style, color, emphasis points). */
  description?: string;
}

export interface GenerateInfographicResult {
  success: boolean;
  status: InfographicStatus;
  customized?: boolean;
  error?: string;
}

export interface DownloadInfographicResult {
  success: boolean;
  filePath?: string;
  size?: number;
  /** Inferred extension from the downloaded file's suggestedFilename (typically png or pdf). */
  extension?: string;
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
    } catch { /* fall through */ }
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      if (document.querySelector(".create-artifact-button-container, [class*='create-artifact'][role='button']")) return true;
      const selectors = [".toggle-studio-panel-button", '[aria-label*="studio" i]', 'button[class*="studio"]'];
      for (const sel of selectors) {
        // @ts-expect-error - DOM types
        const btn = document.querySelector(sel) as any;
        if (!btn) continue;
        btn.click();
        return true;
      }
      return false;
    });
  }

  /** Click the tile surface (fast path — no customization). */
  private async clickInfographicTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const tile = document.querySelector('[jslog^="279184"][role="button"]') as any;
      if (tile) { tile.click(); return true; }
      // Fallback: icon "stacked_bar_chart"
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll('.create-artifact-button-container[role="button"]');
      for (const t of tiles) {
        if ((t as any).querySelector("mat-icon")?.textContent?.trim() === "stacked_bar_chart") {
          (t as any).click();
          return true;
        }
      }
      return false;
    });
  }

  /** Click the chevron to open the customize dialog. */
  private async openInfographicCustomizeDialog(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const tile = document.querySelector('[jslog^="279184"][role="button"]') as any;
      if (!tile) return false;
      const editBtn =
        tile.querySelector('button.edit-button, button[jslog^="270546"]') ||
        tile.querySelector('.option-icon button, .option-icon [role="button"]');
      if (editBtn) { (editBtn as any).click(); return true; }
      return false;
    });
  }

  private async fillInfographicCustomizeDialogAndSubmit(
    page: Page,
    options: GenerateInfographicOptions
  ): Promise<void> {
    // Wait for dialog
    await page.waitForSelector('mat-dialog-container mat-radio-group', { timeout: 10000 });
    await randomDelay(600, 1000);

    // 1. Style radio by numeric value (locale-independent)
    if (options.style) {
      const value = STYLE_VALUE_MAP[options.style];
      await page.evaluate((val: string) => {
        // @ts-expect-error - DOM types
        const radios = document.querySelectorAll('mat-dialog-container mat-radio-button input[type="radio"]');
        for (const r of radios) {
          if ((r as any).value === val) {
            const container = (r as any).closest('mat-radio-button');
            (container || r as any).click();
            return;
          }
        }
      }, value);
      await randomDelay(300, 500);
    }

    // 2. Orientation toggle
    if (options.orientation) {
      const labels = ORIENTATION_LABEL_MAP[options.orientation];
      await page.evaluate((lbls: string[]) => {
        // @ts-expect-error - DOM types
        const toggles = document.querySelectorAll('mat-dialog-container mat-button-toggle');
        for (const t of toggles) {
          const txt = ((t as any).textContent || '').trim().toLowerCase();
          if (lbls.some(l => txt.includes(l.toLowerCase()))) {
            const btn = (t as any).querySelector('button, [role="button"]') || t;
            btn.click();
            return;
          }
        }
      }, labels);
      await randomDelay(300, 500);
    }

    // 3. Language mat-select
    if (options.language) {
      await this.selectMatSelectOption(page, options.language);
    }

    // 4. Description textarea
    if (options.description && options.description.trim()) {
      await page.evaluate((text: string) => {
        // @ts-expect-error - DOM types
        const tas = document.querySelectorAll('mat-dialog-container textarea');
        for (const ta of tas) {
          const aria = (ta as any).getAttribute('aria-label') || '';
          if (/インフォグラフィック|infographic|説明|describe/i.test(aria)) {
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
    }

    // 5. Click Generate
    const clicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll('mat-dialog-container button');
      for (const b of buttons) {
        if ((b as any).disabled) continue;
        const text = ((b as any).textContent || '').trim();
        const cls = ((b as any).className || '').toString();
        if (cls.includes('mdc-button--unelevated') || cls.includes('button-color--primary')) {
          if (/close|cancel|キャンセル|閉じる/i.test(text)) continue;
          (b as any).click();
          return text;
        }
      }
      for (const b of buttons) {
        const text = ((b as any).textContent || '').trim();
        if (/^(生成|create|generate)$/i.test(text)) { (b as any).click(); return text; }
      }
      return '';
    });
    if (!clicked) throw new Error("Could not find the Generate button in customize dialog");
    log.dim(`    Submitted customize dialog via: ${clicked}`);
  }

  private async selectMatSelectOption(page: Page, targetText: string): Promise<void> {
    const opened = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const sel = document.querySelector('mat-dialog-container mat-select');
      if (!sel) return false;
      (sel as any).click();
      return true;
    });
    if (!opened) return;
    try {
      await page.waitForSelector('.cdk-overlay-pane mat-option, .cdk-overlay-pane [role="option"]', { timeout: 5000 });
    } catch { return; }
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
        const isGenerating = (item as any).classList.contains("shimmer-pink") &&
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

  async generateInfographic(
    notebookUrl: string,
    options?: GenerateInfographicOptions
  ): Promise<GenerateInfographicResult> {
    log.info(`📊 Generating infographic for: ${notebookUrl}`);

    const customized = !!(options && (options.style || options.orientation || options.language || options.description));
    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const panelOpen = await this.ensureStudioPanelOpen(page);
      if (!panelOpen) {
        return { success: false, status: { status: "unknown" }, error: "Could not find Studio panel toggle button." };
      }
      await randomDelay(500, 800);

      const currentStatus = await this.checkInfographicStatusInternal(page);
      if (currentStatus.status === "generating") {
        log.info("  Infographic generation already in progress");
        return { success: true, status: currentStatus, customized };
      }

      let triggered = false;
      if (customized) {
        log.info(`  Opening customize dialog (style=${options?.style||'-'}, orientation=${options?.orientation||'-'}, lang=${options?.language||'-'}, desc=${options?.description ? 'yes' : 'no'})`);
        triggered = await this.openInfographicCustomizeDialog(page);
        if (!triggered) {
          return { success: false, status: { status: "unknown" }, error: "Could not open Infographic customize dialog." };
        }
        try {
          await this.fillInfographicCustomizeDialogAndSubmit(page, options!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { success: false, status: { status: "unknown" }, error: `Customize dialog error: ${msg}` };
        }
      } else {
        triggered = await this.clickInfographicTile(page);
        if (!triggered) {
          return { success: false, status: { status: "unknown" }, error: "Could not find Infographic tile in Studio panel." };
        }
      }

      await page.waitForSelector(".artifact-item-button.shimmer-pink", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      const newStatus = await this.checkInfographicStatusInternal(page);
      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  ✅ Infographic generation ${newStatus.status === "ready" ? "completed" : "started"}${customized ? ' (customized)' : ''}`);
        return { success: true, status: newStatus, customized };
      }
      log.warning("  Tile/dialog accepted but shimmer not detected — reporting generating");
      return { success: true, status: { status: "generating" }, customized };
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

  /**
   * Open ⋮ context menu on infographic artifact and click the download menuitem
   * (jslog 296552). Download arrives as a Playwright download event; saved to
   * outputPath if provided, otherwise ~/notebooklm-infographic-{timestamp}.{ext}.
   */
  async downloadInfographic(
    notebookUrl: string,
    outputPath?: string
  ): Promise<DownloadInfographicResult> {
    log.info(`📥 Downloading infographic from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      await this.ensureStudioPanelOpen(page);
      const status = await this.checkInfographicStatusInternal(page);
      if (status.status !== "ready") {
        return { success: false, error: `Infographic is not ready (status: ${status.status}). Generate and wait for completion first.` };
      }

      // Open menu, then click download
      const clickResult = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const arts = document.querySelectorAll('.artifact-item-button');
        for (const a of arts) {
          const iconText = (a as any).querySelector('.artifact-icon')?.textContent?.trim() || '';
          if (iconText !== 'stacked_bar_chart') continue;
          if ((a as any).classList.contains('shimmer-pink')) continue;
          const moreBtn = (a as any).querySelector('button[jslog^="265186"], button[aria-label="その他"]');
          if (moreBtn) { moreBtn.click(); return true; }
        }
        return false;
      });
      if (!clickResult) {
        return { success: false, error: "Could not open artifact ⋮ menu." };
      }
      await randomDelay(600, 900);

      // Wait for download event while clicking
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          page.evaluate(() => {
            // @ts-expect-error - DOM types
            const items = document.querySelectorAll('[role="menuitem"], button.mat-mdc-menu-item');
            for (const mi of items) {
              if (((mi as any).getAttribute('jslog') || '').startsWith('296552')) {
                (mi as any).click();
                return true;
              }
            }
            return false;
          }),
        ]);
        // Derive extension from suggested filename, fall back to png
        const suggested = download.suggestedFilename() || "";
        const inferredExt = (suggested.match(/\.([a-zA-Z0-9]+)$/)?.[1] || "png").toLowerCase();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const defaultPath = path.join(process.env.HOME || "/tmp", `notebooklm-infographic-${timestamp}.${inferredExt}`);
        const finalPath = outputPath || defaultPath;
        const dir = path.dirname(finalPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        await download.saveAs(finalPath);
        const stat = fs.statSync(finalPath);
        log.success(`  ✅ Saved infographic (${stat.size} bytes, .${inferredExt}) to: ${finalPath}`);
        return { success: true, filePath: finalPath, size: stat.size, extension: inferredExt };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { success: false, error: `Download failed: ${msg}` };
      }
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
