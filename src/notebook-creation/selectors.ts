/**
 * NotebookLM UI Selectors
 *
 * These selectors are used for notebook creation automation.
 * Run the selector discovery tool to update these with actual values.
 *
 * Usage:
 *   node dist/notebook-creation/run-discovery.js
 *
 * Note: Must be authenticated first via setup_auth tool.
 */

export const NOTEBOOKLM_SELECTORS = {
  /** New notebook / Create button on homepage
   *
   * Live DOM inspection April 2026 (ja locale):
   *   <button class="mdc-button mat-mdc-button-base create-new-button mat-tonal-button ..."
   *           aria-label="ノートブックを新規作成"
   *           jslog="236819;track:generic_click,impression">
   *     add 新規作成
   *   </button>
   *
   * Locale-independent signals (most resilient first):
   *   1. `.create-new-button` class — stable since Dec 2025
   *   2. `jslog^="236819"` — Google click-tracking ID (locale-agnostic)
   *   3. aria-label contains translation of "create new" in ja/en/fr
   */
  newNotebookButton: {
    primary: 'button.create-new-button',                             // Class: locale-independent
    fallbacks: [
      'button[jslog^="236819"]',                                     // Google click-tracking ID
      'button[aria-label*="新規作成"]',                                 // ja "create new"
      'button[aria-label*="新しい"]',                                   // ja "new"
      'button[aria-label*="Create new"]',                            // en
      'button[aria-label*="Create"]',                                // en short
      'button[aria-label*="Créer"]',                                  // fr
      'button[aria-label*="Nouveau"]',                                // fr
      'mat-card.create-new-action-button',                            // Card variant fallback
    ],
    confirmed: true, // April 2026 — locale-independent class confirmed
  },

  /** Notebook name input field
   * Note: NotebookLM auto-creates notebook with default name.
   * Name can be edited later via the title element. */
  notebookNameInput: {
    primary: 'input[type="text"]',
    fallbacks: [
      '[contenteditable="true"]',
      'input[aria-label*="name" i]',
    ],
    confirmed: false,
  },

  /** Add source / Upload source button
   * Discovered: aria="Add source" with class "add-source-button"
   * Locale note: class selector is locale-independent; aria-label is English-only */
  addSourceButton: {
    primary: 'button.add-source-button',                          // Class: locale-independent
    fallbacks: [
      'button[aria-label="Add source"]',                          // English aria-label
      'button[aria-label*="Add source"]',                         // English partial match
      'button[aria-label="Opens the upload source dialogue"]',    // English full match
    ],
    confirmed: true, // December 2025 - Updated
  },

  /** URL/Discover sources option (for adding URLs)
   * Discovered: "search_sparkDiscover sources" button
   * Locale note: aria-label text is locale-dependent */
  urlSourceOption: {
    primary: 'button[class*="url-source"], button[class*="discover"]', // Class: locale-independent
    fallbacks: [
      'button[aria-label*="Discover"]',     // English aria-label
      'button[aria-label*="URL" i]',        // "URL" is same in most languages
      'mat-chip[value="url"]',              // Angular Material value attribute
    ],
    confirmed: true, // December 2025
  },

  /** Text/Paste source option
   * Locale note: aria-label text is locale-dependent */
  textSourceOption: {
    primary: 'mat-chip[value="text"], button[value="text"]',     // Value attr: locale-independent
    fallbacks: [
      'button[aria-label*="Copied text"]',  // English aria-label
      'button[aria-label*="Paste"]',        // English
      'button[class*="text-source"]',       // Class: locale-independent
    ],
    confirmed: false,
  },

  /** File upload source option
   * Discovered: aria="Upload sources from your computer"
   * Locale note: aria-label text is locale-dependent */
  fileSourceOption: {
    primary: 'button[class*="upload"], input[type="file"] + button', // Class: locale-independent
    fallbacks: [
      'button[aria-label="Upload sources from your computer"]',   // English full match
      'button[aria-label*="Upload"]',       // English partial match
      'span[role="button"]',
    ],
    confirmed: true, // December 2025
  },

  /** URL input field — appears after clicking Website/URL source type
   *
   * Live DOM inspection April 2026 (ja locale):
   *   <textarea class="mat-mdc-input-element cdk-textarea-autosize query-box-textarea ..."
   *             aria-label="URL を入力"
   *             placeholder="リンクを貼り付ける"
   *             jslog="279306;track:impression,input_">
   *
   * NOTE: NotebookLM replaced the old `<input type="url">` with a `<textarea>`
   * (enables multi-URL paste + YouTube detection). The old primary selector
   * will never match the new UI.
   *
   * Locale-independent signals:
   *   1. `textarea[jslog^="279306"]` — Google tracking ID for this input
   *   2. `mat-dialog-container textarea` inside the URL sub-dialog
   *   3. aria-label matches "URL" (same word in most Latin locales + ja)
   */
  urlInput: {
    primary: 'textarea[jslog^="279306"]',                            // jslog: locale-independent
    fallbacks: [
      'mat-dialog-container textarea[aria-label*="URL" i]',          // Dialog-scoped aria
      'textarea[aria-label*="URL" i]',                                // Global aria fallback
      'textarea[placeholder*="リンク"]',                                // ja placeholder
      'textarea[placeholder*="link" i]',                              // en placeholder
      'textarea[placeholder*="URL"]',                                 // Placeholder "URL"
      'input[type="url"]',                                            // Legacy input tag
      'input[type="text"][placeholder*="http"]',                      // Legacy pattern
    ],
    confirmed: true, // April 2026
  },

  /** Website/URL source type button inside the Add source dialog
   *
   * Live DOM inspection April 2026 (ja locale):
   *   <button class="mdc-button ... drop-zone-icon-button mdc-button--outlined ..."
   *           jslog="279308;track:generic_click,impression">
   *     link video_youtube ウェブサイト
   *   </button>
   *
   * Locale-independent: jslog ID is stable across locales; Material icon names
   * (`link`, `video_youtube`) in textContent are also never translated.
   */
  urlSourceTypeButton: {
    primary: 'mat-dialog-container button[jslog^="279308"]',
    fallbacks: [
      'button[jslog^="279308"]',                                      // Global jslog
      'mat-dialog-container button.drop-zone-icon-button:has(mat-icon:text("link"))', // Icon-based
      'button[aria-label*="ウェブサイト"]',                             // ja
      'button[aria-label*="Website" i]',                              // en
      'button[aria-label*="URL" i]',                                  // en/ja URL
    ],
    confirmed: true, // April 2026
  },

  /** Text paste source type button inside the Add source dialog
   * jslog 279295 — "コピーしたテキスト" / "Copied text" */
  textSourceTypeButton: {
    primary: 'mat-dialog-container button[jslog^="279295"]',
    fallbacks: [
      'button[jslog^="279295"]',
      'mat-dialog-container button.drop-zone-icon-button:has(mat-icon:text("content_paste"))',
      'button[aria-label*="コピーしたテキスト"]',
      'button[aria-label*="Copied text" i]',
      'button[aria-label*="Paste"]',
    ],
    confirmed: true, // April 2026
  },

  /** File upload source type button inside the Add source dialog
   * jslog 279304 — "ファイルをアップロード" / "Upload files" */
  fileSourceTypeButton: {
    primary: 'mat-dialog-container button[jslog^="279304"]',
    fallbacks: [
      'button[jslog^="279304"]',
      'mat-dialog-container button.drop-zone-icon-button:has(mat-icon:text("upload"))',
      'button[aria-label*="ファイルをアップロード"]',
      'button[aria-label*="Upload" i]',
    ],
    confirmed: true, // April 2026
  },

  /** Google Drive source type button (read-only reference) — jslog 279299 */
  driveSourceTypeButton: {
    primary: 'mat-dialog-container button[jslog^="279299"]',
    fallbacks: [
      'button[jslog^="279299"]',
      'button[aria-label*="ドライブ"]',
      'button[aria-label*="Drive" i]',
    ],
    confirmed: true,
  },

  /** Insert/Submit button inside the URL sub-dialog (jslog 279307)
   * Disabled until a valid URL is typed; once enabled, click or press Enter. */
  urlInsertButton: {
    primary: 'mat-dialog-container button[jslog^="279307"]',
    fallbacks: [
      'button[jslog^="279307"]',
      'mat-dialog-container button:not([disabled])[class*="unelevated"]',
      'button[aria-label="挿入"]',
      'button[aria-label*="Insert" i]',
    ],
    confirmed: true,
  },

  /** Insert/Submit button inside the Text-paste sub-dialog (jslog 279297) */
  textInsertButton: {
    primary: 'mat-dialog-container button[jslog^="279297"]',
    fallbacks: [
      'button[jslog^="279297"]',
      'button[aria-label="挿入"]',
      'button[aria-label*="Insert" i]',
    ],
    confirmed: true,
  },

  /** Text input/paste area — appears after clicking "Copied text"
   *
   * Live DOM inspection April 2026 (ja locale):
   *   <textarea class="mat-mdc-input-element copied-text-input-textarea ..."
   *             aria-label="貼り付けたテキスト"
   *             placeholder="ここにテキストを貼り付けてください"
   *             jslog="279298;track:impression,input_">
   */
  textInput: {
    primary: 'textarea.copied-text-input-textarea',                  // Class: locale-independent
    fallbacks: [
      'textarea[jslog^="279298"]',                                   // jslog
      'mat-dialog-container textarea[aria-label*="貼り付け"]',         // ja
      'mat-dialog-container textarea[aria-label*="paste" i]',         // en
      'mat-dialog-container textarea[aria-label*="text" i]',          // en
      'textarea.text-area',                                           // Legacy
      'textarea[class*="text-area"]',                                 // Legacy partial
      'textarea.mat-mdc-form-field-textarea-control',                 // Angular Material
    ],
    confirmed: true, // April 2026
  },

  /** File input element
   * Discovered: "choose file" span triggers hidden input[type="file"]
   * Updated: December 2025 - dropzone UI */
  fileInput: {
    primary: 'input[type="file"]',
    fallbacks: [],
    confirmed: true, // December 2025
  },

  /** Choose file button in dropzone (December 2025 UI) */
  chooseFileButton: {
    primary: 'span.dropzone__file-dialog-button',
    fallbacks: [
      'span[xapscottyuploadertrigger]',        // Angular upload trigger attribute
      '[class*="file-dialog-button"]',          // Class rename resilience
      'button[class*="upload"][class*="trigger"]', // Generic upload trigger pattern
      'span[class*="file-dialog"]',             // Partial class match
      'a:text("choose file")',                  // Text-based (English, last resort)
    ],
    confirmed: true, // December 2025
  },

  /** Submit/Add button
   * Discovered: "Insert" button for text sources, "Submit" for chat */
  submitButton: {
    primary: 'button:has-text("Insert")', // Note: :has-text may not work, use insertButton for text
    fallbacks: [
      'button[type="submit"]',
      'button[aria-label="Submit"]',
      'button[aria-label*="Add"]',
    ],
    confirmed: true, // December 2025
  },

  /** Insert button - specifically for adding text sources */
  insertButton: {
    primary: 'button',  // Will need text-based matching
    fallbacks: [],
    confirmed: true, // December 2025
  },

  /** Close dialog button
   * Discovered: aria="Close dialogue" (British spelling)
   * Note: Google uses British "dialogue" — US "dialog" added as fallback */
  closeDialogButton: {
    primary: 'button[aria-label="Close dialogue"]',
    fallbacks: [
      'button[aria-label="Close dialog"]',  // US spelling variant
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
    ],
    confirmed: true, // December 2025
  },

  /** Processing/Loading indicator */
  processingIndicator: {
    primary: '[role="progressbar"]',
    fallbacks: [
      '[aria-label*="loading" i]',
      '[aria-label*="processing" i]',
      '.loading',
      '.spinner',
    ],
    confirmed: false,
  },

  /** Success indicator */
  successIndicator: {
    primary: '[aria-label*="success" i]',
    fallbacks: [
      '[data-status="complete"]',
      '.source-added',
    ],
    confirmed: false,
  },

  /** Error message element */
  errorMessage: {
    primary: '[role="alert"]',
    fallbacks: [
      '[aria-live="polite"]',
      '.error-message',
    ],
    confirmed: false,
  },

  /** Chat input (existing - for reference) */
  chatInput: {
    primary: 'textarea.query-box-input',
    fallbacks: [
      'textarea[aria-label]',           // Any textarea with aria-label (locale-agnostic)
      'textarea[class*="query"]',       // Class partial match
      '.chat-input textarea',           // Container-based
      'textarea[aria-label="Query box"]', // English-only, last resort
    ],
    confirmed: true,
  },
} as const;

export type SelectorKey = keyof typeof NOTEBOOKLM_SELECTORS;

/**
 * Get all selectors for a key (primary + fallbacks)
 */
export function getSelectors(key: SelectorKey): string[] {
  const info = NOTEBOOKLM_SELECTORS[key];
  return [info.primary, ...info.fallbacks].filter(Boolean);
}

/**
 * Try each selector until one matches
 */
export async function findElement(
  page: { $(selector: string): Promise<unknown | null> },
  key: SelectorKey
): Promise<unknown | null> {
  const selectors = getSelectors(key);

  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        return element;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Wait for any of the selectors to appear
 */
export async function waitForElement(
  page: {
    waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  },
  key: SelectorKey,
  options: { timeout?: number; state?: string } = {}
): Promise<unknown | null> {
  const selectors = getSelectors(key);
  const timeout = options.timeout || 10000;
  const state = options.state || "visible";

  // Try each selector with a fraction of the total timeout
  const perSelectorTimeout = Math.max(1000, timeout / selectors.length);

  for (const selector of selectors) {
    try {
      const element = await page.waitForSelector(selector, {
        timeout: perSelectorTimeout,
        state,
      });
      if (element) {
        return element;
      }
    } catch {
      continue;
    }
  }

  return null;
}
