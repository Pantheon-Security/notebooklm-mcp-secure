import type { Page } from "patchright";
import { waitForElement, getSelectors } from "./selectors.js";
import { NotebookCreationError, NotebookCreationErrorCode } from "./errors.js";
import { log } from "../utils/logger.js";
import { randomDelay, humanType, realisticClick } from "../utils/stealth-utils.js";
import { CONFIG, NOTEBOOKLM_URL } from "../config.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";

export class NotebookNavigation {
  private page: Page | null = null;

  constructor(
    private authManager: AuthManager,
    private contextManager: SharedContextManager
  ) {}

  getCurrentPage(): Page | null {
    return this.page;
  }

  async validateCurrentAuth(): Promise<void> {
    if (!this.page) {
      throw new NotebookCreationError("Page not initialized", {
        code: NotebookCreationErrorCode.PAGE_NOT_INITIALIZED,
      });
    }

    const context = this.page.context();
    const isAuthenticated = await this.authManager.validateWithRetry(context);
    if (!isAuthenticated) {
      throw new Error("NotebookLM authentication expired during notebook creation. Please run setup_auth first.");
    }
  }

  async initialize(headless?: boolean): Promise<void> {
    log.info("🌐 Initializing browser for notebook creation...");

    const context = await this.contextManager.getOrCreateContext(
      headless === false ? true : undefined
    );

    const isAuthenticated = await this.authManager.validateWithRetry(context);
    if (!isAuthenticated) {
      throw new Error("Not authenticated to NotebookLM. Please run setup_auth first.");
    }

    this.page = await context.newPage();
    await this.page.goto(NOTEBOOKLM_URL, {
      waitUntil: "domcontentloaded",
      timeout: CONFIG.browserTimeout,
    });

    await randomDelay(2000, 3000);
    await this.waitForNotebookReady(this.page);
    const anchor = await waitForElement(this.page, "newNotebookButton", {
      timeout: 10000,
    });
    if (!anchor) {
      log.warning("NotebookLM shell loaded but create-notebook anchor was not found before timeout; continuing with selector fallbacks.");
    }

    log.success("✅ Browser initialized and navigated to NotebookLM");
  }

  async waitForNotebookReady(page: Page): Promise<void> {
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

  async clickNewNotebook(): Promise<void> {
    if (!this.page) {
      throw new NotebookCreationError("Page not initialized", {
        code: NotebookCreationErrorCode.PAGE_NOT_INITIALIZED,
      });
    }
    await this.validateCurrentAuth();

    log.info("📝 Clicking 'New notebook' button...");

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
        log.debug(`notebook-nav: clicking 'New notebook' button selector: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
        log.debug(`notebook-nav: clicking 'New notebook' button via text pattern: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new NotebookCreationError("Failed to click new notebook", {
      code: NotebookCreationErrorCode.CLICK_NEW_NOTEBOOK_FAILED,
      selector: selectors.join(" | "),
      url: this.safePageUrl(this.page),
      cause: lastError,
    });
  }

  async setNotebookName(name: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");
    await this.validateCurrentAuth();

    log.info(`📝 Setting notebook name: ${name}`);

    const element = await waitForElement(this.page, "notebookNameInput", {
      timeout: 10000,
    });

    if (!element) {
      log.warning("⚠️ Name input not found - notebook may have been created with default name");
      return;
    }

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
        log.debug(`notebook-nav: typing notebook name into input selector: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async finalizeAndGetUrl(): Promise<string> {
    if (!this.page) throw new Error("Page not initialized");
    await this.validateCurrentAuth();

    log.info("🔗 Getting notebook URL...");
    await randomDelay(1000, 2000);

    const currentUrl = this.page.url();
    if (currentUrl.includes("/notebook/")) {
      return currentUrl;
    }

    const notebookLinks = await this.page.$$('a[href*="/notebook/"]');
    if (notebookLinks.length > 0) {
      const href = await notebookLinks[0].getAttribute("href");
      if (href) {
        return href.startsWith("http") ? href : `https://notebooklm.google.com${href}`;
      }
    }

    return currentUrl;
  }

  safePageUrl(page: Page): string {
    try {
      return page.url();
    } catch (err) {
      log.debug(`notebook-nav: reading page URL failed: ${err instanceof Error ? err.message : String(err)}`);
      return "[unavailable]";
    }
  }

  async cleanup(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        log.debug(`notebook-nav: closing page in cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.page = null;
    }
  }
}
