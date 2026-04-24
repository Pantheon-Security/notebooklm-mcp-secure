/**
 * Research Manager — Fast Research / Deep Research (NotebookLM UI)
 *
 * Wraps NotebookLM's built-in "Search for new sources" feature that lives at
 * the top of the source panel. Given a query, NotebookLM searches the chosen
 * corpus (Web or Google Drive), presents a list of candidate sources, and
 * offers an "Import" button to add all of them to the notebook.
 *
 * Selectors derived from live NotebookLM DOM inspection (April 2026, ja locale):
 *
 * ── Source-panel toggle ──
 * - .toggle-source-panel-button — used if the panel is collapsed
 *
 * ── Query box ──
 * - textarea.query-box-textarea (jslog 274655, aria "入力されたクエリをもとにソースを検出する",
 *   placeholder "ウェブで新しいソースを検索")
 *
 * ── Research mode trigger (Fast vs Deep) ──
 * - button.researcher-menu-trigger (jslog 282720) — opens menu with:
 *     * jslog 282722 — "search_spark Fast Research" (結果をすばやく取得)
 *     * jslog 282721 — "travel_explore Deep Research" (詳細なレポートと結果)
 *
 * ── Corpus trigger (Web vs Drive) ──
 * - button.corpus-menu-trigger (jslog 282717) — opens menu with:
 *     * jslog 282718 — "language ウェブ上の最適なソース"
 *     * jslog 282719 — "ドライブ Google ドライブのコンテンツ"
 *
 * ── Submit ──
 * - button.actions-enter-button (jslog 282723, aria "送信") — disabled until
 *   a non-empty query is typed.
 *
 * ── Completion / candidates ──
 * - .source-discovery-container appears once the research is done.
 *   Contains a "completed" header and candidate cards.
 * - Action buttons inside the container:
 *     * 表示 (show) — jslog 282706
 *     * thumb_up/down — jslog 281148 / 281147
 *     * 削除 (dismiss) — jslog 282707
 *     * インポート (import) — jslog 282708 ← adds the candidates as real sources
 *
 * ── After Import ──
 * - New .single-source-container rows are appended to the panel (one per
 *   candidate). Typical outcome: +7 to +10 sources for a Fast Research, more
 *   for Deep Research.
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType } from "../utils/stealth-utils.js";

export type ResearchMode = "fast" | "deep";
export type ResearchCorpus = "web" | "drive";

export interface ResearchSourcesOptions {
  query: string;
  mode?: ResearchMode;             // default "fast"
  corpus?: ResearchCorpus;         // default "web"
  /** If true, clicks the Import button after research completes. Default false. */
  autoImport?: boolean;
  /** Max time to wait for the .source-discovery-container to appear. Default: 60s fast, 600s deep. */
  timeoutMs?: number;
}

export interface ResearchSourcesResult {
  success: boolean;
  query: string;
  mode: ResearchMode;
  corpus: ResearchCorpus;
  completion: "completed" | "timeout";
  imported: boolean;
  sourcesBefore: number;
  sourcesAfter: number;
  addedTitles?: string[];
  error?: string;
}

const MODE_JSLOG: Record<ResearchMode, string> = {
  fast: "282722",
  deep: "282721",
};

const CORPUS_JSLOG: Record<ResearchCorpus, string> = {
  web: "282718",
  drive: "282719",
};

export class ResearchManager {
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

