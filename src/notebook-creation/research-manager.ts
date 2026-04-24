/**
 * Research Manager — Fast Research / Deep Research (NotebookLM UI)
 *
 * Wraps NotebookLM's built-in "Search for new sources" feature (the query
 * box at the top of the source panel, with a Fast / Deep Research toggle).
 *
 * ## Async 3-step design (April 2026)
 *
 * Deep Research takes 2-10 minutes which exceeds the MCP client's ~60s
 * request timeout. To work around this the feature is split into three
 * independently-callable MCP tools:
 *
 *   1. `research_sources` — submits the query and returns immediately
 *   2. `get_research_status` — polls the discovery container state
 *   3. `import_research_results` — clicks Import (or Dismiss) when
 *      the candidates are ready
 *
 * Fast mode (~15-30s) fits this pattern too: trigger → short wait → import.
 *
 * ## DOM selectors (April 2026, ja locale)
 *
 * ── Source-panel toggle ──
 * - .toggle-source-panel-button
 *
 * ── Query box + controls ──
 * - textarea.query-box-textarea (jslog 274655)
 * - button.researcher-menu-trigger (jslog 282720)
 *     * menuitem jslog 282722 — Fast Research
 *     * menuitem jslog 282721 — Deep Research
 * - button.corpus-menu-trigger (jslog 282717)
 *     * menuitem jslog 282718 — Web
 *     * menuitem jslog 282719 — Drive
 * - button.actions-enter-button (jslog 282723) — disabled until query typed
 *
 * ── Discovery container (appears after submit) ──
 * - .source-discovery-container
 * - Import button: jslog 282708
 * - Dismiss button: jslog 282707
 * - "Show preview" button: jslog 282706
 * - Thumbs: 281148 / 281147
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType } from "../utils/stealth-utils.js";

export type ResearchMode = "fast" | "deep";
export type ResearchCorpus = "web" | "drive";
export type ResearchImportAction = "import" | "dismiss";

const MODE_JSLOG: Record<ResearchMode, string> = {
  fast: "282722",
  deep: "282721",
};

const CORPUS_JSLOG: Record<ResearchCorpus, string> = {
  web: "282718",
  drive: "282719",
};

export interface TriggerResearchOptions {
  query: string;
  mode?: ResearchMode;
  corpus?: ResearchCorpus;
}

export interface TriggerResearchResult {
  success: boolean;
  query: string;
  mode: ResearchMode;
  corpus: ResearchCorpus;
  triggered: boolean;
  sourcesBefore: number;
  note?: string;
  error?: string;
}

export type ResearchStatus = "idle" | "running" | "completed";

export interface ResearchStatusResult {
  success: boolean;
  status: ResearchStatus;
  /** Number of discovered candidates (only when status === "completed") */
  candidatesCount?: number;
  /** Up to 5 candidate titles for preview (only when status === "completed") */
  candidatePreview?: string[];
  /** Present when currentLoad text is visible */
  headerText?: string;
  error?: string;
}

