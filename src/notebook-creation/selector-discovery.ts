/**
 * Automated UI selector discovery for NotebookLM
 *
 * This tool navigates NotebookLM's interface and discovers CSS selectors
 * for elements needed to create notebooks programmatically.
 */

import type { Page, BrowserContext } from "patchright";
import type { ElementInfo, DiscoveryResult, SelectorInfo } from "./types.js";
import { log } from "../utils/logger.js";
import { randomDelay, realisticClick } from "../utils/stealth-utils.js";
import { CONFIG, NOTEBOOKLM_URL } from "../config.js";



/**
 * Keywords to identify UI elements by their text/aria-label
 */
const ELEMENT_KEYWORDS = {
  newNotebook: ["new", "create", "notebook", "+", "add notebook"],
  addSource: ["add source", "add", "source", "+", "upload"],
  urlSource: ["url", "website", "web", "link", "webpage"],
  textSource: ["text", "paste", "copy", "clipboard"],
  fileSource: ["file", "upload", "pdf", "document", "drive"],
  submit: ["add", "submit", "done", "create", "save", "ok", "confirm"],
  cancel: ["cancel", "close", "back", "x"],
};

/**
 * Discovers UI selectors for NotebookLM's notebook creation workflow
 */
export class SelectorDiscovery {
  private page: Page | null = null;

  constructor(private context: BrowserContext) {}

  /**
   * Run the full discovery process
   */
  async discover(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
      selectors: {},
      homepageElements: [],
      creationElements: [],
      sourceElements: [],
      discoveredAt: new Date().toISOString(),
      errors: [],
    };

