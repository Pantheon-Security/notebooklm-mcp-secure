/**
 * Source Manager
 *
 * Manages sources within NotebookLM notebooks (list, add, remove).
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType } from "../utils/stealth-utils.js";
import { NOTEBOOKLM_SELECTORS } from "./selectors.js";
import type { NotebookSource } from "./types.js";

export interface SourceInfo {
  id: string;
  title: string;
  type: "url" | "text" | "file" | "drive" | "unknown";
  status: "ready" | "processing" | "failed" | "unknown";
}

export interface ListSourcesResult {
  sources: SourceInfo[];
  count: number;
  notebookUrl: string;
}

export interface AddSourceResult {
  success: boolean;
  source?: SourceInfo;
  error?: string;
}

export interface RemoveSourceResult {
  success: boolean;
  removedId?: string;
  error?: string;
}

export class SourceManager {
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
    await randomDelay(1500, 2500);

    return this.page;
  }

  /**
   * List all sources in a notebook
   */
  async listSources(notebookUrl: string): Promise<ListSourcesResult> {
    log.info(`📋 Listing sources for: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Wait for the sources panel to load
      await page.waitForTimeout(2000);

      // Extract source information from the page
      const sources = await page.evaluate(() => {
        const results: any[] = [];

        // Look for source items in the sidebar/sources panel
        // Common patterns in NotebookLM:
        // - mat-list-item elements
        // - Elements with source-related classes
        // - Elements within a sources container
        const sourceSelectors = [
          'mat-list-item',
          '[class*="source-item"]',
          '[class*="source-card"]',
          '[role="listitem"]',
          '.sources-list > *',
        ];

        for (const selector of sourceSelectors) {
          // @ts-expect-error - DOM types
          const items = document.querySelectorAll(selector);

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const text = (item as any).textContent?.trim() || "";

            // Skip if it looks like a button or action item
            if (text.length < 3 || text.toLowerCase().includes("add source")) continue;

            // Try to determine type from icons or classes
            const classes = (item as any).className || "";
            const hasUrlIcon = classes.includes("link") || classes.includes("web") ||
                              text.includes("http") || text.includes(".com");
            const hasFileIcon = classes.includes("file") || classes.includes("pdf") ||
                               classes.includes("doc");
            const hasDriveIcon = classes.includes("drive") || classes.includes("google");

            let type = "unknown";
            if (hasUrlIcon) type = "url";
            else if (hasFileIcon) type = "file";
            else if (hasDriveIcon) type = "drive";
            else type = "text";

            // Check for status indicators
            const hasError = classes.includes("error") || classes.includes("failed");
            const hasProcessing = classes.includes("processing") || classes.includes("loading");

            let status = "ready";
            if (hasError) status = "failed";
            else if (hasProcessing) status = "processing";

            results.push({
              id: `source-${i}`,
              title: text.substring(0, 100),
              type,
              status,
            });
          }

          // If we found items with this selector, stop searching
          if (results.length > 0) break;
        }

        return results;
      });

      log.success(`  ✅ Found ${sources.length} sources`);

      return {
        sources,
        count: sources.length,
        notebookUrl,
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Add a source to an existing notebook
   */
  async addSource(notebookUrl: string, source: NotebookSource): Promise<AddSourceResult> {
    log.info(`➕ Adding source to: ${notebookUrl}`);
    log.info(`   Type: ${source.type}, Value: ${source.value.substring(0, 50)}...`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Check if source dialog is already open (new/empty notebooks may auto-open it)
      const dialogAlreadyOpen = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const uploadDialog = document.querySelector('upload-dialog, .cdk-overlay-container mat-dialog-container');
        // @ts-expect-error - DOM types
        const dropzone = document.querySelector('.dropzone__file-dialog-button, span[xapscottyuploadertrigger]');
        return !!(uploadDialog || dropzone);
      });

      if (dialogAlreadyOpen) {
        log.info("  📋 Source dialog already open");
      } else {
        // Click "Add source" button to open dialog
        log.info("  Opening source dialog...");
        const addSourceBtn = await page.$(NOTEBOOKLM_SELECTORS.addSourceButton.primary);
        if (!addSourceBtn) {
          // Try fallbacks
          for (const fallback of NOTEBOOKLM_SELECTORS.addSourceButton.fallbacks) {
            const btn = await page.$(fallback);
            if (btn) {
              await btn.click();
              break;
            }
          }
        } else {
          await addSourceBtn.click();
        }
        await randomDelay(1000, 1500);
      }

      // Handle based on source type
      if (source.type === "url") {
        await this.addUrlSourceInternal(page, source.value);
      } else if (source.type === "text") {
        await this.addTextSourceInternal(page, source.value, source.title);
      } else if (source.type === "file") {
        await this.addFileSourceInternal(page, source.value);
      } else {
        throw new Error(`Unsupported source type: ${source.type}`);
      }

      // Wait for processing
      await this.waitForSourceProcessing(page);

      log.success(`  ✅ Source added successfully`);

      return {
        success: true,
        source: {
          id: `source-new-${Date.now()}`,
          title: source.title || source.value.substring(0, 50),
          type: source.type,
          status: "ready",
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`  ❌ Failed to add source: ${msg}`);
      return {
        success: false,
        error: msg,
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Remove a source from a notebook
   */
  async removeSource(notebookUrl: string, sourceId: string): Promise<RemoveSourceResult> {
    log.info(`🗑️ Removing source ${sourceId} from: ${notebookUrl}`);

    const page = await this.navigateToNotebook(notebookUrl);

    try {
      // Find the source item by index (sourceId format: "source-0", "source-1", etc.)
      const indexMatch = sourceId.match(/source-(\d+)/);
      if (!indexMatch) {
        throw new Error(`Invalid source ID format: ${sourceId}`);
      }
      const sourceIndex = parseInt(indexMatch[1], 10);

      // Find and click on the source to select it
      const clicked = await page.evaluate((index: number) => {
        const sourceSelectors = [
          'mat-list-item',
          '[class*="source-item"]',
          '[role="listitem"]',
        ];

        for (const selector of sourceSelectors) {
          // @ts-expect-error - DOM types
          const items = document.querySelectorAll(selector);
          if (items.length > index) {
            // Look for delete button within the item or select it
            const item = items[index];

            // Try to find delete button
            const deleteBtn = (item as any).querySelector(
              '[aria-label*="delete" i], [aria-label*="remove" i], button[class*="delete"]'
            );

            if (deleteBtn) {
              deleteBtn.click();
              return "deleted";
            }

            // Otherwise click the item to select it
            (item as any).click();
            return "selected";
          }
        }
        return null;
      }, sourceIndex);

      if (!clicked) {
        throw new Error(`Source not found at index ${sourceIndex}`);
      }

      if (clicked === "selected") {
        // Look for delete button in toolbar or context menu
        await randomDelay(500, 800);

        const deleted = await page.evaluate(() => {
          // Look for delete button that appeared after selection
          const deleteSelectors = [
            'button[aria-label*="delete" i]',
            'button[aria-label*="remove" i]',
            '[class*="delete"]',
            '[class*="trash"]',
          ];

          for (const selector of deleteSelectors) {
            // @ts-expect-error - DOM types
            const btn = document.querySelector(selector);
            if (btn && (btn as any).offsetParent !== null) {
              (btn as any).click();
              return true;
            }
          }
          return false;
        });

        if (!deleted) {
          throw new Error("Could not find delete button after selecting source");
        }
      }

      // Confirm deletion if dialog appears
      await randomDelay(500, 800);
      await page.evaluate(() => {
        // Look for confirm button in dialog
        // @ts-expect-error - DOM types
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn as any).textContent?.toLowerCase() || "";
          if (text.includes("delete") || text.includes("remove") || text.includes("confirm")) {
            (btn as any).click();
            return true;
          }
        }
        return false;
      });

      await randomDelay(1000, 1500);

      log.success(`  ✅ Source removed successfully`);

      return {
        success: true,
        removedId: sourceId,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`  ❌ Failed to remove source: ${msg}`);
      return {
        success: false,
        error: msg,
      };
    } finally {
      await this.closePage();
    }
  }

  /**
   * Internal: Add URL source
   */
  private async addUrlSourceInternal(page: Page, url: string): Promise<void> {
    // Click URL/Website option
    const urlOptionClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button, [role='button'], mat-chip");
      for (const btn of buttons) {
        const text = (btn as any).textContent?.toLowerCase() || "";
        const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
        if (text.includes("website") || text.includes("url") || text.includes("link") ||
            aria.includes("website") || aria.includes("discover")) {
          (btn as any).click();
          return true;
        }
      }
      return false;
    });

    if (!urlOptionClicked) {
      throw new Error("Could not find URL/Website source option");
    }

    await randomDelay(800, 1200);

    // Find and fill URL input
    const urlInput = await page.$('input[type="url"], input[type="text"][placeholder*="URL" i], input[placeholder*="http" i]');
    if (!urlInput) {
      throw new Error("Could not find URL input field");
    }

    await humanType(page, 'input[type="url"], input[type="text"]', url);
    await randomDelay(500, 800);

    // Submit
    await page.keyboard.press("Enter");
  }

  /**
   * Internal: Add text source
   */
  private async addTextSourceInternal(page: Page, text: string, _title?: string): Promise<void> {
    // Click text/paste option
    const textOptionClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button, [role='button'], mat-chip");
      for (const btn of buttons) {
        const btnText = (btn as any).textContent?.toLowerCase() || "";
        const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
        if (btnText.includes("copied text") || btnText.includes("paste") || btnText.includes("text") ||
            aria.includes("copied") || aria.includes("paste")) {
          (btn as any).click();
          return true;
        }
      }
      return false;
    });

    if (!textOptionClicked) {
      throw new Error("Could not find text/paste source option");
    }

    await randomDelay(800, 1200);

    // Fill text area
    const textArea = await page.$(NOTEBOOKLM_SELECTORS.textInput.primary);
    if (!textArea) {
      throw new Error("Could not find text input area");
    }

    // Use clipboard for large text
    if (text.length > 500) {
      await page.evaluate((t: string) => {
        // @ts-expect-error - navigator available in browser context
        navigator.clipboard.writeText(t);
      }, text);
      await textArea.focus();
      await page.keyboard.down("Control");
      await page.keyboard.press("v");
      await page.keyboard.up("Control");
    } else {
      await humanType(page, NOTEBOOKLM_SELECTORS.textInput.primary, text);
    }

    await randomDelay(500, 800);

    // Click Insert button
    const insertClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn as any).textContent?.toLowerCase() || "";
        if (text.includes("insert") || text.includes("add") || text.includes("submit")) {
          (btn as any).click();
          return true;
        }
      }
      return false;
    });

    if (!insertClicked) {
      throw new Error("Could not find Insert button");
    }
  }

  /**
   * Internal: Add file source
   * December 2025: NotebookLM uses a dropzone with hidden file input
   */
  private async addFileSourceInternal(page: Page, filePath: string): Promise<void> {
    log.info("  Attempting file upload...");

    // Method 1: Try to use setInputFiles directly on any file input
    // This works even on hidden inputs and bypasses click interception
    try {
      await page.setInputFiles('input[type="file"]', filePath);
      log.info("  File uploaded via direct setInputFiles");
      await randomDelay(500, 1000);
      return;
    } catch (e) {
      log.info(`  Direct setInputFiles failed: ${e}`);
    }

    // Method 2: Click using JavaScript to bypass Playwright overlay checks
    log.info("  Trying JavaScript click on choose file button...");
    const jsClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const btn = document.querySelector('span.dropzone__file-dialog-button');
      if (btn) {
        (btn as any).click();
        return true;
      }
      // @ts-expect-error - DOM types
      const btn2 = document.querySelector('span[xapscottyuploadertrigger]');
      if (btn2) {
        (btn2 as any).click();
        return true;
      }
      return false;
    });

    if (jsClicked) {
      await randomDelay(500, 800);
      try {
        await page.setInputFiles('input[type="file"]', filePath);
        log.info("  File uploaded via JS click + setInputFiles");
        await randomDelay(500, 1000);
        return;
      } catch (e) {
        log.info(`  setInputFiles after JS click failed: ${e}`);
      }
    }

    // Method 3: Try drag and drop simulation
    log.info("  Trying drag-drop simulation...");
    const fileInputExists = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      return !!document.querySelector('input[type="file"]');
    });

    if (fileInputExists) {
      try {
        // Use locator for more robust handling
        const fileInput = page.locator('input[type="file"]');
        await fileInput.setInputFiles(filePath);
        log.info("  File uploaded via locator setInputFiles");
        await randomDelay(500, 1000);
        return;
      } catch (e) {
        log.info(`  Locator setInputFiles failed: ${e}`);
      }
    }

    throw new Error("Could not upload file - all methods failed");
  }

  /**
   * Wait for source processing to complete
   */
  private async waitForSourceProcessing(page: Page, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const isProcessing = await page.evaluate(() => {
        // Look for processing indicators
        // @ts-expect-error - DOM types
        const progressBar = document.querySelector('[role="progressbar"]');
        // @ts-expect-error - DOM types
        const spinner = document.querySelector('[class*="spinner"], [class*="loading"]');
        return !!(progressBar || spinner);
      });

      if (!isProcessing) {
        return;
      }

      await page.waitForTimeout(1000);
    }

    log.warning("  ⚠️ Source processing timeout - continuing anyway");
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