export interface ImportResearchResult {
  success: boolean;
  action: ResearchImportAction;
  imported: boolean;
  sourcesBefore: number;
  sourcesAfter: number;
  addedTitles?: string[];
  error?: string;
}

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
    await randomDelay(1500, 2500);
    return this.page;
  }

  /** Expand the source panel if it's collapsed. */
  private async ensureSourcePanelOpen(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const panel = document.querySelector('section.source-panel') as any;
      // @ts-expect-error - DOM types
      const queryBox = document.querySelector('textarea.query-box-textarea');
      if (queryBox && (queryBox as any).offsetParent) return true;
      // @ts-expect-error - DOM types
      const toggleBtn = document.querySelector('.toggle-source-panel-button, [class*="toggle-source-panel"]') as any;
      if (toggleBtn) { toggleBtn.click(); return true; }
      return !!panel;
    });
  }

  /** Select Fast or Deep research mode. */
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
    } catch { return false; }
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
    } catch { return false; }
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

  // ──────────────────────────────────────────────────────────────────────
  // Tool 1: Trigger research (returns immediately after submit)
  // ──────────────────────────────────────────────────────────────────────
  async triggerResearch(
    notebookUrl: string,
    options: TriggerResearchOptions
  ): Promise<TriggerResearchResult> {
    const mode = options.mode ?? "fast";
    const corpus = options.corpus ?? "web";

    log.info(`🔬 research_sources (trigger): mode=${mode} corpus=${corpus} query="${options.query.slice(0, 60)}..."`);

    if (!options.query || !options.query.trim()) {
      return {
        success: false, triggered: false, query: options.query,
        mode, corpus, sourcesBefore: 0,
        error: "query is required",
      };
    }

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      const panelOpen = await this.ensureSourcePanelOpen(page);
      if (!panelOpen) {
        return {
          success: false, triggered: false, query: options.query,
          mode, corpus, sourcesBefore: 0,
          error: "Could not open the source panel.",
        };
      }
      try {
        await page.waitForSelector('textarea.query-box-textarea', { timeout: 10000 });
      } catch {
        return {
          success: false, triggered: false, query: options.query,
          mode, corpus, sourcesBefore: 0,
          error: "Source-panel query box did not appear.",
        };
      }
      await randomDelay(500, 800);

      const sourcesBefore = await this.countSources(page);

      // Switch mode if not default
      if (mode !== "fast") {
        const modeSet = await this.setMode(page, mode);
        if (!modeSet) log.warning("  ⚠️  Could not set research mode; continuing with UI default");
        await randomDelay(300, 600);
      }

      // Switch corpus if not default
      if (corpus !== "web") {
        const corpusSet = await this.setCorpus(page, corpus);
        if (!corpusSet) log.warning("  ⚠️  Could not set corpus; continuing with UI default");
        await randomDelay(300, 600);
      }

      // Fill query
      await humanType(page, 'textarea.query-box-textarea', options.query, { withTypos: false });
      await randomDelay(300, 600);

      // Submit
      const submitted = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const btn = document.querySelector('button.actions-enter-button:not([disabled]), button[jslog^="282723"]:not([disabled])') as any;
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!submitted) {
        return {
          success: false, triggered: false, query: options.query,
          mode, corpus, sourcesBefore,
          error: "Submit button remained disabled — query may not have registered.",
        };
      }

      // Quick confirmation that the discovery container appeared (in "running" state).
      // Don't wait for completion here — that is get_research_status's job.
      await page.waitForSelector('.source-discovery-container', { timeout: 15000 }).catch(() => {});

      const note = mode === "deep"
        ? "Deep Research typically takes 2-10 minutes. Poll get_research_status until status=completed, then call import_research_results."
        : "Fast Research typically takes 15-30 seconds. Poll get_research_status until status=completed, then call import_research_results.";

      log.success(`  ✅ triggered (sourcesBefore=${sourcesBefore})`);

      return {
        success: true, triggered: true, query: options.query,
        mode, corpus, sourcesBefore, note,
      };
    } finally {
      await this.closePage();
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tool 2: Get research status (lightweight snapshot)
  // ──────────────────────────────────────────────────────────────────────
  async getResearchStatus(notebookUrl: string): Promise<ResearchStatusResult> {
    log.info(`🔍 research_sources (status): ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      await this.ensureSourcePanelOpen(page);
      // Short grace: the discovery container may still be animating in
      await page.waitForSelector(
        '.source-discovery-container, textarea.query-box-textarea',
        { timeout: 10000 }
      ).catch(() => {});

      const snapshot = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const dc = document.querySelector('.source-discovery-container') as any;
        if (!dc || !dc.offsetParent) {
          return { status: 'idle', candidatesCount: 0, candidatePreview: [], headerText: '' };
        }
        // Completed signal = Import button (jslog 282708) present and visible
        const importBtn = dc.querySelector('button[jslog^="282708"]');
        const headerEl = dc.querySelector('[class*="header"], [class*="status"], [class*="title"]');
        const headerText = headerEl?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) || '';
        if (importBtn && (importBtn as any).offsetParent) {
          // Collect candidate titles
          const titles: string[] = [];
          const cards = dc.querySelectorAll('[class*="source-card"], [class*="discovered-source"], [class*="candidate"]');
          for (const c of cards) {
            if (titles.length >= 5) break;
            const t = ((c as any).querySelector('[class*="title"], h3, h4')?.textContent || '').trim().slice(0, 100);
            if (t) titles.push(t);
          }
          // Fallback: pull from full text as link-labeled segments
          if (titles.length === 0) {
            // Scan all anchor/text titles inside the container
            const items = dc.querySelectorAll('a, [class*="result"] [class*="title"]');
            for (const a of items) {
              if (titles.length >= 5) break;
              const t = ((a as any).textContent || '').trim().slice(0, 100);
              if (t && t.length > 5) titles.push(t);
            }
          }
          return { status: 'completed', candidatesCount: titles.length, candidatePreview: titles, headerText };
        }
        // Discovery container is present but no Import button yet → still running
        return { status: 'running', candidatesCount: 0, candidatePreview: [], headerText };
      });

      log.success(`  Status: ${snapshot.status}${snapshot.candidatesCount ? ` (${snapshot.candidatesCount} candidates)` : ''}`);
      return {
        success: true,
        status: snapshot.status as ResearchStatus,
        candidatesCount: snapshot.candidatesCount,
        candidatePreview: snapshot.candidatePreview,
        headerText: snapshot.headerText || undefined,
      };
    } finally {
      await this.closePage();
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Tool 3: Import or dismiss the discovered candidates
  // ──────────────────────────────────────────────────────────────────────
  async importResearchResults(
    notebookUrl: string,
    action: ResearchImportAction = "import"
  ): Promise<ImportResearchResult> {
    log.info(`📥 research_sources (${action}): ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      await this.ensureSourcePanelOpen(page);
      try {
        await page.waitForSelector('.source-discovery-container button[jslog^="282708"]', { timeout: 15000 });
      } catch {
        return {
          success: false, action, imported: false,
          sourcesBefore: await this.countSources(page),
          sourcesAfter: await this.countSources(page),
          error: "Research is not in completed state. Call get_research_status first; status must be 'completed'.",
        };
      }

      const sourcesBefore = await this.countSources(page);
      const titlesBefore = await this.listSourceTitles(page);

      const targetJslog = action === "dismiss" ? "282707" : "282708";

      const clicked = await page.evaluate((prefix: string) => {
        // @ts-expect-error - DOM types
        const btn = document.querySelector(`.source-discovery-container button[jslog^="${prefix}"]`) as any;
        if (!btn) return false;
        btn.click();
        return true;
      }, targetJslog);

      if (!clicked) {
        return {
          success: false, action, imported: false,
          sourcesBefore, sourcesAfter: sourcesBefore,
          error: `Could not click the ${action} button.`,
        };
      }

      if (action === "dismiss") {
        // Dismiss: just wait for the discovery container to disappear
        await page.waitForSelector('.source-discovery-container', { state: "detached", timeout: 10000 }).catch(() => {});
        log.success(`  ✅ dismissed`);
        return {
          success: true, action, imported: false,
          sourcesBefore, sourcesAfter: await this.countSources(page),
        };
      }

      // Import: wait for new rows to appear
      const deadline = Date.now() + 45000;
      let imported = false;
      while (Date.now() < deadline) {
        const nowCount = await this.countSources(page);
        if (nowCount > sourcesBefore) { imported = true; break; }
        await page.waitForTimeout(500);
      }
      // Give NotebookLM time to finish title extraction (raw URL → real title)
      if (imported) await page.waitForTimeout(3000);

      const sourcesAfter = await this.countSources(page);
      const allTitles = await this.listSourceTitles(page);
      const beforeSet = new Set(titlesBefore);
      const addedTitles = allTitles.filter(t => !beforeSet.has(t));

      log.success(`  ✅ imported ${addedTitles.length} new sources (${sourcesBefore} → ${sourcesAfter})`);

      return {
        success: true, action, imported,
        sourcesBefore, sourcesAfter,
        ...(addedTitles.length > 0 && { addedTitles }),
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
