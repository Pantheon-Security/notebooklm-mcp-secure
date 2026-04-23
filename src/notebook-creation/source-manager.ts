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
   *
   * Live DOM inspection April 2026:
   *   section.source-panel
   *   └── div.single-source-container            ← one source row
   *       ├── button.source-stretched-button      (aria-label = source title)
   *       ├── div.icon-and-menu-container
   *       │   ├── mat-icon.source-item-more-menu-icon (text="more_vert" — NOT the title!)
   *       │   └── button.source-item-more-button  (jslog=202051)
   *       ├── div.source-title-column
   *       │   └── div.source-title
   *       │       └── span  (text = source title)
   *       └── div.select-checkbox-container
   *
   * Old selectors matched the menu button children and returned icon names
   * ("more_vert", "video_audio_call") as titles. Fixed by targeting
   * `.single-source-container` as the row and `.source-title` for the title.
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

        // Primary: April 2026 UI — each row is `.single-source-container`
        // Fallback chain kept for legacy UI and UI transitions
        const rowSelectors = [
          '.single-source-container',                   // April 2026 (primary)
          'source-row',                                  // Hypothetical custom element
          '[class*="single-source"]',                    // Class variants
          'mat-list-item',                               // Legacy
          '[role="listitem"]',                           // Generic ARIA
        ];

        let items: any[] = [];
        let matchedSelector = '';
        for (const sel of rowSelectors) {
          // @ts-expect-error - DOM types
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length > 0) {
            items = found;
            matchedSelector = sel;
            break;
          }
        }

        for (let i = 0; i < items.length; i++) {
          const item = items[i] as any;

          // Title extraction: try most reliable → least reliable
          // 1. .source-title textContent (the actual title span)
          // 2. .source-stretched-button aria-label
          // 3. .source-title-column textContent (may include noise)
          const titleEl = item.querySelector('.source-title');
          const ariaTitleEl = item.querySelector('.source-stretched-button');
          const colEl = item.querySelector('.source-title-column');
          let title = (titleEl?.textContent || '').trim();
          if (!title) title = (ariaTitleEl?.getAttribute('aria-label') || '').trim();
          if (!title) title = (colEl?.textContent || '').trim();
          if (!title) title = (item.textContent || '').trim();

          // Filter out obvious icon-only matches (Material Icons names)
          const ICON_NAMES = new Set([
            'more_vert', 'more_horiz', 'description', 'video_audio_call',
            'link', 'upload', 'drive', 'content_paste', 'picture_as_pdf',
          ]);
          if (ICON_NAMES.has(title) || title.length < 1) continue;
          // Drop embedded icon words from start of title (e.g. "description Foo" → "Foo")
          for (const ic of ICON_NAMES) {
            if (title.startsWith(ic + ' ')) title = title.slice(ic.length + 1);
          }
          title = title.slice(0, 120);

          // Type detection
          const rowClasses = (item.className || '').toString().toLowerCase();
          const icon = item.querySelector('.icon-and-menu-container mat-icon, mat-icon');
          const iconText = (icon?.textContent || '').trim();
          let type: string = 'unknown';
          if (/(^|[\s_-])(link|public|language)($|[\s_-])/.test(iconText)) type = 'url';
          else if (/(^|[\s_-])(drive|cloud)($|[\s_-])/.test(iconText)) type = 'drive';
          else if (/(^|[\s_-])(picture_as_pdf|description|article|note|file)($|[\s_-])/.test(iconText)) type = 'file';
          else if (/(^|[\s_-])(content_paste|edit_note|text_snippet)($|[\s_-])/.test(iconText)) type = 'text';
          else if (rowClasses.includes('link') || rowClasses.includes('url')) type = 'url';
          else if (rowClasses.includes('drive')) type = 'drive';
          else if (rowClasses.includes('file') || rowClasses.includes('pdf')) type = 'file';
          else type = 'text';

          // Status detection
          let status: string = 'ready';
          if (rowClasses.includes('error') || rowClasses.includes('failed')) status = 'failed';
          else if (rowClasses.includes('processing') || rowClasses.includes('loading')) status = 'processing';

          results.push({
            id: `source-${i}`,
            title,
            type,
            status,
            _matchedSelector: matchedSelector,
          });
        }

        return results;
      });

      log.success(`  ✅ Found ${sources.length} sources`);

      return {
        sources: sources.map(({ _matchedSelector, ...s }: any) => s),
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
      // April 2026 signals: 4 source-type tiles with jslog 279295/299/304/308 inside
      // a visible mat-dialog-container. Legacy selectors kept as fallback.
      const dialogAlreadyOpen = await page.evaluate(() => {
        // Primary (April 2026): any of the 4 source-type tiles visible
        // @ts-expect-error - DOM types
        const newDialogTile = document.querySelector(
          'mat-dialog-container button[jslog^="279295"], ' +
          'mat-dialog-container button[jslog^="279299"], ' +
          'mat-dialog-container button[jslog^="279304"], ' +
          'mat-dialog-container button[jslog^="279308"]'
        );
        if (newDialogTile && (newDialogTile as any).offsetParent !== null) return true;
        // Secondary: any visible mat-dialog-container with non-empty content
        // @ts-expect-error - DOM types
        const dialogs = document.querySelectorAll('mat-dialog-container');
        for (const d of dialogs) {
          if ((d as any).offsetParent !== null && d.textContent?.trim()) return true;
        }
        // Legacy: dropzone button
        // @ts-expect-error - DOM types
        const dropzone = document.querySelector('.dropzone__file-dialog-button, span[xapscottyuploadertrigger]');
        // Legacy: English aria-label
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

        // Verify dialog opened (same logic as dialogAlreadyOpen check)
        const dialogOpened = await page.evaluate(() => {
          // @ts-expect-error - DOM types
          const newDialogTile = document.querySelector(
            'mat-dialog-container button[jslog^="279295"], ' +
            'mat-dialog-container button[jslog^="279299"], ' +
            'mat-dialog-container button[jslog^="279304"], ' +
            'mat-dialog-container button[jslog^="279308"]'
          );
          if (newDialogTile && (newDialogTile as any).offsetParent !== null) return true;
          // @ts-expect-error - DOM types
          const dialogs = document.querySelectorAll('mat-dialog-container');
          for (const d of dialogs) {
            if ((d as any).offsetParent !== null && d.textContent?.trim()) return true;
          }
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
      // April 2026: source rows are `.single-source-container`; earlier UIs used `mat-list-item`
      const clicked = await page.evaluate((index: number) => {
        const sourceSelectors = [
          '.single-source-container',
          'source-row',
          '[class*="single-source"]',
          'mat-list-item',
          '[role="listitem"]',
        ];

        for (const selector of sourceSelectors) {
          // @ts-expect-error - DOM types
          const items = document.querySelectorAll(selector);
          if (items.length > index) {
            const item = items[index] as any;

            // Open the ⋮ menu (jslog 202051 in April 2026 UI) first, then look for delete
            const menuBtn = item.querySelector(
              'button.source-item-more-button, button[jslog^="202051"], [aria-label*="menu" i], [aria-label*="more" i], [aria-label*="オプション"]'
            );
            if (menuBtn) {
              menuBtn.click();
              return "menu-opened";
            }

            // Legacy: inline delete button
            const deleteBtn = item.querySelector(
              '[aria-label*="delete" i], [aria-label*="remove" i], [aria-label*="削除"], button[class*="delete"]'
            );
            if (deleteBtn) { deleteBtn.click(); return "deleted"; }

            // Fallback: click the row to select it
            item.click();
            return "selected";
          }
        }
        return null;
      }, sourceIndex);

      if (!clicked) {
        throw new Error(`Source not found at index ${sourceIndex}`);
      }

      if (clicked === "selected" || clicked === "menu-opened") {
        // Wait for menu to render, then find the delete menuitem
        await randomDelay(500, 800);

        const deleted = await page.evaluate(() => {
          // April 2026: the ⋮ menu surface appears as a mat-menu-panel overlay
          // with multiple button[role="menuitem"] children. The delete one uses
          // Material icon "delete" / "delete_forever" (locale-independent).
          // @ts-expect-error - DOM types
          const menuItems = document.querySelectorAll(
            '[role="menuitem"], button.mat-mdc-menu-item, mat-menu-item'
          );
          for (const mi of Array.from(menuItems)) {
            if (!(mi as any).offsetParent && (mi as any).getClientRects().length === 0) continue;
            const icon = (mi as any).querySelector?.('mat-icon');
            const iconText = icon?.textContent?.trim() || '';
            if (iconText === 'delete' || iconText === 'delete_forever' || iconText === 'remove') {
              (mi as any).click();
              return 'menu-item';
            }
          }
          // Fallback: text match
          for (const mi of Array.from(menuItems)) {
            const text = ((mi as any).textContent || '').toLowerCase();
            if (text.includes('delete') || text.includes('remove') || text.includes('削除')) {
              (mi as any).click();
              return 'menu-text';
            }
          }
          // Final fallback: any visible delete button anywhere
          const deleteSelectors = [
            'button[aria-label*="delete" i]',
            'button[aria-label*="remove" i]',
            'button[aria-label*="削除"]',
            '[class*="delete"]',
            '[class*="trash"]',
          ];
          for (const selector of deleteSelectors) {
            // @ts-expect-error - DOM types
            const btn = document.querySelector(selector) as any;
            if (btn && btn.offsetParent !== null) { btn.click(); return 'button'; }
          }
          return '';
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
        const buttons = document.querySelectorAll("mat-dialog-container button, button");
        for (const btn of buttons) {
          if ((btn as any).disabled) continue;
          const text = (btn as any).textContent?.toLowerCase() || "";
          if (text.includes("delete") || text.includes("remove") || text.includes("confirm") ||
              text.includes("削除") || text.includes("確認") || text.includes("はい")) {
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
   *
   * Live DOM inspection April 2026:
   *   1. Add source dialog shows 4 outlined tiles (jslog 279304/308/299/295).
   *      Website/URL tile: jslog starts with "279308".
   *   2. Clicking it opens a sub-dialog with title "ウェブサイトと YouTube の URL".
   *      Input is a <textarea> (not <input type="url">!):
   *        - aria-label="URL を入力" (ja) / "Enter URL" (en)
   *        - placeholder="リンクを貼り付ける" (ja) / "Paste link" (en)
   *        - jslog="279306;track:impression,input_"
   *   3. Submit button: text="挿入" (ja) / "Insert" (en), jslog^="279307".
   *      Disabled until a valid URL is typed. Enter key also works.
   */
  private async addUrlSourceInternal(page: Page, url: string): Promise<void> {
    // Step 1: Click the Website/URL tile (jslog 279308) — locale-independent
    const urlOptionClicked = await page.evaluate(() => {
      // Primary: jslog ID (stable across locales, confirmed April 2026)
      // @ts-expect-error - DOM types
      const byJslog = document.querySelector(
        'mat-dialog-container button[jslog^="279308"], button[jslog^="279308"]'
      ) as any;
      if (byJslog) { byJslog.click(); return 'jslog'; }

      // Secondary: mat-icon text — "link" icon is the URL tile (icon names never translate)
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll(
        'mat-dialog-container button.drop-zone-icon-button, button.drop-zone-icon-button'
      );
      for (const tile of tiles) {
        const icon = (tile as any).querySelector?.('mat-icon');
        const iconText = icon?.textContent?.trim() || '';
        if (iconText === 'link' || iconText.startsWith('link ')) {
          (tile as any).click();
          return 'icon';
        }
      }

      // Tertiary: aria/text fallback (locale-dependent)
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button, [role='button'], mat-chip");
      for (const btn of buttons) {
        const text = (btn as any).textContent?.toLowerCase() || "";
        const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
        const combined = text + ' ' + aria;
        if (combined.includes("url") || combined.includes("website") ||
            combined.includes("ウェブサイト") || combined.includes("サイト") ||
            combined.includes("link") || combined.includes("リンク")) {
          // Skip buttons that look like "URL input" rather than type selector
          if (combined.includes("input") || combined.includes("入力")) continue;
          (btn as any).click();
          return 'text';
        }
      }
      return '';
    });

    if (!urlOptionClicked) {
      throw new Error("Could not find URL/Website source option");
    }
    log.dim(`    Selected URL source via: ${urlOptionClicked}`);

    await randomDelay(800, 1200);

    // Step 2: Find and fill URL input (textarea in April 2026, fallback to input)
    const urlInputSelectors = [
      'mat-dialog-container textarea[jslog^="279306"]',
      'textarea[jslog^="279306"]',
      'mat-dialog-container textarea[aria-label*="URL" i]',
      'mat-dialog-container textarea[placeholder*="リンク"]',
      'mat-dialog-container textarea[placeholder*="link" i]',
      'mat-dialog-container textarea',                          // Any textarea in the open dialog
      'input[type="url"]',                                      // Legacy input
      'input[type="text"][placeholder*="URL" i]',               // Legacy
      'input[placeholder*="http" i]',                           // Legacy
    ];

    let urlInputSelector: string | null = null;
    for (const sel of urlInputSelectors) {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) {
        urlInputSelector = sel;
        break;
      }
    }

    if (!urlInputSelector) {
      throw new Error("Could not find URL input field");
    }
    log.dim(`    URL input found: ${urlInputSelector}`);

    await humanType(page, urlInputSelector, url);
    await randomDelay(500, 800);

    // Step 3: Submit via Insert button (jslog 279307) or Enter key
    const insertClicked = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const btn = document.querySelector(
        'mat-dialog-container button[jslog^="279307"]:not([disabled]), button[jslog^="279307"]:not([disabled])'
      ) as any;
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!insertClicked) {
      // Enter key as fallback — also works for the textarea in April 2026 UI
      await page.keyboard.press("Enter");
    }
  }

  /**
   * Internal: Add text source
   */
  private async addTextSourceInternal(page: Page, text: string, _title?: string): Promise<void> {
    // Step 1: Click the "Copied text" tile — locale-independent via jslog 279295
    const textOptionClicked = await page.evaluate(() => {
      // Primary: jslog ID
      // @ts-expect-error - DOM types
      const byJslog = document.querySelector(
        'mat-dialog-container button[jslog^="279295"], button[jslog^="279295"]'
      ) as any;
      if (byJslog) { byJslog.click(); return 'jslog'; }

      // Secondary: mat-icon "content_paste" (icon names never translate)
      // @ts-expect-error - DOM types
      const tiles = document.querySelectorAll(
        'mat-dialog-container button.drop-zone-icon-button, button.drop-zone-icon-button'
      );
      for (const tile of tiles) {
        const icon = (tile as any).querySelector?.('mat-icon');
        const iconText = icon?.textContent?.trim() || '';
        if (iconText === 'content_paste' || iconText.startsWith('content_paste ')) {
          (tile as any).click();
          return 'icon';
        }
      }

      // Tertiary: aria/text (locale-dependent)
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("button, [role='button'], mat-chip");
      for (const btn of buttons) {
        const btnText = (btn as any).textContent?.toLowerCase() || "";
        const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
        const combined = btnText + ' ' + aria;
        if (combined.includes("copied text") || combined.includes("paste") ||
            combined.includes("コピーしたテキスト") || combined.includes("貼り付け") ||
            combined.includes("texte copié")) {
          (btn as any).click();
          return 'text';
        }
      }
      return '';
    });

    if (!textOptionClicked) {
      throw new Error("Could not find text/paste source option");
    }
    log.dim(`    Selected text source via: ${textOptionClicked}`);

    await randomDelay(800, 1200);

    // Step 2: Find text area (new class: copied-text-input-textarea)
    const textAreaSelectors = [
      'mat-dialog-container textarea.copied-text-input-textarea',
      'textarea.copied-text-input-textarea',
      'mat-dialog-container textarea[jslog^="279298"]',
      'textarea[jslog^="279298"]',
      'mat-dialog-container textarea[aria-label*="貼り付け"]',
      'mat-dialog-container textarea[aria-label*="paste" i]',
      'mat-dialog-container textarea[aria-label*="text" i]',
      NOTEBOOKLM_SELECTORS.textInput.primary,
      ...NOTEBOOKLM_SELECTORS.textInput.fallbacks,
    ];

    let textAreaSelector: string | null = null;
    for (const sel of textAreaSelectors) {
      const el = await page.$(sel);
      if (el && (await el.isVisible())) {
        textAreaSelector = sel;
        break;
      }
    }
    if (!textAreaSelector) {
      throw new Error("Could not find text input area");
    }
    log.dim(`    Text input found: ${textAreaSelector}`);

    const textArea = await page.$(textAreaSelector);
    if (!textArea) {
      throw new Error("Text input disappeared before fill");
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
      await humanType(page, textAreaSelector, text);
    }

    await randomDelay(500, 800);

    // Step 3: Click Insert button — prefer locale-independent jslog 279297
    const insertClicked = await page.evaluate(() => {
      // Primary: jslog ID (April 2026, locale-independent)
      // @ts-expect-error - DOM types
      const byJslog = document.querySelector(
        'mat-dialog-container button[jslog^="279297"]:not([disabled]), button[jslog^="279297"]:not([disabled])'
      ) as any;
      if (byJslog) { byJslog.click(); return 'jslog'; }

      // Secondary: type=submit
      // @ts-expect-error - DOM types
      const submitBtn = document.querySelector(
        "mat-dialog-container button[type='submit']:not([disabled]), button[type='submit']:not([disabled])"
      ) as any;
      if (submitBtn && submitBtn.offsetParent !== null) { submitBtn.click(); return 'submit'; }

      // Tertiary: primary color class (NotebookLM convention, locale-independent)
      // @ts-expect-error - DOM types
      const primaryBtn = document.querySelector(
        "mat-dialog-container button.button-color--primary:not([disabled]), mat-dialog-container button.mdc-button--unelevated:not([disabled])"
      ) as any;
      if (primaryBtn && primaryBtn.offsetParent !== null) { primaryBtn.click(); return 'primary'; }

      // Fallback: text match (locale-dependent)
      // @ts-expect-error - DOM types
      const buttons = document.querySelectorAll("mat-dialog-container button, button");
      for (const btn of buttons) {
        if ((btn as any).disabled) continue;
        const text = (btn as any).textContent?.toLowerCase() || "";
        if (text.includes("insert") || text.includes("add") || text.includes("submit") ||
            text.includes("挿入") || text.includes("追加") || text.includes("insérer")) {
          (btn as any).click();
          return 'text';
        }
      }
      return '';
    });

    if (!insertClicked) {
      throw new Error("Could not find Insert button");
    }
    log.dim(`    Submitted text via: ${insertClicked}`);
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
