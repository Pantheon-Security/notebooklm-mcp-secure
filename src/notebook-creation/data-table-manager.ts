/**
 * Data Table Manager
 *
 * Manages Data Table extraction in NotebookLM notebooks.
 * Data Tables are structured tabular representations of information
 * extracted from notebook sources, available through the Studio panel.
 *
 * Selectors derived from live NotebookLM DOM inspection (Feb 2026):
 * - Studio panel is visible by default (toggle: .toggle-studio-panel-button)
 * - Data table tile: aria-label="Data table", role="button", class="create-artifact-button-container blue"
 * - Clicking tile immediately starts generation (no customise dialog)
 * - Generating state: .artifact-item-button.shimmer-blue with .rotate sync icon
 * - Artifact title during generation: "Generating data table…"
 * - Chat-embedded tables use standard <table><tr><th>/<td> (no <tbody>)
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

export interface DataTable {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
}

export interface DataTableStatus {
  status: "not_started" | "generating" | "ready" | "failed" | "unknown";
  progress?: number;
}

export interface GenerateDataTableResult {
  success: boolean;
  status: DataTableStatus;
  error?: string;
}

export interface GetDataTableResult {
  success: boolean;
  table?: DataTable;
  error?: string;
}

export class DataTableManager {
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
   *   - Toggle button: .toggle-studio-panel-button, aria-label="Collapse/Expand studio panel"
   *   - Tiles container: .create-artifact-button-container (visible when panel is open)
   *
   * Strategy:
   * 1. If tiles are already visible the panel is open — return true immediately
   * 2. Try the toggle button via a prioritised selector chain (guards against future renames)
   * 3. Click the button only when the panel is collapsed (aria includes "expand")
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
      // 1. Tiles already visible — panel is open, nothing to do
      // @ts-expect-error - DOM types
      if (document.querySelector(".create-artifact-button-container")) return true;

      // 2. Find the toggle button (primary selector first, then fallbacks for DOM changes)
      const candidateSelectors = [
        ".toggle-studio-panel-button",   // Confirmed present as of Feb 2026
        '[aria-label*="studio" i]',      // Aria-label fallback (case-insensitive)
        'button[class*="studio"]',       // Class-name fallback
      ];

      // 2. Tiles absent — panel is collapsed. Find toggle and click to open.
      // No aria-label text matching: labels are locale-dependent (e.g. "Réduire" in French).
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
   * Check data table artifact status in the artifact library.
   * Looks for artifacts with the "table_view" icon (data table artifacts).
   */
  private async checkDataTableStatusInternal(page: Page): Promise<DataTableStatus> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        if (iconText !== "table_view") continue;

        // Found a data table artifact
        const title = (item as any).querySelector(".artifact-title");
        const titleText = title?.textContent?.trim() || "";

        // Check if generating — shimmer-blue class is locale-independent (primary);
        // title text fallback is English-only ("Generating data table…")
        if ((item as any).classList.contains("shimmer-blue") || titleText.toLowerCase().includes("generating")) {
          return { status: "generating" as const, progress: 0 };
        }

        // Otherwise it's ready
        return { status: "ready" as const };
      }

      // No data table artifact found
      return { status: "not_started" as const };
    });
  }

  /**
   * Click the Data Table tile in the Studio panel.
   * This immediately triggers generation (no customise dialog).
   */
  private async clickDataTableTile(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // Primary: data-create-button-type (locale-independent, confirmed by CBR-75 Feb 2026)
      // @ts-expect-error - DOM types
      const tileByType = document.querySelector('[data-create-button-type="9"][role="button"]') as any;
      if (tileByType) {
        tileByType.click();
        return true;
      }
      // Fallback: English aria-label
      // @ts-expect-error - DOM types
      const tileByAria = document.querySelector('[aria-label="Data table"][role="button"]') as any;
      if (tileByAria) {
        tileByAria.click();
        return true;
      }
      // Last resort: text search (English only)
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll(".create-artifact-button-container");
      for (const t of tiles) {
        const text = t.textContent?.toLowerCase() || "";
        if (text.includes("data table")) {
          (t as any).click();
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Click on an existing data table artifact to open/display it
   */
  private async clickDataTableArtifact(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const artifactItems = document.querySelectorAll(".artifact-item-button");
      for (const item of artifactItems) {
        const icon = (item as any).querySelector(".artifact-icon");
        const iconText = icon?.textContent?.trim() || "";
        if (iconText !== "table_view") continue;

        // Skip generating artifacts
        if ((item as any).classList.contains("shimmer-blue")) continue;

        // Click the artifact button
        const btn = (item as any).querySelector("button.artifact-button-content") as any;
        if (btn) {
          btn.click();
          return true;
        }
        // Fallback: click the item itself
        (item as any).click();
        return true;
      }
      return false;
    });
  }

  /**
   * Generate a data table for a notebook
   */
  async generateDataTable(notebookUrl: string): Promise<GenerateDataTableResult> {
    log.info(`Generating data table for: ${notebookUrl}`);

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

      // Check current status in artifact library
      const currentStatus = await this.checkDataTableStatusInternal(page);

      if (currentStatus.status === "generating") {
        log.info("  Data table generation already in progress");
        return { success: true, status: currentStatus };
      }

      if (currentStatus.status === "ready") {
        log.info("  Data table already generated");
        return { success: true, status: currentStatus };
      }

      // Click Data Table tile (triggers immediate generation)
      const tileClicked = await this.clickDataTableTile(page);
      if (!tileClicked) {
        return {
          success: false,
          status: { status: "unknown" },
          error: "Could not find Data Table tile in Studio panel.",
        };
      }

      // Wait for the generating artifact to appear in the sidebar (shimmer-blue = in progress).
      // Falls back gracefully if it doesn't appear within 15s (slow machines, large notebooks).
      await page.waitForSelector(".artifact-item-button.shimmer-blue", { timeout: 15000 }).catch(() => {});
      await randomDelay(500, 800);

      // Check if generation started
      const newStatus = await this.checkDataTableStatusInternal(page);

      if (newStatus.status === "generating" || newStatus.status === "ready") {
        log.success(`  Data table generation ${newStatus.status === "ready" ? "completed" : "started"}`);
        return { success: true, status: newStatus };
      }

      return {
        success: false,
        status: newStatus,
        error: "Data table generation may have failed to start. Try again or check the notebook.",
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Get an existing data table from a notebook.
   * Clicks on the data table artifact to display it, then extracts table data.
   */
  async getDataTable(notebookUrl: string): Promise<GetDataTableResult> {
    log.info(`Extracting data table from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Ensure Studio panel is visible
      await this.ensureStudioPanelOpen(page);
      await randomDelay(500, 800);

      // Check if data table artifact is ready
      const status = await this.checkDataTableStatusInternal(page);
      if (status.status === "generating") {
        return {
          success: false,
          error: "Data table is still generating. Please wait and try again.",
        };
      }
      if (status.status === "not_started") {
        return {
          success: false,
          error: "No data table found. Use generate_data_table first.",
        };
      }

      // Click the data table artifact to open it
      const artifactClicked = await this.clickDataTableArtifact(page);
      if (!artifactClicked) {
        return {
          success: false,
          error: "Could not click on data table artifact.",
        };
      }

      await randomDelay(2000, 3000);

      // Extract table data from the page
      const table = await this.extractTableData(page);

      if (!table) {
        return {
          success: false,
          error: "Could not extract table data. The table may not be visible yet.",
        };
      }

      log.success(`  Extracted data table: ${table.totalColumns} columns x ${table.totalRows} rows`);

      return {
        success: true,
        table,
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Extract structured table data from all tables on the page.
   * NotebookLM tables use <table> with direct <tr> children (no <tbody>).
   * Returns the largest table found.
   */
  private async extractTableData(page: Page): Promise<DataTable | null> {
    return await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const tables = document.querySelectorAll("table");
      if (tables.length === 0) return null;

      let bestTable: { headers: string[]; rows: string[][]; totalRows: number; totalColumns: number } | null = null;

      for (const table of tables) {
        // Only consider visible tables
        if (!(table as any).offsetWidth) continue;

        const allRows = (table as any).querySelectorAll("tr");
        const headers: string[] = [];
        const rows: string[][] = [];

        for (const row of allRows) {
          const ths = row.querySelectorAll("th");
          const tds = row.querySelectorAll("td");

          if (ths.length > 0) {
            // Header row
            if (headers.length === 0) {
              for (const th of ths) {
                headers.push((th.textContent || "").trim());
              }
            }
          } else if (tds.length > 0) {
            // Data row
            const rowData: string[] = [];
            for (const td of tds) {
              rowData.push((td.textContent || "").trim());
            }
            rows.push(rowData);
          }
        }

        const totalCells = headers.length + rows.reduce((sum, r) => sum + r.length, 0);
        const currentBest = bestTable
          ? bestTable.totalColumns + bestTable.rows.reduce((sum, r) => sum + r.length, 0)
          : 0;

        if (totalCells > currentBest) {
          bestTable = {
            headers,
            rows,
            totalRows: rows.length,
            totalColumns: headers.length,
          };
        }
      }

      return bestTable;
    });
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
