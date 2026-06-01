/**
 * NotebookLM Library Sync
 *
 * Syncs local library with actual NotebookLM notebooks.
 * Detects stale entries, extracts real URLs, and offers cleanup.
 */

import type { Page } from "patchright";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";
import { CONFIG, NOTEBOOKLM_URL } from "../config.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";

type BrowserDomElement = unknown;

type BrowserTextElement = {
  textContent?: string | null;
};

type BrowserElementWithId = {
  id?: string;
};

type BrowserElementWithQuery = {
  querySelector(selector: string): BrowserDomElement | null;
  querySelectorAll(selector: string): Iterable<BrowserDomElement>;
};

type BrowserClickableElement = BrowserTextElement &
  BrowserElementWithQuery & {
    click(): void;
    getAttribute(name: string): string | null;
  };

type BrowserLinkElement = {
  href?: string;
};

type BrowserDocumentContext = {
  document: {
    querySelectorAll(selector: string): Iterable<BrowserDomElement>;
  };
};



export interface ActualNotebook {
  title: string;
  url: string;
  sourceCount: number;
  createdDate: string;
}

export interface SyncResult {
  actualNotebooks: ActualNotebook[];
  matched: Array<{
    libraryId: string;
    libraryName: string;
    actualTitle: string;
    actualUrl: string;
  }>;
  staleEntries: Array<{
    libraryId: string;
    libraryName: string;
    libraryUrl: string;
    reason: string;
    /**
     * Whether this entry is SAFE to auto-remove. Only true when we have an
     * exact, UUID-based confirmation that the notebook no longer exists. Entries
     * that merely failed a fuzzy title match are reported as stale (for the
     * human to review) but are NOT eligible for destructive auto-fix.
     */
    autoFixSafe: boolean;
  }>;
  missingNotebooks: ActualNotebook[];
  suggestions: string[];
}

/**
 * Syncs library with actual NotebookLM notebooks
 */
