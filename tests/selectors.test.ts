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

    const element = await waitForElement(page, "newNotebookButton", { timeout: 1150 }); // 4 selectors x 250ms, then the primary retry lands past the 700ms mark

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

  it("carries locale-independent fallbacks for every control the English aria-labels gate", () => {
    const all = (key: keyof typeof NOTEBOOKLM_SELECTORS) =>
      [NOTEBOOKLM_SELECTORS[key].primary, ...NOTEBOOKLM_SELECTORS[key].fallbacks].join("\n");
    expect(all("newNotebookButton")).toContain('mat-icon:text-is("add_2")');
    expect(all("addSourceButton")).toContain('mat-icon:text-is("add_2")');
    expect(all("textSourceOption")).toContain('jslog^="279295"');
    expect(all("fileSourceOption")).toContain('jslog^="279304"');
    expect(all("textInput")).toContain("textarea.copied-text-input-textarea");
    expect(all("closeDialogButton")).toContain("button.close-button");
  });

  it("does not hardcode any German UI string", () => {
    const everything = JSON.stringify(NOTEBOOKLM_SELECTORS);
    for (const word of ["Neues Notebook", "Quelle hinzufügen", "Dateien hochladen", "Kopierter Text", "Schließen", "Feld für Anfragen"]) {
      expect(everything).not.toContain(word);
    }
  });
});
