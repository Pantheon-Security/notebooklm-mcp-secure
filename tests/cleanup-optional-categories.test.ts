/**
 * Regression gate: cleanup_data must not delete OPTIONAL categories
 * unconditionally (FX-018).
 *
 * getCleanupPaths marks three deep-mode categories `optional: true` — Claude
 * Projects Cache, Editor Logs, Trash Files. performCleanup only log.warning'd
 * about them and then deleted them like anything else.
 *
 * findClaudeProjects() globs ~/.claude/projects/*notebooklm-mcp* — the agent's
 * own conversation transcripts. That is data this server does not own, and
 * cleanup_data always runs in deep mode, so it was in scope on every confirmed
 * run.
 *
 * These tests build a real temp HOME with a Claude projects directory in it and
 * check what survives.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("FX-018 — optional cleanup categories are opt-in", () => {
  let homeDir: string;
  let claudeProject: string;
  const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NODE_ENV"] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-cleanup-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NODE_ENV = "test";

    // The agent's own conversation transcripts — matched by the
    // *notebooklm-mcp* glob in findClaudeProjects().
    claudeProject = path.join(homeDir, ".claude", "projects", "home-ross-notebooklm-mcp-secure");
    fs.mkdirSync(claudeProject, { recursive: true });
    fs.writeFileSync(
      path.join(claudeProject, "transcript.jsonl"),
      '{"role":"user","content":"a conversation this server does not own"}\n'
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function newManager() {
    const mod = await import("../src/utils/cleanup-manager.js");
    return new mod.CleanupManager();
  }

  it("still PREVIEWS optional categories so the user can opt in", async () => {
    // The preview must keep listing them — that is how the user learns they
    // exist. Only the deletion is gated.
    const manager = await newManager();
    const preview = await manager.getCleanupPaths("deep", false);

    const optional = preview.categories.filter(c => c.optional);
    expect(optional.length).toBeGreaterThan(0);
    expect(preview.totalPaths).toContain(claudeProject);
  });

  it("does NOT delete the Claude projects cache by default", async () => {
    const manager = await newManager();
    await manager.performCleanup("deep", false);

    expect(fs.existsSync(claudeProject)).toBe(true);
    expect(fs.existsSync(path.join(claudeProject, "transcript.jsonl"))).toBe(true);
  });

  it("reports a skipped optional category as zero deleted, not as deleted", async () => {
    const manager = await newManager();
    const result = await manager.performCleanup("deep", false);

    expect(result.deletedPaths).not.toContain(claudeProject);
    const summary = result.categorySummary["Claude Projects Cache"];
    if (summary) {
      expect(summary.count).toBe(0);
      expect(summary.bytes).toBe(0);
    }
  });

  it("DOES delete the Claude projects cache when explicitly requested", async () => {
    // Opting in must still work — this is a gate, not a removal.
    const manager = await newManager();
    await manager.performCleanup("deep", false, true);

    expect(fs.existsSync(claudeProject)).toBe(false);
  });

  it("keeps deleting non-optional categories by default", async () => {
    // Positive control: the server's OWN data is still cleaned without opt-in.
    const manager = await newManager();
    const preview = await manager.getCleanupPaths("deep", false);
    const required = preview.categories.filter(c => !c.optional && c.paths.length > 0);

    // Create a file inside the first required category path we can write to.
    const target = required[0]?.paths[0];
    if (target) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "owned.json"), "{}");

      const manager2 = await newManager();
      await manager2.performCleanup("deep", false);

      expect(fs.existsSync(target)).toBe(false);
    }
  });
});
