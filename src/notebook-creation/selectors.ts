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
   * Discovered: aria="Add source" with class "add-source-button" */
  addSourceButton: {
    primary: 'button[aria-label="Add source"]',
    fallbacks: [
      'button.add-source-button',
      'button[aria-label*="Add source"]',
      'button[aria-label="Opens the upload source dialogue"]',
    ],
    confirmed: true, // December 2025 - Updated
  },

  /** URL/Discover sources option (for adding URLs)
   * Discovered: "search_sparkDiscover sources" button */
  urlSourceOption: {
    primary: 'button[aria-label*="Discover"]',
    fallbacks: [],
    confirmed: true, // December 2025
  },

  /** Text/Paste source option */
  textSourceOption: {
    primary: 'button[aria-label*="Copied text"]',
    fallbacks: [
      'button[aria-label*="Paste"]',
      'button[aria-label*="text" i]',
    ],
    confirmed: false,
  },

  /** File upload source option
   * Discovered: aria="Upload sources from your computer" */
  fileSourceOption: {
    primary: 'button[aria-label="Upload sources from your computer"]',
    fallbacks: [
      'button[aria-label*="Upload"]',
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
      'span[xapscottyuploadertrigger]',
      'a:text("choose file")',
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
   * Discovered: aria="Close dialogue" */
  closeDialogButton: {
    primary: 'button[aria-label="Close dialogue"]',
    fallbacks: [
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
      'textarea[aria-label="Feld für Anfragen"]',
      'textarea[aria-label="Query box"]',
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
