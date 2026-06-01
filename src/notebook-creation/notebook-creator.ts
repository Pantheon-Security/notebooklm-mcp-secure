/**
 * NotebookLM Notebook Creator
 *
 * Thin orchestration layer for browser navigation and source addition.
 */

import type {
  CreateNotebookOptions,
  CreatedNotebook,
  FailedSource,
} from "./types.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { NotebookNavigation } from "./notebook-nav.js";
import { NotebookCreationSourceManager } from "./source-manager.js";

/**
 * Creates NotebookLM notebooks with sources
 */
export class NotebookCreator {
  private operationQueue: Promise<void> = Promise.resolve();
  private navigation: NotebookNavigation;
  private sourceManager: NotebookCreationSourceManager;

  constructor(
    authManager: AuthManager,
    contextManager: SharedContextManager
  ) {
    this.navigation = new NotebookNavigation(authManager, contextManager);
    this.sourceManager = new NotebookCreationSourceManager(() => this.navigation.getCurrentPage());
  }

  private async withOperationLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.operationQueue;
    this.operationQueue = acquired;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async createNotebook(options: CreateNotebookOptions): Promise<CreatedNotebook> {
    return this.withOperationLock(() => this.runCreateNotebook(options));
  }

  private async runCreateNotebook(options: CreateNotebookOptions): Promise<CreatedNotebook> {
    const { name, sources, sendProgress } = options;
    const totalSteps = 3 + sources.length;
    let currentStep = 0;

    const failedSources: FailedSource[] = [];
    let successCount = 0;

    try {
      currentStep++;
      await sendProgress?.("Initializing browser...", currentStep, totalSteps);
      await this.navigation.initialize(options.browserOptions?.headless);

      currentStep++;
      await sendProgress?.("Creating new notebook...", currentStep, totalSteps);
      await this.navigation.clickNewNotebook();

      await randomDelay(3000, 4000);

      const page = this.navigation.getCurrentPage();
      if (!page) {
        throw new Error("Notebook creation page not available after clicking new notebook");
      }

      const createdNotebookUrl = page.url();
      log.info(`📍 Notebook URL after creation: ${createdNotebookUrl}`);
      if (!createdNotebookUrl.includes("/notebook/")) {
        throw new Error("Failed to create notebook - unexpected URL received (check logs for details)");
      }

      const notebookId = createdNotebookUrl.split("/notebook/")[1]?.split("?")[0];
      log.info(`📓 Created notebook ID: ${notebookId}`);

      await this.navigation.setNotebookName(name);

      for (const source of sources) {
        currentStep++;
        const sourceDesc = this.sourceManager.getSourceDescription(source);
        await sendProgress?.(`Adding source: ${sourceDesc}...`, currentStep, totalSteps);

        try {
          await this.navigation.validateCurrentAuth();
          await this.sourceManager.addSource(source);
          successCount++;
          log.success(`✅ Added source: ${sourceDesc}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`❌ Failed to add source: ${sourceDesc} - ${errorMsg}`);
          failedSources.push({
            source,
            error: errorMsg,
            ...(process.env.DEBUG === "true" && error instanceof Error && error.stack
              ? { stack: error.stack }
              : {}),
          });
        }

        await randomDelay(1000, 2000);
      }

      // Fail-safe: if sources were requested but NONE actually succeeded, the
      // notebook is empty and useless. Discard it (best-effort delete to avoid
      // burning quota) and throw so the caller never persists a library entry
      // or counts a successful creation for it. An empty `sources` array (e.g.
      // an overflow shell notebook) is a legitimate zero-success case and is
      // left untouched.
      if (sources.length > 0 && successCount === 0) {
        log.error(`❌ Notebook creation failed: no sources could be added (${notebookId})`);
        await this.deleteEmptyNotebook();
        throw new Error(
          "Notebook creation failed: no sources could be added; empty notebook was discarded"
        );
      }

      currentStep++;
      await sendProgress?.("Finalizing notebook...", currentStep, totalSteps);
      const notebookUrl = await this.navigation.finalizeAndGetUrl();

      log.success(`✅ Notebook created: ${notebookUrl}`);

      return {
        url: notebookUrl,
        name,
        sourceCount: successCount,
        createdAt: new Date().toISOString(),
        partial: failedSources.length > 0,
        failedSources: failedSources.length > 0 ? failedSources : undefined,
      };
    } catch (error) {
      throw error;
    } finally {
      await this.navigation.cleanup();
    }
  }

  /**
   * Best-effort deletion of a freshly-created but empty notebook (no sources
   * added). Opens the notebook's overflow/options menu and confirms delete.
   *
   * Failure to delete is logged but not rethrown: the caller is already
   * reporting the creation as failed, so we must not mask that with a
   * secondary error.
   */
  private async deleteEmptyNotebook(): Promise<void> {
    const page = this.navigation.getCurrentPage();
    if (!page) {
      log.debug("notebook creator: no page available to delete empty notebook");
      return;
    }

    try {
      const menuButton = page
        .locator(
          'button[aria-label*="more" i], button[aria-label*="options" i], button[aria-label*="settings" i]'
        )
        .first();
      await menuButton.click({ timeout: 5000 });
      await randomDelay(500, 1000);

      const deleteOption = page
        .locator('button:has-text("Delete"), [role="menuitem"]:has-text("Delete")')
        .first();
      await deleteOption.click({ timeout: 5000 });
      await randomDelay(500, 1000);

      // Confirm in any follow-up dialog.
      const confirmButton = page
        .locator('button:has-text("Delete"), button:has-text("Confirm")')
        .last();
      if ((await confirmButton.count()) > 0) {
        await confirmButton.click({ timeout: 5000 });
        await randomDelay(500, 1000);
      }

      log.info("🗑️  Discarded empty notebook (no sources added)");
    } catch (error) {
      log.warning(
        `⚠️ Could not delete empty notebook: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export async function createNotebook(
  authManager: AuthManager,
  contextManager: SharedContextManager,
  options: CreateNotebookOptions
): Promise<CreatedNotebook> {
  const creator = new NotebookCreator(authManager, contextManager);
  return creator.createNotebook(options);
}
