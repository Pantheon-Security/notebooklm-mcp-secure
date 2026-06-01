import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Timing helpers must be stubbed or the processing loops/delays hang the test.
vi.mock("../src/utils/stealth-utils.js", () => ({
  randomDelay: vi.fn().mockResolvedValue(undefined),
  humanType: vi.fn().mockResolvedValue(undefined),
}));

import { SourceManager } from "../src/notebook-creation/source-manager.js";
import { log } from "../src/utils/logger.js";

/**
 * These tests verify the SECURE behaviour of SourceManager:
 *
 *  1. Text sources are entered by setting the textarea value directly via
 *     page.evaluate with the value passed as a SERIALIZED argument — never via
 *     the OS clipboard (navigator.clipboard.writeText + Control+V), which leaked
 *     host clipboard data and corrupted sources when paste failed.
 *  2. addSource only reports status "ready" on a positive completion signal; an
 *     error alert ([role="alert"]) yields "failed", never a false "ready".
 *  3. removeSource resolves a positional index to a STABLE title identity and
 *     deletes by that identity, so the right source is targeted.
 *
 * The in-browser callback bodies passed to page.evaluate never execute under a
 * vi.fn mock, so we assert at the boundary: argument shape/values, resolved
 * identity, and returned status.
 */

function silenceLogs() {
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "success").mockImplementation(() => undefined);
  vi.spyOn(log, "warning").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.spyOn(log, "dim").mockImplementation(() => undefined);
  vi.spyOn(log, "debug").mockImplementation(() => undefined);
}

