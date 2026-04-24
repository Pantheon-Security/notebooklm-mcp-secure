import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/utils/stealth-utils.js", () => ({
  randomDelay: vi.fn().mockResolvedValue(undefined),
}));

import { NotebookCreator } from "../src/notebook-creation/notebook-creator.js";
import { NotebookNavigation } from "../src/notebook-creation/notebook-nav.js";
import {
  NotebookCreationError,
  NotebookCreationErrorCode,
} from "../src/notebook-creation/errors.js";
import { log } from "../src/utils/logger.js";

describe("NotebookNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and falls back when networkidle load state times out", async () => {
    const nav = new NotebookNavigation({} as never, {} as never);
    const warningSpy = vi.spyOn(log, "warning").mockImplementation(() => undefined);
    const page = {
      waitForLoadState: vi
        .fn()
        .mockRejectedValueOnce(new Error("networkidle timeout"))
        .mockResolvedValueOnce(undefined),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com"),
    };

    await nav.waitForNotebookReady(page as never);

    expect(page.waitForLoadState).toHaveBeenNthCalledWith(1, "networkidle", { timeout: 15000 });
    expect(page.waitForLoadState).toHaveBeenNthCalledWith(2, "load", { timeout: 5000 });
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy.mock.calls[0]?.[0]).toContain("falling back to load");
  });

  it("throws a typed NotebookCreationError when the new notebook button cannot be clicked", async () => {
    const nav = new NotebookNavigation({} as never, {} as never);
    const lastError = new Error("text fallback failed");
    nav["page"] = {
      context: vi.fn().mockReturnValue({}),
      $: vi.fn().mockRejectedValue(new Error("selector failed")),
      evaluate: vi.fn().mockRejectedValue(lastError),
      url: vi.fn().mockReturnValue("https://notebooklm.google.com/home"),
    } as never;
    nav["authManager"] = {
      validateWithRetry: vi.fn().mockResolvedValue(true),
    } as never;

    await expect(nav.clickNewNotebook()).rejects.toMatchObject({
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

describe("NotebookCreator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks created notebooks as partial when one or more sources fail", async () => {
    const creator = new NotebookCreator({} as never, {} as never);
    creator["navigation"] = {
      initialize: vi.fn().mockResolvedValue(undefined),
      clickNewNotebook: vi.fn().mockResolvedValue(undefined),
      validateCurrentAuth: vi.fn().mockResolvedValue(undefined),
      getCurrentPage: vi.fn(() => ({
        url: () => "https://notebooklm.google.com/notebook/abc123",
      })),
      setNotebookName: vi.fn().mockResolvedValue(undefined),
      finalizeAndGetUrl: vi.fn().mockResolvedValue("https://notebooklm.google.com/notebook/abc123"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as never;
    creator["sourceManager"] = {
      getSourceDescription: vi.fn((source) => source.value),
      addSource: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("upload failed")),
    } as never;

    const result = await creator.createNotebook({
      name: "Notebook",
      sources: [
        { type: "text", value: "ok" },
        { type: "text", value: "bad" },
      ],
    });

    expect(result.sourceCount).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.failedSources).toHaveLength(1);
  });

  it("revalidates auth before each source add in long notebook creation flows", async () => {
    const creator = new NotebookCreator({} as never, {} as never);
    const validateCurrentAuth = vi.fn().mockResolvedValue(undefined);
    creator["navigation"] = {
      initialize: vi.fn().mockResolvedValue(undefined),
      clickNewNotebook: vi.fn().mockResolvedValue(undefined),
      validateCurrentAuth,
      getCurrentPage: vi.fn(() => ({
        url: () => "https://notebooklm.google.com/notebook/abc123",
      })),
      setNotebookName: vi.fn().mockResolvedValue(undefined),
      finalizeAndGetUrl: vi.fn().mockResolvedValue("https://notebooklm.google.com/notebook/abc123"),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as never;
    creator["sourceManager"] = {
      getSourceDescription: vi.fn((source) => source.value),
      addSource: vi.fn().mockResolvedValue(undefined),
    } as never;

    await creator.createNotebook({
      name: "Notebook",
      sources: [
        { type: "text", value: "one" },
        { type: "text", value: "two" },
      ],
    });

    expect(validateCurrentAuth).toHaveBeenCalledTimes(2);
  });
});