  /** Expand the source panel if it's collapsed. */
  private async ensureSourcePanelOpen(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const panel = document.querySelector('section.source-panel') as any;
      // @ts-expect-error - DOM types
      const queryBox = document.querySelector('textarea.query-box-textarea');
      // If the query box is already visible, panel is open
      if (queryBox && (queryBox as any).offsetParent) return true;
      // Otherwise try to toggle via the button
      // @ts-expect-error - DOM types
      const toggleBtn = document.querySelector('.toggle-source-panel-button, [class*="toggle-source-panel"]') as any;
      if (toggleBtn) {
        toggleBtn.click();
        return true;
      }
      return !!panel;
    });
  }

  /** Open the research-mode menu and select Fast or Deep. */
  private async setMode(page: Page, mode: ResearchMode): Promise<boolean> {
    const targetJslog = MODE_JSLOG[mode];
    const ok = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const trigger = document.querySelector('button.researcher-menu-trigger, button[jslog^="282720"]') as any;
      if (!trigger) return false;
      trigger.click();
      return true;
    });
    if (!ok) return false;
    try {
      await page.waitForSelector('.cdk-overlay-pane [role="menuitem"], .mat-mdc-menu-panel [role="menuitem"]', { timeout: 5000 });
    } catch {
      return false;
    }
    return await page.evaluate((target: string) => {
      // @ts-expect-error - DOM types
      const items = document.querySelectorAll('[role="menuitem"], button.mat-mdc-menu-item');
      for (const mi of items) {
        if (((mi as any).getAttribute('jslog') || '').startsWith(target)) {
          (mi as any).click();
          return true;
        }
      }
      return false;
    }, targetJslog);
  }

  /** Open the corpus menu and select Web or Drive. */
  private async setCorpus(page: Page, corpus: ResearchCorpus): Promise<boolean> {
    const targetJslog = CORPUS_JSLOG[corpus];
    const ok = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const trigger = document.querySelector('button.corpus-menu-trigger, button[jslog^="282717"]') as any;
      if (!trigger) return false;
      trigger.click();
      return true;
    });
    if (!ok) return false;
    try {
      await page.waitForSelector('.cdk-overlay-pane [role="menuitem"], .mat-mdc-menu-panel [role="menuitem"]', { timeout: 5000 });
    } catch {
      return false;
    }
    return await page.evaluate((target: string) => {
      // @ts-expect-error - DOM types
      const items = document.querySelectorAll('[role="menuitem"], button.mat-mdc-menu-item');
      for (const mi of items) {
        if (((mi as any).getAttribute('jslog') || '').startsWith(target)) {
          (mi as any).click();
          return true;
        }
      }
      return false;
    }, targetJslog);
  }

  private async countSources(page: Page): Promise<number> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      return document.querySelectorAll('.single-source-container').length;
    });
  }

  private async listSourceTitles(page: Page): Promise<string[]> {
    return await page.evaluate(() => {
      const titles: string[] = [];
      // @ts-expect-error - DOM types
      const rows = document.querySelectorAll('.single-source-container');
      for (const r of rows) {
        const t = ((r as any).querySelector('.source-title')?.textContent || '').trim().slice(0, 120);
        if (t) titles.push(t);
      }
      return titles;
    });
  }

  /**
   * Run research (fast or deep) and optionally import the discovered sources.
   */
  async researchSources(
    notebookUrl: string,
    options: ResearchSourcesOptions
  ): Promise<ResearchSourcesResult> {
    const mode = options.mode ?? "fast";
    const corpus = options.corpus ?? "web";
    const autoImport = options.autoImport ?? false;
    const timeoutMs = options.timeoutMs ?? (mode === "deep" ? 600000 : 60000);

    log.info(`🔬 research_sources: mode=${mode} corpus=${corpus} autoImport=${autoImport} query="${options.query.slice(0, 60)}..."`);

    if (!options.query || !options.query.trim()) {
      return {
        success: false, query: options.query, mode, corpus,
        completion: "completed", imported: false,
        sourcesBefore: 0, sourcesAfter: 0,
        error: "query is required",
      };
    }

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // 1. Ensure source panel visible
      const panelOpen = await this.ensureSourcePanelOpen(page);
      if (!panelOpen) {
        return {
          success: false, query: options.query, mode, corpus,
          completion: "completed", imported: false,
          sourcesBefore: 0, sourcesAfter: 0,
          error: "Could not open the source panel.",
        };
      }
      // Wait for query box to be present
      try {
        await page.waitForSelector('textarea.query-box-textarea', { timeout: 10000 });
      } catch {
        return {
          success: false, query: options.query, mode, corpus,
          completion: "completed", imported: false,
          sourcesBefore: 0, sourcesAfter: 0,
          error: "Source-panel query box did not appear.",
        };
      }
      await randomDelay(600, 900);

      const sourcesBefore = await this.countSources(page);
      const titlesBefore = await this.listSourceTitles(page);

      // 2. Set mode (Fast/Deep). Only switch if not already the selected mode.
      if (mode !== "fast") {
        const modeSet = await this.setMode(page, mode);
        if (!modeSet) log.warning("  ⚠️  Could not set research mode; continuing with UI default");
        await randomDelay(400, 700);
      }

      // 3. Set corpus (Web/Drive). Only switch if not default.
      if (corpus !== "web") {
        const corpusSet = await this.setCorpus(page, corpus);
        if (!corpusSet) log.warning("  ⚠️  Could not set corpus; continuing with UI default");
        await randomDelay(400, 700);
      }

      // 4. Fill the query
      await humanType(page, 'textarea.query-box-textarea', options.query, { withTypos: false });
      await randomDelay(400, 700);

      // 5. Submit
      const submitted = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const btn = document.querySelector('button.actions-enter-button:not([disabled]), button[jslog^="282723"]:not([disabled])') as any;
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!submitted) {
        return {
          success: false, query: options.query, mode, corpus,
          completion: "completed", imported: false,
          sourcesBefore, sourcesAfter: sourcesBefore,
          error: "Submit button remained disabled — query may not have registered.",
        };
      }

      // 6. Wait for the discovery container to appear with completion state.
      //    The container renders immediately with a loading state, then updates
      //    to completed. We detect the Import button as the definitive completion signal.
      let completion: "completed" | "timeout" = "timeout";
      try {
        await page.waitForSelector('.source-discovery-container button[jslog^="282708"]', { timeout: timeoutMs });
        completion = "completed";
      } catch {
        /* timeout — container didn't reach completed state */
      }

      if (completion === "timeout") {
        return {
          success: false, query: options.query, mode, corpus,
          completion, imported: false,
          sourcesBefore, sourcesAfter: await this.countSources(page),
          error: `Research did not complete within ${timeoutMs}ms`,
        };
      }

      // 7. Optionally auto-import
      let imported = false;
      let addedTitles: string[] | undefined;
      if (autoImport) {
        const clicked = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const btn = document.querySelector('.source-discovery-container button[jslog^="282708"]') as any;
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (!clicked) {
          log.warning("  ⚠️  Could not click Import; returning without import");
        } else {
          // Wait for new .single-source-container rows to appear
          const startCount = sourcesBefore;
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const nowCount = await this.countSources(page);
            if (nowCount > startCount) {
              imported = true;
              break;
            }
            await page.waitForTimeout(500);
          }
          if (imported) {
            // Give NotebookLM a moment to finish titling the newly-imported
            // sources (raw URL → page-title extraction takes a few seconds).
            await page.waitForTimeout(3000);
            const beforeSet = new Set(titlesBefore);
            const allTitles = await this.listSourceTitles(page);
            // Set-diff is robust to reordering (NotebookLM reorders sources
            // by title after ingestion) and to URL→title rewrites.
            addedTitles = allTitles.filter(t => !beforeSet.has(t));
          }
        }
      }

      const sourcesAfter = await this.countSources(page);
      log.success(`  ✅ research_sources done (mode=${mode}, imported=${imported}, +${sourcesAfter - sourcesBefore} sources)`);

      return {
        success: true,
        query: options.query, mode, corpus,
        completion, imported,
        sourcesBefore, sourcesAfter,
        ...(addedTitles && { addedTitles }),
      };
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