    try {
      // Create a new page for discovery
      this.page = await this.context.newPage();

      log.info("🔍 Starting NotebookLM UI selector discovery...");

      // Phase 1: Discover homepage elements
      log.info("📄 Phase 1: Analyzing homepage...");
      await this.navigateToHome();
      result.homepageElements = await this.dumpInteractiveElements();
      result.selectors.newNotebookButton = this.findSelector(
        result.homepageElements,
        ELEMENT_KEYWORDS.newNotebook,
        "New notebook button"
      );

      // Phase 2: Navigate to notebook creation and discover elements
      log.info("📄 Phase 2: Analyzing notebook creation UI...");
      const clickedNew = await this.tryClickNewNotebook(result.selectors.newNotebookButton);

      if (clickedNew) {
        await randomDelay(1500, 2500);
        result.creationElements = await this.dumpInteractiveElements();

        // Find notebook name input
        result.selectors.notebookNameInput = this.findInputSelector(
          result.creationElements,
          ["name", "title", "notebook"],
          "Notebook name input"
        );

        // Find add source button
        result.selectors.addSourceButton = this.findSelector(
          result.creationElements,
          ELEMENT_KEYWORDS.addSource,
          "Add source button"
        );
      }

      // Phase 3: Try to access source addition UI
      log.info("📄 Phase 3: Analyzing source addition UI...");
      if (result.selectors.addSourceButton?.primary) {
        const clickedAddSource = await this.tryClick(result.selectors.addSourceButton.primary);

        if (clickedAddSource) {
          await randomDelay(1000, 2000);
          result.sourceElements = await this.dumpInteractiveElements();

          // Find source type options
          result.selectors.urlSourceOption = this.findSelector(
            result.sourceElements,
            ELEMENT_KEYWORDS.urlSource,
            "URL source option"
          );

          result.selectors.textSourceOption = this.findSelector(
            result.sourceElements,
            ELEMENT_KEYWORDS.textSource,
            "Text source option"
          );

          result.selectors.fileSourceOption = this.findSelector(
            result.sourceElements,
            ELEMENT_KEYWORDS.fileSource,
            "File source option"
          );

          // Find file input element
          result.selectors.fileInput = await this.findFileInput();

          // Find URL input
          result.selectors.urlInput = this.findInputSelector(
            result.sourceElements,
            ["url", "link", "website", "http"],
            "URL input field"
          );

          // Find text input
          result.selectors.textInput = this.findTextareaSelector(
            result.sourceElements,
            ["text", "paste", "content"],
            "Text input area"
          );

          // Find submit button
          result.selectors.submitButton = this.findSelector(
            result.sourceElements,
            ELEMENT_KEYWORDS.submit,
            "Submit/Add button"
          );
        }
      }

      // Phase 4: Look for status indicators
      log.info("📄 Phase 4: Identifying status indicators...");
      const allElements = [
        ...result.homepageElements,
        ...result.creationElements,
        ...result.sourceElements,
      ];

      result.selectors.processingIndicator = this.findSelector(
        allElements,
        ["loading", "processing", "uploading", "progress", "spinner"],
        "Processing indicator"
      );

      result.selectors.successIndicator = this.findSelector(
        allElements,
        ["success", "done", "complete", "added", "✓", "check"],
        "Success indicator"
      );

      result.selectors.errorMessage = this.findSelector(
        allElements,
        ["error", "failed", "invalid", "warning"],
        "Error message"
      );

      log.success("✅ Discovery complete!");
      this.logDiscoveryResults(result);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Discovery error: ${errorMsg}`);
      result.errors.push(errorMsg);
    } finally {
      if (this.page) {
        await this.page.close().catch(() => {});
      }
    }

    return result;
  }

  /**
   * Navigate to NotebookLM homepage
   */
  private async navigateToHome(): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    await this.page.goto(NOTEBOOKLM_URL, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.browserTimeout,
    });

    await randomDelay(2000, 3000);

    // Wait for page to be interactive
    await this.page.waitForLoadState("networkidle").catch(() => {});
  }

  /**
   * Dump all interactive elements on the current page
   */
  async dumpInteractiveElements(): Promise<ElementInfo[]> {
    if (!this.page) return [];

    // Note: page.evaluate runs in browser context - uses any types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await this.page.evaluate((): any[] => {
      // @ts-expect-error - DOM types available in browser context
      const elements = document.querySelectorAll(
        'button, input, textarea, [role="button"], [role="menuitem"], ' +
        '[role="option"], a[href], [tabindex="0"], [onclick], ' +
        '[data-action], .clickable, [aria-haspopup]'
      );

      return Array.from(elements).map((el: any) => {
        const rect = el.getBoundingClientRect();
        // @ts-expect-error - DOM types available in browser context
        const computedStyle = window.getComputedStyle(el);
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          computedStyle.visibility !== "hidden" &&
          computedStyle.display !== "none" &&
          computedStyle.opacity !== "0";

        const attrs = Array.from(el.attributes || []);
        const dataAttrs: Record<string, string> = {};
        for (const attr of attrs as any[]) {
          if (attr.name && attr.name.startsWith("data-")) {
            dataAttrs[attr.name] = attr.value;
          }
        }

        return {
          tag: el.tagName?.toLowerCase() || "",
          id: el.id || "",
          classes: typeof el.className === 'string' ? el.className : "",
          ariaLabel: el.getAttribute?.("aria-label") || null,
          text: el.textContent?.trim().slice(0, 100) || null,
          dataAttrs,
          role: el.getAttribute?.("role") || null,
          isVisible,
          boundingBox: isVisible ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          } : undefined,
        };
      });
    });

    return results as ElementInfo[];
  }

  /**
   * Find a selector matching keywords
   */
  private findSelector(
    elements: ElementInfo[],
    keywords: string[],
    description: string
  ): SelectorInfo {
    const matches: Array<{ element: ElementInfo; score: number; selector: string }> = [];

    for (const el of elements) {
      if (!el.isVisible) continue;

      let score = 0;
      const textLower = (el.text || "").toLowerCase();
      const ariaLower = (el.ariaLabel || "").toLowerCase();
      const classLower = (el.classes || "").toLowerCase();

      for (const keyword of keywords) {
        const kw = keyword.toLowerCase();
        if (textLower.includes(kw)) score += 3;
        if (ariaLower.includes(kw)) score += 4;
        if (classLower.includes(kw)) score += 2;
        if (el.id.toLowerCase().includes(kw)) score += 3;

        // Check data attributes
        for (const [, value] of Object.entries(el.dataAttrs)) {
          if (value.toLowerCase().includes(kw)) score += 2;
        }
      }

      if (score > 0) {
        matches.push({
          element: el,
          score,
          selector: this.buildSelector(el),
        });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      return {
        primary: "",
        fallbacks: [],
        description,
        confirmed: false,
      };
    }

    return {
      primary: matches[0].selector,
      fallbacks: matches.slice(1, 4).map((m) => m.selector),
      description,
      confirmed: false,
    };
  }

  /**
   * Find input element selector
   */
  private findInputSelector(
    elements: ElementInfo[],
    keywords: string[],
    description: string
  ): SelectorInfo {
    const inputs = elements.filter(
      (el) => el.tag === "input" || el.tag === "textarea"
    );

    if (inputs.length === 0) {
      // Fall back to general search
      return this.findSelector(elements, keywords, description);
    }

    return this.findSelector(inputs, keywords, description);
  }

  /**
   * Find textarea selector
   */
  private findTextareaSelector(
    elements: ElementInfo[],
    keywords: string[],
    description: string
  ): SelectorInfo {
    const textareas = elements.filter((el) => el.tag === "textarea");

    if (textareas.length === 0) {
      return this.findSelector(elements, keywords, description);
    }

    return this.findSelector(textareas, keywords, description);
  }

  /**
   * Find file input element
   */
  private async findFileInput(): Promise<SelectorInfo> {
    if (!this.page) {
      return {
        primary: "",
        fallbacks: [],
        description: "File input element",
        confirmed: false,
      };
    }

    // Look for file input directly
    const fileInputs = await this.page.$$('input[type="file"]');

    if (fileInputs.length > 0) {
      // Try to get a more specific selector
      const selector = await this.page.evaluate((el) => {
        // @ts-expect-error - DOM types available in browser context
        const input = el as HTMLInputElement;
        if (input.id) return `#${input.id}`;
        if (input.name) return `input[type="file"][name="${input.name}"]`;
        return 'input[type="file"]';
      }, fileInputs[0]);

      return {
        primary: selector,
        fallbacks: ['input[type="file"]'],
        description: "File input element",
        confirmed: true,
      };
    }

    return {
      primary: 'input[type="file"]',
      fallbacks: [],
      description: "File input element",
      confirmed: false,
    };
  }

  /**
   * Build a CSS selector for an element
   */
  private buildSelector(el: ElementInfo): string {
    // Priority: ID > unique class > aria-label > data attribute > tag + position

    if (el.id) {
      return `#${CSS.escape(el.id)}`;
    }

    if (el.ariaLabel) {
      return `[aria-label="${CSS.escape(el.ariaLabel)}"]`;
    }

    // Try to use a unique class
    const classes = (el.classes || "").split(/\s+/).filter(Boolean);
    for (const cls of classes) {
      // Skip generic classes
      if (cls.length > 3 && !["button", "btn", "input", "text"].includes(cls.toLowerCase())) {
        return `.${CSS.escape(cls)}`;
      }
    }

    // Use data attribute if available
    for (const [attr, value] of Object.entries(el.dataAttrs)) {
      if (value) {
        return `[${attr}="${CSS.escape(value)}"]`;
      }
    }

    // Fall back to role
    if (el.role) {
      return `[role="${el.role}"]`;
    }

    // Last resort: tag
    return el.tag;
  }

  /**
   * Try to click the new notebook button
   */
  private async tryClickNewNotebook(selectorInfo: SelectorInfo | undefined): Promise<boolean> {
    if (!this.page || !selectorInfo?.primary) return false;

    const selectors = [selectorInfo.primary, ...selectorInfo.fallbacks];

    for (const selector of selectors) {
      try {
        const element = await this.page.$(selector);
        if (element && await element.isVisible()) {
          await realisticClick(this.page, selector, true);
          return true;
        }
      } catch (err) {
        log.debug(`selector-discovery: clicking new-notebook button selector: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    // Try common patterns for "new" buttons
    const commonPatterns = [
      'button:has-text("New")',
      'button:has-text("Create")',
      '[aria-label*="new" i]',
      '[aria-label*="create" i]',
      'button[data-action="create"]',
      '.create-button',
      '.new-button',
    ];

    for (const pattern of commonPatterns) {
      try {
        const element = await this.page.$(pattern);
        if (element && await element.isVisible()) {
          await element.click();
          return true;
        }
      } catch (err) {
        log.debug(`selector-discovery: clicking common create/new pattern: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    return false;
  }

  /**
   * Try to click an element by selector
   */
  private async tryClick(selector: string): Promise<boolean> {
    if (!this.page) return false;

    try {
      const element = await this.page.$(selector);
      if (element && await element.isVisible()) {
        await element.click();
        return true;
      }
    } catch (err) {
      log.debug(`selector-discovery: clicking element in tryClick: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    return false;
  }

  /**
   * Log discovery results summary
   */
  private logDiscoveryResults(result: DiscoveryResult): void {
    log.info("\n📊 Discovery Results Summary:");
    log.info(`   Homepage elements: ${result.homepageElements.length}`);
    log.info(`   Creation UI elements: ${result.creationElements.length}`);
    log.info(`   Source UI elements: ${result.sourceElements.length}`);

    log.info("\n🎯 Discovered Selectors:");
    for (const [key, info] of Object.entries(result.selectors)) {
      if (info && typeof info === 'object' && 'primary' in info) {
        const selectorInfo = info as SelectorInfo;
        const status = selectorInfo.primary ? "✓" : "✗";
        log.info(`   ${status} ${key}: ${selectorInfo.primary || "(not found)"}`);
        if (selectorInfo.fallbacks.length > 0) {
          log.info(`      Fallbacks: ${selectorInfo.fallbacks.join(", ")}`);
        }
      }
    }

    if (result.errors.length > 0) {
      log.warning("\n⚠️ Errors encountered:");
      for (const err of result.errors) {
        log.warning(`   - ${err}`);
      }
    }
  }
}

/**
 * CSS.escape polyfill for Node.js
 */
const CSS = {
  escape: (value: string): string => {
    return value.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  },
};

/**
 * Run selector discovery and return results
 */
export async function discoverSelectors(context: BrowserContext): Promise<DiscoveryResult> {
  const discovery = new SelectorDiscovery(context);
  return await discovery.discover();
}
