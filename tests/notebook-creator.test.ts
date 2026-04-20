import { describe, it, expect, vi, afterEach } from "vitest";
import { NotebookCreator } from "../src/notebook-creation/notebook-creator.js";
import {
  NotebookCreationError,
  NotebookCreationErrorCode,
} from "../src/notebook-creation/errors.js";
import { log } from "../src/utils/logger.js";

describe("NotebookCreator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and falls back when networkidle load state times out", async () => {
    const creator = new NotebookCreator({} as never, {} as never);
    const warningSpy = vi.spyOn(log, "warning").mockImplementation(() => undefined);
    const page = {
      waitForLoadState: vi
        .fn()
        .mockRejectedValueOnce(new Error("networkidle timeout"))
        .mockResolvedValueOnce(undefined),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com"),
    };

    await creator["waitForNotebookReady"](page as never);

    expect(page.waitForLoadState).toHaveBeenNthCalledWith(1, "networkidle", { timeout: 15000 });
    expect(page.waitForLoadState).toHaveBeenNthCalledWith(2, "load", { timeout: 5000 });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("falling back to load");
  });

  it("throws a typed NotebookCreationError when the new notebook button cannot be clicked", async () => {
    const creator = new NotebookCreator({} as never, {} as never);
    const lastError = new Error("text fallback failed");
    creator["page"] = {
      $: vi.fn().mockRejectedValue(new Error("selector failed")),
      evaluate: vi.fn().mockRejectedValue(lastError),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com/home"),
    } as never;

    await expect(creator["clickNewNotebook"]()).rejects.toMatchObject({
      name: "NotebookCreationError",
      code: NotebookCreationErrorCode.CLICK_NEW_NOTEBOOK_FAILED,
      url: "https://notebooklm.google.com/home",
      cause: lastError,
    });
  });

  it("exposes a stable typed error surface", () => {
    const err = new NotebookCreationError("boom", {
      code: NotebookCreationErrorCode.CLICK_NEW_NOTEBOOK_FAILED,
      selector: "button[aria-label='Create new notebook']",
      url: "https://notebooklm.google.com/home",
      cause: new Error("inner"),
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(NotebookCreationErrorCode.CLICK_NEW_NOTEBOOK_FAILED);
    expect(err.selector).toContain("Create new notebook");
  });
});
