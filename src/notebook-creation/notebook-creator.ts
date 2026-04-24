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
}

export async function createNotebook(
  authManager: AuthManager,
  contextManager: SharedContextManager,
  options: CreateNotebookOptions
): Promise<CreatedNotebook> {
  const creator = new NotebookCreator(authManager, contextManager);
  return creator.createNotebook(options);
}
