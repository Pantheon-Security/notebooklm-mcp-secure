/**
 * Source Manager
 *
 * Manages sources within NotebookLM notebooks (list, add, remove).
 */

import type { Page } from "patchright";
import * as fs from "fs";
import * as path from "path";
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
      // Wait for page to fully load and stabilize
      log.info("  Waiting for page to load...");
      try {
        await page.waitForLoadState('networkidle', { timeout: 15000 });
      } catch {
        log.warning("  Network idle timeout, continuing...");
      }
      await randomDelay(3000, 4000);

      // Check page state
      const pageState = await page.evaluate(() => {
        // @ts-expect-error - DOM types in evaluate
        const addSourceBtn = document.querySelector('button[aria-label="Add source"]');
        // @ts-expect-error - window in evaluate
        return { hasAddSourceBtn: !!addSourceBtn, windowWidth: window.innerWidth };
      });
      log.dim(`  Page state: width=${pageState.windowWidth}, addSourceBtn=${pageState.hasAddSourceBtn}`);

      // Check if source dialog is already open (new/empty notebooks may auto-open it)
      const dialogAlreadyOpen = await page.evaluate(() => {
        // Check for dropzone (file upload area) - most reliable indicator
        // @ts-expect-error - DOM types
        const dropzone = document.querySelector('.dropzone__file-dialog-button, span[xapscottyuploadertrigger]');
        // Check for source type options in dialog
        // @ts-expect-error - DOM types
        const sourceOptions = document.querySelector('[aria-label="Upload sources from your computer"]');
        return !!(dropzone || sourceOptions);
      });

      if (dialogAlreadyOpen) {
        log.info("  📋 Source dialog already open");
      } else {
        // Click "Add source" button to open dialog using Playwright locator
        log.info("  Opening source dialog...");

        // Try both singular and plural aria-labels (NotebookLM uses "Add source" singular)
        let clicked = false;
        const singularLocator = page.locator('button[aria-label="Add source"]');
        if (await singularLocator.count() > 0 && await singularLocator.first().isVisible()) {
          await singularLocator.first().click();
          log.info("  Clicked 'Add source' button (singular)");
          clicked = true;
        }

        if (!clicked) {
          const pluralLocator = page.locator('button[aria-label="Add sources"]');
          if (await pluralLocator.count() > 0 && await pluralLocator.first().isVisible()) {
            await pluralLocator.first().click();
            log.info("  Clicked 'Add sources' button (plural)");
            clicked = true;
          }
        }

        if (!clicked) {
          // Try class selector as fallback
          const classLocator = page.locator('button.add-source-button');
          if (await classLocator.count() > 0 && await classLocator.first().isVisible()) {
            await classLocator.first().click();
            log.info("  Clicked 'Add source' button (class)");
            clicked = true;
          }
        }

        if (!clicked) {
          throw new Error("Could not find 'Add source' button");
        }

        await randomDelay(1500, 2000);

        // Verify dialog opened
        const dialogOpened = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const dropzone = document.querySelector('.dropzone__file-dialog-button, span[xapscottyuploadertrigger]');
          // @ts-expect-error - DOM types
          const sourceOptions = document.querySelector('[aria-label="Upload sources from your computer"]');
          return !!(dropzone || sourceOptions);
        });

        if (!dialogOpened) {
          log.warning("  ⚠️ Dialog may not have opened, retrying...");
          await randomDelay(1000, 1500);
        }
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
   * December 2025: NotebookLM creates a hidden input[type="file"] AFTER clicking
   * the "choose file" button. The key is: click first, then find the input.
   */
  private async addFileSourceInternal(page: Page, filePath: string): Promise<void> {
    log.info("  Attempting file upload...");

    // Validate and resolve path
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    // Method 1 (PRIMARY): Use Playwright's real click on "choose file" button
    // CRITICAL: Angular blocks JavaScript element.click() - must use Playwright's click()
    log.info("  Using Playwright click on 'choose file' button...");

    try {
      // Try the "choose file" span first (most specific)
      const chooseFileLocator = page.locator('span.dropzone__file-dialog-button');
      if (await chooseFileLocator.count() > 0 && await chooseFileLocator.first().isVisible()) {
        await chooseFileLocator.first().click();
        log.info("  Clicked 'choose file' span with Playwright");

        // Wait for the file input to appear (it's created dynamically after real click)
        // Note: The input has display:none, so use state:'attached' not 'visible'
        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        // Now set the file on the newly created input
        const fileInputLocator = page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via Playwright click + setInputFiles");
        await randomDelay(500, 1000);
        return;
      }

      // Try the xapscotty trigger button
      const xapscottyLocator = page.locator('[xapscottyuploadertrigger]');
      if (await xapscottyLocator.count() > 0 && await xapscottyLocator.first().isVisible()) {
        await xapscottyLocator.first().click();
        log.info("  Clicked xapscotty trigger with Playwright");

        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        const fileInputLocator = page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via xapscotty click + setInputFiles");
        await randomDelay(500, 1000);
        return;
      }

      // Try the upload icon button
      const uploadBtnLocator = page.locator('button[aria-label="Upload sources from your computer"]');
      if (await uploadBtnLocator.count() > 0 && await uploadBtnLocator.first().isVisible()) {
        await uploadBtnLocator.first().click();
        log.info("  Clicked upload button with Playwright");

        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        const fileInputLocator = page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via upload button click + setInputFiles");
        await randomDelay(500, 1000);
        return;
      }
    } catch (e) {
      log.info(`  Playwright click approach: ${e}`);
    }

    // Method 2: Try filechooser event with Playwright click (fallback)
    log.info("  Trying filechooser event approach...");
    try {
      // Set up file chooser listener BEFORE clicking
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });

      // Click using Playwright's real click (not JavaScript click!)
      const chooseFileLocator = page.locator('span.dropzone__file-dialog-button');
      if (await chooseFileLocator.count() > 0) {
        await chooseFileLocator.first().click();
      }

      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(absolutePath);
      log.success("  ✅ File uploaded via filechooser event");
      await randomDelay(500, 1000);
      return;
    } catch (e) {
      log.info(`  Filechooser approach: ${e}`);
    }

    // Method 3: Try existing input[type="file"] directly (in case it already exists)
    try {
      const fileInputLocator = page.locator('input[type="file"]');
      const count = await fileInputLocator.count();
      if (count > 0) {
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via existing locator");
        await randomDelay(500, 1000);
        return;
      }
    } catch (e) {
      log.info(`  Existing locator attempt: ${e}`);
    }

    throw new Error("Could not upload file - all methods failed. NotebookLM may be using an unsupported upload method.");
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