export class NotebookSync {
  private page: Page | null = null;

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager,
    private library: NotebookLibrary
  ) {}

  /**
   * Sync library with actual NotebookLM notebooks
   */
  async syncLibrary(options?: {
    autoFix?: boolean;
    showBrowser?: boolean;
  }): Promise<SyncResult> {
    try {
      log.info("🔄 Starting library sync...");

      // Initialize browser
      await this.initialize(options?.showBrowser);

      // Extract actual notebooks from NotebookLM
      const { notebooks: actualNotebooks, diagnostic } = await this.extractNotebooks();
      log.info(`📚 Found ${actualNotebooks.length} notebooks in NotebookLM`);

      // Get library entries
      const libraryEntries = this.library.listNotebooks();
      log.info(`📖 Library has ${libraryEntries.length} entries`);

      // Compare and categorize
      const result = this.compareLibraryWithActual(libraryEntries, actualNotebooks);

      // Surface diagnostic info in suggestions for debugging
      if (diagnostic.length > 0) {
        result.suggestions.push(`🔍 DOM diagnostic: strategy=${diagnostic[0]}`, ...diagnostic.slice(1).map(d => `  ${d.substring(0, 300)}`));
      }

      // Log summary
      this.logSyncSummary(result);

      // Auto-fix if requested
      if (options?.autoFix) {
        if (result.staleEntries.length > 0) {
          await this.autoFixStaleEntries(result.staleEntries);
        }

        if (result.missingNotebooks.length > 0) {
          await this.autoAddMissingNotebooks(result.missingNotebooks);
        }
      }

      return result;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Extract all notebooks from NotebookLM homepage
   */
  async extractNotebooks(): Promise<{ notebooks: ActualNotebook[]; diagnostic: string[] }> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("📋 Extracting notebooks from NotebookLM...");

    // Wait for page to fully load
    await this.page.waitForLoadState("networkidle").catch(() => {});
    await randomDelay(2000, 3000);

    // Try to click on "My notebooks" tab if it exists
    try {
      const clicked = await this.page.evaluate(() => {
        const browser = globalThis as unknown as BrowserDocumentContext;
        const tabs = Array.from(browser.document.querySelectorAll('button, [role="tab"]')) as BrowserClickableElement[];
        for (const tab of tabs) {
          if (tab.textContent?.includes("My notebooks")) {
            tab.click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        log.info("  📂 Clicked 'My notebooks' tab");
        await randomDelay(1500, 2000);
      }
    } catch (err) {
      log.debug(`notebook sync: failed to click My notebooks tab: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Switch to grid view — UUIDs only exist in grid view's project-button elements
    await this.switchToGridView();

    // Wait for notebook content to load
    await Promise.race([
      this.page.waitForSelector('project-button', { timeout: 15000 }),
      this.page.waitForSelector('project-action-button', { timeout: 15000 }),
      this.page.waitForSelector('table', { timeout: 15000 }),
    ]).catch(() => {});
    await randomDelay(2000, 3000);

    // Collect diagnostics
    const diagnostic: string[] = [];

    const viewMode = await this.page.evaluate(() => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const pb = Array.from(browser.document.querySelectorAll('project-button')).length;
      const tr = Array.from(browser.document.querySelectorAll('tr[role="row"]')).length;
      return { projectButtons: pb, tableRows: tr };
    });
    diagnostic.push(`view-detect: project-button=${viewMode.projectButtons}, table-rows=${viewMode.tableRows}`);

    // Strategy 1: Grid view project-button cards (primary — has UUIDs)
    let notebooks: ActualNotebook[] = [];
    let strategy = "none";

    if (viewMode.projectButtons > 0) {
      strategy = "grid-project-button";
      notebooks = await this.extractFromGridView();
      diagnostic.push(`grid-extraction: ${notebooks.length} notebooks`);
    }

    // Strategy 2: Table rows + click-navigation for URLs (fallback)
    if (notebooks.length === 0 && viewMode.tableRows > 0) {
      strategy = "table-click-nav";
      notebooks = await this.extractFromTableViewWithNavigation();
      diagnostic.push(`table-click-nav: ${notebooks.length} notebooks`);
    }

    // Strategy 3: Table rows with placeholder URLs (last resort)
    if (notebooks.length === 0) {
      strategy = "table-rows-pending";
      notebooks = await this.extractFromTableViewBasic();
      diagnostic.push(`table-basic: ${notebooks.length} notebooks`);
    }

    diagnostic.unshift(`strategy=${strategy}`);

    // Log results
    log.dim(`  Strategy used: ${strategy}`);
    log.dim(`  Extracted ${notebooks.length} notebooks from page`);
    for (const d of diagnostic) {
      log.dim(`  [diag] ${d.substring(0, 200)}`);
    }

    // Deduplicate by URL (O(n) using Set)
    const seenUrls = new Set<string>();
    const uniqueNotebooks = notebooks.filter(notebook => {
      if (seenUrls.has(notebook.url)) return false;
      seenUrls.add(notebook.url);
      return true;
    });

    log.success(`✅ Extracted ${uniqueNotebooks.length} notebooks`);
    return { notebooks: uniqueNotebooks, diagnostic };
  }

  /**
   * Switch to grid view — notebook UUIDs only appear in grid view DOM
   */
  private async switchToGridView(): Promise<void> {
    if (!this.page) return;

    try {
      // Check if already in grid view
      const alreadyGrid = await this.page.evaluate(() => {
        const browser = globalThis as unknown as BrowserDocumentContext;
        return Array.from(browser.document.querySelectorAll('project-button')).length > 0;
      });
      if (alreadyGrid) {
        log.info("  📊 Already in grid view");
        return;
      }

      const switched = await this.page.evaluate(() => {
        const browser = globalThis as unknown as BrowserDocumentContext;
        // Strategy 1: Find mat-button-toggle containing grid_view icon
        const toggles = Array.from(browser.document.querySelectorAll('mat-button-toggle')) as BrowserClickableElement[];
        for (const toggle of toggles) {
          const text = toggle.textContent?.trim() || "";
          if (text.includes('grid_view')) {
            // Click the inner button, not the toggle wrapper
            const innerBtn = (toggle.querySelector('button') as BrowserClickableElement | null) || toggle;
            innerBtn.click();
            return "toggle";
          }
        }

        // Strategy 2: Find by aria-label
        const buttons = Array.from(browser.document.querySelectorAll('[role="radio"], button')) as BrowserClickableElement[];
        for (const btn of buttons) {
          const label = btn.getAttribute('aria-label') || "";
          if (label.toLowerCase().includes('grid view') || label.toLowerCase().includes('grid_view')) {
            btn.click();
            return "aria";
          }
        }

        return null;
      });

      if (switched) {
        log.info(`  📊 Switched to grid view (via ${switched})`);
        // Wait specifically for project-button elements to appear
        await this.page.waitForSelector('project-button', { timeout: 8000 }).catch(() => {});
        await randomDelay(1000, 1500);
      }
    } catch (err) {
      log.debug(`notebook sync: failed to switch to grid view: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Extract notebooks from grid view project-button elements.
   * UUIDs are embedded in child element IDs (e.g., id="project-UUID-title").
   */
  private async extractFromGridView(): Promise<ActualNotebook[]> {
    if (!this.page) return [];

    return await this.page.evaluate(() => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const results: Array<{
        title: string;
        url: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      const projectButtons = Array.from(browser.document.querySelectorAll('project-button')) as BrowserClickableElement[];

      for (const btn of projectButtons) {
        try {
          // Extract title from .project-button-title
          const titleEl = btn.querySelector('.project-button-title') as (BrowserTextElement & BrowserElementWithId) | null;
          const title = titleEl?.textContent?.trim() || "";
          if (!title) continue;

          // Extract UUID from child element IDs (pattern: project-UUID-title)
          const titleId = titleEl?.id || "";
          const uuidMatch = titleId.match(/project-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-title/);
          let url = "";
          if (uuidMatch && uuidMatch[1]) {
            url = `https://notebooklm.google.com/notebook/${uuidMatch[1]}`;
          }

          // Fallback: search all element IDs and aria-labelledby for UUID
          if (!url) {
            const allIds = Array.from(btn.querySelectorAll('[id]')) as BrowserElementWithId[];
            for (const el of allIds) {
              const idMatch = el.id?.match(/project-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
              if (idMatch) {
                url = `https://notebooklm.google.com/notebook/${idMatch[1]}`;
                break;
              }
            }
          }

          if (!url) continue;

          // Extract date and source count from subtitle
          const subtitle = (btn.querySelector('.project-button-subtitle') as BrowserTextElement | null)?.textContent || "";
          let createdDate = "";
          let sourceCount = 0;

          const dateMatch = subtitle.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
          if (dateMatch) createdDate = dateMatch[1];

          const sourceMatch = subtitle.match(/(\d+)\s*source/i);
          if (sourceMatch) sourceCount = parseInt(sourceMatch[1], 10);

          results.push({ title, url, sourceCount, createdDate });
        } catch (err) {
          log.debug(`notebook sync: failed to extract notebook card: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return results;
    });
  }

  /**
   * Extract notebooks from table view by clicking each row to capture the navigation URL.
   * Slower but works when grid view is unavailable.
   */
  private async extractFromTableViewWithNavigation(): Promise<ActualNotebook[]> {
    if (!this.page) return [];

    // First extract metadata from table rows
    const rowData = await this.page.evaluate(() => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const results: Array<{
        title: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      // Select only data rows (with Source text), preserving DOM order
      const rows = Array.from(browser.document.querySelectorAll('tr[role="row"]')) as BrowserClickableElement[];
      for (const row of rows) {
        const rowText = row.textContent || "";
        if (!rowText.match(/\d+\s*Source/i)) continue;

        const titleEl = row.querySelector('.project-table-title') as BrowserTextElement | null;
        const title = titleEl?.textContent?.trim() || "";
        if (!title || title.length < 3) continue;

        let sourceCount = 0;
        const sourceMatch = rowText.match(/(\d+)\s*Source/i);
        if (sourceMatch) sourceCount = parseInt(sourceMatch[1], 10);

        let createdDate = "";
        const dateMatch = rowText.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
        if (dateMatch) createdDate = dateMatch[1];

        results.push({ title, sourceCount, createdDate });
      }
      return results;
    });

    if (rowData.length === 0) return [];

    // Click each row to capture the URL via navigation
    const notebooks: ActualNotebook[] = [];

    // Capture the library root URL ONCE, before any navigation. If the page is
    // already sitting on a /notebook/ URL (left over from a prior step), the
    // per-row waitForURL(/\/notebook\//) would resolve immediately against the
    // pre-existing URL and mislabel every row with the wrong UUID. In that case
    // navigate back to the library root first so clicks produce real
    // navigations from a known-good base.
    let startUrl = this.page.url();
    if (/\/notebook\//.test(startUrl)) {
      log.warning("  ⚠️ Not on library root before row scrape — returning to library");
      await this.page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded", timeout: CONFIG.browserTimeout });
      await this.page.waitForLoadState("networkidle").catch(() => {});
      await randomDelay(1500, 2000);
      startUrl = this.page.url();
    }

    for (let i = 0; i < rowData.length; i++) {
      const row = rowData[i];
      try {
        // Record the URL immediately before the click so we can confirm that a
        // REAL navigation occurred (and not accept a pre-existing notebook URL).
        const urlBeforeClick = this.page.url();

        // Click the data row by index (skip non-data rows in evaluate)
        await this.page.evaluate((clickIdx: number) => {
          const browser = globalThis as unknown as BrowserDocumentContext;
          const allRows = Array.from(browser.document.querySelectorAll('tr[role="row"]')) as BrowserClickableElement[];
          const dataRows: BrowserClickableElement[] = [];
          for (const r of allRows) {
            if (r.textContent?.match(/\d+\s*Source/i)) {
              dataRows.push(r);
            }
          }
          dataRows[clickIdx]?.click();
        }, i);

        // Wait for the URL to actually CHANGE to a new /notebook/ page. Using a
        // predicate (rather than a bare /\/notebook\// regex) prevents resolving
        // immediately against a pre-existing notebook URL and capturing a stale
        // UUID for this row.
        await this.page
          .waitForURL(
            (u) => /\/notebook\//.test(u.toString()) && u.toString() !== urlBeforeClick,
            { timeout: 10000 }
          )
          .catch(() => {});
        await randomDelay(500, 1000);

        // Capture the URL — only trust a UUID when a real navigation to a NEW
        // notebook actually happened.
        const currentUrl = this.page.url();
        const notebookMatch = currentUrl.match(/\/notebook\/([a-f0-9-]+)/i);
        const navigated = currentUrl !== urlBeforeClick && notebookMatch !== null;
        const url = navigated
          ? `https://notebooklm.google.com/notebook/${notebookMatch![1]}`
          : `pending-nav-${notebooks.length}`;

        if (!navigated) {
          log.warning(`  ⚠️ Row click did not navigate to a new notebook: ${row.title}`);
        }

        notebooks.push({
          title: row.title,
          url,
          sourceCount: row.sourceCount,
          createdDate: row.createdDate,
        });

        // Navigate back to the library root
        await this.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.browserTimeout });
        await this.page.waitForLoadState("networkidle").catch(() => {});
        await randomDelay(1500, 2000);
      } catch (err) {
        log.debug(`notebook-sync: navigating to notebook row for URL extraction: ${err instanceof Error ? err.message : String(err)}`);
        log.warning(`  ⚠️ Could not navigate to notebook: ${row.title}`);
      }
    }

    return notebooks;
  }

  /**
   * Basic table row extraction without URLs (last resort fallback).
   */
  private async extractFromTableViewBasic(): Promise<ActualNotebook[]> {
    if (!this.page) return [];

    return await this.page.evaluate(() => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const results: Array<{
        title: string;
        url: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      const rows = Array.from(browser.document.querySelectorAll('tr')) as BrowserClickableElement[];

      for (const row of rows) {
        const rowText = row.textContent || "";
        if (!rowText.match(/\d+\s*Source/i)) continue;

        // Get title from dedicated class or first cell
        const titleEl = row.querySelector('.project-table-title') as BrowserTextElement | null;
        let title = titleEl?.textContent?.trim() || "";
        if (!title) {
          const cells = Array.from(row.querySelectorAll('td, th')) as BrowserTextElement[];
          for (const cell of cells) {
            const cellText = cell.textContent?.trim() || "";
            if (cellText.length > 3 &&
                !cellText.match(/^[\d\s]+$/) &&
                !cellText.match(/^\d+\s*Source/i) &&
                !cellText.match(/^\d{1,2}\s+\w{3}\s+\d{4}$/) &&
                !cellText.match(/^(Owner|Viewer|Editor)$/i)) {
              title = cellText;
              break;
            }
          }
        }

        if (!title || title.length < 3) continue;

        let sourceCount = 0;
        const sourceMatch = rowText.match(/(\d+)\s*Source/i);
        if (sourceMatch) sourceCount = parseInt(sourceMatch[1], 10);

        let createdDate = "";
        const dateMatch = rowText.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
        if (dateMatch) createdDate = dateMatch[1];

        // Try links/data attributes for URL
        let url = "";
        const links = Array.from(row.querySelectorAll('a')) as BrowserLinkElement[];
        for (const link of links) {
          const href = link.href || "";
          if (href.includes('/notebook/')) { url = href; break; }
        }
        if (!url) {
          const childWithDataId = row.querySelector('[data-notebook-id]') as { getAttribute(name: string): string | null } | null;
          const dataId = row.getAttribute('data-notebook-id') ||
                        childWithDataId?.getAttribute('data-notebook-id');
          if (dataId) url = `https://notebooklm.google.com/notebook/${dataId}`;
        }
        if (!url) url = `pending-${results.length}`;

        results.push({ title, url, sourceCount, createdDate });
      }

      return results;
    });
  }

  /**
   * Compare library entries with actual notebooks
   */
  private compareLibraryWithActual(
    libraryEntries: Array<{ id: string; name: string; url: string }>,
    actualNotebooks: ActualNotebook[]
  ): SyncResult {
    const matched: SyncResult["matched"] = [];
    const staleEntries: SyncResult["staleEntries"] = [];
    const suggestions: string[] = [];

    // Is the extraction trustworthy enough to treat "UUID absent from this list"
    // as positive proof of deletion? Only if we actually saw notebooks AND every
    // one of them yielded a real UUID. An empty list usually means extraction
    // failed (page didn't load / strategy missed) — NOT that the account is
    // empty — and a "pending-*" entry could BE the very notebook we're checking,
    // so "absent" is not a confirmation. Without this guard a failed scrape would
    // mark every valid library entry as "confirmed deleted" and autoFix would
    // wipe the whole library. This is the core data-loss M33 must prevent.
    const extractionIsAuthoritative =
      actualNotebooks.length > 0 &&
      actualNotebooks.every((n) => this.extractNotebookId(n.url) !== null);

    // Track which actual notebooks are matched
    const matchedActualIndices = new Set<number>();
    // Actual notebooks tied to a library entry by a FUZZY (unconfirmed) title
    // match. They are not authoritative matches, but we must not auto-ADD them
    // as "missing" either — that would create a duplicate library entry for a
    // notebook the human still needs to reconcile. Excluded from auto-add only.
    const fuzzyReservedIndices = new Set<number>();

    // Check each library entry
    for (const entry of libraryEntries) {
      // Extract notebook ID from URL (null = pending/garbage, never a match key)
      const libraryNotebookId = this.extractNotebookId(entry.url);

      // First try: EXACT UUID match. This is the only authoritative identity —
      // and the only signal allowed to drive a destructive auto-fix.
      let exactMatchIndex = -1;
      if (libraryNotebookId !== null) {
        for (let i = 0; i < actualNotebooks.length; i++) {
          const actualNotebookId = this.extractNotebookId(actualNotebooks[i].url);
          if (actualNotebookId !== null && actualNotebookId === libraryNotebookId) {
            exactMatchIndex = i;
            break;
          }
        }
      }

      // Second try: fuzzy title match. This is a SUGGESTION ONLY. A 60% word
      // overlap can match the wrong notebook ("Security Notes 2025" vs "...2026"),
      // so a fuzzy hit must never be fed into removal/relabel — it only avoids
      // proposing deletion of an entry we can plausibly still see.
      let fuzzyMatchIndex = -1;
      if (exactMatchIndex < 0) {
        const normalizedEntryName = this.normalizeTitle(entry.name);
        for (let i = 0; i < actualNotebooks.length; i++) {
          if (matchedActualIndices.has(i)) continue; // Already matched
          const normalizedActualTitle = this.normalizeTitle(actualNotebooks[i].title);
          if (this.titlesMatch(normalizedEntryName, normalizedActualTitle)) {
            fuzzyMatchIndex = i;
            break;
          }
        }
      }

      if (exactMatchIndex >= 0) {
        const matchingActual = actualNotebooks[exactMatchIndex];
        matched.push({
          libraryId: entry.id,
          libraryName: entry.name,
          actualTitle: matchingActual.title,
          actualUrl: matchingActual.url,
        });
        matchedActualIndices.add(exactMatchIndex);

        // Title drift on a UUID-confirmed match is safe to suggest relabelling.
        const cleanActualTitle = this.normalizeTitle(matchingActual.title);
        const cleanEntryName = this.normalizeTitle(entry.name);
        if (cleanEntryName !== cleanActualTitle) {
          suggestions.push(
            `📝 "${entry.name}" matches "${matchingActual.title}" (consider updating library entry)`
          );
        }
      } else if (fuzzyMatchIndex >= 0) {
        // Fuzzy hit: report as a SUGGESTION only. Do not consume the actual
        // notebook (leave it as "missing" so the human sees both sides) and do
        // NOT mark the library entry as auto-removable.
        const fuzzyActual = actualNotebooks[fuzzyMatchIndex];
        fuzzyReservedIndices.add(fuzzyMatchIndex);
        suggestions.push(
          `❓ "${entry.name}" may correspond to "${fuzzyActual.title}" (fuzzy title match — verify manually; not auto-applied)`
        );
        staleEntries.push({
          libraryId: entry.id,
          libraryName: entry.name,
          libraryUrl: entry.url,
          reason: "No exact UUID match; only a fuzzy title match was found (review manually)",
          autoFixSafe: false,
        });
      } else {
        // No exact and no fuzzy match. Only safe to auto-remove when we could
        // actually derive a real UUID for this entry AND positively confirmed it
        // is absent. If the entry's own URL has no parseable UUID (pending/
        // garbage), we cannot prove the notebook is gone — never auto-delete it.
        staleEntries.push({
          libraryId: entry.id,
          libraryName: entry.name,
          libraryUrl: entry.url,
          reason:
            libraryNotebookId === null
              ? "Entry has no resolvable notebook UUID (cannot confirm deletion — review manually)"
              : !extractionIsAuthoritative
              ? "Notebook not found, but extraction was incomplete (empty or pending results) — cannot confirm deletion; review manually"
              : "Notebook UUID not present in NotebookLM (confirmed deleted or moved)",
          autoFixSafe: libraryNotebookId !== null && extractionIsAuthoritative,
        });
      }
    }

    // Find notebooks not in library. Exclude fuzzy-reserved actuals so we don't
    // auto-add a duplicate of a notebook a stale entry probably already denotes.
    const missingNotebooks = actualNotebooks.filter(
      (_, index) => !matchedActualIndices.has(index) && !fuzzyReservedIndices.has(index)
    );

    // Generate suggestions
    if (staleEntries.length > 0) {
      suggestions.unshift(
        `🗑️  ${staleEntries.length} stale library entries should be removed`
      );
    }
    if (missingNotebooks.length > 0) {
      suggestions.push(
        `➕ ${missingNotebooks.length} notebooks could be added to library`
      );
    }

    return {
      actualNotebooks,
      matched,
      staleEntries,
      missingNotebooks,
      suggestions,
    };
  }

  /**
   * Normalize a title for comparison
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      // Remove emoji across all Unicode ranges (flags, symbols, supplemental
      // pictographs, etc.) plus the zero-width-joiner and variation selectors
      // used to compose emoji sequences. A hardcoded set / narrow range missed
      // common emoji and made otherwise-equal titles normalize differently,
      // producing false "stale" mismatches.
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[\u{200D}\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu, "") // ZWJ, variation selectors, skin-tone modifiers
      .replace(/[^\w\s]/g, " ") // Remove punctuation
      .replace(/\s+/g, " ") // Normalize whitespace
      .trim();
  }

  /**
   * Check if two titles match (fuzzy)
   */
  private titlesMatch(title1: string, title2: string): boolean {
    // Exact match
    if (title1 === title2) return true;

    // One contains the other
    if (title1.includes(title2) || title2.includes(title1)) return true;

    // Split into words and check overlap
    const words1 = new Set(title1.split(" ").filter(w => w.length > 3));
    const words2 = new Set(title2.split(" ").filter(w => w.length > 3));

    if (words1.size === 0 || words2.size === 0) return false;

    const intersection = [...words1].filter(w => words2.has(w));
    const overlapRatio = intersection.length / Math.min(words1.size, words2.size);

    // If 60%+ of significant words match, consider it a match
    return overlapRatio >= 0.6;
  }

  /**
   * Extract a STABLE notebook UUID from a URL, or null if none can be derived.
   *
   * Returns null for "pending-*" placeholders and for any URL that does not
   * carry a real /notebook/UUID segment. A null id must NEVER be treated as a
   * match key (two unknowns are not "equal") and must NEVER feed a destructive
   * auto-fix decision — doing so previously let placeholder/garbage ids collide
   * or let a missing id be (mis)matched and removed.
   */
  private extractNotebookId(url: string): string | null {
    if (!url || url.startsWith("pending-")) return null;
    // URL format: https://notebooklm.google.com/notebook/UUID?authuser=X
    // Require a canonical UUID so a partial/garbage id can't be matched.
    const match = url.match(
      /\/notebook\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
    );
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Auto-fix stale entries by removing them
   */
  private async autoFixStaleEntries(
    staleEntries: SyncResult["staleEntries"]
  ): Promise<void> {
    log.info("🔧 Auto-fixing stale entries...");

    for (const entry of staleEntries) {
      // DESTRUCTIVE GUARD: only remove entries we could confirm as deleted via
      // an exact UUID. Fuzzy/unresolvable entries are left for manual review so
      // a valid library entry is never destroyed on a 60%-title-overlap guess.
      if (!entry.autoFixSafe) {
        log.warning(
          `⏭️  Skipping auto-remove of "${entry.libraryName}" — ${entry.reason}`
        );
        continue;
      }
      try {
        this.library.removeNotebook(entry.libraryId);
        log.success(`✅ Removed stale entry: ${entry.libraryName}`);
      } catch (error) {
        log.warning(`⚠️ Could not remove ${entry.libraryName}: ${error}`);
      }
    }
  }

  /**
   * Auto-add missing notebooks to library
   */
  private async autoAddMissingNotebooks(
    missingNotebooks: ActualNotebook[]
  ): Promise<void> {
    // Only add notebooks that have real URLs (not pending placeholders)
    const addable = missingNotebooks.filter(n => !n.url.startsWith("pending-"));
    if (addable.length === 0) {
      log.warning("⚠️ Missing notebooks have no extractable URLs — skipping auto-add");
      return;
    }

    log.info(`➕ Auto-adding ${addable.length} missing notebooks...`);

    for (const notebook of addable) {
      try {
        this.library.addNotebook({
          name: notebook.title,
          url: notebook.url,
          description: `Auto-synced from NotebookLM: ${notebook.title}`,
          topics: ["auto-synced"],
          use_cases: [],
          tags: [],
        });
        log.success(`  ✅ Added: ${notebook.title}`);
      } catch (error) {
        log.warning(`  ⚠️ Could not add ${notebook.title}: ${error}`);
      }
    }
  }

  /**
   * Log sync summary
   */
  private logSyncSummary(result: SyncResult): void {
    log.info("");
    log.info("📊 Sync Summary:");
    log.info(`  ✅ Matched: ${result.matched.length}`);
    log.info(`  ⚠️  Stale: ${result.staleEntries.length}`);
    log.info(`  ➕ Missing: ${result.missingNotebooks.length}`);
    log.info("");

    if (result.suggestions.length > 0) {
      log.info("💡 Suggestions:");
      for (const suggestion of result.suggestions) {
        log.info(`  ${suggestion}`);
      }
    }
  }

  /**
   * Initialize browser and navigate to NotebookLM
   */
  private async initialize(showBrowser?: boolean): Promise<void> {
    log.info("🌐 Initializing browser for sync...");

    // Get browser context
    const context = await this.contextManager.getOrCreateContext(
      showBrowser === true ? true : undefined
    );

    // Check authentication
    const isAuthenticated = await this.authManager.validateWithRetry(context);
    if (!isAuthenticated) {
      throw new Error(
        "Not authenticated to NotebookLM. Please run setup_auth first."
      );
    }

    // Create new page
    this.page = await context.newPage();

    // Navigate to NotebookLM
    await this.page.goto(NOTEBOOKLM_URL, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.browserTimeout,
    });

    await randomDelay(2000, 3000);
    await this.page.waitForLoadState("networkidle").catch(() => {});

    log.success("✅ Browser initialized");
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        log.debug(`notebook sync: failed to close page: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.page = null;
    }
  }
}

/**
 * Sync library with NotebookLM
 */
export async function syncLibrary(
  authManager: AuthManager,
  contextManager: SharedContextManager,
  library: NotebookLibrary,
  options?: { autoFix?: boolean; showBrowser?: boolean }
): Promise<SyncResult> {
  const sync = new NotebookSync(authManager, contextManager, library);
  return await sync.syncLibrary(options);
}
