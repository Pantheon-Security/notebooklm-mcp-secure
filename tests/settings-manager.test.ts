/**
 * Unit tests for SettingsManager (src/utils/settings-manager.ts).
 *
 * Covers default settings, persistence via saveSettings, getEffectiveSettings,
 * filterTools with profile + disabledTools gates, and disk round-trip with a
 * second SettingsManager instance.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted temp dir shared across all vi.mock factories.
const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-settings-manager-test-")),
  };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
    getConfig: () => ({ ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT }),
  };
});

import { SettingsManager } from "../src/utils/settings-manager.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Helper: build a minimal Tool stub. */
function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" as const, properties: {} },
  };
}

describe("SettingsManager", () => {
  const settingsFile = path.join(TMP_ROOT, "settings.json");

  beforeEach(() => {
    // Wipe and recreate the temp dir between tests so each starts clean.
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });

    // Ensure env var overrides don't bleed into tests.
    delete process.env.NOTEBOOKLM_PROFILE;
    delete process.env.NOTEBOOKLM_DISABLED_TOOLS;
  });

  afterEach(() => {
    delete process.env.NOTEBOOKLM_PROFILE;
    delete process.env.NOTEBOOKLM_DISABLED_TOOLS;
  });

  // -------------------------------------------------------------------------
  // 1. Default settings when no file exists
  // -------------------------------------------------------------------------
  describe("default settings", () => {
    it("returns default profile and empty disabledTools when no settings file exists", () => {
      const sm = new SettingsManager();
      const settings = sm.getEffectiveSettings();

      expect(settings.profile).toBe("standard");
      expect(settings.disabledTools).toEqual([]);
      expect(fs.existsSync(settingsFile)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. saveSettings persists to disk
  // -------------------------------------------------------------------------
  describe("saveSettings", () => {
    it("writes updated settings to disk", async () => {
      const sm = new SettingsManager();

      await sm.saveSettings({ profile: "minimal", disabledTools: ["re_auth"] });

      expect(fs.existsSync(settingsFile)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as {
        profile: string;
        disabledTools: string[];
      };
      expect(raw.profile).toBe("minimal");
      expect(raw.disabledTools).toEqual(["re_auth"]);
    });

    it("merges partial updates without overwriting unrelated keys", async () => {
      const sm = new SettingsManager();

      await sm.saveSettings({ disabledTools: ["get_health"] });
      await sm.saveSettings({ profile: "full" });

      const settings = sm.getEffectiveSettings();
      expect(settings.profile).toBe("full");
      expect(settings.disabledTools).toEqual(["get_health"]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. getEffectiveSettings reads back persisted values
  // -------------------------------------------------------------------------
  describe("getEffectiveSettings", () => {
    it("reflects values written by saveSettings", async () => {
      const sm = new SettingsManager();

      await sm.saveSettings({ profile: "full", disabledTools: ["ask_question"] });

      const settings = sm.getEffectiveSettings();
      expect(settings.profile).toBe("full");
      expect(settings.disabledTools).toContain("ask_question");
    });
  });

  // -------------------------------------------------------------------------
  // 4. filterTools correctly excludes disabled tools and includes enabled ones
  // -------------------------------------------------------------------------
  describe("filterTools", () => {
    it("includes tools allowed by profile and excludes disabled ones", async () => {
      const sm = new SettingsManager();

      // Use "full" profile (wildcard "*") so the profile gate doesn't filter.
      // Three tools: ask_question and get_health are enabled; re_auth is disabled.
      await sm.saveSettings({ profile: "full", disabledTools: ["re_auth"] });

      const allTools: Tool[] = [
        makeTool("ask_question"),
        makeTool("get_health"),
        makeTool("re_auth"),
      ];

      const result = sm.filterTools(allTools);
      const names = result.map((t) => t.name);

      expect(names).toContain("ask_question");
      expect(names).toContain("get_health");
      expect(names).not.toContain("re_auth");
      expect(result).toHaveLength(2);
    });

    it("filters out tools not in the active profile allowlist", async () => {
      const sm = new SettingsManager();

      // "minimal" profile only allows a small set; "custom_tool" is not on it.
      await sm.saveSettings({ profile: "minimal", disabledTools: [] });

      const allTools: Tool[] = [
        makeTool("ask_question"),  // in minimal profile
        makeTool("get_health"),    // in minimal profile
        makeTool("custom_tool"),   // not in any named profile
      ];

      const result = sm.filterTools(allTools);
      const names = result.map((t) => t.name);

      expect(names).toContain("ask_question");
      expect(names).toContain("get_health");
      expect(names).not.toContain("custom_tool");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Disk round-trip: second SettingsManager loads saved settings
  // -------------------------------------------------------------------------
  describe("disk round-trip", () => {
    it("second SettingsManager instance loads settings saved by the first", async () => {
      const first = new SettingsManager();
      await first.saveSettings({
        profile: "full",
        disabledTools: ["deep_research", "gemini_query"],
      });

      // Construct a completely new instance pointing at the same configDir.
      const second = new SettingsManager();
      const loaded = second.getEffectiveSettings();

      expect(loaded.profile).toBe("full");
      expect(loaded.disabledTools).toEqual(["deep_research", "gemini_query"]);
    });

    it("settings file path is inside the configured configDir", () => {
      const sm = new SettingsManager();
      expect(sm.getSettingsPath()).toBe(settingsFile);
    });
  });
});
