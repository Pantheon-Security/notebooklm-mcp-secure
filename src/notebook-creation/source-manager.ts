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
import { NOTEBOOKLM_SELECTORS, findElement, getSelectors } from "./selectors.js";
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
    const context = await this.contextManager.getOrCreateContext();
    const isAuth = await this.authManager.validateWithRetry(context);

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
      } catch (err) {
        log.debug(`source-manager: waiting for network idle after page load: ${err instanceof Error ? err.message : String(err)}`);
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
    // Click URL/Website source type option — prefer locale-independent signals
    const urlOptionClicked = await page.evaluate(() => {
      // Primary: data/value attribute (locale-independent)
      // @ts-expect-error - DOM types
      const byData = document.querySelector('[data-source-type="url"], [value="url"], mat-chip[value="url"]') as any;
      if (byData) {
        byData.click();
        return true;
      }
      // Fallback: text/aria match ("URL" is the same word in most languages)
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button, [role='button'], mat-chip");
      for (const btn of buttons) {
        const text = (btn as any).textContent?.toLowerCase() || "";
        const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
        if (text.includes("url") || aria.includes("url") ||
            text.includes("website") || text.includes("link") || aria.includes("discover")) {
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

    // Click Insert button — prefer locale-independent selectors
    const insertClicked = await page.evaluate(() => {
      // Primary: type=submit (locale-independent)
      // @ts-expect-error - DOM types
      const submitBtn = document.querySelector("button[type='submit']:not([disabled])") as any;
      if (submitBtn && submitBtn.offsetParent !== null) {
        submitBtn.click();
        return true;
      }
      // Secondary: primary color class (locale-independent NotebookLM convention)
      // @ts-expect-error - DOM types
      const primaryBtn = document.querySelector("button.button-color--primary:not([disabled])") as any;
      if (primaryBtn && primaryBtn.offsetParent !== null) {
        primaryBtn.click();
        return true;
      }
      // Fallback: text match (English only)
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
      } catch (err) {
        log.debug(`source-manager: closing page: ${err instanceof Error ? err.message : String(err)}`);
        // Ignore close errors
      }
      this.page = null;
    }
  }
}

export class NotebookCreationSourceManager {
  constructor(private getPage: () => Page | null) {}

  async addSource(source: NotebookSource): Promise<void> {
    const page = this.requirePage();

    const expectedNotebookUrl = page.url();
    log.info(`📍 Current notebook URL: ${expectedNotebookUrl}`);

    const dialogAlreadyOpen = await this.isSourceDialogOpen();
    log.info(`📋 Source dialog already open: ${dialogAlreadyOpen}`);

    if (!dialogAlreadyOpen) {
      await this.clickAddSource();

      const currentUrl = page.url();
      if (!currentUrl.includes("/notebook/") ||
          (expectedNotebookUrl.includes("/notebook/") &&
           !currentUrl.includes(expectedNotebookUrl.split("/notebook/")[1]?.split("?")[0] || ""))) {
        log.error(`❌ URL changed unexpectedly! Expected: ${expectedNotebookUrl}, Got: ${currentUrl}`);
        throw new Error("Navigation error: accidentally navigated away from notebook. This may indicate clicking wrong button.");
      }
    } else {
      log.info("📋 Source dialog already open - skipping clickAddSource");
    }

    switch (source.type) {
      case "url":
        await this.addUrlSource(source.value);
        break;
      case "text":
        await this.addTextSource(source.value, source.title);
        break;
      case "file":
        await this.addFileSource(source.value);
        break;
      default:
        throw new Error(`Unknown source type: ${(source as NotebookSource).type}`);
    }

    log.info(`📍 URL after adding source: ${page.url()}`);
  }

  getSourceDescription(source: NotebookSource): string {
    switch (source.type) {
      case "url":
        try {
          const url = new URL(source.value);
          return `URL: ${url.hostname}`;
        } catch (err) {
          log.debug(`source-manager: parsing source URL in getSourceDescription: ${err instanceof Error ? err.message : String(err)}`);
          return `URL: ${source.value.slice(0, 50)}`;
        }
      case "text":
        return source.title || `Text: ${source.value.slice(0, 30)}...`;
      case "file":
        return `File: ${path.basename(source.value)}`;
      default:
        return "Unknown source";
    }
  }

  private requirePage(): Page {
    const page = this.getPage();
    if (!page) throw new Error("Page not initialized");
    return page;
  }

  private async isSourceDialogOpen(): Promise<boolean> {
    const page = this.getPage();
    if (!page) return false;

    const dialogIndicators = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const dialogs = document.querySelectorAll("mat-dialog-container");
      for (const d of dialogs) {
        if ((d as any).offsetParent !== null && d.textContent?.trim()) {
          return { open: true, reason: "dialog_container_visible" };
        }
      }

      // @ts-expect-error - DOM types
      const chipGroup = document.querySelector("mat-chip-listbox, mat-chip-group, mat-chip-set");
      if (chipGroup && (chipGroup as any).offsetParent !== null) {
        return { open: true, reason: "chip_group_visible" };
      }

      // @ts-expect-error - DOM types
      const dropzones = document.querySelectorAll('.dropzone, [class*="dropzone"]');
      if (dropzones.length > 0) {
        for (const dz of dropzones) {
          if ((dz as any).offsetParent !== null) {
            return { open: true, reason: "dropzone_visible" };
          }
        }
      }

      // @ts-expect-error - DOM types
      const uploadBtn = document.querySelector('button[class*="upload"], input[type="file"]');
      if (uploadBtn && (uploadBtn as any).offsetParent !== null) {
        return { open: true, reason: "upload_button_visible" };
      }

      return { open: false };
    });

    log.info(`📋 isSourceDialogOpen check: ${JSON.stringify(dialogIndicators)}`);
    return dialogIndicators.open;
  }

  private async clickAddSource(): Promise<void> {
    const page = this.requirePage();

    log.info("📎 Clicking 'Add source' button...");
    const debugEnabled = process.env.DEBUG === "true";

    if (debugEnabled) {
      log.dim(`  Current URL: ${page.url()}`);
    }

    await randomDelay(2000, 3000);

    if (debugEnabled) {
      const buttonsInfo = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const buttons = document.querySelectorAll('button, [role="button"]');
        const info: Array<{text: string, aria: string, class: string, visible: boolean}> = [];
        for (const btn of buttons) {
          const text = (btn as any).textContent?.trim().substring(0, 50) || "";
          const aria = (btn as any).getAttribute("aria-label") || "";
          const cls = (btn as any).className?.substring(0, 50) || "";
          const visible = (btn as any).offsetParent !== null;
          if (aria.toLowerCase().includes("add") || aria.toLowerCase().includes("create") ||
              text.toLowerCase().includes("add") || text.toLowerCase().includes("create") ||
              cls.toLowerCase().includes("add") || cls.toLowerCase().includes("create")) {
            info.push({ text, aria, class: cls, visible });
          }
        }
        return info;
      });
      log.dim(`  Buttons found: ${JSON.stringify(buttonsInfo, null, 2)}`);
    }

    try {
      let addSourceLocator = page.locator('button[aria-label="Add source"]');
      let count = await addSourceLocator.count();
      log.info(`  Method 1a: Found ${count} button(s) with aria-label="Add source"`);

      if (count === 0) {
        addSourceLocator = page.locator('button[aria-label="Add sources"]');
        count = await addSourceLocator.count();
        log.info(`  Method 1b: Found ${count} button(s) with aria-label="Add sources"`);
      }

      if (count > 0 && await addSourceLocator.first().isVisible()) {
        await addSourceLocator.first().click();
        await randomDelay(800, 1500);
        log.success("✅ Clicked 'Add source' button (locator)");
        return;
      }
    } catch (e) {
      log.info(`  Locator approach failed: ${e}`);
    }

    try {
      const classLocator = page.locator('button.add-source-button');
      const count = await classLocator.count();
      log.info(`  Method 2: Found ${count} button(s) with class add-source-button`);
      if (count > 0 && await classLocator.first().isVisible()) {
        await classLocator.first().click();
        await randomDelay(800, 1500);
        log.success("✅ Clicked 'Add source' button (class)");
        return;
      }
    } catch (e) {
      log.info(`  Class selector failed: ${e}`);
    }

    try {
      const clicked = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const elements = document.querySelectorAll('button, [role="button"]');
        for (const el of elements) {
          const elText = (el as any).textContent?.trim().toLowerCase() || "";
          const ariaLabel = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
          const className = (el as any).className?.toLowerCase() || "";

          if (ariaLabel.includes("create") || className.includes("create-notebook") ||
              elText.includes("create") || elText.includes("add note") ||
              className.includes("add-note")) {
            continue;
          }

          if (ariaLabel === "add source" || ariaLabel.includes("add source") ||
              elText.includes("add source") || className.includes("add-source")) {
            (el as any).click();
            return { clicked: true, aria: ariaLabel, text: elText.substring(0, 30) };
          }
        }
        return { clicked: false };
      });

      if (clicked.clicked) {
        await randomDelay(800, 1500);
        log.success(`✅ Clicked 'Add source' button (JS fallback) - aria: ${clicked.aria}, text: ${clicked.text}`);
        return;
      }
    } catch (err) {
      log.debug(`source-manager: clicking 'Add source' button via JS fallback: ${err instanceof Error ? err.message : String(err)}`);
    }

    log.warning("⚠️ Add source button not found, waiting and retrying...");
    await randomDelay(3000, 4000);

    try {
      let addSourceLocator = page.locator('button[aria-label="Add source"]');
      let count = await addSourceLocator.count();
      log.info(`  Retry: Found ${count} button(s) with aria-label="Add source"`);

      if (count === 0) {
        addSourceLocator = page.locator('button[aria-label="Add sources"]');
        count = await addSourceLocator.count();
        log.info(`  Retry: Found ${count} button(s) with aria-label="Add sources"`);
      }

      if (count > 0 && await addSourceLocator.first().isVisible()) {
        await addSourceLocator.first().click();
        await randomDelay(800, 1500);
        log.success("✅ Clicked 'Add source' button (retry)");
        return;
      }
    } catch (e) {
      log.info(`  Retry failed: ${e}`);
    }

    throw new Error("Could not find 'Add source' button after retry");
  }

  private async addUrlSource(url: string): Promise<void> {
    const page = this.requirePage();
    log.info(`🔗 Adding URL source: ${url}`);

    await this.clickSourceTypeByText(["Website", "webWebsite", "Link", "Discover sources"]);
    await randomDelay(500, 1000);

    const selectors = getSelectors("urlInput");
    for (const selector of selectors) {
      try {
        const input = await page.$(selector);
        if (input && await input.isVisible()) {
          await humanType(page, selector, url, { withTypos: false });
          await randomDelay(500, 1000);
          await this.clickSubmitButton();
          await this.waitForSourceProcessing();
          return;
        }
      } catch (err) {
        log.debug(`source-manager: entering URL into source input selector: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error("Could not find URL input field");
  }

  private async addTextSource(text: string, title?: string): Promise<void> {
    const page = this.requirePage();
    log.info(`📝 Adding text source${title ? `: ${title}` : ""}`);

    const textOptionClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const byData = document.querySelector('[data-source-type="text"], [data-type="text"], mat-chip[value="text"]') as any;
      if (byData) {
        byData.click();
        return { clicked: true };
      }

      // @ts-expect-error - DOM types
      const chips = document.querySelectorAll('mat-chip, mat-chip-option, [mat-chip-option]');
      for (const chip of chips) {
        const chipText = (chip as any).textContent?.trim() || "";
        if (chipText.includes("Copied text")) {
          (chip as any).click();
          return { clicked: true };
        }
      }

      // @ts-expect-error - DOM types
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const spanText = (span as any).textContent?.trim() || "";
        if (spanText === "Copied text") {
          let target = span as any;
          for (let i = 0; i < 5; i++) {
            if (target.parentElement) {
              target = target.parentElement;
              const tagName = target.tagName?.toLowerCase();
              if (tagName === "mat-chip" || tagName === "mat-chip-option" || tagName === "button") {
                target.click();
                return { clicked: true };
              }
            }
          }
          (span as any).click();
          return { clicked: true };
        }
      }

      return { clicked: false };
    });

    if (!textOptionClicked.clicked) {
      log.warning("⚠️ Could not click 'Copied text' option");
    }

    await randomDelay(2000, 2500);

    const textarea = await page.$('textarea.text-area') ||
                     await page.$('textarea[class*="text-area"]') ||
                     await page.$('textarea.mat-mdc-form-field-textarea-control');

    if (!textarea) {
      throw new Error("Could not find text input area");
    }

    const isVisible = await textarea.isVisible().catch(() => false);
    if (!isVisible) {
      await randomDelay(1000, 1500);
    }

    await textarea.click();
    await randomDelay(200, 400);

    if (text.length > 500) {
      await page.evaluate((clipboardText) => {
        // @ts-expect-error - DOM types available in browser context
        navigator.clipboard.writeText(clipboardText);
      }, text);
      await page.keyboard.press("Control+V");
    } else {
      await textarea.fill(text);
    }

    await randomDelay(500, 1000);
    await this.clickInsertButton();
    await this.waitForSourceProcessingLenient();
  }

  private async addFileSource(filePath: string): Promise<void> {
    const page = this.requirePage();
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    log.info(`📁 Adding file source: ${path.basename(absolutePath)}`);
    await randomDelay(500, 1000);

    try {
      const chooseFileLocator = page.locator('span.dropzone__file-dialog-button');
      if (await chooseFileLocator.count() > 0 && await chooseFileLocator.first().isVisible()) {
        await chooseFileLocator.first().click();
        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);
        await page.locator('input[type="file"]').first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via Playwright click + setInputFiles");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }

      const xapscottyLocator = page.locator('[xapscottyuploadertrigger]');
      if (await xapscottyLocator.count() > 0 && await xapscottyLocator.first().isVisible()) {
        await xapscottyLocator.first().click();
        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);
        await page.locator('input[type="file"]').first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via xapscotty click + setInputFiles");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }

      const uploadBtnLocator = page.locator(
        'button[class*="upload"], button[aria-label="Upload sources from your computer"]'
      );
      if (await uploadBtnLocator.count() > 0 && await uploadBtnLocator.first().isVisible()) {
        await uploadBtnLocator.first().click();
        await page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);
        await page.locator('input[type="file"]').first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via upload button click + setInputFiles");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }
    } catch (e) {
      log.info(`  Playwright click approach: ${e}`);
    }

    try {
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
      const chooseFileLocator = page.locator('span.dropzone__file-dialog-button');
      if (await chooseFileLocator.count() > 0) {
        await chooseFileLocator.first().click();
      }
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(absolutePath);
      log.success("  ✅ File uploaded via filechooser event");
      await randomDelay(1000, 2000);
      await this.waitForSourceProcessingLenient();
      return;
    } catch (e) {
      log.info(`  Filechooser approach: ${e}`);
    }

    try {
      const fileInputLocator = page.locator('input[type="file"]');
      if (await fileInputLocator.count() > 0) {
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via existing locator");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }
    } catch (e) {
      log.info(`  Existing locator attempt: ${e}`);
    }

    throw new Error("Could not upload file - all methods failed. NotebookLM may be using an unsupported upload method.");
  }

  private async clickSourceTypeByText(textPatterns: string[]): Promise<void> {
    const page = this.requirePage();
    for (const pattern of textPatterns) {
      try {
        const clicked = await page.evaluate((searchText) => {
          // @ts-expect-error - DOM types
          const elements = document.querySelectorAll('span, button, [role="button"], div');
          for (const el of elements) {
            const text = (el as any).textContent?.trim() || "";
            if ((text === searchText || text.toLowerCase().includes(searchText.toLowerCase())) &&
                (el as any).offsetParent !== null) {
              (el as any).click();
              return true;
            }
          }
          return false;
        }, pattern);

        if (clicked) {
          log.success(`✅ Clicked source type: ${pattern}`);
          await randomDelay(800, 1200);
          return;
        }
      } catch (err) {
        log.debug(`source-manager: clicking source type tab via text pattern: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log.warning(`⚠️ Could not find source type: ${textPatterns.join(", ")}`);
  }

  private async clickSubmitButton(): Promise<void> {
    const page = this.requirePage();
    const selectors = getSelectors("submitButton");

    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          return;
        }
      } catch (err) {
        log.debug(`source-manager: clicking submit button selector: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await page.keyboard.press("Enter");
  }

  private async clickInsertButton(): Promise<void> {
    const page = this.requirePage();
    const clicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const submitBtn = document.querySelector("button[type='submit']:not([disabled])") as any;
      if (submitBtn && submitBtn.offsetParent !== null) {
        submitBtn.click();
        return true;
      }
      // @ts-expect-error - DOM types
      const primaryBtn = document.querySelector("button.button-color--primary:not([disabled])") as any;
      if (primaryBtn && primaryBtn.offsetParent !== null) {
        primaryBtn.click();
        return true;
      }
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = (btn as any).textContent?.trim() || "";
        if (text === "Insert" || text.toLowerCase() === "insert") {
          (btn as any).click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      log.success("✅ Clicked 'Insert' button");
      return;
    }

    log.warning("⚠️ 'Insert' button not found, trying submit button");
    await this.clickSubmitButton();
  }

  private async waitForSourceProcessing(): Promise<void> {
    const page = this.requirePage();
    log.info("⏳ Waiting for source processing...");

    const timeout = 60000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const successElement = await findElement(page, "successIndicator");
      if (successElement) {
        log.success("✅ Source processed successfully");
        return;
      }

      const errorElement = await findElement(page, "errorMessage");
      if (errorElement) {
        // @ts-expect-error - innerText exists on element
        const errorText = await errorElement.innerText?.() || "Unknown error";
        throw new Error(`Source processing failed: ${errorText}`);
      }

      const processingElement = await findElement(page, "processingIndicator");
      if (!processingElement) {
        await randomDelay(1000, 1500);
        return;
      }

      await page.waitForTimeout(1000);
    }

    log.warning("⚠️ Source processing timeout - continuing anyway");
  }

  private async waitForSourceProcessingLenient(): Promise<void> {
    const page = this.requirePage();
    log.info("⏳ Waiting for source processing...");

    await randomDelay(3000, 4000);
    const dialogStillOpen = await this.isSourceDialogOpen();

    if (!dialogStillOpen) {
      log.success("✅ Source dialog closed - assuming success");
      return;
    }

    const hasError = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const alerts = document.querySelectorAll('[role="alert"]');
      for (const alert of alerts) {
        const text = (alert as any).textContent?.toLowerCase() || "";
        if (text.includes("error") || text.includes("failed") || text.includes("invalid") || text.includes("unable")) {
          return text.substring(0, 100);
        }
      }
      return null;
    });

    if (hasError) {
      throw new Error(`Source processing failed: ${hasError}`);
    }

    await randomDelay(2000, 3000);
    log.success("✅ Source processing appears complete");
  }
}
