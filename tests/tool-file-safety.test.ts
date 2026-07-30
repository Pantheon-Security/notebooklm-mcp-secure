import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleExportLibrary } from "../src/tools/handlers/system.js";
import {
  handleAddFolder,
  handleAddSource,
  handleCreateNotebook,
} from "../src/tools/handlers/notebook-creation.js";
import { handleGetNotebookChatHistory } from "../src/tools/handlers/gemini.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";

afterEach(() => {
  delete process.env.NLMCP_EXPORT_DIR;
  delete process.env.NLMCP_FOLDER_ALLOWLIST;
});

describe("tool file path safety", () => {
  it("rejects export_library output paths outside the export base", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-export-"));
    process.env.NLMCP_EXPORT_DIR = exportDir;

    const ctx = {
      library: {
        listNotebooks: () => [],
        getStats: () => ({ total_notebooks: 0, total_queries: 0 }),
      },
    } as unknown as HandlerContext;

    const result = await handleExportLibrary(ctx, {
      format: "json",
      output_path: path.join(os.tmpdir(), "outside-export.json"),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inside/);
    expect(fs.existsSync(path.join(os.tmpdir(), "outside-export.json"))).toBe(false);

    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("allows export_library relative paths inside the export base", async () => {
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-export-"));
    process.env.NLMCP_EXPORT_DIR = exportDir;

    const ctx = {
      library: {
        listNotebooks: () => [],
        getStats: () => ({ total_notebooks: 0, total_queries: 0 }),
      },
    } as unknown as HandlerContext;

    const result = await handleExportLibrary(ctx, {
      format: "json",
      output_path: "library.json",
    });

    expect(result.success).toBe(true);
    expect(result.data?.file_path).toBe(path.join(exportDir, "library.json"));
    expect(fs.existsSync(path.join(exportDir, "library.json"))).toBe(true);

    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("rejects add_folder paths outside the folder allowlist before scanning", async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-folder-allow-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-folder-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "secret");
    process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

    const result = await handleAddFolder({} as HandlerContext, {
      folder_path: outsideDir,
      dry_run: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inside one of/);

    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects add_folder paths that traverse sensitive credential directories", async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-folder-allow-"));
    const sensitiveDir = path.join(allowedDir, ".ssh");
    fs.mkdirSync(sensitiveDir);
    fs.writeFileSync(path.join(sensitiveDir, "id_rsa"), "secret");
    process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

    const result = await handleAddFolder({} as HandlerContext, {
      folder_path: sensitiveDir,
      dry_run: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sensitive directory/);

    fs.rmSync(allowedDir, { recursive: true, force: true });
  });

  // FX-004/FX-005 — add_source and create_notebook accepted type:"file" with no
  // confinement at all, uploading any readable local file to Google at read scope.
  // add_folder (admin-scoped) enforced an allowlist; these read-scope siblings did not.
  describe("file-typed sources are confined (FX-005)", () => {
    it("rejects add_source file sources outside the allowlist", async () => {
      const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-allow-"));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-outside-"));
      const secret = path.join(outsideDir, "id_rsa");
      fs.writeFileSync(secret, "PRIVATE KEY");
      process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

      const result = await handleAddSource({} as HandlerContext, {
        notebook_url: "https://notebooklm.google.com/notebook/abc",
        source: { type: "file", value: secret },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/inside one of|sensitive directory/);

      fs.rmSync(allowedDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it("rejects add_source file sources traversing sensitive credential dirs", async () => {
      const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-allow-"));
      const sshDir = path.join(allowedDir, ".ssh");
      fs.mkdirSync(sshDir);
      const secret = path.join(sshDir, "id_rsa");
      fs.writeFileSync(secret, "PRIVATE KEY");
      process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

      const result = await handleAddSource({} as HandlerContext, {
        notebook_url: "https://notebooklm.google.com/notebook/abc",
        source: { type: "file", value: secret },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sensitive directory/);

      fs.rmSync(allowedDir, { recursive: true, force: true });
    });

    it("rejects create_notebook file sources outside the allowlist", async () => {
      const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-allow-"));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-outside-"));
      const secret = path.join(outsideDir, "credentials");
      fs.writeFileSync(secret, "aws_secret_access_key = x");
      process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

      const result = await handleCreateNotebook({} as HandlerContext, {
        name: "x",
        sources: [{ type: "file", value: secret }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/inside one of|sensitive directory/);

      fs.rmSync(allowedDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it("still accepts a file source inside the allowlist", async () => {
      const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-src-allow-"));
      const doc = path.join(allowedDir, "notes.md");
      fs.writeFileSync(doc, "# notes");
      process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

      const result = await handleAddSource({} as HandlerContext, {
        notebook_url: "https://notebooklm.google.com/notebook/abc",
        source: { type: "file", value: doc },
      });

      // The path guard must not be what rejects this one. It will still fail
      // later (no real browser/ctx), but never with a confinement error.
      if (!result.success) {
        expect(result.error).not.toMatch(/inside one of|sensitive directory/);
      }

      fs.rmSync(allowedDir, { recursive: true, force: true });
    });
  });

  // FX-006 — get_notebook_chat_history wrote to any caller-supplied absolute
  // path with no confinement and no mode. Sibling writers (export_library,
  // download_audio) confine to an export base; this one did not.
  describe("chat-history export is confined (FX-006)", () => {
    it("rejects output_file outside the export base before doing any work", async () => {
      const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-export-"));
      process.env.NLMCP_EXPORT_DIR = exportDir;
      const target = path.join(os.tmpdir(), `nlmcp-escape-${process.pid}.json`);

      const result = await handleGetNotebookChatHistory({} as HandlerContext, {
        notebook_url: "https://notebooklm.google.com/notebook/abc",
        output_file: target,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/inside/);
      expect(fs.existsSync(target)).toBe(false);

      fs.rmSync(exportDir, { recursive: true, force: true });
    });
  });
});
