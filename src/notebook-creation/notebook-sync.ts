/**
 * NotebookLM Library Sync
 *
 * Syncs local library with actual NotebookLM notebooks.
 * Detects stale entries, extracts real URLs, and offers cleanup.
 */

import type { Page } from "patchright";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";
import { CONFIG } from "../config.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import type { NotebookLibrary } from "../library/notebook-library.js";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

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
        // @ts-expect-error - DOM types
        const tabs = document.querySelectorAll('button, [role="tab"]');
        for (const tab of tabs) {
          if ((tab as any).textContent?.includes("My notebooks")) {
            (tab as any).click();
            return true;
          }
        }
        return false;
      });
      if (clicked) {
        log.info("  📂 Clicked 'My notebooks' tab");
        await randomDelay(1500, 2000);
      }
    } catch {
      // Tab might already be selected or doesn't exist
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
      // @ts-expect-error - DOM types
      const pb = document.querySelectorAll('project-button').length;
      // @ts-expect-error - DOM types
      const tr = document.querySelectorAll('tr[role="row"]').length;
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
        // @ts-expect-error - DOM types
        return document.querySelectorAll('project-button').length > 0;
      });
      if (alreadyGrid) {
        log.info("  📊 Already in grid view");
        return;
      }

      const switched = await this.page.evaluate(() => {
        // Strategy 1: Find mat-button-toggle containing grid_view icon
        // @ts-expect-error - DOM types
        const toggles = document.querySelectorAll('mat-button-toggle');
        for (const toggle of toggles) {
          const text = (toggle as any).textContent?.trim() || "";
          if (text.includes('grid_view')) {
            // Click the inner button, not the toggle wrapper
            const innerBtn = (toggle as any).querySelector('button') || toggle;
            (innerBtn as any).click();
            return "toggle";
          }
        }

        // Strategy 2: Find by aria-label
        // @ts-expect-error - DOM types
        const buttons = document.querySelectorAll('[role="radio"], button');
        for (const btn of buttons) {
          const label = (btn as any).getAttribute('aria-label') || "";
          if (label.toLowerCase().includes('grid view') || label.toLowerCase().includes('grid_view')) {
            (btn as any).click();
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
    } catch {
      // Grid toggle may not exist
    }
  }

  /**
   * Extract notebooks from grid view project-button elements.
   * UUIDs are embedded in child element IDs (e.g., id="project-UUID-title").
   */
  private async extractFromGridView(): Promise<ActualNotebook[]> {
    if (!this.page) return [];

    return await this.page.evaluate(() => {
      const results: Array<{
        title: string;
        url: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      // @ts-expect-error - DOM types
      const projectButtons = document.querySelectorAll('project-button');

      for (const btn of projectButtons) {
        try {
          // Extract title from .project-button-title
          const titleEl = (btn as any).querySelector('.project-button-title');
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
            const allIds = (btn as any).querySelectorAll('[id]');
            for (const el of allIds) {
              const idMatch = el.id.match(/project-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
              if (idMatch) {
                url = `https://notebooklm.google.com/notebook/${idMatch[1]}`;
                break;
              }
            }
          }

          if (!url) continue;

          // Extract date and source count from subtitle
          const subtitle = (btn as any).querySelector('.project-button-subtitle')?.textContent || "";
          let createdDate = "";
          let sourceCount = 0;

          const dateMatch = subtitle.match(/(\d{1,2}\s+\w{3}\s+\d{4})/);
          if (dateMatch) createdDate = dateMatch[1];

          const sourceMatch = subtitle.match(/(\d+)\s*source/i);
          if (sourceMatch) sourceCount = parseInt(sourceMatch[1], 10);

          results.push({ title, url, sourceCount, createdDate });
        } catch {
          // Skip individual failures
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
      const results: Array<{
        title: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      // Select only data rows (with Source text), preserving DOM order
      // @ts-expect-error - DOM types
      const rows = document.querySelectorAll('tr[role="row"]');
      for (const row of rows) {
        const rowText = (row as any).textContent || "";
        if (!rowText.match(/\d+\s*Source/i)) continue;

        const titleEl = (row as any).querySelector('.project-table-title');
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
    const startUrl = this.page.url();

    for (let i = 0; i < rowData.length; i++) {
      const row = rowData[i];
      try {
        // Click the data row by index (skip non-data rows in evaluate)
        await this.page.evaluate((clickIdx: number) => {
          // @ts-expect-error - DOM types
          const allRows = document.querySelectorAll('tr[role="row"]');
          const dataRows: any[] = [];
          for (const r of allRows) {
            if ((r as any).textContent?.match(/\d+\s*Source/i)) {
              dataRows.push(r);
            }
          }
          if (dataRows[clickIdx]) (dataRows[clickIdx] as any).click();
        }, i);

        // Wait for navigation to complete
        await this.page.waitForURL(/\/notebook\//, { timeout: 10000 }).catch(() => {});
        await randomDelay(500, 1000);

        // Capture the URL
        const currentUrl = this.page.url();
        const notebookMatch = currentUrl.match(/\/notebook\/([a-f0-9-]+)/i);
        const url = notebookMatch
          ? `https://notebooklm.google.com/notebook/${notebookMatch[1]}`
          : `pending-nav-${notebooks.length}`;

        notebooks.push({
          title: row.title,
          url,
          sourceCount: row.sourceCount,
          createdDate: row.createdDate,
        });

        // Navigate back
        await this.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.browserTimeout });
        await this.page.waitForLoadState("networkidle").catch(() => {});
        await randomDelay(1500, 2000);
      } catch {
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
      const results: Array<{
        title: string;
        url: string;
        sourceCount: number;
        createdDate: string;
      }> = [];

      // @ts-expect-error - DOM types
      const rows = document.querySelectorAll('tr');

      for (const row of rows) {
        const rowText = (row as any).textContent || "";
        if (!rowText.match(/\d+\s*Source/i)) continue;

        // Get title from dedicated class or first cell
        const titleEl = (row as any).querySelector('.project-table-title');
        let title = titleEl?.textContent?.trim() || "";
        if (!title) {
          const cells = (row as any).querySelectorAll('td, th');
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
        const links = (row as any).querySelectorAll('a');
        for (const link of links) {
          const href = link.href || "";
          if (href.includes('/notebook/')) { url = href; break; }
        }
        if (!url) {
          const dataId = (row as any).getAttribute('data-notebook-id') ||
                        (row as any).querySelector('[data-notebook-id]')?.getAttribute('data-notebook-id');
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

    // Track which actual notebooks are matched
    const matchedActualIndices = new Set<number>();

    // Check each library entry
    for (const entry of libraryEntries) {
      // Extract notebook ID from URL
      const libraryNotebookId = this.extractNotebookId(entry.url);

      // Try to find matching actual notebook
      let matchingActualIndex: number = -1;

      // First try: match by URL/ID
      for (let i = 0; i < actualNotebooks.length; i++) {
        const actual = actualNotebooks[i];
        const actualNotebookId = this.extractNotebookId(actual.url);
        if (actualNotebookId === libraryNotebookId && !actual.url.startsWith("pending-")) {
          matchingActualIndex = i;
          break;
        }
      }

      // Second try: match by title similarity (fuzzy match)
      if (matchingActualIndex < 0) {
        const normalizedEntryName = this.normalizeTitle(entry.name);
        for (let i = 0; i < actualNotebooks.length; i++) {
          if (matchedActualIndices.has(i)) continue; // Already matched
          const actual = actualNotebooks[i];
          const normalizedActualTitle = this.normalizeTitle(actual.title);

          // Check for significant overlap
          if (this.titlesMatch(normalizedEntryName, normalizedActualTitle)) {
            matchingActualIndex = i;
            break;
          }
        }
      }

      if (matchingActualIndex >= 0) {
        const matchingActual = actualNotebooks[matchingActualIndex];
        matched.push({
          libraryId: entry.id,
          libraryName: entry.name,
          actualTitle: matchingActual.title,
          actualUrl: matchingActual.url,
        });
        matchedActualIndices.add(matchingActualIndex);

        // Check if name differs significantly
        const cleanActualTitle = this.normalizeTitle(matchingActual.title);
        const cleanEntryName = this.normalizeTitle(entry.name);
        if (cleanEntryName !== cleanActualTitle) {
          suggestions.push(
            `📝 "${entry.name}" matches "${matchingActual.title}" (consider updating library entry)`
          );
        }
      } else {
        staleEntries.push({
          libraryId: entry.id,
          libraryName: entry.name,
          libraryUrl: entry.url,
          reason: "Notebook not found in NotebookLM (may be deleted or URL changed)",
        });
      }
    }

    // Find notebooks not in library
    const missingNotebooks = actualNotebooks.filter(
      (_, index) => !matchedActualIndices.has(index)
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
      .replace(/[🔓🔒📁📄🔐⚛️🧠🛡️💻📋]/g, "") // Remove emojis
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, "") // Remove other emojis
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
   * Extract notebook ID from URL
   */
  private extractNotebookId(url: string): string {
    // URL format: https://notebooklm.google.com/notebook/UUID?authuser=X
    const match = url.match(/\/notebook\/([a-f0-9-]+)/i);
    return match ? match[1] : url;
  }

  /**
   * Auto-fix stale entries by removing them
   */
  private async autoFixStaleEntries(
    staleEntries: SyncResult["staleEntries"]
  ): Promise<void> {
    log.info("🔧 Auto-fixing stale entries...");

    for (const entry of staleEntries) {
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
    const isAuthenticated = await this.authManager.validateCookiesExpiry(context);
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
      } catch {
        // Ignore cleanup errors
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
