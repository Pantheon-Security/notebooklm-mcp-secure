import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-notebook-library-test-")),
  };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      dataDir: TMP_ROOT,
      configDir: TMP_ROOT,
      // Ensure no default notebook is auto-created by createDefaultLibrary
      notebookUrl: "",
      notebookDescription: "General knowledge base - configure NOTEBOOK_DESCRIPTION to help Claude understand what's in this notebook",
    },
    getConfig: () => ({
      ...actual.CONFIG,
      dataDir: TMP_ROOT,
      configDir: TMP_ROOT,
      notebookUrl: "",
      notebookDescription: "General knowledge base - configure NOTEBOOK_DESCRIPTION to help Claude understand what's in this notebook",
    }),
  };
});

import { NotebookLibrary } from "../src/library/notebook-library.js";
import type { AddNotebookInput } from "../src/library/types.js";

const SAMPLE_INPUT: AddNotebookInput = {
  url: "https://notebooklm.google.com/notebook/abc123",
  name: "Test Notebook",
  description: "A notebook for testing purposes",
  topics: ["testing", "vitest"],
  content_types: ["documentation"],
  use_cases: ["Running unit tests"],
  tags: ["test"],
};

function makeLibrary(): NotebookLibrary {
  return new NotebookLibrary();
}

describe("NotebookLibrary", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
  });

  // ─── 1. addNotebook ───────────────────────────────────────────────────────

  it("addNotebook persists to disk and returns the notebook object", () => {
    const lib = makeLibrary();
    const notebook = lib.addNotebook(SAMPLE_INPUT);

    // Returned object has correct fields
    expect(notebook.name).toBe("Test Notebook");
    expect(notebook.url).toBe(SAMPLE_INPUT.url);
    expect(notebook.description).toBe(SAMPLE_INPUT.description);
    expect(notebook.topics).toEqual(["testing", "vitest"]);
    expect(typeof notebook.id).toBe("string");
    expect(notebook.id.length).toBeGreaterThan(0);

    // File was written
    const libraryPath = lib.getLibraryPath();
    expect(fs.existsSync(libraryPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(libraryPath, "utf-8")) as {
      notebooks: Array<{ id: string; name: string }>;
    };
    expect(raw.notebooks).toHaveLength(1);
    expect(raw.notebooks[0]?.id).toBe(notebook.id);
    expect(raw.notebooks[0]?.name).toBe("Test Notebook");
  });

  // ─── 2. getNotebook ───────────────────────────────────────────────────────

  it("getNotebook retrieves by ID and returns null for unknown ID", () => {
    const lib = makeLibrary();
    const notebook = lib.addNotebook(SAMPLE_INPUT);

    const found = lib.getNotebook(notebook.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(notebook.id);

    expect(lib.getNotebook("does-not-exist")).toBeNull();
  });

  // ─── 3. listNotebooks ─────────────────────────────────────────────────────

  it("listNotebooks returns all entries", () => {
    const lib = makeLibrary();

    expect(lib.listNotebooks()).toHaveLength(0);

    lib.addNotebook(SAMPLE_INPUT);
    lib.addNotebook({ ...SAMPLE_INPUT, name: "Second Notebook" });

    const all = lib.listNotebooks();
    expect(all).toHaveLength(2);
    const names = all.map((n) => n.name);
    expect(names).toContain("Test Notebook");
    expect(names).toContain("Second Notebook");
  });

  // ─── 4. setActiveNotebook / getActiveNotebook ─────────────────────────────

  it("selectNotebook / getActiveNotebook round-trip", () => {
    const lib = makeLibrary();
    const first = lib.addNotebook(SAMPLE_INPUT);
    const second = lib.addNotebook({ ...SAMPLE_INPUT, name: "Second Notebook" });

    // First notebook is auto-activated when it's the only one
    expect(lib.getActiveNotebook()?.id).toBe(first.id);

    // Switch to second
    lib.selectNotebook(second.id);
    expect(lib.getActiveNotebook()?.id).toBe(second.id);

    // Switch back
    lib.selectNotebook(first.id);
    expect(lib.getActiveNotebook()?.id).toBe(first.id);
  });

  it("selectNotebook throws for unknown ID", () => {
    const lib = makeLibrary();
    expect(() => lib.selectNotebook("ghost")).toThrow("Notebook not found: ghost");
  });

  // ─── 5. removeNotebook ────────────────────────────────────────────────────

  it("removeNotebook removes the entry; subsequent getNotebook returns null", () => {
    const lib = makeLibrary();
    const notebook = lib.addNotebook(SAMPLE_INPUT);

    const removed = lib.removeNotebook(notebook.id);
    expect(removed).toBe(true);

    expect(lib.getNotebook(notebook.id)).toBeNull();
    expect(lib.listNotebooks()).toHaveLength(0);
  });

  it("removeNotebook returns false for unknown ID", () => {
    const lib = makeLibrary();
    expect(lib.removeNotebook("ghost")).toBe(false);
  });

  it("removeNotebook clears active_notebook_id when the active notebook is removed", () => {
    const lib = makeLibrary();
    const notebook = lib.addNotebook(SAMPLE_INPUT);
    expect(lib.getActiveNotebook()?.id).toBe(notebook.id);

    lib.removeNotebook(notebook.id);
    expect(lib.getActiveNotebook()).toBeNull();
  });

  // ─── 6. Disk round-trip ───────────────────────────────────────────────────

  it("second NotebookLibrary instance loads the previously saved notebook", () => {
    const lib1 = makeLibrary();
    const notebook = lib1.addNotebook(SAMPLE_INPUT);

    // Construct a fresh instance pointing to the same temp dir
    const lib2 = makeLibrary();

    const found = lib2.getNotebook(notebook.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(notebook.id);
    expect(found?.name).toBe("Test Notebook");
    expect(found?.url).toBe(SAMPLE_INPUT.url);

    expect(lib2.listNotebooks()).toHaveLength(1);
  });

  // ─── 7. getStats ─────────────────────────────────────────────────────────

  it("getStats returns correct counts after add/remove", () => {
    const lib = makeLibrary();

    // Empty library
    let stats = lib.getStats();
    expect(stats.total_notebooks).toBe(0);
    expect(stats.active_notebook).toBeNull();
    expect(stats.total_queries).toBe(0);

    // After two adds
    const first = lib.addNotebook(SAMPLE_INPUT);
    lib.addNotebook({ ...SAMPLE_INPUT, name: "Second Notebook" });

    stats = lib.getStats();
    expect(stats.total_notebooks).toBe(2);
    expect(stats.active_notebook).toBe(first.id); // first was auto-set active
    expect(stats.total_queries).toBe(0);

    // After removing one
    lib.removeNotebook(first.id);
    stats = lib.getStats();
    expect(stats.total_notebooks).toBe(1);
    expect(typeof stats.last_modified).toBe("string");
  });
});
