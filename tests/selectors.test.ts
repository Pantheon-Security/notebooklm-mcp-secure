import { describe, it, expect, vi } from "vitest";
import { NOTEBOOKLM_SELECTORS, RESPONSE_SELECTORS } from "../src/notebook-creation/selectors.js";
import { waitForElement } from "../src/utils/page-utils.js";

describe("waitForElement", () => {
  it("uses the full deadline instead of splitting timeout once across selectors", async () => {
    const start = 1_000;
    let consumedMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + consumedMs);
    const page = {
      waitForSelector: vi.fn(async (selector: string, options?: { timeout?: number; state?: string }) => {
        consumedMs += options?.timeout ?? 0;

        if (selector.includes("Create new") && consumedMs >= 700) {
          return { selector };
        }

        throw new Error("not found");
      }),
    };

    const element = await waitForElement(page, "newNotebookButton", { timeout: 900 });

    expect(element).toEqual({ selector: 'button[aria-label="Create new notebook"]' });
    expect(page.waitForSelector).toHaveBeenCalled();
    expect(page.waitForSelector.mock.calls.length).toBeGreaterThan(3);
  });
});

describe("RESPONSE_SELECTORS", () => {
  it("keeps assistant response selectors centralized in notebook selectors", () => {
    expect(RESPONSE_SELECTORS).toContain(".to-user-container .message-text-content");
    expect(RESPONSE_SELECTORS.length).toBeGreaterThan(5);
  });
});

describe("NOTEBOOKLM_SELECTORS", () => {
  it("does not use non-standard text selector syntax in chooseFileButton fallbacks", () => {
    expect(NOTEBOOKLM_SELECTORS.chooseFileButton.fallbacks).not.toContain('a:text("choose file")');
  });

  it("does not use a generic textarea aria-label fallback for chat input", () => {
    expect(NOTEBOOKLM_SELECTORS.chatInput.fallbacks).not.toContain("textarea[aria-label]");
  });

  it("excludes source-discovery query textareas from text source selectors", () => {
    expect(NOTEBOOKLM_SELECTORS.textInput.primary).toContain(":not(.query-box-input)");
    expect(NOTEBOOKLM_SELECTORS.textInput.primary).toContain('[placeholder*="search the web" i]');
    expect(NOTEBOOKLM_SELECTORS.textInput.fallbacks.some((selector) => selector.includes("mat-dialog-container textarea"))).toBe(true);
  });
});
