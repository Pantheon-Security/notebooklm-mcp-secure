/**
 * Regression gate: an erasure certificate must distinguish "erased and
 * confirmed gone" from "there was never a file here" (FX-024).
 *
 * eraseFile() returned {deleted:false, size:0, verified:true} on ENOENT. Both
 * outcomes therefore read as verified in the GDPR Art.17 record, with nothing
 * marking which one actually happened.
 *
 * `verified` deliberately STAYS true for an absent file — an absent file holds
 * no data, so the erasure claim is sound, and flipping it to false would make a
 * clean install report an unverified erasure, which is a worse falsehood. The
 * fix is to record the fact separately, via paths_absent.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ErasureResultLike {
  data_type: string;
  path: string;
  items_deleted: number;
  size_bytes: number;
  verified: boolean;
  paths_absent?: string[];
}

describe("FX-024 — absent paths are recorded, not silently reported as erased", () => {
  let homeDir: string;
  let dataDir: string;
  const envKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NLMCP_QUERY_LOG_DIR",
    "NODE_ENV",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-erasure-"));
    dataDir = path.join(homeDir, ".local", "share", "notebooklm-mcp");
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function eraseNotebooks(): Promise<ErasureResultLike> {
    const mod = await import("../src/compliance/data-erasure.js");
    const { CONFIG } = await import("../src/config.js");
    const manager = mod.getDataErasureManager();
    // eraseNotebooks is private; reach it through the erasure entry point the
    // DSAR path uses, then pick out the notebook_library result.
    const results = (await (
      manager as unknown as {
        eraseNotebooks: (config: unknown) => Promise<ErasureResultLike>;
      }
    ).eraseNotebooks(CONFIG)) as ErasureResultLike;
    return results;
  }

  it("marks a library.json that was never there as absent", async () => {
    // No library.json written — the file does not exist.
    const result = await eraseNotebooks();

    expect(result.items_deleted).toBe(0);
    expect(result.paths_absent).toBeDefined();
    expect(result.paths_absent?.some(p => p.endsWith("library.json"))).toBe(true);
  });

  it("does not mark a library.json that WAS erased as absent", async () => {
    fs.writeFileSync(path.join(dataDir, "library.json"), JSON.stringify({ notebooks: [] }));

    const result = await eraseNotebooks();

    expect(result.items_deleted).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.paths_absent ?? []).not.toContain(path.join(dataDir, "library.json"));
  });

  it("keeps verified true for an absent file", async () => {
    // An absent file holds no data, so the erasure claim still holds. This
    // pins the deliberate choice not to flip verified to false.
    const result = await eraseNotebooks();
    expect(result.verified).toBe(true);
  });
});
