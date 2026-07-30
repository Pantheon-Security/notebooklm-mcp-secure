/**
 * Regression gate: stored-URL safety (FX-007 / FX-008).
 *
 * add_notebook persisted args.url with no validation, while its sibling
 * update_notebook validated the same field. The stored URL is later resolved
 * by ask_question via notebook_id and handed to SessionManager, whose only
 * gate was startsWith("http") — so the shared, Google-authenticated browser
 * would navigate to an attacker-controlled page and scrape it back as the
 * notebook's "answer".
 *
 * FX-007 — add_notebook validates the URL at write time
 * FX-008 — SessionManager rejects non-NotebookLM URLs at the sink
 */

import { describe, it, expect, vi } from "vitest";
import { handleAddNotebook } from "../src/tools/handlers/notebook-management.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";
import { SessionManager } from "../src/session/session-manager.js";

const HOSTILE = "https://attacker.example/phish";

describe("stored URL safety", () => {
  describe("FX-007 — add_notebook validates at write time", () => {
    it("rejects a non-NotebookLM URL and never reaches the library", async () => {
      const addNotebook = vi.fn();
      const ctx = { library: { addNotebook } } as unknown as HandlerContext;

      const result = await handleAddNotebook(ctx, {
        url: HOSTILE,
        name: "x",
        description: "x",
        topics: [],
      });

      expect(result.success).toBe(false);
      expect(addNotebook).not.toHaveBeenCalled();
    });

    it("still accepts a genuine NotebookLM URL", async () => {
      const addNotebook = vi.fn((a: { url: string }) => ({ id: "n1", ...a }));
      const ctx = { library: { addNotebook } } as unknown as HandlerContext;

      const result = await handleAddNotebook(ctx, {
        url: "https://notebooklm.google.com/notebook/abc123",
        name: "x",
        description: "x",
        topics: [],
      });

      expect(result.success).toBe(true);
      expect(addNotebook).toHaveBeenCalledTimes(1);
    });
  });

  describe("FX-008 — SessionManager rejects hostile URLs at the sink", () => {
    const makeManager = (): SessionManager =>
      new SessionManager({} as unknown as ConstructorParameters<typeof SessionManager>[0]);

    it("refuses to open a session for a non-NotebookLM URL", async () => {
      await expect(
        makeManager().getOrCreateSession(undefined, HOSTILE)
      ).rejects.toThrow(/notebooklm|not allowed|invalid/i);
    });

    it("still refuses a non-absolute URL", async () => {
      await expect(
        makeManager().getOrCreateSession(undefined, "notanurl")
      ).rejects.toThrow();
    });
  });
});
