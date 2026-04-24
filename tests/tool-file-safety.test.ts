import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleExportLibrary } from "../src/tools/handlers/system.js";
import { handleAddFolder } from "../src/tools/handlers/notebook-creation.js";
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
});
