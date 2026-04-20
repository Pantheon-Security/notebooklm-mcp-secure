/**
 * NotebookLM Notebook Creator
 *
 * Creates notebooks programmatically via browser automation.
 * Supports URL, text, and file sources.
 */

import type { Page } from "patchright";
import type {
  CreateNotebookOptions,
  CreatedNotebook,
  NotebookSource,
  FailedSource,
} from "./types.js";
import { findElement, waitForElement, getSelectors } from "./selectors.js";
import { NotebookCreationError, NotebookCreationErrorCode } from "./errors.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType, realisticClick } from "../utils/stealth-utils.js";
import { CONFIG, NOTEBOOKLM_URL } from "../config.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import fs from "fs";
import path from "path";



/**
 * Creates NotebookLM notebooks with sources
 */
export class NotebookCreator {
  private page: Page | null = null;
  // Serialises concurrent createNotebook calls — prevents interleaved browser ops (I163)
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager
  ) {}

  private async withOperationLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const acquired = new Promise<void>(resolve => { release = resolve; });
    const previous = this.operationQueue;
    this.operationQueue = acquired;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Create a new notebook with sources
   */
  async createNotebook(options: CreateNotebookOptions): Promise<CreatedNotebook> {
    return this.withOperationLock(() => this._createNotebook(options));
  }

  private async _createNotebook(options: CreateNotebookOptions): Promise<CreatedNotebook> {
    const { name, sources, sendProgress } = options;
    const totalSteps = 3 + sources.length; // Init + Create + Sources + Finalize
    let currentStep = 0;

    const failedSources: FailedSource[] = [];
    let successCount = 0;

    try {
      // Step 1: Initialize browser and navigate
      currentStep++;
      await sendProgress?.("Initializing browser...", currentStep, totalSteps);
      await this.initialize(options.browserOptions?.headless);

      // Step 2: Create new notebook
      currentStep++;
      await sendProgress?.("Creating new notebook...", currentStep, totalSteps);
      await this.clickNewNotebook();

      // Wait for notebook to fully load and stabilize
      await randomDelay(3000, 4000);

      // Verify we're on a notebook page
      const createdNotebookUrl = this.page!.url();
      log.info(`📍 Notebook URL after creation: ${createdNotebookUrl}`);
      if (!createdNotebookUrl.includes("/notebook/")) {
        throw new Error("Failed to create notebook - unexpected URL received (check logs for details)");
      }

      // Store the notebook ID for verification later
      const notebookId = createdNotebookUrl.split("/notebook/")[1]?.split("?")[0];
      log.info(`📓 Created notebook ID: ${notebookId}`);

      await this.setNotebookName(name);

      // Step 3+: Add each source
      for (const source of sources) {
        currentStep++;
        const sourceDesc = this.getSourceDescription(source);
        await sendProgress?.(`Adding source: ${sourceDesc}...`, currentStep, totalSteps);

        try {
          await this.addSource(source);
          successCount++;
          log.success(`✅ Added source: ${sourceDesc}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ Failed to add source: ${sourceDesc} - ${errorMsg}`);
          failedSources.push({ source, error: errorMsg });
        }

        // Delay between sources
        await randomDelay(1000, 2000);
      }

      // Step N: Finalize and get URL
      currentStep++;
      await sendProgress?.("Finalizing notebook...", currentStep, totalSteps);
      const notebookUrl = await this.finalizeAndGetUrl();

      log.success(`✅ Notebook created: ${notebookUrl}`);

      return {
        url: notebookUrl,
        name,
        sourceCount: successCount,
        createdAt: new Date().toISOString(),
        failedSources: failedSources.length > 0 ? failedSources : undefined,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Notebook creation failed: ${errorMsg}`);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Initialize browser and navigate to NotebookLM
   */
  private async initialize(headless?: boolean): Promise<void> {
    log.info("🌐 Initializing browser for notebook creation...");

    // Get browser context
    // Note: getOrCreateContext(true) = show browser, getOrCreateContext(false) = headless
    // When browserOptions.headless === false, user wants visible browser, so pass true
    const context = await this.contextManager.getOrCreateContext(
      headless === false ? true : undefined
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

    // Wait for page to be ready
    await this.waitForNotebookReady(this.page);

    log.success("✅ Browser initialized and navigated to NotebookLM");
  }

  private async waitForNotebookReady(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch (error) {
      const pageUrl = this.safePageUrl(page);
      log.warning(
        `Notebook creation waitForLoadState(networkidle) timed out; falling back to load. url=${pageUrl} error=${error instanceof Error ? error.message : String(error)}`
      );
      try {
        await page.waitForLoadState("load", { timeout: 5000 });
      } catch (fallbackError) {
        log.warning(
          `Notebook creation fallback waitForLoadState(load) failed; continuing after fallback timeout. url=${pageUrl} error=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`
        );
      }
    }
  }

  /**
   * Click the "New notebook" button
   */
  private async clickNewNotebook(): Promise<void> {
    if (!this.page) {
      throw new NotebookCreationError("Page not initialized", {
        code: NotebookCreationErrorCode.PAGE_NOT_INITIALIZED,
      });
    }

    log.info("📝 Clicking 'New notebook' button...");

    // Try to find and click the new notebook button
    const selectors = getSelectors("newNotebookButton");
    let lastError: unknown;

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await realisticClick(this.page, selector, true);
          await randomDelay(1000, 2000);
          log.success("✅ Clicked 'New notebook' button");
          return;
        }
      } catch (err) {
        lastError = err;
        log.debug(`notebook-creator: clicking 'New notebook' button selector: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    // Try text-based selectors as fallback via evaluate (since :has-text() isn't supported)
    const textPatterns = ["New notebook", "Create notebook", "Create new", "New"];

    for (const pattern of textPatterns) {
      try {
        const clicked = await this.page.evaluate((searchText) => {
          // @ts-expect-error - DOM types
          const elements = document.querySelectorAll('button, a, [role="button"]');
          for (const el of elements) {
            const elText = (el as any).textContent?.toLowerCase() || "";
            const ariaLabel = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
            if (elText.includes(searchText.toLowerCase()) || ariaLabel.includes(searchText.toLowerCase())) {
              (el as any).click();
              return true;
            }
          }
          return false;
        }, pattern);

        if (clicked) {
          await randomDelay(1000, 2000);
          log.success("✅ Clicked 'New notebook' button (text match)");
          return;
        }
      } catch (err) {
        lastError = err;
        log.debug(`notebook-creator: clicking 'New notebook' button via text pattern: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    throw new NotebookCreationError("Failed to click new notebook", {
      code: NotebookCreationErrorCode.CLICK_NEW_NOTEBOOK_FAILED,
      selector: selectors.join(" | "),
      url: this.safePageUrl(this.page),
      cause: lastError,
    });
  }

  private safePageUrl(page: Page): string {
    try {
      return page.url();
    } catch (err) {
      log.debug(`notebook-creator: reading page URL failed: ${err instanceof Error ? err.message : String(err)}`);
      return "[unavailable]";
    }
  }

  /**
   * Set the notebook name
   */
  private async setNotebookName(name: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info(`📝 Setting notebook name: ${name}`);

    // Wait for and find the name input
    const element = await waitForElement(this.page, "notebookNameInput", {
      timeout: 10000,
    });

    if (!element) {
      // NotebookLM might auto-generate a name - check if we're on the notebook page
      log.warning("⚠️ Name input not found - notebook may have been created with default name");
      return;
    }

    // Type the name
    const selectors = getSelectors("notebookNameInput");
    for (const selector of selectors) {
      try {
        const input = await this.page.$(selector);
        if (input && await input.isVisible()) {
          await humanType(this.page, selector, name, { withTypos: false });
          await randomDelay(500, 1000);
          log.success(`✅ Set notebook name: ${name}`);
          return;
        }
      } catch (err) {
        log.debug(`notebook-creator: typing notebook name into input selector: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
  }

  /**
   * Add a source to the notebook
   */
  private async addSource(source: NotebookSource): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    // CRITICAL: Track the notebook URL to detect accidental navigation
    const expectedNotebookUrl = this.page.url();
    log.info(`📍 Current notebook URL: ${expectedNotebookUrl}`);

    // Check if source dialog is already open (happens for new notebooks)
    const dialogAlreadyOpen = await this.isSourceDialogOpen();
    log.info(`📋 Source dialog already open: ${dialogAlreadyOpen}`);

    if (!dialogAlreadyOpen) {
      // Click "Add source" button only if dialog isn't already open
      await this.clickAddSource();

      // Verify we didn't accidentally navigate away
      const currentUrl = this.page.url();
      if (!currentUrl.includes("/notebook/") ||
          (expectedNotebookUrl.includes("/notebook/") &&
           !currentUrl.includes(expectedNotebookUrl.split("/notebook/")[1]?.split("?")[0] || ""))) {
        log.error(`❌ URL changed unexpectedly! Expected: ${expectedNotebookUrl}, Got: ${currentUrl}`);
        throw new Error(`Navigation error: accidentally navigated away from notebook. This may indicate clicking wrong button.`);
      }
    } else {
      log.info("📋 Source dialog already open - skipping clickAddSource");
    }

    // Handle based on source type
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

    // Verify we're still on the same notebook after adding source
    const finalUrl = this.page.url();
    log.info(`📍 URL after adding source: ${finalUrl}`);
  }

  /**
   * Check if the source dialog is already open
   */
  private async isSourceDialogOpen(): Promise<boolean> {
    if (!this.page) return false;

    // Check for source dialog indicators
    const dialogIndicators = await this.page.evaluate(() => {
      // Method 0: Structural check — any visible mat-dialog-container means a dialog is open
      // Locale-independent (class name, not translated text)
      // @ts-expect-error - DOM types
      const dialogs = document.querySelectorAll("mat-dialog-container");
      for (const d of dialogs) {
        if ((d as any).offsetParent !== null && d.textContent?.trim()) {
          return { open: true, reason: "dialog_container_visible" };
        }
      }

      // Method 1: Check for source type chip group (locale-independent structural check)
      // @ts-expect-error - DOM types
      const chipGroup = document.querySelector("mat-chip-listbox, mat-chip-group, mat-chip-set");
      if (chipGroup && (chipGroup as any).offsetParent !== null) {
        return { open: true, reason: "chip_group_visible" };
      }

      // Method 2: Check for file upload dropzone (initial notebook state, locale-independent)
      // @ts-expect-error - DOM types
      const dropzones = document.querySelectorAll('.dropzone, [class*="dropzone"]');
      if (dropzones.length > 0) {
        for (const dz of dropzones) {
          if ((dz as any).offsetParent !== null) {
            return { open: true, reason: "dropzone_visible" };
          }
        }
      }

      // Method 3: Check for file upload button (locale-independent: class/type, not text)
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

  /**
   * Click the "Add source" button
   */
  private async clickAddSource(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("📎 Clicking 'Add source' button...");

    const debugEnabled = process.env.DEBUG === "true";

    if (debugEnabled) {
      // Log current URL to see if we're on the notebook page
      const currentUrl = this.page.url();
      log.dim(`  Current URL: ${currentUrl}`);
    }

    // Wait for page to settle and for any animations/updates to complete
    await randomDelay(2000, 3000);

    // DOM enumeration is expensive and may leak user-visible button text into
    // logs (notebook/source titles). Only dump when DEBUG=true.
    if (debugEnabled) {
      const buttonsInfo = await this.page.evaluate(() => {
        // @ts-expect-error - DOM types
        const buttons = document.querySelectorAll('button, [role="button"]');
        const info: Array<{text: string, aria: string, class: string, visible: boolean}> = [];
        for (const btn of buttons) {
          const text = (btn as any).textContent?.trim().substring(0, 50) || "";
          const aria = (btn as any).getAttribute("aria-label") || "";
          const cls = (btn as any).className?.substring(0, 50) || "";
          const visible = (btn as any).offsetParent !== null;
          // Only include buttons with relevant content
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

    // Method 1: Use Playwright locator with aria-label (try both singular and plural)
    try {
      // Try singular first
      let addSourceLocator = this.page.locator('button[aria-label="Add source"]');
      let count = await addSourceLocator.count();
      log.info(`  Method 1a: Found ${count} button(s) with aria-label="Add source"`);

      // Try plural if singular not found
      if (count === 0) {
        addSourceLocator = this.page.locator('button[aria-label="Add sources"]');
        count = await addSourceLocator.count();
        log.info(`  Method 1b: Found ${count} button(s) with aria-label="Add sources"`);
      }

      if (count > 0) {
        const isVisible = await addSourceLocator.first().isVisible();
        log.info(`  Method 1: First button visible: ${isVisible}`);
        if (isVisible) {
          await addSourceLocator.first().click();
          await randomDelay(800, 1500);
          log.success("✅ Clicked 'Add source' button (locator)");
          return;
        }
      }
    } catch (e) {
      log.info(`  Locator approach failed: ${e}`);
    }

    // Method 2: Use class selector
    try {
      const classLocator = this.page.locator('button.add-source-button');
      const count = await classLocator.count();
      log.info(`  Method 2: Found ${count} button(s) with class add-source-button`);
      if (count > 0) {
        const isVisible = await classLocator.first().isVisible();
        log.info(`  Method 2: First button visible: ${isVisible}`);
        if (isVisible) {
          await classLocator.first().click();
          await randomDelay(800, 1500);
          log.success("✅ Clicked 'Add source' button (class)");
          return;
        }
      }
    } catch (e) {
      log.info(`  Class selector failed: ${e}`);
    }

    // Method 3: Fallback using page.evaluate with JavaScript click
    try {
      const clicked = await this.page.evaluate(() => {
        // @ts-expect-error - DOM types
        const elements = document.querySelectorAll('button, [role="button"]');
        for (const el of elements) {
          const elText = (el as any).textContent?.trim().toLowerCase() || "";
          const ariaLabel = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
          const className = (el as any).className?.toLowerCase() || "";

          // Skip if this is a "Create notebook" or "Add note" button
          // Check BOTH aria-label AND text content for "create" to avoid clicking wrong button
          if (ariaLabel.includes("create") || className.includes("create-notebook") ||
              elText.includes("create") || elText.includes("add note") ||
              className.includes("add-note")) {
            continue;
          }

          // Match "Add source" or "Add sources" specifically
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
      log.debug(`notebook-creator: clicking 'Add source' button via JS fallback: ${err instanceof Error ? err.message : String(err)}`);
      // Continue to error
    }

    // If we get here, button wasn't found. Try waiting and retrying once more.
    log.warning("⚠️ Add source button not found, waiting and retrying...");
    await randomDelay(3000, 4000);

    // Final retry with Method 1 (try both singular and plural)
    try {
      let addSourceLocator = this.page.locator('button[aria-label="Add source"]');
      let count = await addSourceLocator.count();
      log.info(`  Retry: Found ${count} button(s) with aria-label="Add source"`);

      if (count === 0) {
        addSourceLocator = this.page.locator('button[aria-label="Add sources"]');
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

  /**
   * Add a URL source
   */
  private async addUrlSource(url: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info(`🔗 Adding URL source: ${url}`);

    // Click "Website" option - discovered as span with "Website" text
    await this.clickSourceTypeByText(["Website", "webWebsite", "Link", "Discover sources"]);

    // Find and fill URL input
    await randomDelay(500, 1000);
    const selectors = getSelectors("urlInput");

    for (const selector of selectors) {
      try {
        const input = await this.page.$(selector);
        if (input && await input.isVisible()) {
          await humanType(this.page, selector, url, { withTypos: false });
          await randomDelay(500, 1000);

          // Submit
          await this.clickSubmitButton();
          await this.waitForSourceProcessing();
          return;
        }
      } catch (err) {
        log.debug(`notebook-creator: entering URL into source input selector: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    throw new Error("Could not find URL input field");
  }

  /**
   * Add a text source
   */
  private async addTextSource(text: string, title?: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info(`📝 Adding text source${title ? `: ${title}` : ""}`);

    // Click "Copied text" source type chip.
    // NOTE: This chip label is locale-dependent ("Texte copié" in French etc.).
    // We try locale-independent data attributes first, then fall back to English text.
    const textOptionClicked = await this.page.evaluate(() => {
      // Primary: data attribute (locale-independent, if NotebookLM uses stable data-type values)
      // @ts-expect-error - DOM types
      const byData = document.querySelector('[data-source-type="text"], [data-type="text"], mat-chip[value="text"]') as any;
      if (byData) {
        byData.click();
        return { clicked: true, method: "data-attr", text: byData.textContent?.substring(0, 30) };
      }

      // Fallback: text match (English only — may miss French/other locales)
      // @ts-expect-error - DOM types
      const chips = document.querySelectorAll('mat-chip, mat-chip-option, [mat-chip-option]');
      for (const chip of chips) {
        const text = (chip as any).textContent?.trim() || "";
        if (text.includes("Copied text")) {
          (chip as any).click();
          return { clicked: true, method: "mat-chip", text: text.substring(0, 30) };
        }
      }

      // Fallback: find span with exact text and click its closest clickable ancestor
      // @ts-expect-error - DOM types
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = (span as any).textContent?.trim() || "";
        if (text === "Copied text") {
          // Try to find clickable parent (mat-chip, button, or div with click handler)
          let target = span as any;
          for (let i = 0; i < 5; i++) {
            if (target.parentElement) {
              target = target.parentElement;
              const tagName = target.tagName?.toLowerCase();
              if (tagName === "mat-chip" || tagName === "mat-chip-option" || tagName === "button") {
                target.click();
                return { clicked: true, method: "parent-" + tagName };
              }
            }
          }
          // If no good parent, just click the span
          (span as any).click();
          return { clicked: true, method: "span-direct" };
        }
      }
      return { clicked: false };
    });
    if (!textOptionClicked.clicked) {
      log.warning("⚠️ Could not click 'Copied text' option");
    }

    // Wait for text area to appear
    await randomDelay(2000, 2500);

    // Find the text area - discovered as textarea.text-area
    const textarea = await this.page.$('textarea.text-area') ||
                     await this.page.$('textarea[class*="text-area"]') ||
                     await this.page.$('textarea.mat-mdc-form-field-textarea-control');

    if (textarea) {
      const isVisible = await textarea.isVisible().catch(() => false);

      if (!isVisible) {
        // Try waiting a bit more
        await randomDelay(1000, 1500);
      }

      // Click to focus
      await textarea.click();
      await randomDelay(200, 400);

      // For large text, use clipboard paste instead of typing
      if (text.length > 500) {
        await this.page.evaluate((t) => {
          // @ts-expect-error - DOM types available in browser context
          navigator.clipboard.writeText(t);
        }, text);
        await this.page.keyboard.press("Control+V");
      } else {
        // Type the text
        await textarea.fill(text);
      }

      await randomDelay(500, 1000);

      // Click "Insert" button
      await this.clickInsertButton();

      // Wait for processing but be lenient with errors
      await this.waitForSourceProcessingLenient();
      return;
    }

    throw new Error("Could not find text input area");
  }

  /**
   * Add a file source
   * December 2025: NotebookLM creates a hidden input[type="file"] AFTER clicking
   * the "choose file" button. CRITICAL: Must use Playwright's real click (not JS click)
   * because Angular blocks programmatic JavaScript clicks on the upload trigger.
   */
  private async addFileSource(filePath: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    // Validate file exists
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    log.info(`📁 Adding file source: ${path.basename(absolutePath)}`);

    await randomDelay(500, 1000);

    // Method 1 (PRIMARY): Use Playwright's real click on "choose file" button
    // CRITICAL: Angular blocks JavaScript element.click() - must use Playwright's click()
    log.info("  Using Playwright click on 'choose file' button...");
    try {
      // Try clicking the "choose file" span using Playwright's real click
      const chooseFileLocator = this.page.locator('span.dropzone__file-dialog-button');
      if (await chooseFileLocator.count() > 0 && await chooseFileLocator.first().isVisible()) {
        await chooseFileLocator.first().click();
        log.info("  Clicked 'choose file' span with Playwright");

        // Wait for the file input to appear (it's created dynamically after real click)
        // Note: The input has display:none, so use state:'attached' not 'visible'
        await this.page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        // Now set the file on the newly created input
        const fileInputLocator = this.page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via Playwright click + setInputFiles");
        await randomDelay(1000, 2000);
        // Use lenient processing check for file uploads (avoids false positive error detection)
        await this.waitForSourceProcessingLenient();
        return;
      }

      // Try the xapscotty trigger button
      const xapscottyLocator = this.page.locator('[xapscottyuploadertrigger]');
      if (await xapscottyLocator.count() > 0 && await xapscottyLocator.first().isVisible()) {
        await xapscottyLocator.first().click();
        log.info("  Clicked xapscotty trigger with Playwright");

        await this.page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        const fileInputLocator = this.page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via xapscotty click + setInputFiles");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }

      // Try the upload icon button (class-based first for locale-independence, then English aria-label)
      const uploadBtnLocator = this.page.locator(
        'button[class*="upload"], button[aria-label="Upload sources from your computer"]'
      );
      if (await uploadBtnLocator.count() > 0 && await uploadBtnLocator.first().isVisible()) {
        await uploadBtnLocator.first().click();
        log.info("  Clicked upload button with Playwright");

        await this.page.waitForSelector('input[type="file"]', { timeout: 5000, state: 'attached' });
        await randomDelay(200, 400);

        const fileInputLocator = this.page.locator('input[type="file"]');
        await fileInputLocator.first().setInputFiles(absolutePath);
        log.success("  ✅ File uploaded via upload button click + setInputFiles");
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessingLenient();
        return;
      }
    } catch (e) {
      log.info(`  Playwright click approach: ${e}`);
    }

    // Method 2: Try filechooser event with Playwright click
    log.info("  Trying filechooser event approach...");
    try {
      // Set up file chooser listener BEFORE clicking
      const fileChooserPromise = this.page.waitForEvent('filechooser', { timeout: 5000 });

      // Click using Playwright's real click
      const chooseFileLocator = this.page.locator('span.dropzone__file-dialog-button');
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

    // Method 3: Try existing input[type="file"] directly (in case it already exists)
    try {
      const fileInputLocator = this.page.locator('input[type="file"]');
      const count = await fileInputLocator.count();
      if (count > 0) {
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

  /**
   * Click a source type by text content (for the new dialog structure)
   */
  private async clickSourceTypeByText(textPatterns: string[]): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    for (const pattern of textPatterns) {
      try {
        const clicked = await this.page.evaluate((searchText) => {
          // @ts-expect-error - DOM types
          const elements = document.querySelectorAll('span, button, [role="button"], div');
          for (const el of elements) {
            const text = (el as any).textContent?.trim() || "";
            // Match exact text or text that contains the pattern
            if (text === searchText || text.toLowerCase().includes(searchText.toLowerCase())) {
              // Make sure it's visible
              if ((el as any).offsetParent !== null) {
                (el as any).click();
                return true;
              }
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
        log.debug(`notebook-creator: clicking source type tab via text pattern: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    log.warning(`⚠️ Could not find source type: ${textPatterns.join(", ")}`);
  }

  /**
   * Click the submit/add button
   */
  private async clickSubmitButton(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    const selectors = getSelectors("submitButton");

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await element.click();
          return;
        }
      } catch (err) {
        log.debug(`notebook-creator: clicking submit button selector: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    // Try pressing Enter as fallback
    await this.page.keyboard.press("Enter");
  }

  /**
   * Click the "Insert" button (for text sources)
   */
  private async clickInsertButton(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    // Find and click the "Insert" button — prefer locale-independent selectors
    const clicked = await this.page.evaluate(() => {
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

    // Fallback: try the general submit button
    log.warning("⚠️ 'Insert' button not found, trying submit button");
    await this.clickSubmitButton();
  }

  /**
   * Wait for source processing to complete
   */
  private async waitForSourceProcessing(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("⏳ Waiting for source processing...");

    const timeout = 60000; // 1 minute timeout
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check for success indicator
      const successElement = await findElement(this.page, "successIndicator");
      if (successElement) {
        log.success("✅ Source processed successfully");
        return;
      }

      // Check for error
      const errorElement = await findElement(this.page, "errorMessage");
      if (errorElement) {
        // @ts-expect-error - innerText exists on element
        const errorText = await errorElement.innerText?.() || "Unknown error";
        throw new Error(`Source processing failed: ${errorText}`);
      }

      // Check if processing indicator is gone
      const processingElement = await findElement(this.page, "processingIndicator");
      if (!processingElement) {
        // No processing indicator and no error - assume success
        await randomDelay(1000, 1500);
        return;
      }

      await this.page.waitForTimeout(1000);
    }

    log.warning("⚠️ Source processing timeout - continuing anyway");
  }

  /**
   * Lenient version of waitForSourceProcessing that ignores false positive errors
   */
  private async waitForSourceProcessingLenient(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("⏳ Waiting for source processing...");

    // Simple approach: wait a fixed time and check if dialog closed
    await randomDelay(3000, 4000);

    // Check if we're back to the main notebook view (no source dialog)
    const dialogStillOpen = await this.isSourceDialogOpen();

    if (!dialogStillOpen) {
      log.success("✅ Source dialog closed - assuming success");
      return;
    }

    // Check for actual error indicators (be specific)
    const hasError = await this.page.evaluate(() => {
      // @ts-expect-error - DOM types
      const alerts = document.querySelectorAll('[role="alert"]');
      for (const alert of alerts) {
        const text = (alert as any).textContent?.toLowerCase() || "";
        // Only treat as error if it contains error-related words
        if (text.includes("error") || text.includes("failed") || text.includes("invalid") || text.includes("unable")) {
          return text.substring(0, 100);
        }
      }
      return null;
    });

    if (hasError) {
      throw new Error(`Source processing failed: ${hasError}`);
    }

    // Wait a bit more for processing
    await randomDelay(2000, 3000);
    log.success("✅ Source processing appears complete");
  }

  /**
   * Finalize notebook creation and get the URL
   */
  private async finalizeAndGetUrl(): Promise<string> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("🔗 Getting notebook URL...");

    // The URL should already be the notebook URL after creation
    await randomDelay(1000, 2000);

    const currentUrl = this.page.url();

    // Check if we're on a notebook page
    if (currentUrl.includes("/notebook/")) {
      return currentUrl;
    }

    // Try to find the notebook URL in the page
    const notebookLinks = await this.page.$$('a[href*="/notebook/"]');
    if (notebookLinks.length > 0) {
      const href = await notebookLinks[0].getAttribute("href");
      if (href) {
        return href.startsWith("http") ? href : `https://notebooklm.google.com${href}`;
      }
    }

    // Return current URL as fallback
    return currentUrl;
  }

  /**
   * Get a human-readable description of a source
   */
  private getSourceDescription(source: NotebookSource): string {
    switch (source.type) {
      case "url":
        try {
          const url = new URL(source.value);
          return `URL: ${url.hostname}`;
        } catch (err) {
          log.debug(`notebook-creator: parsing source URL in getSourceDescription: ${err instanceof Error ? err.message : String(err)}`);
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

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        log.debug(`notebook-creator: closing page in cleanup: ${err instanceof Error ? err.message : String(err)}`);
        // Ignore cleanup errors
      }
      this.page = null;
    }
  }
}

/**
 * Create a notebook with the given options
 */
export async function createNotebook(
  authManager: AuthManager,
  contextManager: SharedContextManager,
  options: CreateNotebookOptions
): Promise<CreatedNotebook> {
  const creator = new NotebookCreator(authManager, contextManager);
  return await creator.createNotebook(options);
}
