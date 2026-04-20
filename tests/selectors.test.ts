import { describe, it, expect, vi } from "vitest";
import { waitForElement } from "../src/notebook-creation/selectors.js";

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
