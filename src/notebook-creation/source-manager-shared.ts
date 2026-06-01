/**
 * Source Manager — shared primitives
 *
 * Helpers genuinely shared between the two source managers in
 * `source-manager.ts`:
 *   - SourceManager                  (legacy: list/add/remove on an existing
 *                                     notebook)
 *   - NotebookCreationSourceManager  (the creation flow)
 *
 * Only logic that is byte-equivalent between the two classes lives here; the
 * managers' distinct flows (source-type selection, submit/insert clicks, error
 * alert handling, waitForSourceProcessing) intentionally differ and stay in
 * place. These helpers are a pure de-duplication and are behavior-preserving.
 */

import type { Page } from "patchright";
import { log } from "../utils/logger.js";
import { getSelectors } from "./selectors.js";

// DOM-context typing pattern used inside page.evaluate callbacks. These are
// type-only (erased at compile time), so sharing them via `import type` does not
// affect the runtime behavior of any evaluate body.

export type BrowserDomElement = unknown;

export type BrowserSourceItem = {
  textContent?: string | null;
  className?: string;
  id?: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): BrowserDomElement | null;
  click(): void;
};

export type BrowserVisibleElement = {
  textContent?: string | null;
  className?: string;
  offsetParent?: unknown;
  parentElement?: BrowserVisibleElement | null;
  getAttribute(name: string): string | null;
  click(): void;
};

export type BrowserTextVisibleElement = BrowserVisibleElement & {
  className?: string;
};

export type BrowserTextAreaCandidate = BrowserVisibleElement & {
  value?: string;
};

export type BrowserInnerTextHandle = {
  innerText(): Promise<string>;
};

export type BrowserDocumentContext = {
  document: {
    querySelector(selector: string): BrowserDomElement | null;
    querySelectorAll(selector: string): Iterable<BrowserDomElement>;
  };
  window: {
    innerWidth: number;
  };
};

/**
 * Find the first `textInput` selector that resolves to a visible textarea which
 * is NOT the "discover sources" / "search the web" / query-box control.
 *
 * This is the exact, equivalent logic that both SourceManager and
 * NotebookCreationSourceManager used (their two private copies differed only in
 * an unused `rejected` field and the debug-log wording — callers read only the
 * boolean match). The three exclusion substrings are kept byte-identical.
 *
 * @param debugLabel preserves each caller's original debug log line verbatim.
 */
export async function findValidTextInputSelector(
  page: Page,
  debugLabel: string
): Promise<string | null> {
  for (const selector of getSelectors("textInput")) {
    try {
      const state = await page.evaluate((targetSelector) => {
        const browser = globalThis as unknown as BrowserDocumentContext;
        const textarea = browser.document.querySelector(targetSelector) as BrowserTextAreaCandidate | null;
        if (!textarea || textarea.offsetParent === null) {
          return { matches: false };
        }

        const aria = textarea.getAttribute("aria-label")?.toLowerCase() || "";
        const placeholder = textarea.getAttribute("placeholder")?.toLowerCase() || "";
        const className = textarea.className?.toLowerCase() || "";
        const haystack = `${aria} ${placeholder} ${className}`;

        return {
          matches: !haystack.includes("discover sources") &&
            !haystack.includes("search the web") &&
            !haystack.includes("query-box"),
        };
      }, selector);

      if (state.matches) {
        return selector;
      }
    } catch (err) {
      log.debug(`${debugLabel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}

/**
 * Set the text-source content via the direct DOM-value path only.
 * The value is passed as a serialized page.evaluate argument (never
 * string-interpolated). We deliberately do NOT use the OS copy/paste
 * buffer: writing to it leaks/overwrites the host's copied data and, when
 * the relevant browser permission is denied (common in headless), a paste
 * keystroke would inject STALE buffered contents and corrupt the source.
 *
 * This is the byte-identical evaluate block both classes used. The differing
 * focus/click step that precedes it (textArea.focus() in the legacy manager,
 * textarea.click() in the creation manager) stays with each caller.
 */
export async function setTextSourceValue(
  page: Page,
  selector: string,
  value: string
): Promise<void> {
  await page.evaluate(({ selector, value }) => {
    const browser = globalThis as unknown as {
      document: {
        querySelector(target: string): {
          value?: string;
          textContent?: string | null;
          dispatchEvent(event: unknown): boolean;
          focus(): void;
        } | null;
      };
      Event: new (type: string, options?: { bubbles?: boolean }) => unknown;
    };

    const textarea = browser.document.querySelector(selector);
    if (!textarea) return false;

    textarea.focus();
    if (typeof textarea.value === "string") {
      textarea.value = value;
    } else {
      textarea.textContent = value;
    }

    textarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new browser.Event("change", { bubbles: true }));
    return true;
  }, { selector, value });
}