describe("SourceManager", () => {
  beforeEach(() => {
    silenceLogs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("text source entry uses the direct DOM-value path (not clipboard paste)", () => {
    it("sets the value via a serialized page.evaluate argument and never touches the OS clipboard", async () => {
      const sm = new SourceManager({} as never, {} as never);

      const SECRET = "private text the host must never leak to the clipboard";

      // Spies that MUST NOT be invoked by the secure path.
      const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
      const keyboardPress = vi.fn().mockResolvedValue(undefined);

      // page.evaluate is called for several distinct purposes during the text
      // flow. Key the mock on argument SHAPE, not call order, so the test does
      // not break if the implementation reorders internal steps:
      //   - selector validation: arg is a plain string selector  -> { matches: true }
      //   - set-value call:      arg is { selector, value }       -> true
      //   - option/insert clicks: arg is undefined                -> true
      const evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
        if (typeof arg === "string") {
          return { matches: true };
        }
        if (arg && typeof arg === "object" && "value" in (arg as Record<string, unknown>)) {
          return true;
        }
        return true;
      });

      const page = {
        evaluate,
        $: vi.fn().mockResolvedValue({ focus: vi.fn().mockResolvedValue(undefined) }),
        keyboard: { press: keyboardPress },
      };

      // Expose a clipboard spy on the global so we can prove it is never used.
      // vi.stubGlobal is used because `navigator` is a read-only getter in this
      // environment and cannot be assigned directly. It is auto-restored by
      // vi.restoreAllMocks()/unstubAllGlobals in afterEach.
      vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWriteText } });

      try {
        await (sm as unknown as {
          addTextSourceInternal(p: unknown, t: string, title?: string): Promise<void>;
        }).addTextSourceInternal(page as never, SECRET);
      } finally {
        vi.unstubAllGlobals();
      }

      // The secret text must have been handed to page.evaluate as a serialized
      // argument (the direct-value path), proving it was NOT string-interpolated
      // into the function body and NOT routed through the clipboard.
      const carriedAsArg = evaluate.mock.calls.some(
        (call) =>
          call[1] &&
          typeof call[1] === "object" &&
          (call[1] as { value?: unknown }).value === SECRET
      );
      expect(carriedAsArg).toBe(true);

      // Security guarantees: the OS clipboard was never written, and no
      // Control+V / paste keystroke was issued.
      expect(clipboardWriteText).not.toHaveBeenCalled();
      expect(keyboardPress).not.toHaveBeenCalled();
    });
  });

  describe("addSource reports an honest processing status", () => {
    it("returns 'ready' on a genuine success signal (no error alert, processing cleared)", async () => {
      const sm = new SourceManager({} as never, {} as never);

      // No error alert present.
      vi.spyOn(
        sm as unknown as { detectSourceErrorAlert(p: unknown): Promise<string | null> },
        "detectSourceErrorAlert"
      ).mockResolvedValue(null);

      // Processing indicator already cleared -> positive completion.
      const page = { evaluate: vi.fn().mockResolvedValue(false), waitForTimeout: vi.fn() };

      const status = await (sm as unknown as {
        waitForSourceProcessing(p: unknown, t?: number): Promise<string>;
      }).waitForSourceProcessing(page as never);

      expect(status).toBe("ready");
    });

    it("returns 'failed' (not a false 'ready') when an error alert is detected", async () => {
      const sm = new SourceManager({} as never, {} as never);

      // An error alert [role="alert"] is present.
      vi.spyOn(
        sm as unknown as { detectSourceErrorAlert(p: unknown): Promise<string | null> },
        "detectSourceErrorAlert"
      ).mockResolvedValue("error: source could not be processed");

      // Even if the spinner is gone, an error alert must win and yield "failed".
      const page = { evaluate: vi.fn().mockResolvedValue(false), waitForTimeout: vi.fn() };

      const status = await (sm as unknown as {
        waitForSourceProcessing(p: unknown, t?: number): Promise<string>;
      }).waitForSourceProcessing(page as never);

      expect(status).toBe("failed");
      expect(status).not.toBe("ready");
    });
  });

  describe("removeSource targets the source by stable identity, not raw index", () => {
    it("resolves the index to a title and deletes the source matching that title", async () => {
      const sm = new SourceManager({} as never, {} as never);

      const RESOLVED_TITLE = "My Important Doc";

      // page.evaluate serves three roles in removeSource; key on argument shape:
      //   - resolve identity: arg is the numeric index -> { title, duplicateCount: 1 }
      //   - click by title:   arg is the title string  -> "deleted"
      //   - confirm in dialog: no arg                   -> true
      const evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
        if (typeof arg === "number") {
          return { title: RESOLVED_TITLE, duplicateCount: 1 };
        }
        if (typeof arg === "string") {
          return "deleted";
        }
        return true;
      });

      const page = { evaluate, close: vi.fn().mockResolvedValue(undefined) };

      // Bypass the real navigateToNotebook goto/auth flow and inject our page.
      vi.spyOn(
        sm as unknown as { navigateToNotebook(url: string): Promise<unknown> },
        "navigateToNotebook"
      ).mockResolvedValue(page as never);

      const result = await sm.removeSource(
        "https://notebooklm.google.com/notebook/abc",
        "source-0"
      );

      expect(result.success).toBe(true);
      expect(result.removedId).toBe("source-0");

      // The click step must have been driven by the RESOLVED TITLE (identity),
      // not by the positional index — this is the security fix.
      const clickedByTitle = evaluate.mock.calls.some((call) => call[1] === RESOLVED_TITLE);
      expect(clickedByTitle).toBe(true);

      // And the numeric index was only used for the resolution step.
      const resolvedByIndex = evaluate.mock.calls.some((call) => typeof call[1] === "number");
      expect(resolvedByIndex).toBe(true);
    });

    it("refuses to delete when the identity is ambiguous (duplicate titles)", async () => {
      const sm = new SourceManager({} as never, {} as never);

      const evaluate = vi.fn(async (_fn: unknown, arg?: unknown) => {
        if (typeof arg === "number") {
          // Two sources share the same title prefix -> ambiguous.
          return { title: "Duplicate Title", duplicateCount: 2 };
        }
        return true;
      });

      const page = { evaluate, close: vi.fn().mockResolvedValue(undefined) };

      vi.spyOn(
        sm as unknown as { navigateToNotebook(url: string): Promise<unknown> },
        "navigateToNotebook"
      ).mockResolvedValue(page as never);

      const result = await sm.removeSource(
        "https://notebooklm.google.com/notebook/abc",
        "source-0"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Ambiguous");
      // Crucially, no click-by-title happened: nothing was deleted.
      const clickedByTitle = evaluate.mock.calls.some((call) => typeof call[1] === "string");
      expect(clickedByTitle).toBe(false);
    });
  });
});
