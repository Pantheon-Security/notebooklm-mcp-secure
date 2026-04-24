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

import { log } from "../utils/logger.js";

/**
 * CSS selectors to find assistant response elements.
 * Keep NotebookLM selector knowledge in this module so UI drift is audited in
 * one place.
 */
export const RESPONSE_SELECTORS = [
  ".to-user-container .message-text-content",
  "[data-message-author='bot']",
  "[data-message-author='assistant']",
  "[data-message-role='assistant']",
  "[data-author='assistant']",
  "[data-renderer*='assistant']",
  "[data-automation-id='response-text']",
  "[data-automation-id='assistant-response']",
  "[data-automation-id='chat-response']",
  "[data-testid*='assistant']",
  "[data-testid*='response']",
  "[aria-live='polite']",
  "[role='listitem'][data-message-author]",
] as const;

export const NOTEBOOKLM_SELECTORS = {
  /** New notebook / Create button on homepage
   * Discovered: "addCreate new" with aria="Create new notebook" */
  newNotebookButton: {
    primary: 'button[aria-label="Create new notebook"]',
    fallbacks: [
      'button[aria-label*="Create new"]',
      'button[aria-label*="Create"]',
    ],
    confirmed: true, // December 2025
  },

  /** Notebook name input field
   * Note: NotebookLM auto-creates notebook with default name.
   * Name can be edited later via the title element.
   * Primary is scoped to an Angular Material dialog to avoid matching
   * random text inputs elsewhere on the page. */
  notebookNameInput: {
    primary: 'mat-dialog-container input[type="text"]',
    fallbacks: [
      '[role="dialog"] input[type="text"]',
      'mat-dialog-container [contenteditable="true"]',
      'input[aria-label*="name" i]',
      'input[aria-label*="title" i]',
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

  /** URL input field - appears after clicking Discover sources */
  urlInput: {
    primary: 'input[type="url"]',
    fallbacks: [
      'input[type="text"][placeholder*="URL"]',
      'input[type="text"][placeholder*="http"]',
      'input[aria-label*="URL"]',
      'textarea[placeholder*="URL"]',
    ],
    confirmed: false,
  },

  /** Text input/paste area - appears after clicking "Copied text"
   * Discovered: class contains "text-area" */
  textInput: {
    primary: 'textarea.text-area',
    fallbacks: [
      'textarea[class*="text-area"]',
      'textarea.mat-mdc-form-field-textarea-control',
      'textarea:not([readonly]):not(.query-box-input)',
    ],
    confirmed: true, // December 2025
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
      'a[aria-label*="choose file" i]',         // Standard selector, English fallback
      'a[href][class*="file"]',                 // Generic link fallback
    ],
    confirmed: true, // December 2025
  },

  /** Submit/Add button — scoped to Angular Material dialog actions so we
   * don't match arbitrary submit buttons elsewhere on the page.
   * Discovered: "Insert" button for text sources, "Submit" for chat.
   * Text-engine (:has-text) kept as fallback for locale-agnostic routes. */
  submitButton: {
    primary: 'mat-dialog-actions button[type="submit"]',
    fallbacks: [
      '[role="dialog"] button[type="submit"]',
      'mat-dialog-actions button[color="primary"]',
      'button[type="submit"]',
      'button:has-text("Insert")',
      'button[aria-label="Submit"]',
      'button[aria-label*="Add"]',
    ],
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
      'textarea[aria-label][class*="query"]', // Aria + query class scope
      '.chat-input textarea[aria-label]', // Container-scoped aria fallback
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
    } catch (err) {
      log.debug(`selector not found (${selector}): ${err instanceof Error ? err.message : String(err)}`);
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
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }

      try {
        const element = await page.waitForSelector(selector, {
          timeout: Math.max(1, Math.min(remaining, 250)),
          state,
        });
        if (element) {
          return element;
        }
      } catch (err) {
        log.debug(`waitForElement: ${selector} timed out: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return null;
}
