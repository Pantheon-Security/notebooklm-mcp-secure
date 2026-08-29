/**
 * Regression gate: tool-schema URL patterns must track the live host (FX-027).
 *
 * FX-015 made every declared `inputSchema` load-bearing at dispatch. FX-026
 * then moved the product to notebook.google.com — but only in
 * validateNotebookUrl, not in the 14 `pattern:` declarations scattered across
 * src/tools/definitions/. The result was a tool that passed its own URL
 * validator and was still refused a layer earlier:
 *
 *   add_notebook -> "Invalid input for add_notebook: url does not match the
 *                    required format"
 *
 * Found by driving the built server against Ross's real notebooks, not by any
 * unit test — the two fixes were individually correct and only interacted
 * wrongly in production.
 *
 * This gate walks the SHIPPED definitions rather than hardcoding a list, so a
 * new tool that declares a notebook-URL pattern is covered the day it lands.
 */

import { describe, expect, it } from "vitest";
import { buildToolDefinitions } from "../src/tools/index.js";
import { NotebookLibrary } from "../src/library/notebook-library.js";

interface SchemaNode {
  type?: string;
  pattern?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

/** Every (toolName, propertyPath, pattern) triple in the shipped schemas. */
function collectPatterns(): Array<{ tool: string; path: string; pattern: string }> {
  const found: Array<{ tool: string; path: string; pattern: string }> = [];
  const tools = buildToolDefinitions(new NotebookLibrary());

  const walk = (tool: string, node: SchemaNode | undefined, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.pattern === "string") {
      found.push({ tool, path, pattern: node.pattern });
    }
    if (node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(tool, child, path ? `${path}.${key}` : key);
      }
    }
    if (node.items) walk(tool, node.items, `${path}[]`);
  };

  for (const tool of tools) {
    walk(tool.name, tool.inputSchema as SchemaNode, "");
  }
  return found;
}

/** Patterns that are clearly about a NotebookLM URL, not a filesystem path. */
function notebookUrlPatterns() {
  return collectPatterns().filter(p => /google/i.test(p.pattern));
}

describe("FX-027 — shipped schema URL patterns accept the live host", () => {
  it("finds notebook-URL patterns to check (guards against a vacuous pass)", () => {
    // If this ever hits zero the suite below would pass by asserting nothing.
    expect(notebookUrlPatterns().length).toBeGreaterThan(0);
  });

  const LIVE = "https://notebook.google.com/notebook/ab8c4613-a575-4cfa-8811-af70d2f6aaac";
  const LEGACY = "https://notebooklm.google.com/notebook/ab8c4613-a575-4cfa-8811-af70d2f6aaac";

  it("every notebook-URL pattern accepts the CURRENT host", () => {
    const failures = notebookUrlPatterns().filter(
      p => !new RegExp(p.pattern).test(LIVE)
    );
    expect(
      failures.map(f => `${f.tool}.${f.path} (${f.pattern})`),
      "these schema patterns reject the live notebook.google.com host"
    ).toEqual([]);
  });

  it("every notebook-URL pattern still accepts the LEGACY host", () => {
    // Stored library entries and existing client calls still carry it.
    const failures = notebookUrlPatterns().filter(
      p => !new RegExp(p.pattern).test(LEGACY)
    );
    expect(
      failures.map(f => `${f.tool}.${f.path} (${f.pattern})`),
      "these schema patterns reject the legacy host"
    ).toEqual([]);
  });

  it("no notebook-URL pattern admits a lookalike host", () => {
    // The widening must not turn into "any google-ish string".
    const hostile = [
      "https://notebook.google.attacker.com/notebook/x",
      "https://evil.notebook.google.com/notebook/x",
      "http://notebook.google.com/notebook/x",
      "https://notebookgoogle.com/notebook/x",
    ];
    const admitted: string[] = [];
    for (const p of notebookUrlPatterns()) {
      for (const url of hostile) {
        if (new RegExp(p.pattern).test(url)) {
          admitted.push(`${p.tool}.${p.path} admits ${url}`);
        }
      }
    }
    expect(admitted).toEqual([]);
  });

  it("schema descriptions do not advertise the retired host", () => {
    // A description telling the caller to use notebooklm.google.com is now
    // actively misleading guidance for an LLM client.
    const tools = buildToolDefinitions(new NotebookLibrary());
    const stale: string[] = [];
    const walk = (tool: string, node: unknown, path: string): void => {
      if (!node || typeof node !== "object") return;
      const n = node as { description?: string; properties?: Record<string, unknown> };
      if (typeof n.description === "string" && n.description.includes("notebooklm.google.com")) {
        stale.push(`${tool}.${path}`);
      }
      if (n.properties) {
        for (const [key, child] of Object.entries(n.properties)) {
          walk(tool, child, path ? `${path}.${key}` : key);
        }
      }
    };
    for (const tool of tools) walk(tool.name, tool.inputSchema, "");
    expect(stale).toEqual([]);
  });
});
