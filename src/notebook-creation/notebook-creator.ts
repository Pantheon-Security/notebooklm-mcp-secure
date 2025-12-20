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
import { log } from "../utils/logger.js";
import { randomDelay, humanType, realisticClick } from "../utils/stealth-utils.js";
import { CONFIG } from "../config.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import fs from "fs";
import path from "path";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

/**
 * Creates NotebookLM notebooks with sources
 */
export class NotebookCreator {
  private page: Page | null = null;

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager
  ) {}

  /**
   * Create a new notebook with sources
   */
  async createNotebook(options: CreateNotebookOptions): Promise<CreatedNotebook> {
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

    // Wait for page to be ready
    await this.page.waitForLoadState("networkidle").catch(() => {});

    log.success("✅ Browser initialized and navigated to NotebookLM");
  }

  /**
   * Click the "New notebook" button
   */
  private async clickNewNotebook(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("📝 Clicking 'New notebook' button...");

    // Try to find and click the new notebook button
    const selectors = getSelectors("newNotebookButton");

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await realisticClick(this.page, selector, true);
          await randomDelay(1000, 2000);
          log.success("✅ Clicked 'New notebook' button");
          return;
        }
      } catch {
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
      } catch {
        continue;
      }
    }

    throw new Error("Could not find 'New notebook' button");
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
      } catch {
        continue;
      }
    }
  }

  /**
   * Add a source to the notebook
   */
  private async addSource(source: NotebookSource): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    // Check if source dialog is already open (happens for new notebooks)
    const dialogAlreadyOpen = await this.isSourceDialogOpen();

    if (!dialogAlreadyOpen) {
      // Click "Add source" button only if dialog isn't already open
      await this.clickAddSource();
    } else {
      log.info("📋 Source dialog already open");
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
  }

  /**
   * Check if the source dialog is already open
   */
  private async isSourceDialogOpen(): Promise<boolean> {
    if (!this.page) return false;

    // Check for source dialog indicators
    const dialogIndicators = await this.page.evaluate(() => {
      // @ts-expect-error - DOM types
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = (span as any).textContent?.trim() || "";
        // These texts only appear when the source dialog is open
        if (text === "Copied text" || text === "Website" || text === "Discover sources") {
          return true;
        }
      }
      return false;
    });

    return dialogIndicators;
  }

  /**
   * Click the "Add source" button
   */
  private async clickAddSource(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    log.info("📎 Clicking 'Add source' button...");

    const selectors = getSelectors("addSourceButton");

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await realisticClick(this.page, selector, true);
          await randomDelay(800, 1500);
          log.success("✅ Clicked 'Add source' button");
          return;
        }
      } catch {
        continue;
      }
    }

    // Fallback: look for any "add" button via evaluate (since :has-text() isn't supported)
    const addPatterns = ["Add source", "Add", "Upload", "+"];

    for (const pattern of addPatterns) {
      try {
        const clicked = await this.page.evaluate((searchText) => {
          // @ts-expect-error - DOM types
          const elements = document.querySelectorAll('button, [role="button"]');
          for (const el of elements) {
            const elText = (el as any).textContent?.trim() || "";
            const ariaLabel = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
            // For "+" we need exact match, for others partial match
            if (searchText === "+") {
              if (elText === "+" || ariaLabel.includes("add")) {
                (el as any).click();
                return true;
              }
            } else if (elText.toLowerCase().includes(searchText.toLowerCase()) || ariaLabel.includes(searchText.toLowerCase())) {
              (el as any).click();
              return true;
            }
          }
          return false;
        }, pattern);

        if (clicked) {
          await randomDelay(800, 1500);
          log.success("✅ Clicked 'Add source' button (fallback)");
          return;
        }
      } catch {
        continue;
      }
    }

    throw new Error("Could not find 'Add source' button");
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
      } catch {
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

    // Click "Copied text" option - look for mat-chip or span with exact text
    const textOptionClicked = await this.page.evaluate(() => {
      // First, try to find mat-chip elements (Angular Material chips)
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

    // First try to find file input directly
    let fileInput = await this.page.$('input[type="file"]');
    if (fileInput) {
      await fileInput.setInputFiles(absolutePath);
      await randomDelay(1000, 2000);
      await this.waitForSourceProcessing();
      return;
    }

    // If not found, click on upload option first
    log.info("  Looking for upload option...");
    const uploadClicked = await this.page.evaluate(() => {
      // @ts-expect-error - DOM types
      const elements = document.querySelectorAll("button, [role='button'], span, div[role='button']");
      for (const el of elements) {
        const text = (el as any).textContent?.toLowerCase() || "";
        const aria = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
        if ((text.includes("upload") || text.includes("file") || text.includes("computer") ||
             aria.includes("upload") || aria.includes("file")) &&
            (el as any).offsetParent !== null) {
          (el as any).click();
          return true;
        }
      }
      return false;
    });

    if (uploadClicked) {
      await randomDelay(1000, 1500);
      fileInput = await this.page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(absolutePath);
        await randomDelay(1000, 2000);
        await this.waitForSourceProcessing();
        return;
      }
    }

    throw new Error("Could not find file upload input");
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
      } catch {
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
      } catch {
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

    // Find and click the "Insert" button by text
    const clicked = await this.page.evaluate(() => {
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll('button');
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
        } catch {
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
      } catch {
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
