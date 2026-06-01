/**
 * Studio Manager Base
 *
 * Shared page-lifecycle plumbing for the NotebookLM "Studio" managers
 * (audio, video, data table). These managers all open a notebook page,
 * validate authentication, drive a Studio-panel artifact flow, then close
 * the page. The navigation and teardown logic is identical across them and
 * lives here; the artifact-specific flows stay in each subclass.
 *
 * Behavior is preserved exactly:
 *   - navigateToNotebook: getOrCreateContext → validateWithRetry (throws
 *     "Not authenticated. Run setup_auth first." when false) → newPage →
 *     goto(domcontentloaded) → waitForLoadState("networkidle") (errors
 *     swallowed) → per-subclass randomDelay → return page.
 *   - closePage: close the page, swallowing errors, then null the handle.
 *
 * Per-subclass differences are expressed as protected properties so that no
 * call site needs to thread arguments:
 *   - navigateDelay: video & data table use 2000–3000ms, audio uses 1500–2500ms.
 *   - logName: the log-prefix used in the swallowed close-error debug line.
 */

import type { Page } from "patchright";
import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

/** Opaque DOM element handle used only in `as`-casts inside page.evaluate bodies. */
export type BrowserDomElement = unknown;

/** Minimal `document` shape used inside page.evaluate bodies. Common to all managers. */
export interface BrowserDocumentContext {
  document: {
    querySelector(selector: string): BrowserDomElement | null;
    querySelectorAll(selector: string): Iterable<BrowserDomElement>;
  };
}

export abstract class StudioManagerBase {
  protected page: Page | null = null;

  /**
   * Trailing delay applied after navigation settles. Video & data table use the
   * default (2000–3000ms); audio overrides to 1500–2500ms.
   */
  protected readonly navigateDelay: { min: number; max: number } = { min: 2000, max: 3000 };

  /** Log prefix used in the swallowed close-error debug line (kept per-manager). */
  protected abstract readonly logName: string;

  constructor(
    protected authManager: AuthManager,
    protected contextManager: SharedContextManager
  ) {}

  /**
   * Navigate to a notebook and ensure we're on the right page
   */
  protected async navigateToNotebook(notebookUrl: string): Promise<Page> {
    const context = await this.contextManager.getOrCreateContext();
    const isAuth = await this.authManager.validateWithRetry(context);

    if (!isAuth) {
      throw new Error("Not authenticated. Run setup_auth first.");
    }

    this.page = await context.newPage();
    await this.page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("networkidle").catch(() => {});
    await randomDelay(this.navigateDelay.min, this.navigateDelay.max);

    return this.page;
  }

  /**
   * Close the page if open
   */
  protected async closePage(): Promise<void> {
    if (this.page) {
      try {
        await this.page.close();
      } catch (err) {
        log.debug(`${this.logName}: closing page: ${err instanceof Error ? err.message : String(err)}`);
        // Ignore close errors
      }
      this.page = null;
    }
  }
}
