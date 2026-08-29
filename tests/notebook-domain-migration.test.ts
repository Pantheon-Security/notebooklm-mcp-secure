/**
 * Regression gate: Google migrated NotebookLM to notebook.google.com (FX-026).
 *
 * Verified live on 2026-08-13:
 *   curl -I https://notebooklm.google.com/  ->  301  ->  https://notebook.google.com/
 *
 * The old host is permanently redirected, so every place that hardcodes
 * `notebooklm.google.com` is now wrong in one of two ways:
 *
 *  - validateNotebookUrl REJECTS the live host outright, so ask_question and
 *    the session sink refuse every real notebook (this is the hard block);
 *  - auth-manager's `startsWith("https://notebooklm.google.com/")` checks never
 *    fire after the redirect, so a completed Google login goes undetected —
 *    which is exactly what happened to auth-now.mjs during the live test drive.
 *
 * The fix widens the host pattern to accept BOTH labels. It deliberately does
 * NOT loosen to *.google.com, which would undo FX-011 — the subdomain and
 * suffix attacks below must keep failing.
 */

import { describe, expect, it } from "vitest";
import { validateNotebookUrl, isNotebookLMUrl } from "../src/utils/security.js";

function accepts(url: string): boolean {
  try {
    validateNotebookUrl(url);
    return true;
  } catch {
    return false;
  }
}

describe("FX-026 — notebook.google.com is the live NotebookLM host", () => {
  describe("the new host must be accepted", () => {
    const valid = [
      "https://notebook.google.com/",
      "https://notebook.google.com/notebook/abc-123-def",
      "https://notebook.google.co.uk/",
      "https://notebook.google.de/notebook/xyz",
      "https://notebook.google.com.au/",
    ];

    for (const url of valid) {
      it(`accepts ${url}`, () => {
        expect(accepts(url)).toBe(true);
      });
    }
  });

  describe("the legacy host must keep working", () => {
    // The 301 is served by Google, not by us — a stored legacy URL must still
    // validate so existing libraries do not break.
    const legacy = [
      "https://notebooklm.google.com/",
      "https://notebooklm.google.com/notebook/abc-123-def",
      "https://notebooklm.google.co.uk/",
    ];

    for (const url of legacy) {
      it(`still accepts ${url}`, () => {
        expect(accepts(url)).toBe(true);
      });
    }
  });

  describe("FX-011's guarantees must survive the widening", () => {
    const hostile = [
      "https://notebook.google.attacker.com/",
      "https://notebooklm.google.attacker.com/",
      "https://evil.notebook.google.com/",
      "https://notebook.google.com.attacker.io/",
      "https://notebookgoogle.com/",
      "https://notebook-google.com/",
      "https://attacker.com/notebook.google.com",
      "http://notebook.google.com/",
    ];

    for (const url of hostile) {
      it(`still rejects ${url}`, () => {
        expect(accepts(url)).toBe(false);
      });
    }
  });

  describe("isNotebookLMUrl — the shared host check", () => {
    // auth-manager, notebook-nav and notebook-sync each had their own inline
    // startsWith("https://notebooklm.google.com/"). One implementation now, so
    // the next domain change is a one-line fix rather than a 20-site sweep.
    it("recognises both labels", () => {
      expect(isNotebookLMUrl("https://notebook.google.com/")).toBe(true);
      expect(isNotebookLMUrl("https://notebooklm.google.com/")).toBe(true);
      expect(isNotebookLMUrl("https://notebook.google.co.uk/notebook/x")).toBe(true);
    });

    it("rejects a lookalike host", () => {
      expect(isNotebookLMUrl("https://notebook.google.attacker.com/")).toBe(false);
      expect(isNotebookLMUrl("https://accounts.google.com/")).toBe(false);
    });

    it("does not throw on malformed input", () => {
      expect(isNotebookLMUrl("not a url")).toBe(false);
      expect(isNotebookLMUrl("")).toBe(false);
    });
  });
});
